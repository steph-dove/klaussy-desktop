// Theme switching: changing the theme preset must update the CSS custom
// properties on the renderer's :root and persist to config.json. Catches
// theme.js regressions where presets stop applying or the IPC contract
// drifts from what the renderer expects.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

function readConfig(userDataDir) {
  const cfg = path.join(userDataDir, 'config.json');
  if (!fs.existsSync(cfg)) return {};
  try { return JSON.parse(fs.readFileSync(cfg, 'utf-8')); } catch { return {}; }
}

async function readBg(win) {
  return win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
}

test('switching theme preset updates --bg and persists', async ({ mainWindow, userDataDir }) => {
  await mainWindow.waitForLoadState('networkidle');

  // Each preset has a distinct --bg; verify two we can tell apart.
  await mainWindow.evaluate(() => window.ThemeManager.apply('monokai'));
  await expect.poll(() => readBg(mainWindow), { timeout: 2000 }).toBe('#272822');

  await mainWindow.evaluate(() => window.ThemeManager.apply('nord'));
  await expect.poll(() => readBg(mainWindow), { timeout: 2000 }).toBe('#2e3440');

  // setTheme is fire-and-forget from apply(); poll config until it lands.
  await expect.poll(() => readConfig(userDataDir).theme && readConfig(userDataDir).theme.preset, {
    timeout: 5000,
  }).toBe('nord');
});
