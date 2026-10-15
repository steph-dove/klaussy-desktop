// Command Palette (Cmd+K) — distinct from quick-open (Cmd+P). Drives the real
// renderer: App.showCommandPalette() builds the command list and CommandPalette.show
// mounts a .palette-overlay. Proves the overlay appears, lists known commands,
// filters live as you type, Enter runs the selected command (Change Theme ->
// the #theme-overlay surfaces), and Escape tears the palette down. Targets the
// palette's own .palette-overlay/.palette-item, never a shared backdrop class.

const { test, expect } = require('./fixtures');

test.beforeEach(async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();
});

test('command palette opens, lists commands, and Escape closes', async ({ mainWindow }) => {
  const overlay = mainWindow.locator('.palette-overlay');

  await mainWindow.evaluate(() => window.App.showCommandPalette());
  await expect(overlay).toBeVisible();
  await expect(mainWindow.locator('.palette-input')).toBeFocused();

  const items = mainWindow.locator('.palette-overlay .palette-item');
  await expect(items.filter({ hasText: 'New Task' })).toHaveCount(1);
  await expect(items.filter({ hasText: 'Change Theme' })).toHaveCount(1);

  await mainWindow.locator('.palette-input').press('Escape');
  await expect(overlay).toBeHidden();
});

test('command palette filters the list as you type', async ({ mainWindow }) => {
  const overlay = mainWindow.locator('.palette-overlay');

  await mainWindow.evaluate(() => window.App.showCommandPalette());
  await expect(overlay).toBeVisible();

  const items = mainWindow.locator('.palette-overlay .palette-item');
  const total = await items.count();
  expect(total).toBeGreaterThan(1);

  await mainWindow.locator('.palette-input').fill('theme');
  // Only the Change Theme entry survives the substring filter.
  await expect(items).toHaveCount(1);
  await expect(items.first()).toHaveText('Change Theme');

  // A query that matches nothing empties the list without closing the palette.
  await mainWindow.locator('.palette-input').fill('zzz-no-such-command');
  await expect(items).toHaveCount(0);
  await expect(overlay).toBeVisible();

  await mainWindow.locator('.palette-input').press('Escape');
  await expect(overlay).toBeHidden();
});

test('Enter executes the selected command (Change Theme opens the theme picker)', async ({ mainWindow }) => {
  const overlay = mainWindow.locator('.palette-overlay');
  const themeOverlay = mainWindow.locator('#theme-overlay');

  // Make sure the theme picker starts closed so the assertion is meaningful.
  await expect(themeOverlay).toBeHidden();

  await mainWindow.evaluate(() => window.App.showCommandPalette());
  await expect(overlay).toBeVisible();

  // Filter down to a single command then Enter runs it and closes the palette.
  await mainWindow.locator('.palette-input').fill('Change Theme');
  await expect(mainWindow.locator('.palette-overlay .palette-item')).toHaveCount(1);
  await mainWindow.locator('.palette-input').press('Enter');

  await expect(overlay).toBeHidden();
  await expect(themeOverlay).toBeVisible();
  await expect(mainWindow.locator('#theme-list .theme-option').first()).toBeVisible();

  // Clean up: close the theme picker so other tests start from a clean slate.
  await mainWindow.locator('#theme-close').click();
  await expect(themeOverlay).toBeHidden();
});

test('selecting a filtered command runs it (New Task modal)', async ({ mainWindow }) => {
  const overlay = mainWindow.locator('.palette-overlay');
  const modal = mainWindow.locator('#modal-overlay');

  await expect(modal).toBeHidden();
  await mainWindow.evaluate(() => window.App.showCommandPalette());
  await expect(overlay).toBeVisible();

  // Filter to the single "New Task" entry, then run it from the keyboard.
  await mainWindow.locator('.palette-input').fill('New Task');
  await expect(mainWindow.locator('.palette-overlay .palette-item')).toHaveCount(1);
  await mainWindow.locator('.palette-input').press('Enter');

  await expect(overlay).toBeHidden();
  await expect(modal).toBeVisible();

  await mainWindow.locator('#modal-cancel').click();
  await expect(modal).toBeHidden();
});

test('arrow keys keep the selected command in view; hover does not scroll', async ({ mainWindow }) => {
  const overlay = mainWindow.locator('.palette-overlay');
  const list = mainWindow.locator('.palette-overlay .palette-list');
  const input = mainWindow.locator('.palette-input');

  // Synthetic commands so the list overflows its max-height no matter how many
  // real commands exist.
  await mainWindow.evaluate(() => {
    const commands = [];
    for (let i = 1; i <= 40; i++) commands.push({ label: 'Scroll test command ' + i, action() {} });
    window.CommandPalette.show(commands);
  });
  await expect(overlay).toBeVisible();
  await expect(input).toBeFocused();

  const overflows = await list.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(overflows).toBe(true);

  // toBeInViewport checks the page viewport, not the scroll container, so
  // compare the selected row's rect against the list's rect.
  const selectedInView = () => list.evaluate((el) => {
    const sel = el.querySelector('.palette-item.selected');
    const a = el.getBoundingClientRect();
    const b = sel.getBoundingClientRect();
    return b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
  });

  for (let i = 0; i < 25; i++) await input.press('ArrowDown');
  await expect(mainWindow.locator('.palette-item.selected')).toHaveText('Scroll test command 26');
  expect(await selectedInView()).toBe(true);

  for (let i = 0; i < 25; i++) await input.press('ArrowUp');
  await expect(mainWindow.locator('.palette-item.selected')).toHaveText('Scroll test command 1');
  expect(await selectedInView()).toBe(true);

  const before = await list.evaluate((el) => el.scrollTop);
  await mainWindow.locator('.palette-item', { hasText: /^Scroll test command 3$/ }).hover();
  await expect(mainWindow.locator('.palette-item.selected')).toHaveText('Scroll test command 3');
  expect(await list.evaluate((el) => el.scrollTop)).toBe(before);

  await input.press('Escape');
  await expect(overlay).toBeHidden();
});
