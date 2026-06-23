// GitHub CLI surface: account list/switch/detect, CI status and logs,
// dependency probe, and the scheme-restricted external URL opener.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { ipcMain, shell, BrowserWindow } = require('electron');
const { loadConfig, saveConfig } = require('../util/config');
const { ghExec, clearGhTokenCache, execFileP } = require('../util/exec');
const { allProviders, getProvider, binFor, installCommandFor, authMetaFor } = require('../state/ai-providers');
const { discoverReposOnDisk } = require('./repo');

// Parse `gh auth status` output into structured account records.
//
// gh exits 1 if *any* account has a bad token, even when others are fine —
// so we always parse from both stdout and stderr and never trust the exit
// code to mean "no accounts." Output looks like:
//
//   github.com
//     ✓ Logged in to github.com account stephanie913 (keyring)
//       - Active account: true
//     X Failed to log in to github.com account steph-dove (keyring)
//       - Active account: false
//       - The token in keyring is invalid.
//
// Returns [{ username, active, valid, reason }].
function parseGhAuthStatus(text) {
  const accounts = [];
  if (!text) return accounts;
  let pending = null;
  const flush = () => { if (pending) { accounts.push(pending); pending = null; } };
  for (const raw of text.split('\n')) {
    const m = raw.match(/account\s+([^\s]+)/);
    if (m) {
      flush();
      // "✓ Logged in" → valid; "X Failed to log in" → invalid. Default to
      // valid because some gh versions phrase the success line without ✓.
      const valid = !/Failed to log in/i.test(raw);
      pending = { username: m[1], active: false, valid, reason: null };
      continue;
    }
    if (!pending) continue;
    if (/Active account:\s*true/.test(raw)) pending.active = true;
    if (/token .* is invalid/i.test(raw) || /token in keyring is invalid/i.test(raw)) {
      pending.valid = false;
      pending.reason = 'Token is invalid';
    } else if (/token .* expired/i.test(raw)) {
      pending.valid = false;
      pending.reason = 'Token expired';
    }
  }
  flush();
  return accounts;
}

// Run `gh auth status` and return parsed accounts regardless of exit code.
// On a non-zero exit, gh still prints the account list — we just have to
// pull it from err.stdout/err.stderr instead of letting the throw discard it.
function readGhAccounts() {
  try {
    const out = execFileSync('gh', ['auth', 'status'], {
      stdio: 'pipe', timeout: 5000,
    }).toString();
    return { accounts: parseGhAuthStatus(out), error: null };
  } catch (err) {
    const merged = [
      err.stdout ? err.stdout.toString() : '',
      err.stderr ? err.stderr.toString() : '',
    ].join('\n');
    const accounts = parseGhAuthStatus(merged);
    // If we recovered any accounts, the partial parse is the answer; only
    // surface the raw error when gh truly produced nothing parseable (e.g.
    // gh not installed, no accounts at all).
    if (accounts.length > 0) return { accounts, error: null };
    return { accounts: [], error: (err.stderr ? err.stderr.toString() : err.message).trim() };
  }
}

// Open URL in default browser. Scheme-restricted: a compromised renderer (or
// xterm's WebLinksAddon auto-detecting a file:// / javascript: / smb: token in
// the PTY stream) must not be able to hand an arbitrary URI to the OS opener.
const OPEN_EXTERNAL_ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
ipcMain.handle('open-external', (_event, { url }) => {
  if (typeof url !== 'string') return { error: 'url must be a string' };
  let parsed;
  try { parsed = new URL(url); } catch { return { error: 'invalid URL' }; }
  if (!OPEN_EXTERNAL_ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { error: `blocked scheme: ${parsed.protocol}` };
  }
  shell.openExternal(parsed.toString());
  return { ok: true };
});

// List authed accounts with per-account validity. One bad token must NOT
// hide the other accounts — see readGhAccounts() for the recovery path.
ipcMain.handle('gh-list-accounts', async () => readGhAccounts());

