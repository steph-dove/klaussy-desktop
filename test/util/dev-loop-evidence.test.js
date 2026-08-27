require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { devLoopEvidence, phaseFromEvidence } = require('../../main/ipc/files');

const NONE = {
  hasPlan: false, commits: 0, qaMedia: 0,
  prNumber: null, prUrl: null,
  checksTotal: 0, checksPassed: 0, checksFailed: 0,
  reviewThreads: 0,
};

function ev(overrides) {
  return Object.assign({}, NONE, overrides);
}

test('a run with nothing to show for it stays on Phase 1', () => {
  assert.equal(phaseFromEvidence(NONE), 1);
});

test('a plan or a first commit means implementation is underway', () => {
  assert.equal(phaseFromEvidence(ev({ hasPlan: true })), 2);
  assert.equal(phaseFromEvidence(ev({ commits: 1 })), 2);
});

test('captured QA media means the loop reached the QA phase', () => {
  assert.equal(phaseFromEvidence(ev({ commits: 3, qaMedia: 2 })), 4);
});

test('an open PR means the PR phase is behind it', () => {
  assert.equal(phaseFromEvidence(ev({ commits: 3, prNumber: 67 })), 6);
});

test('checks on the PR move it to CI, reviews to feedback', () => {
  assert.equal(phaseFromEvidence(ev({ prNumber: 67, checksTotal: 2, checksPassed: 1 })), 7);
  assert.equal(phaseFromEvidence(ev({ prNumber: 67, checksTotal: 2, checksPassed: 1, reviewThreads: 1 })), 8);
});

test('every check green reaches the merge gate', () => {
  assert.equal(phaseFromEvidence(ev({ prNumber: 67, checksTotal: 2, checksPassed: 2 })), 9);
});

test('a red check holds the loop short of the merge gate', () => {
  const red = ev({ prNumber: 67, checksTotal: 2, checksPassed: 1, checksFailed: 1 });
  assert.equal(phaseFromEvidence(red), 7);
});

test('the floor never goes backwards as evidence accumulates', () => {
  const timeline = [
    NONE,
    ev({ hasPlan: true }),
    ev({ hasPlan: true, commits: 2 }),
    ev({ hasPlan: true, commits: 2, qaMedia: 3 }),
    ev({ hasPlan: true, commits: 2, qaMedia: 3, prNumber: 67 }),
    ev({ hasPlan: true, commits: 2, qaMedia: 3, prNumber: 67, checksTotal: 2, checksPassed: 2 }),
  ];
  const phases = timeline.map(phaseFromEvidence);
  assert.deepEqual(phases, [1, 2, 2, 4, 6, 9]);
  for (let i = 1; i < phases.length; i++) {
    assert.ok(phases[i] >= phases[i - 1], `regressed at step ${i}`);
  }
});

test('devLoopEvidence reads a real worktree without a PR', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-evidence-'));
  const repo = path.join(tempRoot, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'README.md'), '# x\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  try {
    const before = await devLoopEvidence(repo);
    assert.equal(before.hasPlan, false);
    assert.equal(before.prNumber, null);
    assert.equal(phaseFromEvidence(before), 1);

    fs.writeFileSync(path.join(repo, 'plan.md'), '# plan\n');
    const after = await devLoopEvidence(repo);
    assert.equal(after.hasPlan, true);
    assert.equal(phaseFromEvidence(after), 2);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('devLoopEvidence returns an empty reading for no worktree', async () => {
  const result = await devLoopEvidence('');
  assert.equal(result.hasPlan, false);
  assert.equal(result.commits, 0);
  assert.equal(phaseFromEvidence(result), 1);
});
