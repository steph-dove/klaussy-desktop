require('../setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCommitPusher } = require('../../main/util/commit-pusher');

function harness(results) {
  const state = { head: 'aaa111', pushes: 0, notified: [], logs: [] };
  const pusher = createCommitPusher({
    getHead: async () => state.head,
    push: async () => { state.pushes++; return results.shift() || { ok: true }; },
    onResult: (r) => state.notified.push(r),
    log: (m) => state.logs.push(m),
  });
  return { state, pusher };
}

test('no new commit since the run started means no push', async () => {
  const { state, pusher } = harness([]);
  await pusher.start();
  await pusher.check('end of turn');
  assert.equal(state.pushes, 0);
  assert.deepEqual(state.notified, []);
});

test('a new commit is pushed once, even if the turn end and exit both report it', async () => {
  const { state, pusher } = harness([]);
  await pusher.start();
  state.head = 'bbb222';
  await pusher.check('end of turn');
  await pusher.check('exit');
  assert.equal(state.pushes, 1);
  assert.equal(state.notified.length, 1);
});

test('a later turn that commits again is pushed too', async () => {
  const { state, pusher } = harness([]);
  await pusher.start();
  state.head = 'bbb222';
  await pusher.check('end of turn');
  state.head = 'ccc333';
  await pusher.check('end of turn');
  assert.equal(state.pushes, 2);
});

test('a failed push is reported once and not retried for the same commit', async () => {
  const { state, pusher } = harness([{ error: 'rejected' }]);
  await pusher.start();
  state.head = 'bbb222';
  await pusher.check('end of turn');
  await pusher.check('exit');
  assert.equal(state.pushes, 1);
  assert.deepEqual(state.notified, [{ error: 'rejected' }]);
  assert.ok(state.logs.some((m) => m.includes('push failed: rejected')));
});

test('overlapping checks push only once', async () => {
  const { state, pusher } = harness([]);
  await pusher.start();
  state.head = 'bbb222';
  await Promise.all([pusher.check('end of turn'), pusher.check('exit')]);
  assert.equal(state.pushes, 1);
});

test('a commit made while a push is running is pushed after it', async () => {
  const state = { head: 'aaa111', pushed: [] };
  let release;
  const gate = new Promise((r) => { release = r; });
  const pusher = createCommitPusher({
    getHead: async () => state.head,
    push: async () => { state.pushed.push(state.head); if (state.pushed.length === 1) await gate; return { ok: true }; },
    onResult: () => {},
    log: () => {},
  });
  await pusher.start();
  state.head = 'bbb222';
  const first = pusher.check('end of turn');
  await new Promise((r) => setImmediate(r));
  state.head = 'ccc333';
  await pusher.check('exit');
  release();
  await first;
  assert.deepEqual(state.pushed, ['bbb222', 'ccc333']);
});

test('a thrown push error becomes a reported failure', async () => {
  const state = { notified: [] };
  let head = 'aaa111';
  const pusher = createCommitPusher({
    getHead: async () => head,
    push: async () => { throw new Error('boom'); },
    onResult: (r) => state.notified.push(r),
    log: () => {},
  });
  await pusher.start();
  head = 'bbb222';
  await pusher.check('end of turn');
  assert.deepEqual(state.notified, [{ error: 'boom' }]);
});

test('a git failure while checking is reported instead of read as "no new commit"', async () => {
  const notified = [];
  let fail = false;
  const pusher = createCommitPusher({
    getHead: async () => { if (fail) throw new Error('index.lock exists'); return 'aaa111'; },
    push: async () => ({ ok: true }),
    onResult: (r) => notified.push(r),
    log: () => {},
  });
  await pusher.start();
  fail = true;
  await pusher.check('end of turn');
  assert.equal(notified.length, 1);
  assert.match(notified[0].error, /index\.lock exists/);
});
