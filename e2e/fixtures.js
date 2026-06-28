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
  // Option fixtures — override per spec/test with test.use({ ... }).
  // configSeed: object written to config.json BEFORE launch (agent paths,
  // license state, ollamaUrl, etc). extraEnv: env vars merged into the launch
  // environment (e.g. PATH with a fake-bin dir, KLAUSSY_FORCE_LICENSE_GATE).
  configSeed: [ {}, { option: true } ],
  extraEnv: [ {}, { option: true } ],

  userDataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-'));
    await use(dir);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  },

  electronApp: async ({ userDataDir, configSeed, extraEnv }, use) => {
    if (configSeed && Object.keys(configSeed).length) {
      // schemaVersion stamped so startup migrations leave the seed untouched.
      fs.writeFileSync(
        path.join(userDataDir, 'config.json'),
        JSON.stringify({ schemaVersion: 2, ...configSeed }, null, 2),
      );
    }
    const app = await electron.launch({
      args: [path.join(repoRoot, 'main.js'), `--user-data-dir=${userDataDir}`],
      cwd: repoRoot,
      env: {
        ...process.env,
        KLAUSSY_E2E: '1',
        ELECTRON_ENABLE_LOGGING: '1',
        ...extraEnv,
      },
    });
    await use(app);
    await app.close();
  },

  mainWindow: async ({ electronApp }, use) => {
    const win = await electronApp.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    // The first-run "Setup check" dialog (#deps-overlay, from about-log.js)
    // pops async whenever gh / an agent CLI is missing — always true in CI —
    // and as a full-screen .palette-overlay it intercepts every click, timing
    // out otherwise-fine interactions. Tests don't exercise that dialog, so
    // remove it on sight (now + whenever it's (re)added) for the whole suite.
    await win.evaluate(() => {
      const kill = () => { const o = document.getElementById('deps-overlay'); if (o) o.remove(); };
      kill();
      new MutationObserver(kill).observe(document.documentElement, { childList: true, subtree: true });
    });
    await use(win);
  },
});

module.exports = { test, expect };
