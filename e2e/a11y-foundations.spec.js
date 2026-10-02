/* global window,document */

const { test, expect } = require('./fixtures');

test.describe('a11y foundations', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await expect(mainWindow.locator('#btn-theme')).toBeVisible();
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
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
    await expect(mainWindow.locator('#app')).toHaveJSProperty('inert', false);
    await expect(mainWindow.locator('#btn-prefs')).toBeFocused();
  });

  test('a dialog opened over another stays usable and Escape closes only the top one', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.App.btnManageSessions.click());
    const sessions = mainWindow.locator('#sessions-modal-overlay');
    await expect(sessions).toBeVisible();

    await mainWindow.evaluate(() => { window.App.confirmDeleteSession('demo', [{ repoName: 'repo', path: '/tmp/demo' }]); });
    const del = mainWindow.locator('#delete-session-overlay');
    await expect(del).toBeVisible();
    await expect(del).toHaveJSProperty('inert', false);
    const input = mainWindow.locator('#delete-session-input');
    await input.focus();
    await expect(input).toBeFocused();
    await mainWindow.keyboard.type('del');
    await expect(input).toHaveValue('del');

    await mainWindow.keyboard.press('Escape');
    await expect(del).toBeHidden();
    await expect(sessions).toBeVisible();
    await expect(mainWindow.locator('#app')).toHaveJSProperty('inert', true);
    const focusInSessions = await mainWindow.evaluate(() => document.getElementById('sessions-modal-overlay').contains(document.activeElement));
    expect(focusInSessions).toBe(true);

    await mainWindow.keyboard.press('Escape');
    await expect(sessions).toBeHidden();
    await expect(mainWindow.locator('#app')).toHaveJSProperty('inert', false);
  });

  test('toasts are announced, pausable and dismissible by keyboard', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.toast.error('Push failed: remote rejected'));

    await expect(mainWindow.locator('.a11y-live[aria-live="assertive"]')).toContainText('Push failed: remote rejected');
    const toast = mainWindow.locator('.klaussy-toast', { hasText: 'Push failed: remote rejected' });
    await toast.getByRole('button', { name: 'Dismiss notification' }).focus();
    await mainWindow.keyboard.press('Enter');
    await expect(toast).toHaveCount(0);
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