ipcMain.handle('gh-switch-account', async (_event, { username }) => {
  if (!username) return { error: 'Missing username' };
  // Refuse to switch into an account whose token gh has already flagged
  // invalid — `gh auth switch` succeeds in that case but every downstream
  // call then fails cryptically. Caller should route to the login flow.
  const { accounts } = readGhAccounts();
  const target = accounts.find((a) => a.username === username);
  if (target && !target.valid) {
    // Drop cached owner→token entries — caller will re-auth and the next
    // gh call must read the fresh token, not whatever was cached for this
    // user when its token was still believed valid.
    clearGhTokenCache();
    return { error: 'invalid-token', needsLogin: true, username };
  }
  try {
    execFileSync('gh', ['auth', 'switch', '-u', username], { stdio: 'pipe', timeout: 5000 });
    clearGhTokenCache();
    return { ok: true };
  } catch (err) {
    return { error: (err.stderr ? err.stderr.toString() : err.message).trim() };
  }
});

// In-app gh login (device flow). Spawns `gh auth login --web`, parses the
// one-time code out of gh's stderr, and streams events to the calling
// window so the renderer can show the code in a modal and detect success
// without forcing the user out to a terminal.
//
// We deliberately route through gh rather than implementing OAuth device
// flow ourselves: gh writes the resulting token to the OS keyring with
// the right scopes and host metadata, which is what every other code path
// in this app expects.
let activeLoginChild = null;

function killActiveLogin() {
  if (!activeLoginChild) return;
  try { activeLoginChild.kill(); } catch { /* already exited */ }
  activeLoginChild = null;
}

ipcMain.handle('gh-login-start', async (event, opts) => {
  killActiveLogin();
  const hostname = (opts && opts.hostname) || 'github.com';
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { error: 'no window' };
  const send = (type, payload) => {
    if (win.isDestroyed()) return;
    win.webContents.send('gh-login-event', Object.assign({ type }, payload || {}));
  };

  const args = ['auth', 'login', '--web', '--hostname', hostname, '--git-protocol', 'https'];
  let child;
  try {
    child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    return { error: err.message };
  }
  activeLoginChild = child;

  let combined = '';
  let codeSeen = false;
  let enterSent = false;

  // Watchdogs. gh can hang in two distinct places: before printing the
  // one-time code (network/version issue) and after, while polling for
  // the user's authorization. Without bounds the renderer modal sits on
  // "Waiting…" forever and the user can only escape via window close.
  const CODE_TIMEOUT_MS = 30 * 1000;
  const AUTH_TIMEOUT_MS = 15 * 60 * 1000; // matches gh's internal default
  const codeTimer = setTimeout(() => {
    if (codeSeen) return;
    send('error', { message: 'gh did not produce a one-time code within 30s. Check `gh --version` and your network.' });
    killActiveLogin();
  }, CODE_TIMEOUT_MS);
  const authTimer = setTimeout(() => {
    send('error', { message: 'Sign-in timed out after 15 minutes. Try again.' });
    killActiveLogin();
  }, AUTH_TIMEOUT_MS);

  const onChunk = (chunk) => {
    const piece = chunk.toString();
    combined += piece;
    if (!codeSeen) {
      // gh prints "First copy your one-time code: XXXX-XXXX" on stderr.
      const m = combined.match(/one-time code:\s*([A-Z0-9-]+)/i);
      if (m) {
        codeSeen = true;
        clearTimeout(codeTimer);
        send('code', { code: m[1], verificationUrl: `https://${hostname}/login/device` });
      }
    }
    // Older gh versions wait for Enter before opening the browser. Newer
    // versions skip it. Either is fine — we only feed \n if asked.
    if (codeSeen && !enterSent && /Press Enter/i.test(combined)) {
      enterSent = true;
      try { child.stdin.write('\n'); } catch { /* stdin may be closed */ }
    }
  };
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  child.on('exit', (code, signal) => {
    activeLoginChild = null;
    clearTimeout(codeTimer);
    clearTimeout(authTimer);
    if (code === 0) {
      // Re-read accounts so the renderer can refresh without a second IPC
      // round-trip — and so we surface the freshly-logged-in username.
      const { accounts } = readGhAccounts();
      clearGhTokenCache();
      send('success', { accounts });
      return;
    }
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      send('cancelled', {});
      return;
    }
    send('error', {
      message: combined.trim() || `gh exited with code ${code}`,
      exitCode: code,
    });
  });
  child.on('error', (err) => {
    activeLoginChild = null;
    clearTimeout(codeTimer);
    clearTimeout(authTimer);
    send('error', { message: err.message });
  });

  return { ok: true };
});

