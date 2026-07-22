// Several callers can fire addTaskToUI twice for one id; guard must re-focus, not render a second pane.

/* global window, document */

const { test, expect } = require('./fixtures');

test('addTaskToUI twice for one id renders a single terminal pane', async ({ mainWindow }) => {
  await mainWindow.waitForFunction(() => !!(window.TerminalManager && window.TerminalManager.addTaskToUI));

  const count = await mainWindow.evaluate(() => {
    const id = 990001;
    const task = {
      id, name: 'dedupe', worktreePath: '/tmp/dedupe', branch: 'dedupe',
      repoPath: '/tmp/repo', mode: 'shell', alive: true,
    };
    try {
      window.TerminalManager.addTaskToUI(task);
      window.TerminalManager.addTaskToUI(task);
      return document.querySelectorAll('.terminal-container[data-id="' + id + '"]').length;
    } finally {
      try { window.TerminalManager.removeTaskFromUI(id); } catch {}
    }
  });

  expect(count).toBe(1);
});
