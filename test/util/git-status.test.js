require('../setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { readGitStatus } = require('../../main/ipc/git');

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' },
  });
}
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('repo with no commits lists files and the unborn branch name', async (t) => {
  const dir = tmp(t);
  git(dir, 'init', '-b', 'trunk');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  git(dir, 'add', 'b.txt');
  const res = await readGitStatus(dir);
  assert.equal(res.error, undefined);
  assert.equal(res.branch, 'trunk');
  assert.deepEqual(res.files, [
    { status: 'A ', staged: true, file: 'b.txt' },
    { status: '??', staged: false, file: 'a.txt' },
  ]);
});

test('repo with a commit reports its branch', async (t) => {
  const dir = tmp(t);
  git(dir, 'init', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'x');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'b');
  const res = await readGitStatus(dir);
  assert.equal(res.branch, 'main');
  assert.deepEqual(res.files, [{ status: ' M', staged: false, file: 'a.txt' }]);
});

test('a directory that is not a repo still reports an error', async (t) => {
  const res = await readGitStatus(tmp(t));
  assert.ok(res.error);
  assert.deepEqual(res.files, []);
});
