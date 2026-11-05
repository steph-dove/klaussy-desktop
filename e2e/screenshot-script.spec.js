// scripts/screenshot.js: launch() gets past the Setup check to a loaded Files tab, and a
// right-click on a tree row opens its menu, which is what plans screenshot.

const { test, expect } = require('@playwright/test');
const { launch } = require('../scripts/screenshot');

test('launch() opens the Files tab on a sample repo with no Setup check', async () => {
  const { win, close } = await launch();
  try {
    await expect(win.locator('#deps-overlay')).toHaveCount(0);
    await expect(win.locator('#files-tab-content')).toBeVisible();
    await expect(win.locator('#file-tree .file-tree-label[data-path="src"]')).toBeVisible();
    await win.locator('#file-tree .file-tree-label[data-path="src"]').click({ button: 'right' });
    await expect(win.locator('.context-menu .context-menu-item', { hasText: 'New File' }))
      .toBeVisible();
  } finally {
    await close();
  }
});

test('launch() refuses a repo path that is not a folder', async () => {
  await expect(launch({ repo: '/no/such/folder' })).rejects.toThrow("isn't a folder");
});
