// Copilot's sessions are global, so a worktree's own is found by the cwd in each workspace.yaml.
const fs = require('fs');
const path = require('path');
const os = require('os');

function defaultStateDir() {
  return path.join(process.env.HOME || os.homedir(), '.copilot', 'session-state');
}

function yamlScalar(text, key) {
  const m = String(text || '').match(new RegExp('^' + key + ':[ \\t]*(.*)$', 'm'));
  if (!m) return null;
  const raw = m[1].trim();
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw); } catch { return null; }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

// Copilot records /var or /private/var depending on how it was started.
function samePath(a, b) {
  if (!a || !b) return false;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return path.resolve(a) === path.resolve(b) || real(a) === real(b);
}

function listSessions(worktreePath, stateDir) {
  if (!worktreePath) return [];
  const dir = stateDir || defaultStateDir();
  let ids;
  try { ids = fs.readdirSync(dir); } catch { return []; }
  const found = [];
  for (const id of ids) {
    let text;
    try { text = fs.readFileSync(path.join(dir, id, 'workspace.yaml'), 'utf8'); } catch { continue; }
    if (!samePath(yamlScalar(text, 'cwd'), worktreePath)) continue;
    // A session with no events was abandoned at the trust prompt; nothing to resume.
    const filePath = path.join(dir, id, 'events.jsonl');
    if (!fs.existsSync(filePath)) continue;
    const updated = Date.parse(yamlScalar(text, 'updated_at') || '') || 0;
    found.push({ sessionId: yamlScalar(text, 'id') || id, filePath, updated });
  }
  return found.sort((a, b) => b.updated - a.updated);
}

function latestSession(worktreePath, stateDir) {
  const sessions = listSessions(worktreePath, stateDir);
  return sessions.length ? sessions[0].sessionId : null;
}

function snapshotSessionIds(stateDir) {
  try { return new Set(fs.readdirSync(stateDir || defaultStateDir())); } catch { return new Set(); }
}

function findNewSession(worktreePath, preSpawn, stateDir) {
  const fresh = listSessions(worktreePath, stateDir).find((s) => !(preSpawn && preSpawn.has(s.sessionId)));
  return fresh ? { sessionId: fresh.sessionId, filePath: fresh.filePath } : null;
}

module.exports = { listSessions, latestSession, snapshotSessionIds, findNewSession, yamlScalar };
