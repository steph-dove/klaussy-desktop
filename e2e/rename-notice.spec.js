// The one-time "Klaussy is now Maussian" card. E2E runs never use a Klaussy
// folder, so the main-process answer is stubbed to what an upgraded Mac with a
// saved Azure DevOps org would get.

const { test, expect } = require('./fixtures');

test('the rename card offers to reconnect Azure DevOps with the org filled in', async ({ electronApp, mainWindow }) => {
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('rename-notice-get');
    ipcMain.handle('rename-notice-get', () => ({
      reconnect: [{ collectionUrl: 'https://dev.azure.com/acme', collectionPath: '/acme', host: 'dev.azure.com' }],
    }));
  });
  await mainWindow.evaluate(() => { window.Dialogs.showRenameNotice(); });

  const card = mainWindow.locator('.rename-card');
  await expect(card.getByRole('heading', { name: 'Hey! Klaussy is now Maussian' })).toBeVisible();
  const reconnect = card.getByRole('button', { name: 'Reconnect Azure DevOps' });
  await expect(reconnect).toBeFocused();
  if (process.env.RENAME_SHOT) await mainWindow.screenshot({ path: process.env.RENAME_SHOT });

  await reconnect.click();
  await expect(mainWindow.locator('#az-url-input')).toHaveValue('https://dev.azure.com/acme');
  await mainWindow.locator('#az-cancel-btn').click();

  await card.getByRole('button', { name: 'Got it' }).click();
  await expect(card).toHaveCount(0);
});

test('a fresh install gets no card', async ({ mainWindow }) => {
  await mainWindow.waitForTimeout(1500);
  await expect(mainWindow.locator('.rename-card')).toHaveCount(0);
});
