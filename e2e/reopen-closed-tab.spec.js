/* global window */
const { test, expect } = require('./fixtures');
const { buildRepo, rm } = require('./helpers');

async function openShellTask(page, repo) {
  return page.evaluate(async (r) => {
    const res = await window.klaus.task.attachWorktree(r, 'shell', r, 'main');
    window.App.addTaskToUI(res);
    window.App.switchToTask(res.id);
    return res.id;
  }, repo);
}

function openTaskPaths(page) {
  return page.evaluate(() => Array.from(window.AppState.tasks.values()).map((t) => t.worktreePath));
}

test.describe('reopen closed tab', () => {
  test('Cmd/Ctrl+Shift+T reopens the tab closed from the sidebar', async ({ mainWindow }) => {
    const repo = buildRepo({ 'README.md': '# reopen\n' }, 'reopen-tab');
    try {
      const id = await openShellTask(mainWindow, repo);
      await mainWindow.locator('.task-item[data-id="' + id + '"] .task-close').click();
      await expect.poll(() => openTaskPaths(mainWindow)).not.toContain(repo);

      await mainWindow.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+t' : 'Control+Shift+t');
      await expect.poll(() => openTaskPaths(mainWindow)).toContain(repo);
      const reopened = await mainWindow.evaluate((r) => {
        const t = Array.from(window.AppState.tasks.values()).find((x) => x.worktreePath === r);
        return { mode: t.mode, active: window.AppState.activeTaskId === t.id, left: window.AppState.closedTasks.length };
      }, repo);
      expect(reopened).toEqual({ mode: 'shell', active: true, left: 0 });
    } finally {
      await mainWindow.evaluate(async () => {
        for (const t of Array.from(window.AppState.tasks.values())) {
          await window.klaus.task.kill(t.id);
          window.App.removeTaskFromUI(t.id);
        }
        window.AppState.closedTasks = [];
      });
      rm(repo);
    }
  });

  test('a deleted session is not offered for reopening', async ({ mainWindow }) => {
    const out = await mainWindow.evaluate(() => {
      window.AppState.closedTasks = [
        { worktreePath: '/tmp/kept', mode: 'shell' },
        { worktreePath: '/tmp/deleted', mode: 'claude' },
      ];
      window.App.forgetClosedTasks(['/tmp/deleted']);
      const left = window.AppState.closedTasks.map((r) => r.worktreePath);
      window.AppState.closedTasks = [];
      return left;
    });
    expect(out).toEqual(['/tmp/kept']);
  });
});
