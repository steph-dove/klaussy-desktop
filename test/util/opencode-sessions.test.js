require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSessionIds, listSessionIds, latestSession } = require('../../main/state/opencode-sessions');

// Real `opencode session list` output (opencode 1.17.12), newest-updated first.
const SAMPLE = [
  'Session ID                      Title                                   Updated',
  '───────────────────────────────────────────────────────────────────────────────',
  'ses_0e436e4c9ffesRnkG7reCqaUw0  New session - 2026-07-01T03:46:32.375Z  8:46 PM',
  'ses_0e4373579ffeCRVGrVZd46YTt9  New session - 2026-07-01T03:46:11.718Z  8:46 PM',
].join('\n');

test('parseSessionIds extracts ids in listed (newest-first) order, skipping header/rule', () => {
  assert.deepEqual(parseSessionIds(SAMPLE), [
    'ses_0e436e4c9ffesRnkG7reCqaUw0',
    'ses_0e4373579ffeCRVGrVZd46YTt9',
  ]);
});

test('parseSessionIds is total on empty / junk input', () => {
  assert.deepEqual(parseSessionIds(''), []);
  assert.deepEqual(parseSessionIds(null), []);
  assert.deepEqual(parseSessionIds(undefined), []);
  assert.deepEqual(parseSessionIds('no session ids here\njust text'), []);
});

test('listSessionIds / latestSession degrade to empty when the bin is unusable', () => {
  // A non-existent binary makes execFileSync throw — must be swallowed so resume
  // falls back to a fresh/continue session instead of surfacing an error.
  assert.deepEqual(listSessionIds('opencode-does-not-exist-xyz', '/tmp'), []);
  assert.equal(latestSession('opencode-does-not-exist-xyz', '/tmp'), null);
  // Missing bin / worktree short-circuit without spawning anything.
  assert.deepEqual(listSessionIds('', '/tmp'), []);
  assert.equal(latestSession('opencode', ''), null);
});
