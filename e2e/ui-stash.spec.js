// Stash tab UI: with a dirty active worktree, the Stash tab's
// #stash-message + #btn-stash-push create a stash through the real
// StashPanel handlers, it renders in #stash-list, and the per-item Pop
// button (the UI's combined restore+drop) puts the change back and clears
// the list. git-history-stash.spec.js covers the IPC; this proves the wiring
// from the DOM controls down to git. NOTE: the panel exposes a single "Pop"
// button rather than separate Restore/Drop buttons — pop both restores the
// working-tree change and drops the stash entry, so that one control is what
// we exercise.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

function buildDirtyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-uistash-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  // Dirty a tracked file so there's something to stash.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  return dir;
}

// Reveal the Stash tab the way a tab click does: make the panel visible, mark
// the stash tab active, show its content (hiding the siblings), and run the
// real loader. Driven through window so the subsequent button interactions hit
// the genuine StashPanel handlers wired at module load.
async function openStashTab(mainWindow, repo, taskId) {
  await mainWindow.evaluate(({ wt, id }) => {
    window.AppState.activeTaskId = id;
    window.AppState.tasks.set(id, { id, worktreePath: wt, branch: 'main' });
    document.getElementById('diff-panel').classList.add('visible');
  }, { wt: repo, id: taskId });

  // The actual tab control — clicking is the user's gesture. (Its handler may
  // or may not toggle content on this build; the evaluate below enforces the
  // resulting state deterministically either way.)
  await mainWindow.locator('#diff-tabs .diff-tab[data-tab="stash"]').click();

  await mainWindow.evaluate(() => {
    document.querySelectorAll('#diff-tabs .diff-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === 'stash');
    });
    ['changes', 'pr', 'files', 'search', 'history', 'plan'].forEach(function (n) {
      var el = document.getElementById(n + '-tab-content');
      if (el) el.style.display = 'none';
    });
    document.getElementById('stash-tab-content').style.display = '';
    window.StashPanel.loadStash();
  });
}

test('Stash tab: push via UI, render in list, then Pop restores and clears', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();

  const repo = buildDirtyRepo();
  const taskId = 900000 + (process.pid % 100000);
  const stashMsg = 'ui-stash-' + Date.now();

  try {
    await openStashTab(mainWindow, repo, taskId);

    const stashTab = mainWindow.locator('#stash-tab-content');
    const list = mainWindow.locator('#stash-list');
    const messageInput = mainWindow.locator('#stash-message');
    const pushBtn = mainWindow.locator('#btn-stash-push');

    await expect(stashTab).toBeVisible();
    await expect(messageInput).toBeVisible();
    await expect(pushBtn).toBeVisible();
    // Nothing stashed yet — empty-state copy keys off the current branch.
    await expect(list.locator('.file-tree-empty')).toHaveText(/No stashes on main/);

    // Create a stash through the real controls.
    await messageInput.fill(stashMsg);
    await pushBtn.click();

    // The new stash renders as a .stash-item carrying our message.
    const item = list.locator('.stash-item');
    await expect(item).toHaveCount(1);
    await expect(item.locator('.stash-ref')).toHaveText('stash@{0}');
    await expect(item.locator('.stash-msg')).toContainText(stashMsg);
    // The push handler clears the input after stashing.
    await expect(messageInput).toHaveValue('');

    // Backend agrees: one stash, working tree clean.
    const afterPush = await mainWindow.evaluate(async (wt) => ({
      stashes: (await window.klaus.git.stashList(wt)).stashes,
      files: (await window.klaus.git.status(wt)).files,
    }), repo);
    expect(afterPush.stashes).toHaveLength(1);
    expect(afterPush.stashes[0].message).toContain(stashMsg);
    expect(afterPush.files).toEqual([]);

    // Pop = restore + drop, via the per-item button.
    await item.locator('.stash-pop-btn').click();

    // List returns to empty.
    await expect(list.locator('.stash-item')).toHaveCount(0);
    await expect(list.locator('.file-tree-empty')).toHaveText(/No stashes on main/);

    // Backend agrees: stash gone, the change is back in the working tree.
    const afterPop = await mainWindow.evaluate(async (wt) => ({
      stashes: (await window.klaus.git.stashList(wt)).stashes,
      files: (await window.klaus.git.status(wt)).files,
    }), repo);
    expect(afterPop.stashes).toEqual([]);
    expect(afterPop.files.find((f) => f.file === 'a.txt')).toBeTruthy();
  } finally {
    await mainWindow.evaluate((id) => {
      window.AppState.activeTaskId = null;
      window.AppState.tasks.delete(id);
      var panel = document.getElementById('diff-panel');
      if (panel) panel.classList.remove('visible');
    }, taskId);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
