require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../../main/util/approval-registry');

test('a token redeems once and only once', () => {
  registry._reset();
  const token = registry.issue(7, 'shell-exec');
  const first = registry.redeem(token);
  assert.equal(first.ok, true);
  // Ids are canonicalized to strings on the way in; callers do Number() to look
  // the instance up.
  assert.equal(first.taskId, '7');
  assert.equal(first.tool, 'shell-exec');

  // A second click, or a replayed payload, must not act again.
  const second = registry.redeem(token);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'unknown');
});

test('an unknown token is rejected', () => {
  registry._reset();
  assert.equal(registry.redeem('deadbeef').ok, false);
  assert.equal(registry.redeem('').ok, false);
});

test('tokens are unguessable and distinct per issue', () => {
  registry._reset();
  const a = registry.issue(1, 'x');
  const b = registry.issue(1, 'x');
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{32}$/, '128 bits of hex');
});

test('an expired token is refused and reported as expired', () => {
  registry._reset();
  const token = registry.issue(3, 'tool', -1); // already past its TTL
  const res = registry.redeem(token);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'expired');
});

test('revokeForTask drops only that session/s tokens', () => {
  registry._reset();
  const mine = registry.issue(5, 'a');
  const other = registry.issue(6, 'b');
  registry.revokeForTask(5);
  assert.equal(registry.redeem(mine).ok, false, 'revoked');
  assert.equal(registry.redeem(other).ok, true, 'untouched');
});

// The two call sites disagree on type: events carry a String containerId while
// instances.js revokes with a numeric id. A strict compare made every revoke a
// silent no-op, leaving buttons live for the full TTL after the prompt was gone.
test('revokeForTask matches regardless of id type', () => {
  registry._reset();
  const fromEvent = registry.issue('7', 'tool');
  registry.revokeForTask(7); // number, as instances.js passes it
  assert.equal(registry.redeem(fromEvent).ok, false, 'string-issued token revoked by number');

  const fromNumber = registry.issue(8, 'tool');
  registry.revokeForTask('8');
  assert.equal(registry.redeem(fromNumber).ok, false, 'number-issued token revoked by string');
});

test('sweepExpired clears stale entries without touching live ones', () => {
  registry._reset();
  registry.issue(1, 'old', -1);
  const live = registry.issue(2, 'new');
  registry.sweepExpired();
  assert.equal(registry.size(), 1);
  assert.equal(registry.redeem(live).ok, true);
});
