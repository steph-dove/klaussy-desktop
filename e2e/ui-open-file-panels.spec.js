/* global window */
// Opening a file via window.openFileViewer (command palette, viewer back/forward)
// must leave only the Files panel showing, whichever diff-panel tab was active.

const { test, expect } = require('./fixtures');
const path = require('path');
const { buildRepo, rm } = require('./helpers');

test.beforeEach(async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();
  await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
});

const PANELS = ['changes', 'pr', 'files', 'search', 'history', 'plan', 'devloop', 'notes'];

test('openFileViewer leaves only the Files panel visible from any tab', async ({ mainWindow }) => {
  const taskId = 710000 + (process.pid % 100000);
  const repo = buildRepo({ 'a.txt': 'hello\n' }, 'ui-open-file-panels');

  try {
    await mainWindow.evaluate(({ wt, id }) => {
      window.AppState.activeTaskId = id;
      window.AppState.tasks.set(id, { id, worktreePath: wt, branch: 'main' });
    }, { wt: repo, id: taskId });
    await mainWindow.evaluate((wt) => window.DiffPanel.show(wt), repo);

    const exercised = [];
    for (const tab of ['changes', 'pr', 'search', 'history', 'plan', 'devloop', 'notes']) {
      const tabBtn = mainWindow.locator(`#diff-tabs .diff-tab[data-tab="${tab}"]`);
      // Dev Loop is hidden in some builds; every other tab must be present.
      if (tab === 'devloop' && !(await tabBtn.isVisible())) continue;
      exercised.push(tab);
      await tabBtn.click();
      await expect(mainWindow.locator(`#${tab}-tab-content`)).toBeVisible();
      await mainWindow.evaluate((p) => window.openFileViewer(p, 'a.txt'), path.join(repo, 'a.txt'));

      await expect(mainWindow.locator('#files-tab-content')).toBeVisible();
      await expect(mainWindow.locator('#diff-tabs .diff-tab[data-tab="files"]')).toHaveClass(/active/);
      await expect(tabBtn).not.toHaveClass(/active/);
      await expect(mainWindow.locator('#file-viewer-content')).toBeVisible();
      for (const p of PANELS.filter((x) => x !== 'files')) {
        const loc = mainWindow.locator(`#${p}-tab-content`);
        await expect(loc).toBeHidden();
      }
    }
    expect(exercised).toEqual(expect.arrayContaining(['changes', 'pr', 'search', 'history', 'plan', 'notes']));
  } finally {
    await mainWindow.evaluate((id) => {
      window.AppState.tasks.delete(id);
      window.AppState.activeTaskId = null;
      const closeBtn = document.getElementById('btn-diff');
      if (document.getElementById('diff-panel').classList.contains('visible') && closeBtn) closeBtn.click();
    }, taskId);
    rm(repo);
  }
});
