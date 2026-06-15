// Git hook bridge: terminal/agent commits AND pushes get the same agent
// review as the app's buttons.
//
// Hooks installed per repo (common git dir, shared by all worktrees):
//   pre-commit  — staged-diff review via the socket (agent + lint scorecard)
//   pre-push    — push-range review via the socket; SKIPPED when every
//                 commit in the range already passed review at commit time
//   commit-msg  — free, local, deterministic message check (subject length,
//                 Conventional Commits when the repo demonstrably uses them)
//   post-commit — bookkeeping only: if the just-made commit's staged diff
//                 passed review (passmark left by the server), record its
//                 sha in ~/.klaussy/reviewed-commits.log for the pre-push skip
//
// A git hook can't spawn an interactive agent, so review hooks phone home:
//   hook (sh) → ~/.klaussy/precommit-client.js (node)
//     → unix socket (userData/precommit.sock, 0600) → this module
//     → runStagedCheck / runRangeCheck with the user's default agent
//
// Findings print in the committing terminal and the hook exits 1 — the
// committer (human or agent reading its own output) decides: fix, or bypass
// with `--no-verify` / KLAUSSY_SKIP_REVIEW=1. When the app isn't running the
// hooks no-op in milliseconds; any client-side failure exits 0. Commits and
// pushes must never break because of us.
//
// An existing non-Klaussy hook of the same name is preserved as
// <hook>.klaussy-prev and chained first. Installed repos are tracked in
// config so opting out (Preferences) uninstalls everywhere.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { app } = require('electron');
const { loadConfig, saveConfig } = require('../util/config');

const KLAUSSY_DIR = path.join(os.homedir(), '.klaussy');
const META_PATH = path.join(KLAUSSY_DIR, 'precommit.json'); // legacy single-pointer fallback
// One <pid>.json per running instance, so multiple Klaussy instances each run
// their own review server and the hook client can find whichever is live.
const SOCKETS_DIR = path.join(KLAUSSY_DIR, 'sockets');
const REGISTRY_FILE = path.join(SOCKETS_DIR, process.pid + '.json');
const CLIENT_PATH = path.join(KLAUSSY_DIR, 'precommit-client.js');
const COMMITMSG_CLIENT_PATH = path.join(KLAUSSY_DIR, 'commitmsg-client.js');
const REVIEWED_LOG = path.join(KLAUSSY_DIR, 'reviewed-commits.log');

let server = null;

// ---- Hook scripts -----------------------------------------------------------

