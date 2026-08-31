// The multi-pane layouts draw an accent ring around .terminal-container.active
// to show which pane has input. Entering columns/grid used to strip that class
// and never put it back, so the ring never drew.

/* global window, document */

const { test, expect } = require('./fixtures');

const A = 990101;
const B = 990102;

test('the focused pane is marked active in a multi-pane layout', async ({ mainWindow }) => {
  await mainWindow.waitForFunction(() => !!(window.TerminalManager && window.TerminalManager.addTaskToUI));

  try {
    await mainWindow.evaluate(({ a, b }) => {
      [a, b].forEach((id, i) => window.TerminalManager.addTaskToUI({
        id, name: 'pane-' + i, worktreePath: '/tmp/pane-' + id, branch: 'pane',
        repoPath: '/tmp/repo', mode: 'shell', alive: true,
      }));
      window.TerminalManager.setLayout('columns');
    }, { a: A, b: B });

    // Focusing a pane's xterm is what the app treats as making it current.
    const focused = await mainWindow.evaluate((id) => {
      const el = document.querySelector('.terminal-container[data-id="' + id + '"]');
      const textarea = el && el.querySelector('textarea');
      if (textarea) textarea.focus();
      return {
        focused: !!document.querySelector('.terminal-container[data-id="' + id + '"].active'),
        others: document.querySelectorAll('.terminal-container.active').length,
      };
    }, B);

    expect(focused.focused, 'the focused pane carries .active').toBe(true);
    expect(focused.others, 'only one pane is marked active').toBe(1);
  } finally {
    await mainWindow.evaluate(({ a, b }) => {
      window.TerminalManager.setLayout('single');
      [a, b].forEach((id) => { try { window.TerminalManager.removeTaskFromUI(id); } catch { /* already gone */ } });
    }, { a: A, b: B }).catch(() => {});
  }
});
