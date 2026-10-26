// History tab in a repo with no commits: git log fails with "does not have any
// commits yet", which the main process turns into an empty list, so the pane
// shows "No commits yet" instead of git's raw error.

const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');
const { tmpDir, rm } = require('./helpers');

test('History tab shows an empty state in a repo with no commits', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();

  const repo = tmpDir('history-empty');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
  try {
    // The History loader reads the active task's worktree from AppState.
    await mainWindow.evaluate((wt) => {
      window.AppState.activeTaskId = 'history-empty';
      window.AppState.tasks.set('history-empty', { id: 'history-empty', worktreePath: wt });
      return window.DiffPanel.show(wt);
    }, repo);
    await expect(mainWindow.locator('#diff-panel')).toBeVisible();
    await mainWindow.locator('#diff-tabs .diff-tab[data-tab="history"]').click();
    await expect(mainWindow.locator('#history-tab-content')).toBeVisible();

    const list = mainWindow.locator('#history-list');
    await expect(list).toContainText('No commits yet');
    await expect(list).not.toContainText('Command failed');
    await expect(list.locator('.history-item')).toHaveCount(0);
    if (process.env.QA_SHOT) await mainWindow.screenshot({ path: process.env.QA_SHOT });
  } finally {
    await mainWindow.evaluate(() => {
      window.AppState.activeTaskId = null;
      window.AppState.tasks.delete('history-empty');
    }).catch(() => {});
    rm(repo);
  }
});
