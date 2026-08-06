// Correlates a chat button click back to the agent session that asked for
// permission. A click carries only an opaque token, so a channel member cannot
// approve an arbitrary session by editing the payload — the token must have
// been minted here, for that session, and not used yet.

const crypto = require('crypto');

// Long enough that a prompt left overnight stops being answerable, short enough
// that a stale button can't approve a step the agent has long since moved past.
const DEFAULT_TTL_MS = 30 * 60 * 1000;

const pending = new Map(); // token -> { taskId, tool, createdAt, expiresAt }

function issue(taskId, tool, { ttlMs = DEFAULT_TTL_MS, approveKeys = '', rejectKeys = '' } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  // Prompts that are never clicked would otherwise sit here forever; minting is
  // rare enough that sweeping on each one costs nothing.
  sweepExpired(now);
  // Task ids arrive as a number from instances.js and as a string from a
  // normalized event's containerId. Store one canonical form or revokeForTask
  // silently matches nothing.
  pending.set(token, {
    token, taskId: String(taskId), tool: tool || '',
    approveKeys, rejectKeys,
    createdAt: now, expiresAt: now + ttlMs,
  });
  return token;
}

// Single-use: the entry is removed on the first successful redeem, so a second
// click (or a replayed payload) reports 'used' rather than acting again.
function redeem(token) {
  const entry = pending.get(token);
  if (!entry) return { ok: false, reason: 'unknown' };
  pending.delete(token);
  if (Date.now() > entry.expiresAt) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    taskId: entry.taskId,
    tool: entry.tool,
    approveKeys: entry.approveKeys,
    rejectKeys: entry.rejectKeys,
  };
}

// Drop every outstanding token for a session — called when the agent exits or
// the prompt resolves locally, so a button in chat can't answer a dead prompt.
function revokeForTask(taskId) {
  const key = String(taskId);
  for (const [token, entry] of pending) {
    if (entry.taskId === key) pending.delete(token);
  }
}

function sweepExpired(now = Date.now()) {
  for (const [token, entry] of pending) {
    if (now > entry.expiresAt) pending.delete(token);
  }
}

function size() { return pending.size; }

function _reset() { pending.clear(); }

module.exports = { issue, redeem, revokeForTask, sweepExpired, size, DEFAULT_TTL_MS, _reset };
