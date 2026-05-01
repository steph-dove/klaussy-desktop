// Playwright configuration for Electron e2e tests.
//
// The app is stateful (single Electron process per test, real userData dir),
// so workers stay at 1. Specs live in e2e/ — kept separate from test/ which
// is `node --test` unit tests run against main/util/*.

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'e2e',
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
