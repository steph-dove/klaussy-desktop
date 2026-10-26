const test = require('node:test');
const assert = require('node:assert/strict');
const { gitErrorReason } = require('../../main/util/git-log-error');

test('gitErrorReason: uses the first stderr line without the fatal prefix', () => {
  assert.equal(gitErrorReason({ stderr: 'fatal: not a git repository\nmore', message: 'Command failed: x' }), 'not a git repository');
});

test('gitErrorReason: falls back to the first message line', () => {
  assert.equal(gitErrorReason(new Error('boom\nstack')), 'boom');
});

test('gitErrorReason: skips leading warnings to find the fatal line', () => {
  assert.equal(gitErrorReason({ stderr: 'warning: unreadable config\nfatal: not a git repository' }), 'not a git repository');
});

test('gitErrorReason: handles Buffer stderr and an empty error', () => {
  assert.equal(gitErrorReason({ stderr: Buffer.from('fatal: bad object\n') }), 'bad object');
  assert.equal(gitErrorReason({}), 'unknown error');
});
