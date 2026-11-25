// Playwright configuration for Electron e2e tests.
//
// The app is stateful (single Electron process per test, real userData dir),
// so workers stay at 1. Specs live in e2e/ — kept separate from test/ which
// is `node --test` unit tests run against main/util/*.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { defineConfig } = require('@playwright/test');

// The app only lets the renderer work in folders it already knows (projects,
// recent folders, worktrees: main/util/ipc-guard.js), and specs make their
// repos with mkdtemp under os.tmpdir(). Point TMPDIR at one root per run, and
// e2e/fixtures.js seeds that root as a recent folder, so every spec's temp
// repo is known the way a folder the person opened is. Workers inherit the env
// and reuse the runner's root.
if (!process.env.MAUSSIAN_E2E_ROOT) {
  process.env.MAUSSIAN_E2E_SYSTEM_TMP = os.tmpdir();
  process.env.MAUSSIAN_E2E_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maussian-e2e-root-')));
  process.env.TMPDIR = process.env.MAUSSIAN_E2E_ROOT;
}

module.exports = defineConfig({
  testDir: 'e2e',
  globalTeardown: require.resolve('./e2e/global-teardown.js'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});
