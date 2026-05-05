// Preferences round-trip: open the prefs window, change font size, assert
// it persists to config.json and reappears on a fresh open. Exercises the
// full preload bridge + IPC + saveConfig + atomic-write path without
// needing a project or git state.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

function readConfig(userDataDir) {
  const cfg = path.join(userDataDir, 'config.json');
  if (!fs.existsSync(cfg)) return {};
  try { return JSON.parse(fs.readFileSync(cfg, 'utf-8')); } catch { return {}; }
}

async function openPrefs(electronApp, mainWindow) {
  const [prefsWin] = await Promise.all([
    electronApp.waitForEvent('window'),
    mainWindow.evaluate(() => window.klaus.ui.openPreferences()),
  ]);
  await prefsWin.waitForLoadState('domcontentloaded');
  return prefsWin;
}

test('preferences font size persists across window reopen', async ({ electronApp, mainWindow, userDataDir }) => {
  await mainWindow.waitForLoadState('networkidle');

  const prefsWin = await openPrefs(electronApp, mainWindow);
  const fontSize = prefsWin.locator('#pref-font-size');
  await expect(fontSize).toBeVisible();

  await fontSize.fill('17');
  await fontSize.dispatchEvent('change');

  // 300ms debounce + IPC round-trip; poll instead of sleeping.
  await expect.poll(() => readConfig(userDataDir).fontSize, { timeout: 5000 }).toBe(17);

  await prefsWin.close();

  const prefsWin2 = await openPrefs(electronApp, mainWindow);
  await expect(prefsWin2.locator('#pref-font-size')).toHaveValue('17');
  await prefsWin2.close();
});
