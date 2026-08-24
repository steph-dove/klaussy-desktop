// GitLab CLI (glab) IPC surface: account list, switch account, and installation discovery.

const { execFileSync } = require('child_process');
const { ipcMain } = require('electron');
const { clearGlabTokenCache } = require('../util/glab-exec');

// Parse `glab auth status` output into structured accounts:
// [{ username, hostname, active, valid, reason }]
function parseGlabAuthStatus(text) {
  const accounts = [];
  if (!text) return accounts;

  let currentHost = 'gitlab.com';
  let pending = null;

  const flush = () => {
    if (pending) {
      accounts.push(pending);
      pending = null;
    }
  };

  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Detect standalone host header (e.g. "gitlab.com" or "gitlab.example.com")
    if (/^[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+$/.test(trimmed)) {
      currentHost = trimmed;
      continue;
    }

    // Match "Logged in to <host> as <user>" or "Failed to log in to <host> as <user>"
    const loginMatch = trimmed.match(/(?:[✓X\s]+)?(?:Logged in to|Failed to log in to)\s+(\S+)\s+(?:account\s+|as\s+)?([A-Za-z0-9_.-]+)/i);
    if (loginMatch) {
      flush();
      const host = loginMatch[1];
      const username = loginMatch[2];
      const valid = !/failed|invalid/i.test(trimmed);
      pending = {
        username,
        hostname: host,
        active: false,
        valid,
        reason: null,
      };
      continue;
    }

    if (pending) {
      if (/Active account:\s*true/i.test(trimmed)) {
        pending.active = true;
      }
      if (/token.*invalid/i.test(trimmed)) {
        pending.valid = false;
        pending.reason = 'Token is invalid';
      } else if (/token.*expired/i.test(trimmed)) {
        pending.valid = false;
        pending.reason = 'Token expired';
      }
    }
  }

  flush();
  return accounts;
}

function readGlabAccounts() {
  try {
    const out = execFileSync('glab', ['auth', 'status'], {
      stdio: 'pipe',
      timeout: 5000,
    }).toString();
    return { accounts: parseGlabAuthStatus(out), error: null };
  } catch (err) {
    const merged = [
      err.stdout ? err.stdout.toString() : '',
      err.stderr ? err.stderr.toString() : '',
    ].join('\n');
    const accounts = parseGlabAuthStatus(merged);
    if (accounts.length > 0) return { accounts, error: null };
    return { accounts: [], error: (err.stderr ? err.stderr.toString() : err.message).trim() };
  }
}

ipcMain.handle('glab-list-accounts', async () => {
  return readGlabAccounts();
});

ipcMain.handle('glab-switch-account', async (_event, { username, hostname }) => {
  if (!username) return { error: 'Missing username' };
  const host = hostname || 'gitlab.com';
  try {
    execFileSync('glab', ['auth', 'switch', '--hostname', host, '--user', username], {
      stdio: 'pipe',
      timeout: 5000,
    });
    clearGlabTokenCache();
    return { ok: true };
  } catch (err) {
    return { error: (err.stderr ? err.stderr.toString() : err.message).trim() };
  }
});

module.exports = {
  parseGlabAuthStatus,
  readGlabAccounts,
};
