// Custom Playwright fixture that boots the real Electron app with a fresh
// per-test userData dir. Mirrors the approach test/setup.js uses for unit
// tests — keeps config / license / history / sessions hermetic across runs.
//
// Usage:
//   const { test, expect } = require('./fixtures');
//   test('boots', async ({ electronApp, mainWindow }) => { ... });

const path = require('path');
const fs = require('fs');
const os = require('os');
const { test: base, expect, _electron: electron } = require('@playwright/test');

const repoRoot = path.resolve(__dirname, '..');

const test = base.extend({
  electronApp: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-'));
    const app = await electron.launch({
      args: [path.join(repoRoot, 'main.js'), `--user-data-dir=${userDataDir}`],
      cwd: repoRoot,
      env: {
        ...process.env,
        KLAUSSY_E2E: '1',
        ELECTRON_ENABLE_LOGGING: '1',
      },
    });
    await use(app);
    await app.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  },

  mainWindow: async ({ electronApp }, use) => {
    const win = await electronApp.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});

module.exports = { test, expect };
