// GitHub CLI surface: account list/switch/detect, CI status and logs,
// dependency probe, and the scheme-restricted external URL opener.

const { execFileSync, spawn } = require('child_process');
const { ipcMain, shell, BrowserWindow } = require('electron');
const { loadConfig } = require('../util/config');
const { ghExec, clearGhTokenCache } = require('../util/exec');

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
  // Don't trust gh's exit code — it returns 1 if any account has a bad
  // token, even when others are fine. Treat gh as authed if at least one
  // account in the parsed status output is valid.
  const ghStatus = ghVersion.ok ? readGhAccounts() : { accounts: [], error: 'gh not installed' };
  const validAccounts = ghStatus.accounts.filter((a) => a.valid);
  const authed = validAccounts.length > 0;
  const claudeVersion = probe(claudeBin, ['--version']);

  return {
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
