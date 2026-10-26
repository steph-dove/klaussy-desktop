// Opening a file via window.openFileViewer (command palette, viewer back/forward)
// must leave only the Files panel showing, whichever diff-panel tab was active.

const { test, expect } = require('./fixtures');
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

    for (const tab of ['history', 'plan', 'devloop', 'notes']) {
      const tabBtn = mainWindow.locator(`#diff-tabs .diff-tab[data-tab="${tab}"]`);
      if (!(await tabBtn.isVisible())) continue;
      await tabBtn.click();
      await mainWindow.evaluate((p) => window.openFileViewer(p, 'a.txt'), repo + '/a.txt');

      await expect(mainWindow.locator('#files-tab-content')).toBeVisible();
      for (const p of PANELS.filter((x) => x !== 'files')) {
        const loc = mainWindow.locator(`#${p}-tab-content`);
        if (await loc.count()) await expect(loc).toBeHidden();
      }
    }
  } finally {
    rm(repo);
  }
});