const HOOKS = {
  'pre-commit': `#!/bin/sh
# klaussy-precommit v1 — staged-diff review before commits (installed by Klaussy).
# Opt out: Klaussy Preferences, or KLAUSSY_SKIP_REVIEW=1, or \`git commit --no-verify\`.
[ -n "$KLAUSSY_SKIP_REVIEW" ] && exit 0
HOOK_DIR=$(dirname "$0")
if [ -x "$HOOK_DIR/pre-commit.klaussy-prev" ]; then
  "$HOOK_DIR/pre-commit.klaussy-prev" || exit $?
fi
command -v node >/dev/null 2>&1 || exit 0
exec node "$HOME/.klaussy/precommit-client.js" "$PWD" pre-commit
`,

  'pre-push': `#!/bin/sh
# klaussy-prepush v1 — push-range review before pushes (installed by Klaussy).
# Opt out: Klaussy Preferences, or KLAUSSY_SKIP_REVIEW=1, or \`git push --no-verify\`.
[ -n "$KLAUSSY_SKIP_REVIEW" ] && exit 0
HOOK_DIR=$(dirname "$0")
STDIN_DATA=$(cat)
if [ -x "$HOOK_DIR/pre-push.klaussy-prev" ]; then
  printf '%s\\n' "$STDIN_DATA" | "$HOOK_DIR/pre-push.klaussy-prev" "$@" || exit $?
fi
command -v node >/dev/null 2>&1 || exit 0
FIRST_LINE=$(printf '%s\\n' "$STDIN_DATA" | head -1)
[ -z "$FIRST_LINE" ] && exit 0
LOCAL_SHA=$(printf '%s' "$FIRST_LINE" | awk '{print $2}')
REMOTE_SHA=$(printf '%s' "$FIRST_LINE" | awk '{print $4}')
exec node "$HOME/.klaussy/precommit-client.js" "$PWD" pre-push "$LOCAL_SHA" "$REMOTE_SHA"
`,

  'commit-msg': `#!/bin/sh
# klaussy-commitmsg v1 — free local commit-message check (installed by Klaussy).
HOOK_DIR=$(dirname "$0")
if [ -x "$HOOK_DIR/commit-msg.klaussy-prev" ]; then
  "$HOOK_DIR/commit-msg.klaussy-prev" "$@" || exit $?
fi
command -v node >/dev/null 2>&1 || exit 0
exec node "$HOME/.klaussy/commitmsg-client.js" "$1" "$PWD"
`,

  'post-commit': `#!/bin/sh
# klaussy-postcommit v1 — records review-passed commits for the pre-push skip
# (installed by Klaussy). Bookkeeping only; never blocks anything.
HOOK_DIR=$(dirname "$0")
if [ -x "$HOOK_DIR/post-commit.klaussy-prev" ]; then
  "$HOOK_DIR/post-commit.klaussy-prev" "$@" || true
fi
GD=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
M="$GD/klaussy-review-pass"
[ -f "$M" ] || exit 0
if [ -n "$(find "$M" -mmin -5 2>/dev/null)" ]; then
  mkdir -p "$HOME/.klaussy" 2>/dev/null
  git rev-parse HEAD >> "$HOME/.klaussy/reviewed-commits.log" 2>/dev/null
fi
rm -f "$M"
exit 0
`,
};

const HOOK_MARKERS = {
  'pre-commit': '# klaussy-precommit v1',
  'pre-push': '# klaussy-prepush v1',
  'commit-msg': '# klaussy-commitmsg v1',
  'post-commit': '# klaussy-postcommit v1',
};

// ---- Standalone clients (run OUTSIDE the app, written by the server) --------

