// History + stash IPCs: git log returns parsed commit metadata, git
// stash push/list/pop round-trip. Pins the shape of the data the
// history and stash panels render against.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

function buildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-hist-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '.'); git('commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  git('add', '.'); git('commit', '-q', '-m', 'second');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  git('add', '.'); git('commit', '-q', '-m', 'third');
  return dir;
}

test('git log returns parsed commit metadata', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  const repo = buildRepo();
  try {
    const result = await mainWindow.evaluate(
      ({ wt, n }) => window.klaus.git.log(wt, n),
      { wt: repo, n: 10 },
    );
    expect(result.error).toBeUndefined();
    expect(result.commits).toHaveLength(3);

    const [head, mid, root] = result.commits;
    expect(head.subject).toBe('third');
    expect(mid.subject).toBe('second');
    expect(root.subject).toBe('first');

    expect(head.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(head.short).toMatch(/^[0-9a-f]{7,12}$/);
    expect(head.author).toBe('e2e');
    expect(head.date).toBeTruthy();
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('git stash push, list, pop round-trip', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  const repo = buildRepo();
  try {
    // Dirty the working tree.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n');

    let list = await mainWindow.evaluate((wt) => window.klaus.git.stashList(wt), repo);
    expect(list.stashes).toEqual([]);

    const pushRes = await mainWindow.evaluate(
      ({ wt, msg }) => window.klaus.git.stashPush(wt, msg),
      { wt: repo, msg: 'wip-e2e' },
    );
    expect(pushRes.error).toBeFalsy();

    list = await mainWindow.evaluate((wt) => window.klaus.git.stashList(wt), repo);
    expect(list.stashes).toHaveLength(1);
    expect(list.stashes[0].ref).toBe('stash@{0}');
    expect(list.stashes[0].message).toContain('wip-e2e');

    // Working tree is clean after the stash.
    let status = await mainWindow.evaluate((wt) => window.klaus.git.status(wt), repo);
    expect(status.files).toEqual([]);

    // Pop puts the change back, removes the stash.
    const popRes = await mainWindow.evaluate(
      ({ wt }) => window.klaus.git.stashPop(wt, 0),
      { wt: repo },
    );
    expect(popRes.error).toBeFalsy();

    status = await mainWindow.evaluate((wt) => window.klaus.git.status(wt), repo);
    expect(status.files.find((f) => f.file === 'a.txt')).toBeTruthy();

    list = await mainWindow.evaluate((wt) => window.klaus.git.stashList(wt), repo);
    expect(list.stashes).toEqual([]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