ipcMain.handle('gh-login-cancel', async () => {
  killActiveLogin();
  return { ok: true };
});

// ---- Recent GitHub repos: list + clone-on-demand --------------------------
//
// Powers the New Task modal's "GitHub" section: the 5 most recently pushed
// repos the active gh account can push to (owned + collaborator + org).
// Each entry carries `localPath` when an existing clone is found among
// configured projects or under a known clone parent, so the renderer can
// switch straight to it instead of cloning again.

// origin URLs of every configured project (and the active repo), for matching
// listed GitHub repos to clones already on disk — including clones whose
// directory name differs from the repo name.
async function knownRepoRemotes() {
  const config = loadConfig();
  const paths = new Set();
  for (const p of config.projects || []) {
    if (p && p.path) paths.add(p.path);
  }
  if (config.repoPath) paths.add(config.repoPath);
  const out = [];
  await Promise.all(Array.from(paths).map(async (repoPath) => {
    try {
      const { stdout } = await execFileP('git', ['config', '--get', 'remote.origin.url'], {
        cwd: repoPath, timeout: 3000,
      });
      out.push({ path: repoPath, url: stdout.trim() });
    } catch { /* no origin / not a repo anymore — skip */ }
  }));
  return out;
}

// Where a fresh clone should land: the directory that already holds the most
// configured projects, falling back to ~/klaussy-projects.
function defaultCloneParent() {
  const config = loadConfig();
  const counts = new Map();
  const bump = (repoPath) => {
    const dir = path.dirname(repoPath);
    counts.set(dir, (counts.get(dir) || 0) + 1);
  };
  for (const p of config.projects || []) {
    if (p && p.path) bump(p.path);
  }
  if (config.repoPath) bump(config.repoPath);
  let best = null;
  let bestCount = 0;
  for (const [dir, count] of counts) {
    if (count > bestCount && fs.existsSync(dir)) { best = dir; bestCount = count; }
  }
  return best || path.join(os.homedir(), 'klaussy-projects');
}

// Does this remote URL point at owner/name? Anchored to the end so
// "owner/name-extra" doesn't match. Covers SSH and HTTPS forms.
function remoteMatches(url, nameWithOwner) {
  const escaped = nameWithOwner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('[:/]' + escaped + '(\\.git)?/?$', 'i').test(url.trim());
}

