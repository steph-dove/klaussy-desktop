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

  test('a shell tab closed inside a session comes back as a tab on it', async ({ mainWindow }) => {
    const repo = buildRepo({ 'README.md': '# sub\n' }, 'reopen-sub');
    try {
      const id = await openShellTask(mainWindow, repo);
      await mainWindow.evaluate((taskId) => window.TerminalManager.reopenSubAgents(taskId, [{ mode: 'shell' }]), id);
      const subTabs = mainWindow.locator('.sub-tab[data-sub-id]:not([data-sub-id="0"])');
      await expect(subTabs).toHaveCount(1);
      await subTabs.first().locator('.sub-tab-close').click();
      await expect(subTabs).toHaveCount(0);

      await mainWindow.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+t' : 'Control+Shift+t');
      await expect(subTabs).toHaveCount(1);
      expect(await mainWindow.evaluate(() => ({
        tasks: window.AppState.tasks.size, left: window.AppState.closedTasks.length,
      }))).toEqual({ tasks: 1, left: 0 });
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

  test('a worktree saved with two agents resumes as one task with a tab', async ({ mainWindow }) => {
    const repo = buildRepo({ 'README.md': '# two\n' }, 'resume-two');
    try {
      const out = await mainWindow.evaluate(async (r) => {
        const saved = { worktreePath: r, repoPath: r, branch: 'main', mode: 'shell' };
        const res = await window.App.resumeAllSavedAgents({ path: r, savedAgents: [saved, { ...saved, mode: 'codex', sessionId: 'c1' }] });
        return { tabs: res.subAgentsToReopen, tasks: (await window.klaus.task.list()).filter((t) => t.worktreePath === r).length };
      }, repo);
      expect(out).toEqual({ tabs: [{ mode: 'codex', label: null, sessionId: 'c1' }], tasks: 1 });
    } finally {
      await mainWindow.evaluate(async () => {
        for (const t of await window.klaus.task.list()) await window.klaus.task.kill(t.id);
      });
      rm(repo);
    }
  });

  test('a failed reopen keeps the tab so the shortcut can retry it', async ({ mainWindow }) => {
    const left = await mainWindow.evaluate(async () => {
      window.AppState.closedTasks = [{ worktreePath: '/nonexistent/klaussy-reopen', mode: 'claude', name: 'gone' }];
      await window.App.reopenClosedTask();
      const out = window.AppState.closedTasks.map((r) => r.worktreePath);
      window.AppState.closedTasks = [];
      return out;
    });
    expect(left).toEqual(['/nonexistent/klaussy-reopen']);
  });

  test('a tab that is already open again is skipped, not opened twice', async ({ mainWindow }) => {
    const repo = buildRepo({ 'README.md': '# dup\n' }, 'reopen-dup');
    try {
      await openShellTask(mainWindow, repo);
      const out = await mainWindow.evaluate(async (r) => {
        window.AppState.closedTasks = [{ worktreePath: r, mode: 'shell', repoPath: r, branch: 'main' }];
        const before = window.AppState.tasks.size;
        await window.App.reopenClosedTask();
        return { added: window.AppState.tasks.size - before, left: window.AppState.closedTasks.length };
      }, repo);
      expect(out).toEqual({ added: 0, left: 0 });
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
