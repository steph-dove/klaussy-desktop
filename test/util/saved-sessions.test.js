require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeSavedSessions } = require('../../main/util/saved-sessions');

const copilot = { worktreePath: '/wt/a', mode: 'copilot', sessionId: 'c1' };
const claude = { worktreePath: '/wt/b', mode: 'claude', sessionId: 'k1' };

// Regression: closing the Copilot session while another stayed open wiped its
// entry, so the sidebar rediscovered the worktree from disk as a Claude session.
test('a session that is no longer open keeps its entry', () => {
  const merged = mergeSavedSessions([claude], [copilot, claude]);
  const kept = merged.find((s) => s.worktreePath === '/wt/a');
  assert.equal(kept.mode, 'copilot');
  assert.equal(kept.sessionId, 'c1');
});

test('a worktree that is open is described by the live snapshot, not the old entry', () => {
  const resumed = { worktreePath: '/wt/a', mode: 'copilot', sessionId: 'c2' };
  const merged = mergeSavedSessions([resumed], [copilot]);
  assert.deepEqual(merged, [resumed]);
});

test('every stored entry for a live worktree is replaced together', () => {
  const second = { worktreePath: '/wt/a', mode: 'antigravity', sessionId: 'a1' };
  const merged = mergeSavedSessions([copilot], [copilot, second]);
  assert.deepEqual(merged, [copilot]);
});

test('a dismissed session stays gone', () => {
  assert.deepEqual(mergeSavedSessions([claude], []), [claude]);
});

test('empty and missing inputs do not throw', () => {
  assert.deepEqual(mergeSavedSessions([], []), []);
  assert.deepEqual(mergeSavedSessions(undefined, undefined), []);
  assert.deepEqual(mergeSavedSessions([claude], [null]), [claude]);
});