const CLIENT_SCRIPT = `// Klaussy review hook client — written by Klaussy; edits will be overwritten.
// Invariant: this script may only block when the review RAN and found
// issues. Any client-side failure whatsoever must exit 0.
process.on('uncaughtException', () => process.exit(0));
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Discover every running Klaussy review server. Multiple instances can run at
// once (dev + packaged, or separate launches), each with its own socket.
const KDIR = path.join(os.homedir(), '.klaussy');
const candidates = [];
function addSock(s) { if (s && typeof s === 'string' && candidates.indexOf(s) === -1) candidates.push(s); }
// 1) The instance that owns THIS terminal (env injected by the app on spawn) —
//    so the review (and its scorecard) lands in the window you're working in.
addSock(process.env.KLAUSSY_REVIEW_SOCK);
// 2) Every registered instance.
try {
  const dir = path.join(KDIR, 'sockets');
  for (const f of fs.readdirSync(dir)) {
    if (f.slice(-5) !== '.json') continue;
    try { addSock(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).socket); } catch (e) {}
  }
} catch (e) {}
// 3) Legacy single-pointer fallback.
try { addSock(JSON.parse(fs.readFileSync(path.join(KDIR, 'precommit.json'), 'utf8')).socket); } catch (e) {}

if (!candidates.length) process.exit(0); // app never ran — never block

const cwd = process.argv[2] || process.cwd();
const kind = process.argv[3] === 'pre-push' ? 'pre-push' : 'pre-commit';
const localSha = process.argv[4] || null;
const remoteSha = process.argv[5] || null;
const gateName = kind === 'pre-push' ? 'pre-push review' : 'pre-commit review';

let idx = 0;
function tryNext() {
  if (idx >= candidates.length) process.exit(0); // no live instance — never block
  const target = candidates[idx++];
  let sock;
  try { sock = net.connect(target); } catch (e) { return tryNext(); }
  sock.setEncoding('utf8');
  let buf = '';
  let connected = false;
  // Hard ceiling: a wedged app must not hold commits/pushes hostage.
  const timer = setTimeout(() => {
    console.error('[klaussy] ' + gateName + ' timed out — proceeding without it');
    process.exit(0);
  }, 200000);
  sock.on('connect', () => {
    connected = true;
    console.error('[klaussy] ' + gateName + ' running — silent failures · secrets · debug leftovers · landmines · comments · lint (your agent is reading the '
      + (kind === 'pre-push' ? 'push range' : 'staged diff') + ')…');
    sock.write(JSON.stringify({ cwd, kind, localSha, remoteSha }) + '\\n');
  });
  sock.on('data', (d) => { buf += d; });
  sock.on('end', () => {
    clearTimeout(timer);
    let res;
    try { res = JSON.parse(buf); } catch (e) { process.exit(0); }
    if (res.error) {
      console.error('[klaussy] ' + gateName + ' unavailable: ' + res.error);
      process.exit(0);
    }
    if (res.allReviewed) {
      console.error('[klaussy] ' + gateName + ' skipped — all ' + res.commitCount + ' commit'
        + (res.commitCount === 1 ? '' : 's') + ' in this push already passed review at commit time ✓');
      process.exit(0);
    }
    if (res.skipped) process.exit(0);
    if (!res.findingsCount) {
      // Visible evidence on the clean path too — the full scorecard, so the
      // committer sees everything that was checked.
      console.error('[klaussy] ' + gateName + ' passed:');
      if (res.checklist) console.error(res.checklist);
      process.exit(0);
    }
    console.error('');
    console.error('[klaussy] ' + gateName.charAt(0).toUpperCase() + gateName.slice(1) + ' found ' + res.findingsCount + ' issue(s)'
      + (res.lintErrors ? ' (' + res.lintErrors + ' from lint)' : '') + ':');
    console.error('');
    console.error(res.text);
    console.error('');
    console.error('Fix the issues, or bypass this check with: ' + (kind === 'pre-push' ? 'git push --no-verify' : 'git commit --no-verify'));
    console.error('');
    process.exit(1);
  });
  sock.on('error', () => {
    clearTimeout(timer);
    if (!connected) return tryNext(); // that instance isn't up — try the next
    process.exit(0); // mid-stream failure — never block
  });
}
tryNext();
`;

