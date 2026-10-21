// UI-driven navigation: clicking real sidebar controls opens the right
// modal/overlay and closes it again. No external services needed — pure
// renderer wiring. Each test targets a specific overlay id (not the shared
// backdrop class) so an async first-run dialog can't pollute assertions.

const { test, expect } = require('./fixtures');

test.beforeEach(async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();
});

test('New Task modal opens from the sidebar and cancels closed', async ({ mainWindow }) => {
  const overlay = mainWindow.locator('#modal-overlay');
  await mainWindow.locator('#btn-new-task').click();
  await expect(overlay).toBeVisible();
  // Defaults to the "new worktree" tab.
  await expect(mainWindow.locator('#tab-new')).toHaveClass(/active/);
  await mainWindow.locator('#modal-cancel').click();
  await expect(overlay).toBeHidden();
});

test('New Task modal switches between New and Existing tabs', async ({ mainWindow }) => {
  await mainWindow.locator('#btn-new-task').click();
  await expect(mainWindow.locator('#modal-overlay')).toBeVisible();

  // Tab buttons carry data-tab; clicking flips the active content pane.
  await mainWindow.locator('#modal .modal-tab[data-tab="existing"]').click();
  await expect(mainWindow.locator('#tab-existing')).toHaveClass(/active/);
  await mainWindow.locator('#modal .modal-tab[data-tab="new"]').click();
  await expect(mainWindow.locator('#tab-new')).toHaveClass(/active/);

  await mainWindow.locator('#modal-cancel').click();
  await expect(mainWindow.locator('#modal-overlay')).toBeHidden();
});

test('Open Folder directory picker opens and cancels', async ({ mainWindow }) => {
  const overlay = mainWindow.locator('#dir-pick-overlay');
  await mainWindow.locator('#btn-open-folder').click();
  await expect(overlay).toBeVisible();
  await expect(mainWindow.locator('#dir-pick-input')).toBeVisible();
  await mainWindow.locator('#dir-pick-cancel').click();
  await expect(overlay).toBeHidden();
});

test('Theme picker opens, lists themes, and closes', async ({ mainWindow }) => {
  const overlay = mainWindow.locator('#theme-overlay');
  await mainWindow.locator('#btn-theme').click();
  await expect(overlay).toBeVisible();
  // Several preset rows render; selecting one marks it active.
  const options = mainWindow.locator('#theme-list .theme-option');
  await expect(options.first()).toBeVisible();
  await options.nth(1).click();
  await expect(options.nth(1)).toHaveClass(/active/);
  await mainWindow.locator('#theme-close').click();
  await expect(overlay).toBeHidden();
});

test('Manage Sessions modal opens and closes', async ({ mainWindow }) => {
  const overlay = mainWindow.locator('#sessions-modal-overlay');
  await mainWindow.locator('#btn-manage-sessions').click();
  await expect(overlay).toBeVisible();
  await mainWindow.locator('#sessions-modal-close').click();
  await expect(overlay).toBeHidden();
});

test('Manage Sessions modal retries after a failed load', async ({ mainWindow }) => {
  // window.klaus is frozen, so fail the first load by wrapping the App-level loader.
  await mainWindow.evaluate(() => {
    const orig = App.getDiscoveredWorktrees;
    let failed = false;
    App.getDiscoveredWorktrees = function () {
      if (!failed) { failed = true; return Promise.reject(new Error('boom')); }
      return orig.apply(this, arguments);
    };
  });
  await mainWindow.locator('#btn-manage-sessions').click();
  const list = mainWindow.locator('#sessions-modal-list');
  await expect(list).toContainText('Could not load sessions');
  const retry = list.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeFocused();
  await retry.click();
  await expect(list).not.toContainText('Could not load sessions');
  await expect(retry).toHaveCount(0);
  await expect(list).not.toContainText('Loading');
});

test('Sidebar collapse toggle flips state', async ({ mainWindow }) => {
  // toggleSidebar() flips #sidebar.collapsed and swaps the label Hide<->Show.
  const sidebar = mainWindow.locator('#sidebar');
  const label = mainWindow.locator('#sidebar-toggle-label');
  await mainWindow.locator('#btn-sidebar-toggle').click();
  await expect(sidebar).toHaveClass(/collapsed/);
  await expect(label).toHaveText('Show');
  await mainWindow.locator('#btn-sidebar-toggle').click();
  await expect(sidebar).not.toHaveClass(/collapsed/);
  await expect(label).toHaveText('Hide');
});
