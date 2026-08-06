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
  const token = registry.issue(1, 'tool', -1);
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
