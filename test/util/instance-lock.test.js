require('../setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lock = require('../../main/util/instance-lock');

const OTHER_PID = 999999;
const alive = () => true;
const dead = () => false;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'maussian-lock-'));
}
function plant(dir, holder) {
  fs.writeFileSync(path.join(dir, lock.LOCK_FILE), JSON.stringify(holder));
}

test('the first process to start takes the folder', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(lock.acquire(dir, { kind: 'web' }), { ok: true });
  assert.deepStrictEqual(lock.readLock(dir), { kind: 'web', pid: process.pid });
});

test('a live holder keeps the folder and is reported', () => {
  const dir = tmpDir();
  plant(dir, { kind: 'web', pid: OTHER_PID, port: 43117 });
  const result = lock.acquire(dir, { kind: 'desktop' }, { isAlive: alive });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.holder, { kind: 'web', pid: OTHER_PID, port: 43117 });
});

test('a holder whose process is gone is replaced', () => {
  const dir = tmpDir();
  plant(dir, { kind: 'web', pid: OTHER_PID });
  assert.deepStrictEqual(lock.acquire(dir, { kind: 'desktop' }, { isAlive: dead }), { ok: true });
  assert.strictEqual(lock.readLock(dir).kind, 'desktop');
});

test('an unreadable lock file is replaced', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, lock.LOCK_FILE), 'not json');
  assert.deepStrictEqual(lock.acquire(dir, { kind: 'web' }), { ok: true });
});

test('update adds the port only to a lock this process holds', () => {
  const dir = tmpDir();
  lock.acquire(dir, { kind: 'web' });
  assert.strictEqual(lock.update(dir, { port: 43118 }), true);
  assert.strictEqual(lock.readLock(dir).port, 43118);

  const other = tmpDir();
  plant(other, { kind: 'web', pid: OTHER_PID });
  assert.strictEqual(lock.update(other, { port: 1 }), false);
  assert.strictEqual(lock.readLock(other).port, undefined);
});

test('release leaves another process’s lock alone; discard removes it', () => {
  const dir = tmpDir();
  plant(dir, { kind: 'web', pid: OTHER_PID });
  lock.release(dir);
  assert.ok(lock.readLock(dir));
  lock.discard(dir);
  assert.strictEqual(lock.readLock(dir), null);
});

test('browserUrl carries a fresh one-time pairing code', () => {
  const dir = tmpDir();
  const pairing = require('../../main/util/web-pairing');
  const url = lock.browserUrl(dir, { kind: 'web', pid: OTHER_PID, port: 43117 });
  const m = url.match(/^http:\/\/127\.0\.0\.1:43117\/renderer\/index\.html#pair=([A-Za-z0-9_-]{43})$/);
  assert.ok(m, url);
  assert.strictEqual(pairing.consumePairCode(dir, m[1]), true);
});

test('browserUrl is null before the helper listens, or for the desktop app', () => {
  const dir = tmpDir();
  assert.strictEqual(lock.browserUrl(dir, { kind: 'web', pid: OTHER_PID }), null);
  assert.strictEqual(lock.browserUrl(dir, { kind: 'desktop', pid: OTHER_PID, port: 1 }), null);
});

test('stopHolder sends SIGTERM and waits for the process to exit', async () => {
  let running = true;
  const sent = [];
  const stopped = await lock.stopHolder({ kind: 'web', pid: OTHER_PID }, {
    kill: (pid, sig) => { sent.push([pid, sig]); setTimeout(() => { running = false; }, 50); },
    isAlive: () => running,
    timeoutMs: 2000,
  });
  assert.strictEqual(stopped, true);
  assert.deepStrictEqual(sent, [[OTHER_PID, 'SIGTERM']]);
});

test('stopHolder gives up when the process won’t exit', async () => {
  const stopped = await lock.stopHolder({ kind: 'web', pid: OTHER_PID }, {
    kill: () => {}, isAlive: alive, timeoutMs: 300,
  });
  assert.strictEqual(stopped, false);
});
