// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// A review that changes while its repo is first cloned gets no worktree, so
// callers never pair the new PR with the old PR's checkout.
require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');

const calls = [];
let onClone = () => {};
let cloneError = null;
// Stubbed before the modules under test load, since they destructure execFile.
childProcess.execFile = (cmd, args, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  calls.push([cmd, ...args]);
  const isClone = cmd === 'git' && args[0] === 'clone';
  if (isClone) onClone();
  setImmediate(() => cb(isClone ? cloneError : null, '', ''));
  return { on() {} };
};
const realExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = (cmd, args, opts) => {
  if (cmd === 'gh' && args[0] === 'auth') return Buffer.from('gho_test\n');
  if (cmd === 'git') throw Object.assign(new Error('no git here'), { stderr: '' });
  return realExecFileSync(cmd, args, opts);
};

const { prReview, ensureWorktreeForActivePr } = require('../../main/state/pr-review');

function review(number, repo = `clone-switch-${process.pid}`) {
  return {
    forge: 'github',
    host: 'github.com',
    number,
    baseOwner: 'acme',
    baseRepo: repo,
    meta: { headRefName: `feat-${number}`, baseRefName: 'main' },
  };
}

const clones = () => calls.filter(([cmd, sub]) => cmd === 'git' && sub === 'clone');

test.afterEach(() => {
  prReview.active = null;
  onClone = () => {};
  cloneError = null;
  calls.length = 0;
});

test('reopening the same PR during the first clone carries on', async () => {
  prReview.active = review(4);
  onClone = () => { prReview.active = review(4); };
  const res = await ensureWorktreeForActivePr();
  // It gets past the guard and fails later, at the stubbed-out git steps.
  assert.doesNotMatch(res.error || '', /review changed/);
});

test('two callers that both need the first clone share one git clone', async () => {
  prReview.active = review(5, `clone-share-${process.pid}`);
  await Promise.all([ensureWorktreeForActivePr(), ensureWorktreeForActivePr()]);
  assert.equal(clones().length, 1);
});

test('a failed clone reports git\'s error without the token', async () => {
  prReview.active = review(6, `clone-fail-${process.pid}`);
  cloneError = Object.assign(new Error('clone failed'), {
    stderr: 'fatal: unable to access \'https://oauth2:gho_test@github.com/acme/x.git/\': 403',
  });
  const res = await ensureWorktreeForActivePr();
  assert.match(res.error, /^Clone failed: fatal: unable to access/);
  assert.doesNotMatch(res.error, /gho_test/);
});

test('opening another PR during the first clone stops before the worktree', async () => {
  prReview.active = review(1);
  onClone = () => { prReview.active = review(2); };
  const res = await ensureWorktreeForActivePr();
  assert.match(res.error || '', /review changed while the repository was cloning/);
  assert.ok(calls.some(([cmd, sub]) => cmd === 'git' && sub === 'clone'), 'expected a clone');
  assert.equal(prReview.active.number, 2);
});

test('closing the review during the first clone stops before the worktree', async () => {
  prReview.active = review(3);
  onClone = () => { prReview.active = null; };
  const res = await ensureWorktreeForActivePr();
  assert.match(res.error || '', /review changed while the repository was cloning/);
});
