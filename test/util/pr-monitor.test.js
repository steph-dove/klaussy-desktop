require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldPoll } = require('../../main/state/pr-monitor');

const live = { id: 1, alive: true, worktreePath: '/wt', branch: 'feat' };

test('a live task with a branch is polled', () => {
  assert.equal(shouldPoll(live, new Set()), true);
});

test('a dev-loop task is never auto-fixed in the background', () => {
  assert.equal(shouldPoll({ ...live, devLoop: true }, new Set()), false);
});

test('dead, branchless and already-fixing tasks are skipped', () => {
  assert.equal(shouldPoll({ ...live, alive: false }, new Set()), false);
  assert.equal(shouldPoll({ ...live, branch: null }, new Set()), false);
  assert.equal(shouldPoll({ ...live, worktreePath: '' }, new Set()), false);
  assert.equal(shouldPoll(live, new Set([1])), false);
});
