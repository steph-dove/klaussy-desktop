/* global window,document */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { test, expect } = require('./fixtures');

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control+Shift';

function focusedIn(page, selector) {
  return page.evaluate((sel) => !!document.activeElement.closest(sel), selector);
}

test.describe('keyboard navigation', () => {
  let tmpDir;
  let taskId;

  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.evaluate(() => {
      const kill = () => { const o = document.getElementById('ollama-consent-overlay'); if (o) o.remove(); };
      kill();
      new MutationObserver(kill).observe(document.documentElement, { childList: true, subtree: true });
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-kbd-'));
    taskId = await mainWindow.evaluate(async (dir) => {
      const inst = await window.klaus.task.openFolder(dir, 'shell');
      window.App.addTaskToUI(inst);
      window.App.switchToTask(inst.id);
      return inst.id;
    }, tmpDir);
    await expect.poll(() => focusedIn(mainWindow, '#terminal-area')).toBe(true);
  });

  test.afterEach(async ({ mainWindow }) => {
    await mainWindow.evaluate((id) => window.klaus.task.kill(id), taskId).catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('F6 leaves the terminal and cycles through the visible regions', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('F6');
    expect(await focusedIn(mainWindow, '#sidebar')).toBe(true);
    await expect(mainWindow.locator('.a11y-live[aria-live="polite"] > div').last()).toHaveText('Sidebar');

    await mainWindow.keyboard.press('F6');
    expect(await focusedIn(mainWindow, '#terminal-area .xterm')).toBe(true);

    await mainWindow.keyboard.press(`${MOD}+g`);
    await expect(mainWindow.locator('#diff-panel')).toHaveClass(/\bvisible\b/);
    await mainWindow.keyboard.press('F6');
    expect(await focusedIn(mainWindow, '#diff-panel')).toBe(true);

    await mainWindow.keyboard.press('Shift+F6');
    expect(await focusedIn(mainWindow, '#terminal-area .xterm')).toBe(true);
  });

  test('the palette shortcut in a terminal opens the palette and Escape returns to the terminal', async ({ mainWindow }) => {
    await mainWindow.keyboard.press(`${MOD}+k`);
    await expect(mainWindow.locator('.palette-overlay')).toBeVisible();
    await mainWindow.keyboard.press('Escape');
    await expect(mainWindow.locator('.palette-overlay')).toHaveCount(0);
    await expect.poll(() => focusedIn(mainWindow, '#terminal-area .xterm')).toBe(true);
  });

  test('Shift+F10 opens a keyboard-operable context menu', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Shift+F10');
    const menu = mainWindow.getByRole('menu');
    await expect(menu).toBeVisible();
    const items = menu.getByRole('menuitem');
    await expect(items.first()).toBeFocused();

    await mainWindow.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await mainWindow.keyboard.press('End');
    await expect(items.last()).toBeFocused();

    await mainWindow.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect(await focusedIn(mainWindow, '#terminal-area .xterm')).toBe(true);
  });
});
