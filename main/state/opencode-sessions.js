// opencode exact-resume: sessions live in SQLite (no tailable .jsonl), queried
// via `session list`. Shells out synchronously — use only on user-initiated
// resume/restart, never the 10s autosave loop; failures yield [] (degrade clean).
const { execFileSync } = require('child_process');

// `opencode session list` prints a table; each data row starts with the session
// id token (`ses_…`) and rows are ordered newest-updated first. Parse the ids in
// that order, tolerating the header/rule lines (which don't match).
function parseSessionIds(stdout) {
  const ids = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^\s*(ses_[A-Za-z0-9]+)\b/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

// Session ids for the opencode project rooted at worktreePath, newest-first.
// opencode scopes `session list` to the cwd's project, so we run it there.
function listSessionIds(bin, worktreePath) {
  if (!bin || !worktreePath) return [];
  try {
    const out = execFileSync(bin, ['session', 'list'], {
      cwd: worktreePath,
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseSessionIds(out.toString());
  } catch {
    // Not installed / not authed / no project / timeout — resume degrades to a
    // fresh (or --continue) session rather than surfacing an error.
    return [];
  }
}

// The most recently updated session in this worktree, or null if none.
function latestSession(bin, worktreePath) {
  const ids = listSessionIds(bin, worktreePath);
  return ids.length ? ids[0] : null;
}

module.exports = { parseSessionIds, listSessionIds, latestSession };
