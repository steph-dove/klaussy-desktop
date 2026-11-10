const { electronStub } = require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

// broadcastPrReview reaches for windows; there are none in a unit test.
electronStub.BrowserWindow.getAllWindows = () => [];
electronStub.webContents = { fromId: () => null };

const handlers = {};
const origHandle = electronStub.ipcMain.handle;
electronStub.ipcMain.handle = (channel, fn) => { handlers[channel] = fn; };
require('../../main/ipc/pr-review');
electronStub.ipcMain.handle = origHandle;

const { prReview } = require('../../main/state/pr-review');
const azure = require('../../main/util/forges/azure');

function withDiffFor(fn, body) {
  const orig = azure.diffFor;
  azure.diffFor = fn;
  return body().finally(() => { azure.diffFor = orig; });
}

const activePr = () => ({ forge: 'azure', number: 1, host: 'dev.azure.com', meta: { url: 'https://dev.azure.com/o/p/_git/r/pullrequest/1' }, diff: '', diffPending: false, diffError: 'old' });

test.afterEach(() => { prReview.active = null; });

test('retrying a failed diff fills it in and clears the error', async () => {
  prReview.active = activePr();
  await withDiffFor(async () => 'diff --git a/x b/x\n', async () => {
    assert.deepEqual(await handlers['pr-retry-diff'](), { ok: true });
  });
  assert.equal(prReview.active.diff, 'diff --git a/x b/x\n');
  assert.equal(prReview.active.diffPending, false);
  assert.equal(prReview.active.diffError, null);
});

test('a failed diff is reported with credentials scrubbed', async () => {
  prReview.active = activePr();
  await withDiffFor(async () => { throw new Error("fatal: unable to access 'https://user:s3cret@dev.azure.com/o/p/_git/r/'"); }, async () => {
    const res = await handlers['pr-retry-diff']();
    assert.ok(res.error);
  });
  assert.equal(prReview.active.diffPending, false);
  assert.ok(!prReview.active.diffError.includes('s3cret'));
});

test('a diff that finishes after the review changed is dropped', async () => {
  const first = activePr();
  prReview.active = first;
  let release;
  await withDiffFor(() => new Promise((r) => { release = r; }), async () => {
    const pending = handlers['pr-retry-diff']();
    prReview.active = { ...activePr(), number: 2 };
    release('late diff');
    await pending;
  });
  assert.equal(prReview.active.diff, '');
  assert.equal(first.diff, '');
});
