// Git pre-commit hook bridge: terminal/agent commits get the same
// silent-failure review as the app's Commit button.
//
// A git hook can't spawn an interactive agent (and `claude -p`-style direct
// spawns from a hook would bypass the app's provider/billing handling), so
// the installed hook phones home instead:
//
//   .git hooks/pre-commit (sh)  →  ~/.klaussy/precommit-client.js (node)
//        →  unix socket (userData/precommit.sock, 0600)  →  this module
//        →  runStagedCheck() with the user's default agent
//
// Findings print in the committing terminal and the hook exits 1 — the
// committer (human or agent reading its own Bash output) decides: fix, or
// bypass with `git commit --no-verify` / KLAUSSY_SKIP_REVIEW=1. When the
// app isn't running (no socket) the hook no-ops in milliseconds, so commits
// never break.
//
// Hooks live in the repo's COMMON git dir (shared by all worktrees, and by
// the base checkout). An existing non-Klaussy pre-commit is preserved as
// pre-commit.klaussy-prev and chained first. Installed repos are tracked in
// config so opting out (Preferences) uninstalls everywhere.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { app } = require('electron');
const { loadConfig, saveConfig } = require('../util/config');

const HOOK_MARKER = '# klaussy-precommit v1';
const KLAUSSY_DIR = path.join(os.homedir(), '.klaussy');
const META_PATH = path.join(KLAUSSY_DIR, 'precommit.json');
const CLIENT_PATH = path.join(KLAUSSY_DIR, 'precommit-client.js');

let server = null;

const HOOK_SCRIPT = `#!/bin/sh
${HOOK_MARKER} — silent-failure review before commits (installed by Klaussy).
# Opt out: Klaussy Preferences → "Review commits", or KLAUSSY_SKIP_REVIEW=1,
# or per-commit with \`git commit --no-verify\`.
[ -n "$KLAUSSY_SKIP_REVIEW" ] && exit 0
HOOK_DIR=$(dirname "$0")
if [ -x "$HOOK_DIR/pre-commit.klaussy-prev" ]; then
  "$HOOK_DIR/pre-commit.klaussy-prev" || exit $?
fi
command -v node >/dev/null 2>&1 || exit 0
exec node "$HOME/.klaussy/precommit-client.js" "$PWD"
`;

// Standalone node client — runs OUTSIDE the app (from the git hook), so it
// must not assume anything beyond node + the meta file this module writes.
const CLIENT_SCRIPT = `// Klaussy pre-commit client — written by Klaussy; edits will be overwritten.
// Invariant: this script may only block a commit when the review RAN and
// found issues. Any client-side failure whatsoever must exit 0.
process.on('uncaughtException', () => process.exit(0));
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

let meta;
try {
  meta = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.klaussy', 'precommit.json'), 'utf8'));
} catch {
  process.exit(0); // app never ran — never block commits
}
if (!meta || typeof meta.socket !== 'string' || !meta.socket) process.exit(0);
let sock;
try { sock = net.connect(meta.socket); } catch { process.exit(0); }
sock.setEncoding('utf8');
const cwd = process.argv[2] || process.cwd();
let buf = '';
// Hard ceiling: a wedged app must not hold commits hostage.
const timer = setTimeout(() => {
  console.error('[klaussy] silent-failure review timed out — committing without it');
  process.exit(0);
}, 200000);
sock.on('connect', () => {
  // Announce immediately — the review takes 30-60s and an unexplained pause
  // reads as a hang (or as "no check ran").
  console.error('[klaussy] reviewing staged changes for silent failures (your agent is reading the diff)…');
  sock.write(JSON.stringify({ cwd }) + '\\n');
});
sock.on('data', (d) => { buf += d; });
sock.on('end', () => {
  clearTimeout(timer);
  let res;
  try { res = JSON.parse(buf); } catch { process.exit(0); }
  if (res.error) {
    console.error('[klaussy] silent-failure review unavailable: ' + res.error);
    process.exit(0);
  }
  if (res.skipped) process.exit(0);
  if (!res.findingsCount) {
    // Visible evidence on the clean path too — silence reads as "the check
    // never ran" (and the ~30-60s pause becomes inexplicable).
    console.error('[klaussy] silent-failure review passed: no issues in the staged changes');
    process.exit(0);
  }
  console.error('');
  console.error('[klaussy] Silent-failure review found ' + res.findingsCount + ' issue(s) in the staged changes:');
  console.error('');
  console.error(res.text);
  console.error('');
  console.error('Fix the issues and re-stage, or bypass this check with: git commit --no-verify');
  console.error('');
  process.exit(1);
});
sock.on('error', () => { clearTimeout(timer); process.exit(0); }); // app not running
`;

function socketPath() {
  return path.join(app.getPath('userData'), 'precommit.sock');
}

function commonHooksDir(repoPath) {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: repoPath, stdio: 'pipe',
    }).toString().trim();
    if (!commonDir) return null;
    return path.join(commonDir, 'hooks');
  } catch {
    return null;
  }
}

