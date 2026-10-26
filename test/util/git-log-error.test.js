const test = require('node:test');
const assert = require('node:assert/strict');
const { isNoCommitsError, gitErrorReason } = require('../../main/util/git-log-error');

test('isNoCommitsError: matches an unborn branch', () => {
  const err = { stderr: "fatal: your current branch 'main' does not have any commits yet\n", message: 'Command failed: git log' };
  assert.equal(isNoCommitsError(err), true);
});

test('isNoCommitsError: falls back to message when stderr is missing', () => {
  assert.equal(isNoCommitsError(new Error("fatal: your current branch 'x' does not have any commits yet")), true);
});

test('isNoCommitsError: other failures do not match', () => {
  assert.equal(isNoCommitsError({ stderr: 'fatal: not a git repository' }), false);
  assert.equal(isNoCommitsError(null), false);
});

test('gitErrorReason: uses the first stderr line without the fatal prefix', () => {
  assert.equal(gitErrorReason({ stderr: 'fatal: not a git repository\nmore', message: 'Command failed: x' }), 'not a git repository');
});

test('gitErrorReason: falls back to the first message line', () => {
  assert.equal(gitErrorReason(new Error('boom\nstack')), 'boom');
});

test('gitErrorReason: skips leading warnings to find the fatal line', () => {
  assert.equal(gitErrorReason({ stderr: 'warning: unreadable config\nfatal: not a git repository' }), 'not a git repository');
});
