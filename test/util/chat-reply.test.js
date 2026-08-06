require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyDecision, applyText, isAllowed } = require('../../main/util/chat-reply');
const registry = require('../../main/util/approval-registry');

test('an empty allow-list denies everyone', () => {
  // The dangerous default would be "unset means anyone"; assert it is not.
  assert.equal(isAllowed('U123', []), false);
  assert.equal(isAllowed('U123', undefined), false);
  assert.equal(isAllowed('U123', null), false);
});

test('only listed ids are allowed', () => {
  assert.equal(isAllowed('U123', ['U123']), true);
  assert.equal(isAllowed('U999', ['U123']), false);
  // Discord ids arrive as numbers in some payloads; compare as strings.
  assert.equal(isAllowed(123456, ['123456']), true);
});

test('a click from a non-allow-listed user never redeems the token', () => {
  registry._reset();
  const token = registry.issue(1, 'shell-exec');
  const res = applyDecision({ token, decision: 'approve', userId: 'U999', allowList: ['U123'] });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-allowed');
  // The token must survive so the rightful approver can still use it.
  assert.equal(registry.redeem(token).ok, true, 'token was not consumed');
});

test('an expired token reports expiry rather than acting', () => {
  registry._reset();
  const token = registry.issue(1, 'tool', { ttlMs: -1 });
  const res = applyDecision({ token, decision: 'approve', userId: 'U1', allowList: ['U1'] });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'expired');
  assert.match(res.message, /expired/i);
});

test('a second click on a consumed token is refused', () => {
  registry._reset();
  const token = registry.issue(999999, 'tool'); // no such live session
  applyDecision({ token, decision: 'approve', userId: 'U1', allowList: ['U1'] });
  const again = applyDecision({ token, decision: 'approve', userId: 'U1', allowList: ['U1'] });
  assert.equal(again.ok, false);
  assert.match(again.message, /already answered/i);
});

test('a click for a session that is gone fails cleanly', () => {
  registry._reset();
  const token = registry.issue(999999, 'tool');
  const res = applyDecision({ token, decision: 'approve', userId: 'U1', allowList: ['U1'] });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'gone');
});

test('text replies honour the allow-list and reject empty input', () => {
  assert.equal(applyText({ taskId: 1, text: 'hi', userId: 'U9', allowList: ['U1'] }).reason, 'not-allowed');
  assert.equal(applyText({ taskId: 1, text: '   ', userId: 'U1', allowList: ['U1'] }).reason, 'empty');
});

// After an agent exits, convertInstanceToShell reuses the same instance id and
// marks it alive with a login shell attached. Routing a reply there would run
// the text as a shell command, so a converted tab must look dead to chat.
test('a session converted to a shell no longer accepts chat input', () => {
  const { instances } = require('../../main/state/instances');
  const written = [];
  instances.set(4242, {
    id: 4242, alive: true, mode: 'shell', originalMode: 'claude',
    pty: { write: (d) => written.push(d) },
  });
  try {
    const res = applyText({ taskId: 4242, text: 'rm -rf /', userId: 'U1', allowList: ['U1'] });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'gone');
    assert.deepEqual(written, [], 'nothing reached the shell');
  } finally {
    instances.delete(4242);
  }
});

test('a live agent session does accept chat input', () => {
  const { instances } = require('../../main/state/instances');
  const written = [];
  instances.set(4243, {
    id: 4243, alive: true, mode: 'claude', originalMode: 'claude',
    pty: { write: (d) => written.push(d) },
  });
  try {
    const res = applyText({ taskId: 4243, text: 'proceed', userId: 'U1', allowList: ['U1'] });
    assert.equal(res.ok, true);
    assert.ok(written.join('').includes('proceed'), 'text reached the agent');
  } finally {
    instances.delete(4243);
  }
});

