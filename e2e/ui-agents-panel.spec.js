// Background-agents panel wiring: the always-visible #btn-agents toggles the
// #agents-panel dropdown (style.display), which shows the #agents-panel-empty
// "No active agents" state on a fresh launch, and #btn-agents-close hides it
// again. Also proves the Cmd/Ctrl+Shift+A shortcut toggles the same panel.
// Pure renderer wiring — no external services, fresh app = empty registry.

const { test, expect } = require('./fixtures');

test.beforeEach(async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();
});

test('Agents panel opens from the bar, shows empty state, and closes', async ({ mainWindow }) => {
  const panel = mainWindow.locator('#agents-panel');
  const empty = mainWindow.locator('#agents-panel-empty');

  // Trigger button is always present; panel starts hidden.
  await expect(mainWindow.locator('#btn-agents')).toBeVisible();
  await expect(panel).toBeHidden();

  await mainWindow.locator('#btn-agents').click();
  await expect(panel).toBeVisible();
  // No background agents on a fresh launch -> empty placeholder is shown.
  await expect(empty).toBeVisible();
  await expect(empty).toHaveText('No active agents');
  await expect(mainWindow.locator('#agents-panel-list')).toBeEmpty();

  await mainWindow.locator('#btn-agents-close').click();
  await expect(panel).toBeHidden();
});

test('Cmd/Ctrl+Shift+A toggles the agents panel', async ({ mainWindow }) => {
  const panel = mainWindow.locator('#agents-panel');
  await expect(panel).toBeHidden();

  // The keydown handler accepts metaKey || ctrlKey; one modifier toggles
  // once (pressing both would toggle twice and cancel out).
  await mainWindow.locator('body').click();
  await mainWindow.keyboard.press('Meta+Shift+A');
  await expect(panel).toBeVisible();

  await mainWindow.keyboard.press('Meta+Shift+A');
  await expect(panel).toBeHidden();
});
