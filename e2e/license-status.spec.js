// License is intentionally dormant in the shipping build ("free for individual
// use — no access-key gate", renderer/app-functions-1.js), so there is no
// license UI path to drive. What remains worth guarding is the IPC contract +
// that a seeded config.json is honored on launch (the configSeed fixture seam
// the mocked specs rely on). Two tests: default (unlicensed/dev-bypass) and a
// seeded-activated license.

const { test, expect } = require('./fixtures');

test('license status is reachable and shape-stable by default', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  const status = await mainWindow.evaluate(() => window.klaus.license.status());
  expect(status).toBeTruthy();
  expect(typeof status.activated).toBe('boolean');
  // Dev/unpackaged build bypasses the gate, so the app is always usable.
  expect(status.activated).toBe(true);
});

test.describe('with a seeded activated license', () => {
  test.use({ configSeed: { license: { key: 'seeded-key', instanceId: 'seed-inst', activatedAt: 1718000000000, lastVerified: 4102444800000, email: 'seed@e2e.test', variantName: 'Pro' } } });

  test('config.json license seed is honored at launch', async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    const status = await mainWindow.evaluate(() => window.klaus.license.status());
    expect(status.activated).toBe(true);
    // The seeded email/variant flow through from config into the status object.
    expect(status.email).toBe('seed@e2e.test');
    expect(status.variantName).toBe('Pro');
  });
});
