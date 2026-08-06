// Applies a chat response to the agent that asked for it: an Approve/Reject
// button click, or a freeform line typed back in Slack/Discord.
//
// Everything here is reached from a network socket, so each entry point
// re-checks that the responder is allowed and that the session is still alive.

const { redeem, revokeForTask } = require('./approval-registry');
const { pastePromptInto } = require('./agent-prompt');

const DEFAULT_APPROVE_KEYS = 'y\r';
const DEFAULT_REJECT_KEYS = 'n\r';

// Claude Code draws a numbered menu where 'y' does nothing, while other agents
// take a literal y/n — so read the answer off the prompt that was on screen.
function keysForPrompt(tail) {
  const s = String(tail || '');
  const yes = s.match(/(\d)[.)]\s*Yes\b/i);
  if (!yes) return { approveKeys: DEFAULT_APPROVE_KEYS, rejectKeys: DEFAULT_REJECT_KEYS };
  const no = s.match(/(\d)[.)]\s*No\b/i);
  // A menu option is chosen by its digit alone — no Enter, which would fall
  // through to whatever prompt comes next. ESC cancels when there is no No.
  return { approveKeys: yes[1], rejectKeys: no ? no[1] : '\x1b' };
}

// A literal ESC would close bracketed paste early, leaving the rest to arrive
// as raw keystrokes; tabs/newlines stay since pasted snippets need them.
function sanitizeForPaste(text) {
  return String(text || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
    .trim();
}

// Required to act. An empty allow-list means nobody, not everybody: these
// credentials sit in a shared channel, so the safe default is to deny until the
// user names who may drive their machine.
function isAllowed(userId, allowList) {
  if (!Array.isArray(allowList) || allowList.length === 0) return false;
  return allowList.includes(String(userId));
}

// The isAgentInstance check is load-bearing: a converted tab keeps its id and
// alive flag but runs a login shell, where a reply would execute as a command.
function liveInstance(taskId) {
  const { instances, isAgentInstance } = require('../state/instances');
  const inst = instances.get(Number(taskId));
  if (!inst || !inst.alive || !inst.pty) return null;
  if (!isAgentInstance(inst)) return null;
  return inst;
}

// Resolve a button click. Returns a result the caller renders back into chat.
function applyDecision({ token, decision, userId, allowList }) {
  if (!isAllowed(userId, allowList)) {
    return { ok: false, reason: 'not-allowed', message: 'You are not on this Klaussy approval allow-list.' };
  }
  const claim = redeem(token);
  if (!claim.ok) {
    const message = claim.reason === 'expired'
      ? 'That request expired — approve it in Klaussy instead.'
      : 'That request was already answered.';
    return { ok: false, reason: claim.reason, message };
  }
  const inst = liveInstance(claim.taskId);
  if (!inst) {
    return { ok: false, reason: 'gone', message: 'That session is no longer running.' };
  }
  try {
    const keys = decision === 'approve'
      ? (claim.approveKeys || DEFAULT_APPROVE_KEYS)
      : (claim.rejectKeys || DEFAULT_REJECT_KEYS);
    inst.pty.write(keys);
  } catch (err) {
    return { ok: false, reason: 'write-failed', message: 'Could not reach that session: ' + err.message };
  }
  // The prompt is answered, so any other outstanding button for this session
  // now points at a question that no longer exists.
  revokeForTask(claim.taskId);
  return {
    ok: true,
    decision,
    taskId: claim.taskId,
    tool: claim.tool,
    message: decision === 'approve' ? 'Approved' : 'Rejected',
  };
}

// Send a freeform line to a session's agent. Used for chat replies and for
// answering prompts that want something other than y/n.
function applyText({ taskId, text, userId, allowList }) {
  if (!isAllowed(userId, allowList)) {
    return { ok: false, reason: 'not-allowed', message: 'You are not on this Klaussy approval allow-list.' };
  }
  const body = sanitizeForPaste(text);
  if (!body) return { ok: false, reason: 'empty', message: 'Nothing to send.' };
  const inst = liveInstance(taskId);
  if (!inst) return { ok: false, reason: 'gone', message: 'That session is no longer running.' };
  try {
    pastePromptInto(inst.pty, body);
  } catch (err) {
    return { ok: false, reason: 'write-failed', message: 'Could not reach that session: ' + err.message };
  }
  return { ok: true, taskId, message: 'Sent to the agent.' };
}

module.exports = { applyDecision, applyText, isAllowed, sanitizeForPaste, keysForPrompt };