const COMMITMSG_CLIENT_SCRIPT = `// Klaussy commit-msg client — written by Klaussy; edits will be overwritten.
// Deterministic, local, free. Blocks only on egregious problems; otherwise
// warns and lets the commit through. Any failure here exits 0.
process.on('uncaughtException', () => process.exit(0));
const fs = require('fs');
const cp = require('child_process');

const msgFile = process.argv[2];
const cwd = process.argv[3] || process.cwd();
let msg = '';
try { msg = fs.readFileSync(msgFile, 'utf8'); } catch { process.exit(0); }

// Strip agent attribution before anything else: AI agents (Claude, Codex,
// Gemini, Copilot, …) like to append "Co-Authored-By: <agent>" trailers and
// "Generated with <tool>" / 🤖 promo lines. Remove them so commits read as the
// human's own work. Human co-author trailers are preserved — only lines that
// name an AI agent/tool (or its bot email) are dropped.
const AGENT = /(claude|anthropic|codex|openai|chatgpt|\\bgpt\\b|gemini|google\\s+ai|copilot|cursor|llm\\b|\\bai\\s+assistant\\b)/i;
const stripLine = (l) => {
  const t = l.trim();
  if (/^co-authored-by:/i.test(t) && AGENT.test(t)) return true;
  if (/^(generated|assisted|created|authored)(\\s+\\w+)?\\s+(with|by|using)\\b/i.test(t) && AGENT.test(t)) return true;
  if (/generated with \\[?claude/i.test(t)) return true;
  if (/🤖/.test(t)) return true;
  return false;
};
{
  const lines = msg.split('\\n');
  const kept = [];
  for (const l of lines) { if (!stripLine(l)) kept.push(l); }
  // Collapse blank-line runs left where trailers were removed, and trim
  // trailing blanks, but keep the body's leading structure intact.
  let cleaned = kept.join('\\n').replace(/\\n{3,}/g, '\\n\\n').replace(/\\s+$/, '') + '\\n';
  if (cleaned !== msg) {
    try { fs.writeFileSync(msgFile, cleaned); msg = cleaned; } catch { /* keep original on write failure */ }
  }
}

const subject = (msg.split('\\n').find((l) => l.trim() && !l.startsWith('#')) || '').trim();
if (!subject) process.exit(0); // git rejects empty messages itself

const blockers = [];
const warnings = [];
if (subject.length > 100) blockers.push('subject is ' + subject.length + ' chars — keep it under 72 (hard limit 100)');
else if (subject.length > 72) warnings.push('subject is ' + subject.length + ' chars — 72 or fewer reads best in git log');

// Conventional Commits enforced only when the repo demonstrably uses them.
let recent = [];
try {
  recent = cp.execFileSync('git', ['log', '--format=%s', '-20'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().split('\\n').filter(Boolean);
} catch { /* fresh repo — nothing to infer */ }
const CONV = /^(feat|fix|docs|chore|refactor|test|ci|build|perf|style|release|revert)(\\([^)]*\\))?!?:\\s/;
const convCount = recent.filter((s) => CONV.test(s)).length;
const repoIsConventional = recent.length >= 10 && convCount / recent.length >= 0.7;
if (repoIsConventional && !CONV.test(subject) && !/^(Merge|Revert|fixup!|squash!)/.test(subject)) {
  blockers.push('this repo uses Conventional Commits (' + convCount + '/' + recent.length
    + ' recent subjects match) — use "type(scope): summary", e.g. "fix(auth): …"');
}

if (!blockers.length && !warnings.length) process.exit(0);
console.error('');
console.error('[klaussy] commit message check' + (blockers.length ? ':' : ' (warnings only):'));
for (const b of blockers) console.error('  ✗ ' + b);
for (const w of warnings) console.error('  ⚠ ' + w);
console.error('  Subject: ' + subject);
if (blockers.length) {
  console.error('');
  console.error('Amend the message, or bypass with: git commit --no-verify');
  console.error('');
  process.exit(1);
}
process.exit(0);
`;

// ---- Socket server -----------------------------------------------------------

function socketPath() {
  // Per-PROCESS socket so multiple Klaussy instances (dev + packaged, or two
  // separate launches) each run their own review server instead of one stealing
  // the socket from the other. The hook client discovers all live sockets.
  return path.join(app.getPath('userData'), 'precommit-' + process.pid + '.sock');
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

// reviewed-commits.log → Set of shas, trimmed when it grows unbounded.
function reviewedShas() {
  try {
    let lines = fs.readFileSync(REVIEWED_LOG, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 20000) {
      lines = lines.slice(-10000);
      try { fs.writeFileSync(REVIEWED_LOG, lines.join('\n') + '\n'); } catch {}
    }
    return new Set(lines);
  } catch {
    return new Set();
  }
}

// The push range to review. Remote sha of all zeros = new branch → diff from
// the merge-base with the default branch. Returns null when no sensible base
// exists (e.g. unrelated history) — the caller skips rather than reviewing
// the whole repo history.
function pushRange(cwd, localSha, remoteSha) {
  if (!localSha || /^0+$/.test(localSha)) return null; // branch deletion
  if (remoteSha && !/^0+$/.test(remoteSha)) return remoteSha + '..' + localSha;
  // New branch (remote sha is zeros): diff from the merge-base with the
  // default branch. Try origin/HEAD, then common default-branch remote refs
  // (origin/HEAD is often unset on bare/self-hosted remotes).
  const bases = [];
  try {
    bases.push(execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], {
      cwd, stdio: 'pipe',
    }).toString().trim());
  } catch { /* unset */ }
  for (const c of ['origin/main', 'origin/master', 'origin/dev', 'origin/develop']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', c], { cwd, stdio: 'pipe' });
      bases.push(c);
    } catch { /* no such remote ref */ }
  }
  for (const ref of bases) {
    if (!ref) continue;
    try {
      const base = execFileSync('git', ['merge-base', ref, localSha], { cwd, stdio: 'pipe' }).toString().trim();
      if (base && base !== localSha) return base + '..' + localSha;
    } catch { /* unrelated history — try next */ }
  }
  return null;
}

