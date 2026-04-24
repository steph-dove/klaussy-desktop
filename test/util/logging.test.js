// NOTE: setup MUST be first so the electron stub is registered before
// logging.js runs its import-time console hooks + rolling-file setup.
require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const { scrubLogMsg, captureLog, getLogBuffer } = require('../../main/util/logging');

test('scrubLogMsg strips ghp_ personal access tokens', () => {
  const out = scrubLogMsg('token=ghp_abcdefghij1234567890abcde');
  assert.equal(out, 'token=***');
});

test('scrubLogMsg strips every gh token prefix', () => {
  // The scrubber covers ghp_, gho_, ghs_, ghu_, ghr_ — issued by `gh auth`
  // for different account types. Miss any and a future prefix bump leaks.
  for (const prefix of ['ghp', 'gho', 'ghs', 'ghu', 'ghr']) {
    const token = prefix + '_abcdefghij1234567890abcde';
    assert.equal(scrubLogMsg('t=' + token), 't=***', prefix + ' not scrubbed');
  }
});

test('scrubLogMsg keeps oauth2:*** but drops the password', () => {
  const out = scrubLogMsg('https://oauth2:ghp_secret@github.com/foo/bar');
  assert.match(out, /oauth2:\*\*\*@/);
  assert.doesNotMatch(out, /ghp_secret/);
});

test('scrubLogMsg strips Bearer tokens', () => {
  const out = scrubLogMsg('Authorization: Bearer abc.def.ghi');
  assert.equal(out, 'Authorization: ***');
});

test('scrubLogMsg returns placeholder on non-string inputs', () => {
  const cyclic = {}; cyclic.self = cyclic;
  // String(cyclic) won't throw, but the scrubber's try/catch handles the
  // paranoid case where String() itself throws (e.g. Symbol.toPrimitive).
  const weird = { toString() { throw new Error('nope'); } };
  assert.equal(scrubLogMsg(weird), '[unserializable]');
});

test('scrubLogMsg is a no-op on clean text', () => {
  assert.equal(scrubLogMsg('nothing sensitive here'), 'nothing sensitive here');
});

test('captureLog appends to the ring buffer', () => {
  const before = getLogBuffer().length;
  captureLog('log', ['ring-buffer-test-marker']);
  const after = getLogBuffer().length;
  assert.equal(after, before + 1);
  const last = getLogBuffer()[after - 1];
  assert.equal(last.level, 'log');
  assert.match(last.msg, /ring-buffer-test-marker/);
  assert.match(last.time, /^\d{4}-\d{2}-\d{2}T/);  // ISO timestamp
});

test('captureLog scrubs tokens before storing', () => {
  captureLog('error', ['failed: ghp_abcdefghij1234567890abcde']);
  const buf = getLogBuffer();
  const last = buf[buf.length - 1];
  assert.doesNotMatch(last.msg, /ghp_/);
  assert.match(last.msg, /\*\*\*/);
});

test('getLogBuffer returns a copy, not the live ring', () => {
  const snapshot = getLogBuffer();
  const n = snapshot.length;
  snapshot.push({ time: 'x', level: 'x', msg: 'x' });
  assert.equal(getLogBuffer().length, n);  // live buffer unchanged
});

test('log ring is bounded at LOG_MAX (500)', async () => {
  // Fire enough messages to exceed the cap and confirm the oldest drop.
  for (let i = 0; i < 550; i++) captureLog('log', ['flood-' + i]);
  const buf = getLogBuffer();
  assert.ok(buf.length <= 500, 'ring exceeded 500: ' + buf.length);
  // The first surviving entry must be past the beginning of the flood.
  assert.match(buf[0].msg, /flood-/);
  const firstIdx = parseInt(buf[0].msg.match(/flood-(\d+)/)[1], 10);
  assert.ok(firstIdx >= 50, 'oldest entries should have been dropped');
});
