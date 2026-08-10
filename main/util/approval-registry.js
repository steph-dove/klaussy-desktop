// Correlates a chat button click back to the agent session that asked for
// permission. A click carries only an opaque token, so a channel member cannot
// approve an arbitrary session by editing the payload — the token must have
// been minted here, for that session, and not used yet.

const crypto = require('crypto');

// Long enough that a prompt left overnight stops being answerable, short enough
// that a stale button can't approve a step the agent has long since moved past.
const DEFAULT_TTL_MS = 30 * 60 * 1000;

const pending = new Map(); // token -> { taskId, tool, createdAt, expiresAt }

// What the prompt looked like when the token was minted. A token names only a
// session, so without this it answers whatever that session happens to be asking
// when the button is finally pressed.
function fingerprint(text) {
  const prompt = String(text || '').replace(/\s+/g, ' ').trim();
  if (!prompt) return '';
  return crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 16);
}

function issue(taskId, tool, {
  ttlMs = DEFAULT_TTL_MS, approveKeys = '', rejectKeys = '', options = [], prompt = '',
} = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  // Prompts that are never clicked would otherwise sit here forever; minting is
  // rare enough that sweeping on each one costs nothing.
  sweepExpired(now);
  // A session asks one question at a time, so an older token for it points at a
  // question that has been answered or moved past.
  revokeForTask(taskId);
  // Task ids arrive as a number from instances.js and as a string from a
  // normalized event's containerId. Store one canonical form or revokeForTask
  // silently matches nothing.
  pending.set(token, {
    token, taskId: String(taskId), tool: tool || '',
    approveKeys, rejectKeys, options, prompt: fingerprint(prompt),
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
    options: entry.options,
    prompt: entry.prompt,
  };
}

// True when the screen still shows the question this token was minted for. An
// empty fingerprint on either side means we never had one to compare, and the
// answer stands on the session alone as it did before.
function stillAsking(claim, currentPrompt) {
  if (!claim || !claim.prompt) return true;
  const now = fingerprint(currentPrompt);
  if (!now) return true;
  return claim.prompt === now;
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

module.exports = {
  issue, redeem, revokeForTask, sweepExpired, size, fingerprint, stillAsking, DEFAULT_TTL_MS, _reset,
};
