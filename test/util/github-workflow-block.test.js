require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { workflowBlockFor } = require('../../main/util/forges/github');

function fixture() {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-wf-wt-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-wf-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.yml'), 'name: CI\nSECRET_CONTENT\n');
  return { wt, outside, cleanup: () => {
    fs.rmSync(wt, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  } };
}

test('the best-matching workflow is read from the worktree', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.wt, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(f.wt, '.github', 'workflows', 'ci.yml'), 'name: CI\njobs:\n  test: {}\n');
    fs.writeFileSync(path.join(f.wt, '.github', 'workflows', 'lint.yml'), 'name: Lint\n');
    const block = workflowBlockFor(f.wt, 'CI / test');
    assert.match(block, /\.github\/workflows\/ci\.yml/);
    assert.match(block, /test: \{\}/);
  } finally {
    f.cleanup();
  }
});

test('a workflow symlinked to a file outside the worktree is skipped', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.wt, '.github', 'workflows'), { recursive: true });
    fs.symlinkSync(path.join(f.outside, 'secret.yml'), path.join(f.wt, '.github', 'workflows', 'ci.yml'));
    assert.equal(workflowBlockFor(f.wt, 'CI'), '');
  } finally {
    f.cleanup();
  }
});

test('a workflows directory symlinked outside the worktree is skipped', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.wt, '.github'));
    fs.symlinkSync(f.outside, path.join(f.wt, '.github', 'workflows'), 'dir');
    assert.equal(workflowBlockFor(f.wt, 'CI'), '');
  } finally {
    f.cleanup();
  }
});

test('a symlink to another workflow inside the worktree still works', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  try {
    const wf = path.join(f.wt, '.github', 'workflows');
    fs.mkdirSync(wf, { recursive: true });
    fs.writeFileSync(path.join(f.wt, 'shared.yml'), 'name: CI\nsteps: shared\n');
    fs.symlinkSync(path.join(f.wt, 'shared.yml'), path.join(wf, 'ci.yml'));
    assert.match(workflowBlockFor(f.wt, 'CI'), /steps: shared/);
  } finally {
    f.cleanup();
  }
});

test('no workflows directory gives no block', () => {
  const f = fixture();
  try {
    assert.equal(workflowBlockFor(f.wt, 'CI'), '');
  } finally {
    f.cleanup();
  }
});