// Start the local socket server (idempotent). Called at app boot and before
// any install so a relaunch re-arms hooks installed in earlier runs.
function startPrecommitServer() {
  if (server) return;
  // Unix-socket paths; the Windows named-pipe variant isn't wired up yet, so
  // gate the whole feature there rather than half-install it (hooks present,
  // server absent = pref says ON while nothing ever reviews).
  if (process.platform === 'win32') {
    console.warn('[precommit-hook] git-hook review not yet supported on Windows — skipping');
    return;
  }
  const sock = socketPath();
  // Don't steal a live socket from another running instance (packaged app +
  // dev session is a real combo): if something answers, leave it be.
  const probe = net.connect(sock);
  let probeDone = false;
  const proceed = (takeover) => {
    if (probeDone) return;
    probeDone = true;
    try { probe.destroy(); } catch {}
    if (!takeover) {
      console.warn('[precommit-hook] another instance owns the pre-commit socket — not taking over');
      return;
    }
    reallyStartServer(sock);
  };
  probe.once('connect', () => proceed(false));
  probe.once('error', () => proceed(true)); // nothing listening — ours to claim
  setTimeout(() => proceed(true), 1000);
}

function reallyStartServer(sock) {
  if (server) return;
  try { fs.rmSync(sock, { force: true }); } catch {}
  server = net.createServer((conn) => {
    conn.setEncoding('utf8');
    let buf = '';
    let handled = false;
    conn.on('data', async (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl === -1 || handled) return;
      handled = true;
      let reply = { skipped: true };
      try {
        const req = JSON.parse(buf.slice(0, nl));
        const cwd = typeof req.cwd === 'string' ? req.cwd : null;
        const config = loadConfig();
        if (config.preCommitReview === false) {
          reply = { skipped: true, reason: 'disabled' };
        } else if (!cwd || !fs.existsSync(cwd)) {
          reply = { skipped: true, reason: 'unknown cwd' };
        } else {
          const { runStagedCheck } = require('./precommit-review');
          reply = await runStagedCheck({
            worktreePath: cwd,
            provider: config.defaultProvider || config.defaultMode || 'claude',
          });
        }
      } catch (e) {
        reply = { error: e.message };
      }
      try {
        conn.end(JSON.stringify(reply));
      } catch { /* client gone — its timeout handles it */ }
    });
    conn.on('error', () => {});
  });
  server.on('error', (e) => {
    console.warn('[precommit-hook] socket server error:', e.message);
    server = null;
  });
  server.listen(sock, () => {
    try { fs.chmodSync(sock, 0o600); } catch {}
    try {
      fs.mkdirSync(KLAUSSY_DIR, { recursive: true });
      fs.writeFileSync(META_PATH, JSON.stringify({ socket: sock, pid: process.pid }));
      fs.writeFileSync(CLIENT_PATH, CLIENT_SCRIPT);
    } catch (e) {
      console.warn('[precommit-hook] could not write client/meta:', e.message);
    }
  });
}

// Install the hook for a repo's common git dir. Idempotent; chains any
// pre-existing foreign pre-commit. No-op when the preference is off.
function installHookForRepo(repoPath) {
  try {
    const config = loadConfig();
    if (config.preCommitReview === false) return;
    startPrecommitServer();

    const hooksDir = commonHooksDir(repoPath);
    if (!hooksDir) return;
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'pre-commit');

    if (fs.existsSync(hookPath)) {
      const current = fs.readFileSync(hookPath, 'utf-8');
      if (current.includes(HOOK_MARKER)) return; // ours, already installed
      // Foreign hook: preserve and chain it.
      const prev = path.join(hooksDir, 'pre-commit.klaussy-prev');
      if (!fs.existsSync(prev)) {
        fs.renameSync(hookPath, prev);
      } else {
        // Both a foreign active hook AND a stashed prev exist — installing
        // would lose one of them. Skip, but say so: the pref claims terminal
        // commits are reviewed and for this repo they won't be.
        console.warn('[precommit-hook] NOT installed for', repoPath,
          '— pre-commit and pre-commit.klaussy-prev both exist; resolve manually to enable commit review here');
        return;
      }
    }
    fs.writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755 });

    // Track for uninstall-on-opt-out.
    const cfg = loadConfig();
    cfg.precommitHookRepos = Array.from(new Set([...(cfg.precommitHookRepos || []), repoPath]));
    saveConfig(cfg);
  } catch (e) {
    console.warn('[precommit-hook] install failed for', repoPath, e.message);
  }
}

function uninstallHookForRepo(repoPath) {
  try {
    const hooksDir = commonHooksDir(repoPath);
    if (!hooksDir) return true; // repo gone — nothing left to uninstall
    const hookPath = path.join(hooksDir, 'pre-commit');
    if (!fs.existsSync(hookPath)) return true;
    if (!fs.readFileSync(hookPath, 'utf-8').includes(HOOK_MARKER)) return true; // not ours
    fs.rmSync(hookPath, { force: true });
    const prev = path.join(hooksDir, 'pre-commit.klaussy-prev');
    if (fs.existsSync(prev)) fs.renameSync(prev, hookPath); // restore the original
    return true;
  } catch (e) {
    console.warn('[precommit-hook] uninstall failed for', repoPath, e.message);
    return false;
  }
}

function uninstallAllHooks() {
  const config = loadConfig();
  // Repos whose uninstall failed (unmounted volume, perms) stay tracked so
  // a later opt-out attempt can still clean them — wiping the list would
  // orphan the hook forever.
  const remaining = (config.precommitHookRepos || []).filter((repo) => !uninstallHookForRepo(repo));
  if (remaining.length) {
    console.warn('[precommit-hook] could not uninstall hooks for:', remaining.join(', '));
  }
  config.precommitHookRepos = remaining;
  saveConfig(config);
}

module.exports = { startPrecommitServer, installHookForRepo, uninstallAllHooks };