test('control characters cannot escape bracketed paste', () => {
  const { sanitizeForPaste } = require('../../main/util/chat-reply');
  // A literal ESC would close paste mode early and leave the rest as keystrokes.
  const out = sanitizeForPaste('safe\x1b[201~rm -rf /\x07');
  assert.ok(!out.includes('\x1b'), 'ESC stripped');
  assert.ok(!out.includes('\x07'), 'BEL stripped');
  assert.equal(out, 'safe[201~rm -rf /');
  // Ordinary whitespace in a pasted snippet survives.
  assert.equal(sanitizeForPaste('a\tb\nc'), 'a\tb\nc');
});

// The bug this covers: Claude Code asks with a numbered menu, so the 'y' that
// answers a (y/n) prompt does nothing and the agent just sits there.
test('a numbered menu is answered with its digit, not y', () => {
  const { keysForPrompt } = require('../../main/util/chat-reply');
  const claudeMenu = [
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. Yes, and don\'t ask again for Bash commands',
    '  3. No, and tell Claude what to do differently',
  ].join('\n');
  const keys = keysForPrompt(claudeMenu);
  assert.equal(keys.approveKeys, '1');
  assert.equal(keys.rejectKeys, '3');
  assert.ok(!keys.approveKeys.includes('\r'), 'a menu selects on the digit alone');
});

test('a y/n prompt still gets y/n with Enter', () => {
  const { keysForPrompt } = require('../../main/util/chat-reply');
  const keys = keysForPrompt('Overwrite the file? (y/n)');
  assert.equal(keys.approveKeys, 'y\r');
  assert.equal(keys.rejectKeys, 'n\r');
});

test('a menu with no explicit No rejects with escape', () => {
  const { keysForPrompt } = require('../../main/util/chat-reply');
  const keys = keysForPrompt('Proceed?\n 1. Yes\n 2. Yes, always');
  assert.equal(keys.approveKeys, '1');
  assert.equal(keys.rejectKeys, '\x1b');
});

test('the decided keystrokes are what actually reach the pty', () => {
  registry._reset();
  const { instances } = require('../../main/state/instances');
  const written = [];
  instances.set(5150, {
    id: 5150, alive: true, mode: 'claude', originalMode: 'claude',
    pty: { write: (d) => written.push(d) },
  });
  try {
    const token = registry.issue(5150, 'Bash', { approveKeys: '1', rejectKeys: '3' });
    const res = applyDecision({ token, decision: 'approve', userId: 'U1', allowList: ['U1'] });
    assert.equal(res.ok, true);
    assert.deepEqual(written, ['1'], 'the menu digit, not "y\\r"');
  } finally {
    instances.delete(5150);
  }
});

// A live prompt that matched no phrase-based pattern and ran past the old
// detection window.
const HOTDOG_PROMPT = [
  'Is a hot dog a sandwich?',
  '',
  '❯ 1. Yes',
  "   Meat in a bread carrier. The bun's hinge is an implementation detail, not a category boundary.",
  '  2. No',
  '   A sandwich needs two separate slices. One continuous bun makes it its own thing entirely.',
  '  3. Type something.',
  '  4. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

test('a live selection prompt is recognised as waiting on the user', () => {
  const { APPROVAL_PROMPT_PATTERNS } = require('../../main/state/instances');
  assert.ok(
    APPROVAL_PROMPT_PATTERNS.some((p) => p.test(HOTDOG_PROMPT)),
    'the selection footer is the signal, not the wording of the question',
  );
});

test('a live selection prompt maps Yes/No to its digits', () => {
  const { keysForPrompt } = require('../../main/util/chat-reply');
  const keys = keysForPrompt(HOTDOG_PROMPT);
  assert.equal(keys.approveKeys, '1');
  assert.equal(keys.rejectKeys, '2');
});

test('the buffer holds a whole menu, not just its footer', () => {
  const { ROLLING_BUFFER_SIZE } = require('../../main/state/instances');
  assert.ok(ROLLING_BUFFER_SIZE >= HOTDOG_PROMPT.length,
    `buffer ${ROLLING_BUFFER_SIZE} must fit a ${HOTDOG_PROMPT.length}-char prompt`);
});
