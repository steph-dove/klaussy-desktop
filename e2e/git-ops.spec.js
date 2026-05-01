// git ops: status + diff + stage + unstage + commit through the preload
// bridge. Builds a real git repo, makes a change, drives the IPC the
// diff panel uses, asserts each step's output. Catches regressions in
// the git-* IPC layer that would silently break the diff panel.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

function buildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('git status, diff, stage, unstage, commit round-trip', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repo = buildRepo();
  try {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new file\n');

    // Status: a.txt modified, b.txt untracked.
    let status = await mainWindow.evaluate((wt) => window.klaus.git.status(wt), repo);
    expect(status.branch).toBe('main');
    const aRow = status.files.find((f) => f.file === 'a.txt');
    const bRow = status.files.find((f) => f.file === 'b.txt');
    expect(aRow).toBeTruthy();
    expect(aRow.staged).toBe(false);
    expect(bRow).toBeTruthy();
    expect(bRow.status).toBe('??');

    // Unstaged diff for a.txt: should mention the added 'four' line.
    const diff = await mainWindow.evaluate(
      ({ wt, file }) => window.klaus.git.diff(wt, file, false),
      { wt: repo, file: 'a.txt' },
    );
    expect(diff.diff).toContain('+four');

    // Stage a.txt, status flips to staged.
    await mainWindow.evaluate(
      ({ wt, files }) => window.klaus.git.stage(wt, files),
      { wt: repo, files: ['a.txt'] },
    );
    status = await mainWindow.evaluate((wt) => window.klaus.git.status(wt), repo);
    expect(status.files.find((f) => f.file === 'a.txt' && f.staged)).toBeTruthy();

    // Staged diff sees the change too.
    const stagedDiff = await mainWindow.evaluate(
      ({ wt, file }) => window.klaus.git.diff(wt, file, true),
      { wt: repo, file: 'a.txt' },
    );
    expect(stagedDiff.diff).toContain('+four');

    // Unstage flips it back.
    await mainWindow.evaluate(
      ({ wt, files }) => window.klaus.git.unstage(wt, files),
      { wt: repo, files: ['a.txt'] },
    );
    status = await mainWindow.evaluate((wt) => window.klaus.git.status(wt), repo);
    expect(status.files.find((f) => f.file === 'a.txt' && f.staged)).toBeFalsy();

    // Commit the change end-to-end.
    await mainWindow.evaluate(
      ({ wt, files }) => window.klaus.git.stage(wt, files),
      { wt: repo, files: ['a.txt'] },
    );
    const commit = await mainWindow.evaluate(
      ({ wt, msg }) => window.klaus.git.commit(wt, msg),
      { wt: repo, msg: 'add four' },
    );
    expect(commit.error).toBeFalsy();
    status = await mainWindow.evaluate((wt) => window.klaus.git.status(wt), repo);
    expect(status.files.find((f) => f.file === 'a.txt')).toBeFalsy();
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
