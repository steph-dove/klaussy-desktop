// Applies a chat response to the agent that asked for it: an Approve/Reject
// button click, or a freeform line typed back in Slack/Discord.
//
// Everything here is reached from a network socket, so each entry point
// re-checks that the responder is allowed and that the session is still alive.

const { redeem, revokeForTask } = require('./approval-registry');
const { pastePromptInto } = require('./agent-prompt');

const DEFAULT_APPROVE_KEYS = 'y\r';
const DEFAULT_REJECT_KEYS = 'n\r';

// Slack caps a button label at 75 chars and Discord at 80; option text can be a
// whole sentence.
const OPTION_LABEL_MAX = 70;
// Slack allows 25 elements in an actions block and Discord 25 buttons, but a
// wall of buttons is unreadable — and a menu that long wants the real terminal.
const MAX_OPTIONS = 5;

// A TUI prints this under a selection menu; its presence is what makes a
// numbered list selectable rather than prose.
const SELECTION_FOOTER = /(enter to select|esc to cancel|↑\/↓)/i;
const MENU_LOOKBACK_LINES = 30;

// Only the lines just above the footer: agents write numbered prose constantly,
// and a stale footer elsewhere in the buffer would turn that list into buttons.
function menuRegion(tail) {
  const lines = String(tail || '').split('\n');
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SELECTION_FOOTER.test(lines[i])) { footer = i; break; }
  }
  if (footer === -1) return [];
  return lines.slice(Math.max(0, footer - MENU_LOOKBACK_LINES), footer);
}

// Only option-shaped lines count, so numbered prose doesn't become buttons.
function parsePromptOptions(tail) {
  const seen = new Map();
  for (const line of menuRegion(tail)) {
    // A repaint can lay out columns with cursor moves rather than spaces, so the
    // space is optional; the label may not start with a digit, or "1.5 seconds"
    // would read as option 1.
    const m = line.match(/^\s*[❯>»*]?\s*(\d{1,2})[.)]\s*(?!\d)(\S.*)$/);
    if (!m) continue;
    const key = m[1];
    const label = m[2].trim().replace(/\s+/g, ' ');
    // A repainting TUI shows the same option many times; keep the first.
    if (!seen.has(key)) seen.set(key, { key, label: label.slice(0, OPTION_LABEL_MAX) });
  }
  const all = [...seen.values()];
  // Reported, not inferred from the length: exactly MAX_OPTIONS is complete.
  return { options: all.slice(0, MAX_OPTIONS), truncated: all.length > MAX_OPTIONS };
}

// Toggle-style prompts need several keystrokes and a confirm, which a single
// button can't express — better to say so than to send one wrong key.
function isMultiSelect(tail) {
  return /space to (toggle|select)/i.test(String(tail || ''));
}

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

// Shared gate for every button click; returns { error } or { claim, inst }.
function claimForClick({ token, userId, allowList }) {
  if (!isAllowed(userId, allowList)) {
    return { error: { ok: false, reason: 'not-allowed', message: 'You are not on this Klaussy approval allow-list.' } };
  }
  const claim = redeem(token);
  if (!claim.ok) {
    const message = claim.reason === 'expired'
      ? 'That request expired — answer it in Klaussy instead.'
      : 'That request was already answered.';
    return { error: { ok: false, reason: claim.reason, message } };
  }
  const inst = liveInstance(claim.taskId);
  if (!inst) {
    return { error: { ok: false, reason: 'gone', message: 'That session is no longer running.' } };
  }
  return { claim, inst };
}

// Resolve a yes/no button click. Returns a result the caller renders into chat.
function applyDecision({ token, decision, userId, allowList }) {
  const { error, claim, inst } = claimForClick({ token, userId, allowList });
  if (error) return error;
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

// The key is checked against the options that were actually offered, so a
// redeemed token can only press what was on screen.
function applyChoice({ token, key, userId, allowList }) {
  const { error, claim, inst } = claimForClick({ token, userId, allowList });
  if (error) return error;
  const option = (claim.options || []).find((o) => o.key === String(key));
  if (!option) {
    return { ok: false, reason: 'unknown-option', message: 'That option is no longer on offer.' };
  }
  try {
    inst.pty.write(option.key);
  } catch (err) {
    return { ok: false, reason: 'write-failed', message: 'Could not reach that session: ' + err.message };
  }
  revokeForTask(claim.taskId);
  return { ok: true, taskId: claim.taskId, choice: option, message: `Chose “${option.label}”` };
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

module.exports = {
  applyDecision, applyChoice, applyText,
  isAllowed, sanitizeForPaste, keysForPrompt, parsePromptOptions, isMultiSelect,
  MAX_OPTIONS,
};
