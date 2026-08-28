require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { defaultBranchOf, defaultBranchRefusal } = require('../../main/util/git-repo');

function makeRepo(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-defbranch-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('checkout', '-q', '-B', branch);
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('defaultBranchOf finds the default branch without an origin', () => {
  const repo = makeRepo('main');
  try {
    assert.equal(defaultBranchOf(repo), 'main');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('defaultBranchOf honours a repo whose default is not main', () => {
  const repo = makeRepo('develop');
  try {
    assert.equal(defaultBranchOf(repo), 'develop');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a session may not take the default branch into its worktree', () => {
  const repo = makeRepo('main');
  try {
    const refusal = defaultBranchRefusal(repo, 'main');
    assert.ok(refusal, 'expected a refusal for the default branch');
    assert.match(refusal, /default branch/i);
    // The message has to say what to do instead, not just say no.
    assert.match(refusal, /branch off/i);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('the refusal is case-insensitive', () => {
  const repo = makeRepo('main');
  try {
    assert.ok(defaultBranchRefusal(repo, 'Main'));
    assert.ok(defaultBranchRefusal(repo, 'MAIN'));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('an ordinary feature branch is allowed through', () => {
  const repo = makeRepo('main');
  try {
    assert.equal(defaultBranchRefusal(repo, 'feat/thing'), null);
    assert.equal(defaultBranchRefusal(repo, 'pr-review-updates'), null);
    // A name that merely contains the default branch is not the default branch.
    assert.equal(defaultBranchRefusal(repo, 'main-menu'), null);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a develop-default repo refuses develop and allows main', () => {
  const repo = makeRepo('develop');
  try {
    assert.ok(defaultBranchRefusal(repo, 'develop'));
    assert.equal(defaultBranchRefusal(repo, 'main'), null);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('missing arguments and non-repos are let through rather than blocking', () => {
  assert.equal(defaultBranchRefusal(null, 'main'), null);
  assert.equal(defaultBranchRefusal('/tmp', ''), null);
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-notrepo-'));
  try {
    // Falls back to "main" for a non-repo, which is the safe direction: it
    // still refuses main rather than silently permitting it.
    assert.ok(defaultBranchRefusal(notARepo, 'main'));
    assert.equal(defaultBranchRefusal(notARepo, 'feat/x'), null);
  } finally {
    fs.rmSync(notARepo, { recursive: true, force: true });
  }
});
