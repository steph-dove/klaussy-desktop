// Smoke test: app boots, main window renders, no console errors.
//
// If this fails, we've broken something fundamental — main.js wiring, IPC
// handler registration, or the renderer's index.html load path. Keep it
// cheap and stable; richer flows go in their own specs.

const { test, expect } = require('./fixtures');

test('app launches with main window and no console errors', async ({ electronApp, mainWindow }) => {
  const errors = [];
  mainWindow.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  mainWindow.on('pageerror', (err) => errors.push(err.message));

  await expect(mainWindow).toHaveTitle(/Klaussy|Klaus/i);

  const title = await electronApp.evaluate(({ app }) => app.getName());
  expect(title).toBe('Klaussy');

  await mainWindow.waitForLoadState('networkidle');

  expect(errors, `Renderer console errors:\n${errors.join('\n')}`).toEqual([]);
});
