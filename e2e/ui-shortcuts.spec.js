// Global keyboard shortcuts wired in renderer/app.js document-keydown handlers:
//   Meta+G  -> App.btnDiff.click() toggles the diff panel (.visible on #diff-panel)
//   Meta+P  -> QuickOpen.show() (#quick-open-overlay) when a task/worktree is active
//   New Task modal (#modal-overlay) opens via the sidebar button and closes on
//   Escape (input-scoped handler) / Cancel.
// NOTE: preferences.js declares a `newTask: CmdOrCtrl+T` default, but no runtime
// handler registers it — Meta+T is currently a no-op (asserted below as a guard).
// Defaults confirmed in renderer/preferences.js; handlers in renderer/app.js.

const { test, expect } = require('./fixtures');
const { buildRepo, rm } = require('./helpers');

test.beforeEach(async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();
});

test('Meta+G toggles the diff panel', async ({ mainWindow }) => {
  const repo = buildRepo({ 'README.md': '# diff\n' }, 'shortcuts-diff');
  try {
    // The diff-panel toggle needs an active task with a worktree to render
    // against. Stub AppState the same way quick-open.spec does.
    await mainWindow.evaluate((wt) => {
      window.AppState.activeSessionName = null;
      window.AppState.activeTaskId = 9911;
      window.AppState.tasks.set(9911, { id: 9911, worktreePath: wt, branch: 'main' });
    }, repo);

    const panel = mainWindow.locator('#diff-panel');
    await expect(panel).not.toHaveClass(/\bvisible\b/);

    await mainWindow.keyboard.press('Meta+g');
    await expect(panel).toHaveClass(/\bvisible\b/);

    await mainWindow.keyboard.press('Meta+g');
    await expect(panel).not.toHaveClass(/\bvisible\b/);
  } finally {
    await mainWindow.evaluate(() => {
      if (window.DiffPanel && window.DiffPanel.isVisible && window.DiffPanel.isVisible()) {
        window.DiffPanel.hide();
      }
      window.AppState.activeTaskId = null;
      window.AppState.activeSessionName = null;
      window.AppState.tasks.delete(9911);
    });
    rm(repo);
  }
});

test('Meta+P opens the quick-open palette', async ({ mainWindow }) => {
  const repo = buildRepo(
    { 'README.md': '# r\n', 'src/auth.js': '', 'src/router.js': '' },
    'shortcuts-qo',
  );
  try {
    await mainWindow.evaluate((wt) => {
      window.AppState.activeTaskId = 9912;
      window.AppState.tasks.set(9912, { id: 9912, worktreePath: wt });
      window.QuickOpen.invalidate();
    }, repo);

    await mainWindow.keyboard.press('Meta+p');

    const overlay = mainWindow.locator('.quick-open-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.palette-input')).toBeFocused();

    await overlay.locator('.palette-input').press('Escape');
    await expect(overlay).toHaveCount(0);
  } finally {
    await mainWindow.evaluate(() => {
      window.AppState.activeTaskId = null;
      window.AppState.tasks.delete(9912);
      window.QuickOpen.invalidate();
    });
    rm(repo);
  }
});

test('New Task modal opens (button) and closes on Escape / Cancel; Meta+T is a no-op', async ({ mainWindow }) => {
  const overlay = mainWindow.locator('#modal-overlay');
  await expect(overlay).toBeHidden();

  // Guard: the declared CmdOrCtrl+T binding is never registered as a handler,
  // so the keystroke must not open the modal. If this ever fails, wire Meta+T
  // to App.showModal and update this assertion.
  await mainWindow.keyboard.press('Meta+t');
  await mainWindow.waitForTimeout(200);
  await expect(overlay).toBeHidden();

  // Real open path: the sidebar New Task button.
  await mainWindow.locator('#btn-new-task').click();
  await expect(overlay).toBeVisible();

  // Escape closes — the handler is scoped to #modal-input, which showModal
  // focuses. locator.press focuses the input first, guaranteeing it fires.
  await mainWindow.locator('#modal-input').press('Escape');
  await expect(overlay).toBeHidden();

  // Cancel button also closes.
  await mainWindow.locator('#btn-new-task').click();
  await expect(overlay).toBeVisible();
  await mainWindow.locator('#modal-cancel').click();
  await expect(overlay).toBeHidden();
});