// origin URL of a top-level clone, read straight from .git/config — no git
// subprocess, so it's cheap enough to run across every discovered repo.
// (Discovery only returns repos where .git is a directory, so the file is
// always at this path; worktrees with a .git *file* return null, which is
// fine — they're never the canonical clone we're matching against.)
function originUrlOf(repoPath) {
  try {
    const conf = fs.readFileSync(path.join(repoPath, '.git', 'config'), 'utf-8');
    const m = conf.match(/\[remote "origin"\][^[]*?url\s*=\s*(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

ipcMain.handle('gh-list-recent-repos', async () => {
  let repos;
  try {
    const { stdout } = await execFileP('gh', [
      'api', 'user/repos?sort=pushed&per_page=5&affiliation=owner,collaborator,organization_member',
    ], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    repos = JSON.parse(stdout);
  } catch (err) {
    const msg = ((err.stderr ? String(err.stderr) : '') || err.message || '').trim().split('\n')[0];
    return { error: msg || 'Could not list GitHub repos' };
  }
  if (!Array.isArray(repos)) return { error: 'Unexpected response from gh api' };

  const remotes = await knownRepoRemotes();
  const cloneParent = defaultCloneParent();
  // Repos on disk beyond config.projects — same crawl as the Discovered
  // dropdown section (common dev dirs, org subdirs, scan roots). Matched by
  // origin URL (read from .git/config, no subprocess) rather than directory
  // name, so renamed clones (e.g. klaussy-agents cloned as "klaussy") still count.
  let discoveredRemotes = [];
  try {
    const discovered = await discoverReposOnDisk();
    discoveredRemotes = discovered
      .map((d) => ({ path: d.path, url: originUrlOf(d.path) }))
      .filter((d) => d.url);
  } catch { /* degrade to config-only matching */ }

  const out = [];
  for (const r of repos) {
    if (!r || !r.full_name || !r.name) continue;
    // Existing clone? Configured projects first, then discovered repos, then
    // <cloneParent>/<name> — all verified by origin URL before trusting.
    let localPath = null;
    const known = remotes.find((k) => remoteMatches(k.url, r.full_name))
      || discoveredRemotes.find((k) => remoteMatches(k.url, r.full_name));
    if (known) {
      localPath = known.path;
    } else {
      const direct = path.join(cloneParent, r.name);
      const directUrl = originUrlOf(direct);
      if (directUrl && remoteMatches(directUrl, r.full_name)) localPath = direct;
    }
    out.push({
      nameWithOwner: r.full_name,
      name: r.name,
      owner: r.owner ? r.owner.login : null,
      defaultBranch: r.default_branch || 'main',
      isPrivate: !!r.private,
      pushedAt: r.pushed_at || null,
      localPath,
    });
  }
  return { repos: out };
});

// Clone a GitHub repo into the default clone parent and adopt it as a
// configured project. Idempotent: an existing clone at the target path is
// adopted instead of re-cloned.
ipcMain.handle('gh-clone-repo', async (_event, { nameWithOwner }) => {
  if (typeof nameWithOwner !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(nameWithOwner)) {
    return { error: 'Invalid repository name: ' + nameWithOwner };
  }
  // path.join(parent, '..') must never escape the clone parent — GitHub can't
  // host dot-only names, so anything matching is a forged renderer payload.
  if (nameWithOwner.split('/').some((seg) => /^\.+$/.test(seg))) {
    return { error: 'Invalid repository name: ' + nameWithOwner };
  }
  const parent = defaultCloneParent();
  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch (e) {
    return { error: 'Could not create clone directory ' + parent + ': ' + e.message };
  }

  const repoName = nameWithOwner.split('/')[1];
  const target = path.join(parent, repoName);

  const adopt = () => {
    const config = loadConfig();
    config.projects = config.projects || [];
    if (!config.projects.some((p) => p && p.path === target)) {
      config.projects.push({ name: repoName, path: target });
      saveConfig(config);
    }
    return { path: target, name: repoName };
  };

  if (fs.existsSync(target)) {
    // Adopt only if it's really a clone of the requested repo — a same-named
    // directory cloned from elsewhere must not be silently adopted (the
    // renderer would then toast success and switch to the wrong codebase).
    if (fs.existsSync(path.join(target, '.git'))) {
      try {
        const { stdout } = await execFileP('git', ['config', '--get', 'remote.origin.url'], {
          cwd: target, timeout: 3000,
        });
        if (remoteMatches(stdout, nameWithOwner)) return adopt();
      } catch { /* no origin — treat as a different repo below */ }
      return { error: target + ' already exists but is a clone of a different repository.' };
    }
    return { error: 'Path already exists and is not a git repo: ' + target };
  }

  try {
    await execFileP('gh', ['repo', 'clone', nameWithOwner, target], {
      timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const tail = ((err.stderr ? String(err.stderr) : '') || err.message || '').trim().split('\n').pop();
    return { error: 'Clone failed: ' + tail };
  }
  return adopt();
});

// Probe each logged-in gh account's token against the GitHub REST API for
// the given PR. Returns the first account that gets a 200 response, or the
// currently-active account as fallback. Used by the picker to auto-switch
// when the user pastes a URL their currently-active account can't see.
//
// Scoped to github.com only — GHE autodetect is on the deferred list because
// account<->host binding needs careful handling (a single `gh` install can
// hold accounts across multiple hosts).
ipcMain.handle('gh-detect-account-for-repo', async (_event, { owner, repo, prNumber }) => {
  if (!owner || !repo || !prNumber) return { error: 'missing owner/repo/prNumber' };
  const { accounts: parsed, error } = readGhAccounts();
  if (parsed.length === 0 && error) return { error };
  // Skip accounts whose tokens gh has already flagged invalid — probing
  // them just wastes an API call that's guaranteed to 401.
  const accounts = parsed.filter((a) => a.valid);
  const active = accounts.find((a) => a.active);
  const activeUsername = active ? active.username : null;

  // Try the active account first so the common case (it works, skip the loop)
  // only costs one round trip.
  const ordered = active ? [active, ...accounts.filter((a) => !a.active)] : accounts.slice();
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prNumber)}`;
  for (const acc of ordered) {
    let token;
    try {
      token = execFileSync('gh', ['auth', 'token', '--user', acc.username], {
        stdio: 'pipe', timeout: 5000,
      }).toString().trim();
    } catch { continue; }
    if (!token) continue;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'klaussy-desktop',
        },
      });
      if (res.status === 200) {
        return { username: acc.username, active: acc.active === true, activeUsername };
      }
    } catch { /* network error — try next account */ }
  }
  // Nothing matched: return the active account so the caller can fall back
  // without switching.
  return { username: activeUsername, active: true, activeUsername, noMatch: true };
});

// Pre-launch dep check: probe gh + claude so a first-run dialog can guide
// the user through setup instead of letting them hit cryptic IPC errors
// downstream when these CLIs are missing or unauthed.
ipcMain.handle('check-dependencies', async () => {
  // Refresh PATH first — when the user clicks Re-check after running the
  // installer, freshly-installed binaries are in $PATH on disk but not yet
  // in our process.env. Lazy-required to avoid an import cycle
  // (app-events → ipc/tasks → ipc/gh).
  try {
    const { refreshSpawnPath } = require('../bootstrap/app-events');
    refreshSpawnPath();
  } catch { /* during early init the bootstrap module may not be ready */ }
  clearGhTokenCache();

  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  // The user's current default agent — the one the installer offers and the
  // one we treat as "primary" for setup. Not hard-required: any installed
  // agent satisfies the setup gate (the renderer checks "≥1 agent installed").
  const defaultProvider = config.defaultProvider || config.defaultMode || 'claude';

  function probe(cmd, args) {
    try {
      const out = execFileSync(cmd, args, { stdio: 'pipe', timeout: 5000 }).toString().trim();
      return { ok: true, output: out };
    } catch (err) {
      return { ok: false, error: (err.stderr ? err.stderr.toString() : err.message).trim() };
    }
  }

  const ghVersion = probe('gh', ['--version']);
  // Don't trust gh's exit code — it returns 1 if any account has a bad
  // token, even when others are fine. Treat gh as authed if at least one
  // account in the parsed status output is valid.
  const ghStatus = ghVersion.ok ? readGhAccounts() : { accounts: [], error: 'gh not installed' };
  const validAccounts = ghStatus.accounts.filter((a) => a.valid);
  const authed = validAccounts.length > 0;
  const claudeVersion = probe(claudeBin, ['--version']);

  // Probe every supported AI CLI so the Setup Check can list install status +
  // a one-line install command per agent (optional — only Claude is required).
  const agents = allProviders().map((p) => {
    const provider = getProvider(p.id);
    const bin = binFor(p.id, config);
    const v = probe(bin, provider.versionArgs);
    const auth = authMetaFor(p.id);
    // authed: true / false when we have a verified status probe, else null
    // (unknown) so the UI doesn't show a false "not signed in".
    // Note: a "not signed in" status often exits non-zero and writes to
    // stderr (e.g. `codex login status` → exit 1, stderr "Not logged in"), so
    // check both streams and don't require a clean exit.
    let authed = null;
    if (v.ok && auth.statusArgs) {
      const s = probe(bin, auth.statusArgs);
      if (s.ok) {
        authed = !auth.notAuthedPattern.test(s.output || '');
      } else if (auth.notAuthedPattern.test(s.error || '')) {
        authed = false;
      }
    }
    return {
      id: p.id,
      name: `${p.displayName} (${p.defaultBin})`,
      installed: v.ok,
      version: v.ok ? v.output.split('\n')[0] : null,
      path: bin,
      isDefault: p.id === defaultProvider, // the user's current default agent
      installCommand: installCommandFor(p.id),
      authed,
      loginCommand: auth.loginCommand,
    };
  });

  return {
    agents,
    // The current default agent — the renderer names it in the install bundle.
    // Any installed agent satisfies setup; this is just which one we'd install.
    defaultProvider,
    // The renderer uses `platform` to pick OS-appropriate install commands
    // (brew vs winget vs apt). We resolve it here rather than have the
    // renderer sniff navigator.platform — cleaner and matches what the rest
    // of the app uses for cross-platform branching.
    platform: process.platform,
    gh: {
      installed: ghVersion.ok,
      authed,
      version: ghVersion.ok ? ghVersion.output.split('\n')[0] : null,
      authError: authed ? null : (ghStatus.error || null),
      accounts: ghStatus.accounts,
    },
    claude: {
      installed: claudeVersion.ok,
      version: claudeVersion.ok ? claudeVersion.output : null,
      path: claudeBin,
    },
  };
});

// One-click "install missing requirements" — writes a per-OS script to a
// temp file and opens the user's system terminal to run it. We deliberately
// run *outside* Klaussy: brew/winget/apt all expect TTY-attached prompts
// (sudo password, OAuth callbacks, license confirms) and the user is used
// to seeing those in their normal terminal.
//
// Each script is idempotent — guarded with `command -v` (or `Get-Command`)
// so re-running it after a partial install just fills in the missing pieces.

// The bundle installs Node, gh, Ollama, and EVERY agent CLI (`agents`: array of
// { displayName, bin, installCommand, loginCommand }) — so whichever agent the
// user picks later already works, with no extra setup. Each agent install is
// guarded (skip if already present) and non-fatal (a single failure doesn't
// abort the rest under `set -e`).
function installScriptMac(agents) {
  const names = agents.map((a) => a.displayName).join(', ');
  const installs = agents.map((a) => `if ! command -v ${a.bin} >/dev/null 2>&1; then
  echo "→ ${a.displayName}: ${a.installCommand}"
  ${a.installCommand} || echo "⚠ ${a.displayName} install failed — retry it later."
fi`).join('\n\n');
  const logins = agents.map((a) => `echo "       • ${a.displayName}: ${a.loginCommand}"`).join('\n');
  return `#!/bin/bash
set -e
echo "Installing Klaussy requirements…"
echo "(Node, GitHub CLI, Ollama + all agent CLIs: ${names} — ~2 GB total, mostly Ollama)"
echo

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Installing…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [ -f /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -f /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
fi

# brew install is idempotent — safe to call on already-installed formulas.
echo "→ brew install node gh ollama"
brew install node gh ollama

# Make brew's bins reachable in this shell before invoking npm —
# fresh installs add to PATH via shell rc files this subshell hasn't sourced.
export PATH="$(brew --prefix 2>/dev/null)/bin:$PATH"
hash -r

${installs}

echo
echo "✓ All requirements installed."
echo
echo "Next steps:"
echo "  1. Run 'gh auth login' to authenticate GitHub (or use Klaussy's Sign in button)"
echo "  2. Sign in to the agent(s) you'll use — run each once:"
${logins}
echo
read -p "Press Enter to close this window…"
`;
}

function installScriptWin(agents) {
  const names = agents.map((a) => a.displayName).join(', ');
  // Per-agent: skip if already on PATH; a failure is caught so it can't abort
  // the rest (ErrorActionPreference is 'Stop').
  const installs = agents.map((a) => `if (-not (Test-Cmd ${a.bin})) {
  Write-Host '→ ${a.displayName}'
  try { ${a.installCommand} } catch { Write-Host "⚠ ${a.displayName} install failed: $_" }
  Sync-Path
}`).join('\n\n');
  const logins = agents.map((a) => `Write-Host '       • ${a.displayName}: ${a.loginCommand}'`).join('\n');
  return `$ErrorActionPreference = 'Stop'
Write-Host 'Installing Klaussy requirements…'
Write-Host '(Node, GitHub CLI, Ollama + all agent CLIs: ${names} — ~2 GB total, mostly Ollama)'
Write-Host ''

function Test-Cmd($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Refresh PATH from registry so Test-Cmd sees anything added by prior installs
# (winget edits machine env, the session doesn't pick that up otherwise).
function Sync-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path','Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path','User')
  $env:Path = "$machine;$user"
}
Sync-Path

Write-Host '→ winget install Node, GitHub CLI, Ollama'
winget install --id OpenJS.NodeJS  -e --accept-source-agreements --accept-package-agreements
winget install --id GitHub.cli     -e --accept-source-agreements --accept-package-agreements
winget install --id Ollama.Ollama  -e --accept-source-agreements --accept-package-agreements

Sync-Path

${installs}

Write-Host ''
Write-Host '✓ All requirements installed.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Run ''gh auth login'' to authenticate GitHub (or use Klaussy''s Sign in button)'
Write-Host '  2. Sign in to the agent(s) you''ll use — run each once:'
${logins}
Write-Host ''
Read-Host 'Press Enter to close this window'
`;
}

function installScriptLinux(agents) {
  const names = agents.map((a) => a.displayName).join(', ');
  // Per-agent: npm-global writes into the apt-installed system node_modules, so
  // it needs root; a script installer (e.g. Antigravity's curl|bash) installs
  // into the user's home (~/.local/bin) and must NOT run under sudo, or it lands
  // in root's home and stays off the user's PATH. Guarded + non-fatal.
  const installs = agents.map((a) => {
    const line = a.installCommand.startsWith('npm ') ? `sudo ${a.installCommand}` : a.installCommand;
    return `if ! command -v ${a.bin} >/dev/null 2>&1; then
  echo "→ ${a.displayName}: ${line}"
  ${line} || echo "⚠ ${a.displayName} install failed — retry it later."
fi`;
  }).join('\n\n');
  const logins = agents.map((a) => `echo "       • ${a.displayName}: ${a.loginCommand}"`).join('\n');
  return `#!/bin/bash
set -e
echo "Installing Klaussy requirements…"
echo "(Node, GitHub CLI, Ollama + all agent CLIs: ${names} — ~2 GB total, mostly Ollama)"
echo "(sudo password may be required)"
echo

echo "→ apt install nodejs, npm, gh"
sudo apt update
sudo apt install -y nodejs npm gh
hash -r

${installs}
hash -r

if ! command -v ollama >/dev/null 2>&1; then
  echo "→ curl … | sh   (official Ollama installer; sudo for the daemon)"
  curl -fsSL https://ollama.com/install.sh | sh
fi

echo
echo "✓ All requirements installed."
echo
echo "Next steps:"
echo "  1. Run 'gh auth login' to authenticate GitHub (or use Klaussy's Sign in button)"
echo "  2. Sign in to the agent(s) you'll use — run each once:"
${logins}
echo
read -p "Press Enter to close this window…"
`;
}

// Resolve EVERY agent CLI the installer should set up. We install them all on
// first run — regardless of the user's current default — so switching agents
// later needs no extra setup. Agents with no known install command are skipped.
function installerAgentsInfo() {
  return allProviders()
    .map((p) => {
      const auth = authMetaFor(p.id) || {};
      return {
        displayName: p.displayName,
        bin: p.defaultBin,
        // Tailored to this host's OS — npm providers get "npm install -g <pkg>";
        // script installers (e.g. Antigravity) get the curl|bash form on
        // mac/Linux and the PowerShell irm|iex form on Windows.
        installCommand: installCommandFor(p.id, process.platform),
        loginCommand: auth.loginCommand || p.defaultBin,
      };
    })
    .filter((a) => a.installCommand);
}

// Pick the first terminal emulator that exists on the user's PATH. Linux
// has no canonical "open a terminal" command — distros ship different
// emulators — so we probe a known list and fall back to xterm.
function findLinuxTerminal() {
  const candidates = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
  for (const term of candidates) {
    try {
      execFileSync('which', [term], { stdio: 'pipe' });
      return term;
    } catch { /* not found, try next */ }
  }
  return null;
}

ipcMain.handle('install-requirements', async () => {
  const platform = process.platform;
  const tmpDir = os.tmpdir();
  const stamp = Date.now();
  const agents = installerAgentsInfo(); // installs every agent CLI, not just the default

  try {
    if (platform === 'darwin') {
      const scriptPath = path.join(tmpDir, `klaussy-install-${stamp}.sh`);
      fs.writeFileSync(scriptPath, installScriptMac(agents), { mode: 0o755 });
      // osascript opens Terminal.app and runs the script in a new tab; the
      // script's trailing `read` keeps the window open for output review.
      spawn('osascript', [
        '-e', `tell application "Terminal" to do script "${scriptPath}"`,
        '-e', 'tell application "Terminal" to activate',
      ], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    }

    if (platform === 'win32') {
      const scriptPath = path.join(tmpDir, `klaussy-install-${stamp}.ps1`);
      fs.writeFileSync(scriptPath, installScriptWin(agents));
      // -NoExit so the window stays open after the script finishes; the
      // empty title argument is required by `start` when the next arg is
      // quoted-looking.
      spawn('cmd', [
        '/c', 'start', '""',
        'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      ], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
      return { ok: true };
    }

    // Linux
    const term = findLinuxTerminal();
    if (!term) {
      return { error: 'No terminal emulator found. Install one of: gnome-terminal, konsole, xterm.' };
    }
    const scriptPath = path.join(tmpDir, `klaussy-install-${stamp}.sh`);
    fs.writeFileSync(scriptPath, installScriptLinux(agents), { mode: 0o755 });
    // gnome-terminal uses `--`, the rest use `-e`. xterm/konsole/xfce4 all
    // accept `-e <command>`; gnome-terminal needs `-- bash <script>`.
    const args = term === 'gnome-terminal' ? ['--', 'bash', scriptPath] : ['-e', `bash ${scriptPath}`];
    spawn(term, args, { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// ---- CI/CD Status (Feature 3) ----

ipcMain.handle('ci-status', async (_event, { worktreePath, branch }) => {
  try {
    const output = ghExec([
      'run', 'list', '--branch', branch, '--limit', '5',
      '--json', 'status,conclusion,name,url,createdAt'
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 10000 }).toString();
    return { runs: JSON.parse(output) };
  } catch (err) {
    return { runs: [], error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('ci-run-logs', async (_event, { worktreePath, runId }) => {
  try {
    const output = ghExec(['run', 'view', String(runId), '--log-failed'], {
      cwd: worktreePath, stdio: 'pipe', timeout: 15000, maxBuffer: 5 * 1024 * 1024
    }).toString();
    return { logs: output };
  } catch (err) {
    return { logs: '', error: err.stderr ? err.stderr.toString() : err.message };
  }
});