// Are all non-merge commits in the range already review-passed?
function allCommitsReviewed(cwd, range) {
  try {
    const shas = execFileSync('git', ['rev-list', '--no-merges', range], { cwd, stdio: 'pipe' })
      .toString().split('\n').filter(Boolean);
    if (!shas.length) return { all: true, count: 0 };
    const reviewed = reviewedShas();
    return { all: shas.every((s) => reviewed.has(s)), count: shas.length };
  } catch {
    return { all: false, count: 0 };
  }
}

// After a clean staged review, leave a passmark in the worktree's git dir;
// the post-commit hook turns it into a reviewed-commits.log entry if a
// commit follows within 5 minutes.
function leaveReviewPassmark(worktreePath) {
  try {
    const gd = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: worktreePath, stdio: 'pipe',
    }).toString().trim();
    if (gd) fs.writeFileSync(path.join(gd, 'klaussy-review-pass'), String(Date.now()));
  } catch { /* non-git or unreadable — the pre-push gate simply won't skip */ }
}

// Start the local socket server (idempotent). Called at app boot and before
// any install so a relaunch re-arms hooks installed in earlier runs.
function startPrecommitServer() {
  if (server) return;
  // Unix-socket paths; the Windows named-pipe variant isn't wired up yet, so
  // gate the whole feature there rather than half-install it.
  if (process.platform === 'win32') {
    console.warn('[precommit-hook] git-hook review not yet supported on Windows — skipping');
    return;
  }
  // Each instance owns a unique per-pid socket, so there's nothing to steal —
  // just clean up after any instances that died without unregistering, then
  // start our own server.
  pruneDeadInstances();
  reallyStartServer(socketPath());
}

// Drop registry entries (and their stale sockets) for instances no longer
// running, so the hook client doesn't waste time dialing dead sockets.
function pruneDeadInstances() {
  let files = [];
  try { files = fs.readdirSync(SOCKETS_DIR); } catch { return; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(SOCKETS_DIR, f);
    let entry;
    try { entry = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { try { fs.rmSync(p, { force: true }); } catch {} continue; }
    let alive = false;
    if (entry && entry.pid) {
      try { process.kill(entry.pid, 0); alive = true; }
      catch (e) { alive = e.code === 'EPERM'; } // EPERM = exists, not ours
    }
    if (!alive) {
      try { fs.rmSync(p, { force: true }); } catch {}
      if (entry && entry.socket) { try { fs.rmSync(entry.socket, { force: true }); } catch {} }
    }
  }
}

let cleanupRegistered = false;
function registerCleanupOnce() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const cleanup = () => {
    try { fs.rmSync(REGISTRY_FILE, { force: true }); } catch {}
    try { fs.rmSync(socketPath(), { force: true }); } catch {}
  };
  try { app.on('will-quit', cleanup); } catch {}
  process.on('exit', cleanup);
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
        const provider = config.defaultProvider || config.defaultMode || 'claude';
        if (config.preCommitReview === false) {
          reply = { skipped: true, reason: 'disabled' };
        } else if (!cwd || !fs.existsSync(cwd)) {
          reply = { skipped: true, reason: 'unknown cwd' };
        } else if (req.kind === 'pre-push') {
          const range = pushRange(cwd, req.localSha, req.remoteSha);
          if (!range) {
            reply = { skipped: true, reason: 'no reviewable range' };
          } else {
            const seen = allCommitsReviewed(cwd, range);
            if (seen.all) {
              reply = { skipped: true, allReviewed: true, commitCount: seen.count };
            } else {
              const { runRangeCheck } = require('./precommit-review');
              reply = await runRangeCheck({ worktreePath: cwd, provider, range });
            }
          }
        } else {
          const { runStagedCheck } = require('./precommit-review');
          reply = await runStagedCheck({ worktreePath: cwd, provider });
          // Clean staged review → passmark, so the commit that follows gets
          // recorded and the eventual push can skip re-reviewing it.
          if (reply && !reply.error && !reply.skipped && !reply.cancelled && !reply.findingsCount) {
            leaveReviewPassmark(cwd);
          }
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
      fs.mkdirSync(SOCKETS_DIR, { recursive: true });
      // Route THIS instance's own terminals' hooks back to itself: a commit in
      // this window's embedded terminal is reviewed here and its scorecard
      // shows in this window. Child PTYs inherit process.env.
      process.env.KLAUSSY_REVIEW_SOCK = sock;
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ socket: sock, pid: process.pid }));
      // Legacy single-pointer fallback for any old client still on disk.
      fs.writeFileSync(META_PATH, JSON.stringify({ socket: sock, pid: process.pid }));
      fs.writeFileSync(CLIENT_PATH, CLIENT_SCRIPT);
      fs.writeFileSync(COMMITMSG_CLIENT_PATH, COMMITMSG_CLIENT_SCRIPT);
    } catch (e) {
      console.warn('[precommit-hook] could not write client/meta:', e.message);
    }
    registerCleanupOnce();
  });
}

