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

// state/pr-review.js used two local scrubbers on git's error output before it
// switched to scrubLogMsg. Every secret they removed must still be removed.
test('scrubLogMsg redacts everything the old git-output scrubbers did', () => {
  const cases = [
    ['https://oauth2:glpat-AbC123xyz@gitlab.com/group/sub/repo.git', 'glpat-AbC123xyz'],
    ['https://oauth2:gho_abcdefghij1234567890abcd@github.com/o/r.git', 'gho_abcdefghij1234567890abcd'],
    ['https://x-token-auth:bbtoken987@bitbucket.org/ws/repo.git', 'bbtoken987'],
    ['https://me%40example.com:ATATT3xFfGF0secret@bitbucket.org/ws/repo.git', 'ATATT3xFfGF0secret'],
    ['https://builduser:app%2Fpass%3D@bitbucket.example.com/proj/repo.git', 'app%2Fpass%3D'],
    ["fatal: unable to access 'https://oauth2:tok42@gitlab.example.com/a/b.git/': 403", 'tok42'],
    ['remote: x-token-auth:zzz111@ rejected', 'zzz111'],
  ];
  for (const [input, secret] of cases) {
    const out = scrubLogMsg(input);
    assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
  }
  assert.ok(!scrubLogMsg(cases[3][0]).includes('me%40example.com'), 'Bitbucket email user leaked');
});

test('scrubLogMsg redacts other scheme://user:secret@ URLs and Basic auth', () => {
  assert.equal(scrubLogMsg('ssh://git:hunter2@host/x'), 'ssh://***:***@host/x');
  assert.equal(scrubLogMsg('Authorization: Basic dXNlcjpwYXNzd29yZA=='), 'Authorization: ***');
  assert.equal(scrubLogMsg('see https://github.com/a/b by user@example.com'), 'see https://github.com/a/b by user@example.com');
  assert.equal(scrubLogMsg('Basic dXNlcjpwYXNz'), '***');
});

test('scrubLogMsg leaves prose about Basic auth and URLs with ports alone', () => {
  for (const s of [
    'remote: Basic authentication is deprecated',
    'Basic Authentication required',
    'remote: HTTP Basic: Access denied',
    'see https://host:8080/a/@scope/pkg',
  ]) {
    assert.equal(scrubLogMsg(s), s);
  }
});

test('scrubLogMsg treats a missing message as empty', () => {
  assert.equal(scrubLogMsg(undefined), '');
  assert.equal(scrubLogMsg(null), '');
});
