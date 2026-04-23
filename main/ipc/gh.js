// GitHub CLI surface: account list/switch/detect, CI status and logs,
// dependency probe, and the scheme-restricted external URL opener.

const { execFileSync } = require('child_process');
const { ipcMain, shell } = require('electron');
const { loadConfig } = require('../util/config');
const { ghExec, clearGhTokenCache } = require('../util/exec');

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

// Parse `gh auth status` to surface authed accounts + which one is active.
// gh's output looks like:
//   github.com
//     ✓ Logged in to github.com account stephanie913 (keyring)
//       - Active account: true
//   ...
// We just need (account, isActive) per host.
ipcMain.handle('gh-list-accounts', async () => {
  try {
    const out = execFileSync('gh', ['auth', 'status'], { stdio: 'pipe', timeout: 5000 }).toString();
    const lines = out.split('\n');
    const accounts = [];
    let pending = null;
    for (const raw of lines) {
      const m = raw.match(/account\s+([^\s]+)/);
      if (m) {
        if (pending) accounts.push(pending);
        pending = { username: m[1], active: false };
        continue;
      }
      if (pending && /Active account:\s*true/.test(raw)) pending.active = true;
    }
    if (pending) accounts.push(pending);
    return { accounts };
  } catch (err) {
    return { accounts: [], error: (err.stderr ? err.stderr.toString() : err.message).trim() };
  }
});

ipcMain.handle('gh-switch-account', async (_event, { username }) => {
  if (!username) return { error: 'Missing username' };
  try {
    execFileSync('gh', ['auth', 'switch', '-u', username], { stdio: 'pipe', timeout: 5000 });
    // Drop cached owner→token entries so next gh call re-reads from the
    // freshly switched account.
    clearGhTokenCache();
    return { ok: true };
  } catch (err) {
    return { error: (err.stderr ? err.stderr.toString() : err.message).trim() };
  }
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
  let accounts = [];
  let activeUsername = null;
  try {
    const out = execFileSync('gh', ['auth', 'status'], { stdio: 'pipe', timeout: 5000 }).toString();
    let pending = null;
    for (const raw of out.split('\n')) {
      const m = raw.match(/account\s+([^\s]+)/);
      if (m) {
        if (pending) accounts.push(pending);
        pending = { username: m[1], active: false };
        continue;
      }
      if (pending && /Active account:\s*true/.test(raw)) pending.active = true;
    }
    if (pending) accounts.push(pending);
  } catch (err) {
    return { error: (err.stderr ? err.stderr.toString() : err.message).trim() };
  }
  const active = accounts.find((a) => a.active);
  activeUsername = active ? active.username : null;

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
  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';

  function probe(cmd, args) {
    try {
      const out = execFileSync(cmd, args, { stdio: 'pipe', timeout: 5000 }).toString().trim();
      return { ok: true, output: out };
    } catch (err) {
      return { ok: false, error: (err.stderr ? err.stderr.toString() : err.message).trim() };
    }
  }

  const ghVersion = probe('gh', ['--version']);
  const ghAuth = ghVersion.ok ? probe('gh', ['auth', 'status']) : { ok: false, error: 'gh not installed' };
  const claudeVersion = probe(claudeBin, ['--version']);

  return {
    gh: {
      installed: ghVersion.ok,
      authed: ghAuth.ok,
      version: ghVersion.ok ? ghVersion.output.split('\n')[0] : null,
      authError: ghAuth.ok ? null : ghAuth.error,
    },
    claude: {
      installed: claudeVersion.ok,
      version: claudeVersion.ok ? claudeVersion.output : null,
      path: claudeBin,
    },
  };
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
