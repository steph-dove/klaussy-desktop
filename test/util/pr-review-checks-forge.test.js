const { electronStub } = require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');

// Every gh call fails fast; the tests only care whether one was made. The
// stubs go in before the handlers load, since they destructure child_process.
const ghCalls = [];
childProcess.execFile = (cmd, args, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (cmd === 'gh') ghCalls.push(args);
  setImmediate(() => cb(Object.assign(new Error('stubbed ' + cmd), { stderr: '' })));
  return { stdin: { write() {}, end() {} } };
};
childProcess.execFileSync = (cmd, args) => {
  if (cmd === 'gh') {
    ghCalls.push(args);
    throw Object.assign(new Error('stubbed gh'), { stderr: '' });
  }
  return Buffer.from('');
};

const handlers = {};
const origHandle = electronStub.ipcMain.handle;
electronStub.ipcMain.handle = (channel, fn) => { handlers[channel] = fn; };
require('../../main/ipc/pr-review-checks');
electronStub.ipcMain.handle = origHandle;

const { prReview } = require('../../main/state/pr-review');

const fakeEvent = { sender: { isDestroyed: () => true, send() {} } };

// Each gh-backed handler, with args that get past its own input checks.
const cases = [
  ['pr-review-required-checks', undefined, { required: [] }],
  ['pr-review-run-rerun-failed', { runId: 1 }, { error: 'Only available on GitHub pull requests' }],
  ['pr-review-workflows-list', undefined, { workflows: [] }],
  ['pr-review-workflow-dispatch', { workflowId: 1, ref: 'main' }, { error: 'Only available on GitHub pull requests' }],
  ['pr-review-run-log-watch-start', { requestId: 'r1', runId: 1 }, { error: 'Only available on GitHub pull requests' }],
  ['pr-review-run-cancel', { runId: 1 }, { error: 'Only available on GitHub pull requests' }],
  ['pr-review-check-annotations', { checkRunId: 1 }, { annotations: [] }],
];

function activate(forge) {
  prReview.active = {
    forge,
    number: 7,
    baseOwner: 'acme',
    baseRepo: 'app',
    meta: { headRefOid: 'abc', headRefName: 'feature', baseRefName: 'main' },
  };
}

test.afterEach(() => {
  prReview.active = null;
  ghCalls.length = 0;
});

for (const [channel, args, expected] of cases) {
  test(`${channel} returns early on a Bitbucket PR without running gh`, async () => {
    activate('bitbucket');
    const res = await handlers[channel](fakeEvent, args);
    assert.deepEqual(res, expected);
    assert.equal(ghCalls.length, 0);
  });

  test(`${channel} still runs gh on a GitHub PR`, async () => {
    activate('github');
    await handlers[channel](fakeEvent, args);
    if (channel === 'pr-review-run-log-watch-start') {
      await handlers['pr-review-run-log-watch-stop'](fakeEvent, { requestId: 'r1' });
    }
    assert.ok(ghCalls.length > 0, 'expected a gh call');
  });
}
