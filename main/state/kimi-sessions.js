// Kimi Code exact-resume. Sessions are bucketed by workdir on disk, but every
// one is also appended to a flat ~/.kimi-code/session_index.jsonl as
// {sessionId, sessionDir, workDir} — cheaper to read than shelling out to the
// CLI, and it works while signed out.
const fs = require('fs');
const path = require('path');
const { getProvider } = require('./ai-providers');

// Mirrors kimi's own normalizeWorkDir (path.resolve, plus forward slashes on
// Windows); diverge from it and the comparison below silently matches nothing.
function normalizeWorkDir(workDir) {
  if (/^[A-Za-z]:[\\/]/.test(workDir) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(workDir)) {
    return path.win32.resolve(workDir).replace(/\\/g, '/');
  }
  return path.resolve(workDir);
}

// Session ids recorded for `worktreePath`, oldest-first — the index is an
// append log, so its order is creation order.
function parseSessionIds(indexText, worktreePath) {
  const target = normalizeWorkDir(worktreePath);
  const ids = [];
  for (const line of String(indexText || '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry.sessionId !== 'string' || typeof entry.workDir !== 'string') continue;
    if (normalizeWorkDir(entry.workDir) !== target) continue;
    ids.push(entry.sessionId);
  }
  return ids;
}

function listSessionIds(worktreePath, home) {
  if (!worktreePath) return [];
  const kimiHome = home || getProvider('kimi').sessionDir();
  try {
    return parseSessionIds(fs.readFileSync(path.join(kimiHome, 'session_index.jsonl'), 'utf8'), worktreePath);
  } catch {
    // Not installed / never run / unreadable: resume degrades to `--continue`.
    return [];
  }
}

function latestSession(worktreePath, home) {
  const ids = listSessionIds(worktreePath, home);
  return ids.length ? ids[ids.length - 1] : null;
}

module.exports = { parseSessionIds, listSessionIds, latestSession, normalizeWorkDir };
