// Background-agent registry. Tracks every backgroundable Claude streaming
// request so the renderer can navigate away from the originating surface,
// see the agent in the global "Agents" panel, and re-attach to it later
// (live chunks while running, accumulated text when complete).
//
// Lifecycle is owned here, not by the originating webContents:
//   * register() is called by spawnClaudeStream when agentMeta is provided.
//   * appendText / markDone / markError / markCancelled mutate the record
//     and fan out an `agents-changed` broadcast to every BrowserWindow.
//   * cancel() looks up the proc and SIGTERMs it; the proc's exit handler
//     calls markCancelled, which fires the broadcast.
//
// Records keep accumulated stdout in `text` so a renderer that mounts
// after the stream started can render the catch-up content immediately
// without waiting for new chunks.
//
// In-memory only; FIFO eviction keeps completed records under MAX_COMPLETED.

const MAX_COMPLETED = 50;

// Map<agentId, AgentRecord>
//   id, kind, status: 'running'|'done'|'error'|'cancelled',
//   text (accumulated stdout), error?, payload? (extraDoneFields),
//   startedAt, finishedAt?, sourceContext, dedupeKey,
//   channelPrefix, isStreamJson, read (true once user has viewed it),
//   _proc (private, never serialized)
const agents = new Map();

// Lazy import to avoid require cycle (windows.js doesn't import this, but
// any future code that does will appreciate the deferred resolution).
let _windows = null;
function getAllWindows() {
  if (!_windows) _windows = require('./windows');
  return _windows.allWindows;
}

function broadcast(channel, payload) {
  const wins = getAllWindows();
  for (const win of wins) {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function serialize(record) {
  if (!record) return null;
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    text: record.text,
    error: record.error || null,
    payload: record.payload || null,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt || null,
    sourceContext: record.sourceContext || null,
    dedupeKey: record.dedupeKey || null,
    channelPrefix: record.channelPrefix,
    isStreamJson: !!record.isStreamJson,
    read: !!record.read,
  };
}

function listSerialized() {
  return Array.from(agents.values()).map(serialize);
}

function fanout() {
  broadcast('agents-changed', listSerialized());
}

// Drop oldest completed records until we're at or below MAX_COMPLETED.
// Running agents are never evicted.
function evictCompleted() {
  const completed = Array.from(agents.values())
    .filter((r) => r.status !== 'running')
    .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
  while (completed.length > MAX_COMPLETED) {
    const dropped = completed.shift();
    agents.delete(dropped.id);
  }
}

function register({ id, kind, channelPrefix, sourceContext, dedupeKey, isStreamJson, proc }) {
  const record = {
    id,
    kind,
    status: 'running',
    text: '',
    error: null,
    payload: null,
    startedAt: Date.now(),
    finishedAt: null,
    sourceContext: sourceContext || null,
    dedupeKey: dedupeKey || null,
    channelPrefix,
    isStreamJson: !!isStreamJson,
    read: false,
    _proc: proc,
  };
  agents.set(id, record);
  fanout();
  return record;
}

function appendText(id, chunk) {
  const r = agents.get(id);
  if (!r || r.status !== 'running') return;
  r.text += chunk;
  // Don't broadcast `agents-changed` per chunk — that would re-render the
  // panel on every token. Live chunks reach consumers via the existing
  // per-id chunk channel (broadcast from claude-streaming.js). The panel
  // only cares about status transitions.
}

function markDone(id, payload) {
  const r = agents.get(id);
  if (!r) return;
  r.status = 'done';
  r.payload = payload || null;
  r.finishedAt = Date.now();
  r._proc = null;
  evictCompleted();
  fanout();
}

function markError(id, error) {
  const r = agents.get(id);
  if (!r) return;
  r.status = 'error';
  r.error = error || 'Unknown error';
  r.finishedAt = Date.now();
  r._proc = null;
  evictCompleted();
  fanout();
}

function markCancelled(id) {
  const r = agents.get(id);
  if (!r) return;
  r.status = 'cancelled';
  r.finishedAt = Date.now();
  r._proc = null;
  evictCompleted();
  fanout();
}

function cancel(id) {
  const r = agents.get(id);
  if (!r) return false;
  if (r._proc && !r._proc.killed) {
    try { r._proc.kill('SIGTERM'); } catch { /* already dead */ }
  }
  // markCancelled fires from the proc.exit handler in claude-streaming.js.
  return true;
}

function get(id) {
  return serialize(agents.get(id));
}

function list() {
  return listSerialized();
}

function findByDedupeKey(key) {
  if (!key) return null;
  for (const r of agents.values()) {
    if (r.dedupeKey === key) return serialize(r);
  }
  return null;
}

function markRead(id) {
  const r = agents.get(id);
  if (!r || r.read) return;
  r.read = true;
  fanout();
}

function markAllRead() {
  let changed = false;
  for (const r of agents.values()) {
    if (!r.read) { r.read = true; changed = true; }
  }
  if (changed) fanout();
}

function clearCompleted() {
  let changed = false;
  for (const [id, r] of agents) {
    if (r.status !== 'running') { agents.delete(id); changed = true; }
  }
  if (changed) fanout();
}

module.exports = {
  register,
  appendText,
  markDone,
  markError,
  markCancelled,
  cancel,
  get,
  list,
  findByDedupeKey,
  markRead,
  markAllRead,
  clearCompleted,
};
