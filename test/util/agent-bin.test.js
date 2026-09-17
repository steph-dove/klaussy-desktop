const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveAgentBin } = require('../../main/util/agent-bin');

test('a configured path that exists resolves to itself', () => {
  assert.equal(resolveAgentBin(process.execPath), process.execPath);
});

test('a configured path that does not exist resolves to null', () => {
  assert.equal(resolveAgentBin(path.join(path.dirname(process.execPath), 'no-such-agent-xyz')), null);
});

test('a bare name on PATH resolves to an absolute path', () => {
  const hit = resolveAgentBin('node');
  assert.ok(hit, 'node should be on PATH while the test suite runs');
  assert.ok(path.isAbsolute(hit));
});

test('a bare name that is not installed resolves to null', () => {
  assert.equal(resolveAgentBin('klaussy-not-a-real-agent-xyz'), null);
});

test('an empty or missing binary name resolves to null', () => {
  assert.equal(resolveAgentBin(''), null);
  assert.equal(resolveAgentBin(null), null);
  assert.equal(resolveAgentBin(undefined), null);
});
