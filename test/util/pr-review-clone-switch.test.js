// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// A review that changes while its repo is first cloned gets no worktree, so
// callers never pair the new PR with the old PR's checkout.
require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');

const calls = [];
let onClone = () => {};
// Stubbed before the modules under test load, since they destructure execFile.
childProcess.execFile = (cmd, args, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  calls.push([cmd, ...args]);
  if (cmd === 'git' && args[0] === 'clone') onClone();
  setImmediate(() => cb(null, '', ''));
  return { on() {} };
};
const realExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = (cmd, args, opts) => {
  if (cmd === 'gh' && args[0] === 'auth') return Buffer.from('gho_test\n');
  if (cmd === 'git') throw Object.assign(new Error('no git here'), { stderr: '' });
  return realExecFileSync(cmd, args, opts);
};

const { prReview, ensureWorktreeForActivePr } = require('../../main/state/pr-review');

function review(number) {
  return {
    forge: 'github',
    host: 'github.com',
    number,
    baseOwner: 'acme',
    baseRepo: `clone-switch-${process.pid}`,
    meta: { headRefName: `feat-${number}`, baseRefName: 'main' },
  };
}

test.afterEach(() => {
  prReview.active = null;
  onClone = () => {};
  calls.length = 0;
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
