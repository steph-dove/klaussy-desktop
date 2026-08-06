require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { isHookInstalledForRepo } = require('../../main/state/precommit-hook');

// A throwaway git repo whose common hooks dir we can poke at directly.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precommit-hook-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const hooksDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: dir, stdio: 'pipe',
  }).toString().trim();
  return { dir, hooksDir: path.join(hooksDir, 'hooks') };
}

test('reports not-installed when no pre-commit hook exists', () => {
  const { dir } = makeRepo();
  assert.equal(isHookInstalledForRepo(dir), false);
});

test('reports installed when our marked hook is present', () => {
  const { dir, hooksDir } = makeRepo();
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\n# klaussy-precommit v1\nexit 0\n');
  assert.equal(isHookInstalledForRepo(dir), true);
});

test('reports not-installed for a foreign pre-commit hook', () => {
  const { dir, hooksDir } = makeRepo();
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\n# somebody elses hook\nexit 0\n');
  assert.equal(isHookInstalledForRepo(dir), false);
});

test('sees a hook installed on the main repo from a linked worktree', () => {
  // The whole reason for using the common git dir: a hook installed once is
  // visible from every linked worktree. Install on the main repo, then check
  // from a `git worktree add` checkout.
  const { dir, hooksDir } = makeRepo();
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\n# klaussy-precommit v1\nexit 0\n');
  // A commit is needed before a worktree can be added.
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init'], { cwd: dir });
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'precommit-wt-')), 'linked');
  execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: dir });
  assert.equal(isHookInstalledForRepo(wt), true);
});

test('reports not-installed for a non-git path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precommit-nogit-'));
  assert.equal(isHookInstalledForRepo(dir), false);
});

test('returns false rather than throwing on a bad input', () => {
  assert.equal(isHookInstalledForRepo(null), false);
  assert.equal(isHookInstalledForRepo(''), false);
});
