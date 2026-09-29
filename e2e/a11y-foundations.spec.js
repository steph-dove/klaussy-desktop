/* global window,document */

const { test, expect } = require('./fixtures');

test.describe('a11y foundations', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await expect(mainWindow.locator('#btn-theme')).toBeVisible();
    await mainWindow.evaluate(() => {
      const o = document.getElementById('ollama-consent-overlay');
      if (o) o.style.display = 'none';
    });
  });

  test('theme picker is a labelled modal dialog that traps and restores focus', async ({ mainWindow }) => {
    await mainWindow.locator('#btn-theme').focus();
    await mainWindow.keyboard.press('Enter');

    const overlay = mainWindow.locator('#theme-overlay');
    await expect(overlay).toBeVisible();
    const dialog = overlay.locator('[role="dialog"]');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAccessibleName('Theme');
    await expect(mainWindow.locator('#app')).toHaveJSProperty('inert', true);

    for (let i = 0; i < 25; i++) {
      await mainWindow.keyboard.press('Tab');
      const inside = await mainWindow.evaluate(() => document.getElementById('theme-overlay').contains(document.activeElement));
      expect(inside).toBe(true);
    }

    await mainWindow.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
    await expect(mainWindow.locator('#app')).toHaveJSProperty('inert', false);
    await expect(mainWindow.locator('#btn-theme')).toBeFocused();
  });

  test('dynamically created dialogs get the same treatment', async ({ mainWindow }) => {
    await mainWindow.locator('#btn-prefs').focus();
    await mainWindow.evaluate(() => window.Dialogs.showShortcuts());

    const dialog = mainWindow.locator('.palette-overlay [role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    const focusedInside = await mainWindow.evaluate(() => !!document.activeElement.closest('.palette-overlay'));
    expect(focusedInside).toBe(true);

    await mainWindow.keyboard.press('Escape');
    await expect(mainWindow.locator('.palette-overlay')).toHaveCount(0);
    await expect(mainWindow.locator('#btn-prefs')).toBeFocused();
  });

  test('toasts are announced, pausable and dismissible by keyboard', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.toast.error('Push failed: remote rejected'));

    await expect(mainWindow.locator('.a11y-live[aria-live="assertive"]')).toHaveText('Push failed: remote rejected');
    const close = mainWindow.getByRole('button', { name: 'Dismiss notification' });
    await close.focus();
    await mainWindow.keyboard.press('Enter');
    await expect(mainWindow.locator('.klaussy-toast')).toHaveCount(0);
  });

  test('role=button elements activate with Enter and Space', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => {
      const el = document.createElement('div');
      el.id = 'a11y-probe';
      el.textContent = 'Probe';
      el.dataset.clicks = '0';
      el.addEventListener('click', () => { el.dataset.clicks = String(Number(el.dataset.clicks) + 1); });
      window.A11y.makeButton(el);
      document.getElementById('app').appendChild(el);
    });
    const probe = mainWindow.locator('#a11y-probe');
    await probe.focus();
    await mainWindow.keyboard.press('Enter');
    await mainWindow.keyboard.press('Space');
    await expect(probe).toHaveAttribute('data-clicks', '2');
    await probe.evaluate((el) => el.remove());
  });
});