// ---- Install / uninstall ------------------------------------------------------

function installOneHook(hooksDir, hookName, repoPath) {
  const hookPath = path.join(hooksDir, hookName);
  const marker = HOOK_MARKERS[hookName];
  if (fs.existsSync(hookPath)) {
    const current = fs.readFileSync(hookPath, 'utf-8');
    if (current.includes(marker)) {
      // Ours — refresh in place so hook-script fixes reach installed repos.
      if (current !== HOOKS[hookName]) fs.writeFileSync(hookPath, HOOKS[hookName], { mode: 0o755 });
      return;
    }
    const prev = path.join(hooksDir, hookName + '.klaussy-prev');
    if (!fs.existsSync(prev)) {
      fs.renameSync(hookPath, prev);
    } else {
      console.warn('[precommit-hook] NOT installed for', repoPath,
        '—', hookName, 'and', hookName + '.klaussy-prev both exist; resolve manually to enable this gate');
      return;
    }
  }
  fs.writeFileSync(hookPath, HOOKS[hookName], { mode: 0o755 });
}

// Install all Klaussy hooks for a repo's common git dir. Idempotent; chains
// any pre-existing foreign hooks. No-op when the preference is off.
function installHookForRepo(repoPath) {
  try {
    const config = loadConfig();
    if (config.preCommitReview === false) return;
    startPrecommitServer();

    const hooksDir = commonHooksDir(repoPath);
    if (!hooksDir) return;
    fs.mkdirSync(hooksDir, { recursive: true });
    for (const hookName of Object.keys(HOOKS)) {
      try {
        installOneHook(hooksDir, hookName, repoPath);
      } catch (e) {
        console.warn('[precommit-hook] install of', hookName, 'failed for', repoPath, e.message);
      }
    }

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
    for (const hookName of Object.keys(HOOKS)) {
      const hookPath = path.join(hooksDir, hookName);
      if (!fs.existsSync(hookPath)) continue;
      if (!fs.readFileSync(hookPath, 'utf-8').includes(HOOK_MARKERS[hookName])) continue; // not ours
      fs.rmSync(hookPath, { force: true });
      const prev = path.join(hooksDir, hookName + '.klaussy-prev');
      if (fs.existsSync(prev)) fs.renameSync(prev, hookPath); // restore the original
    }
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
  // orphan the hooks forever.
  const remaining = (config.precommitHookRepos || []).filter((repo) => !uninstallHookForRepo(repo));
  if (remaining.length) {
    console.warn('[precommit-hook] could not uninstall hooks for:', remaining.join(', '));
  }
  config.precommitHookRepos = remaining;
  saveConfig(config);
}

module.exports = { startPrecommitServer, installHookForRepo, uninstallAllHooks, leaveReviewPassmark };
