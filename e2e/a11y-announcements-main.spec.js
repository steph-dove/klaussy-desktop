/* global window,document */
const { test, expect } = require('./fixtures');
const { openShellTask, tmpDir, rm } = require('./helpers');

const announced = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('.a11y-live')).map((el) => el.textContent).join(' | '));

test.describe('main window status and announcements', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
  });

  test('a task row describes its state and the window title names it', async ({ mainWindow }) => {
    const dir = tmpDir('sr-task');
    try {
      const id = await openShellTask(mainWindow, dir);
      const main = mainWindow.locator(`.task-item[data-id="${id}"] .task-main`);
      await expect(main).toHaveAccessibleDescription(/running/);
      const name = await mainWindow.evaluate((tid) => window.AppState.tasks.get(tid).name, id);
      await expect.poll(() => mainWindow.title()).toContain(name);

      await mainWindow.evaluate((tid) => window.Sidebar.showUnreadBadge(tid), id);
      await expect(main).toHaveAccessibleDescription(/unread output/);
      expect(await announced(mainWindow)).toContain('New output in ' + name);

      const textarea = mainWindow.locator('.xterm-helper-textarea').first();
      await expect(textarea).toHaveAttribute('aria-label', new RegExp(name + '.*terminal'));
    } finally {
      rm(dir);
    }
  });

  test('git failures stay on screen until dismissed and are announced', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => {
      window.DiffPanel.panelEl = window.DiffPanel.panelEl || document.getElementById('diff-panel');
      window.DiffPanel.reportGitResults('Fetch', 'Fetched', [{ ok: true }, { error: 'could not resolve host\nmore' }]);
    });
    const banner = mainWindow.locator('.diff-status-banner.diff-status-error');
    await expect(banner).toContainText('Fetch failed: could not resolve host');
    expect(await announced(mainWindow)).toContain('Fetch failed: could not resolve host');
    await mainWindow.waitForTimeout(6500);
    await expect(banner).toBeAttached();
    await banner.getByRole('button', { name: 'Dismiss', includeHidden: true }).dispatchEvent('click');
    await expect(banner).toHaveCount(0);
  });

  test('error toasts do not time out', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.toast.error('Merge failed: conflict'));
    const toast = mainWindow.locator('.klaussy-toast.error', { hasText: 'Merge failed: conflict' });
    await expect(toast).toBeVisible();
    await mainWindow.waitForTimeout(9000);
    await expect(toast).toBeVisible();
  });

  test('toggles expose their state', async ({ mainWindow }) => {
    const btnDiff = mainWindow.locator('#btn-diff');
    await expect(btnDiff).toHaveAttribute('aria-expanded', /true|false/);
    const before = await btnDiff.getAttribute('aria-expanded');
    await mainWindow.evaluate(() => document.getElementById('btn-diff').classList.toggle('active'));
    await expect(btnDiff).not.toHaveAttribute('aria-expanded', before);
    await expect(mainWindow.locator('#diff-reveal')).toHaveAttribute('aria-expanded', before === 'true' ? 'false' : 'true');
    await mainWindow.evaluate(() => document.getElementById('btn-diff').classList.toggle('active'));

    await expect(mainWindow.locator('#btn-layout')).toHaveAccessibleName(/Terminal layout: (single|columns|grid)/);

    await mainWindow.locator('#btn-theme').click();
    const pressed = mainWindow.locator('#theme-overlay .theme-option[aria-pressed="true"]');
    await expect(pressed).toHaveCount(1);
    await mainWindow.keyboard.press('Escape');
  });

  test('the token chart has a text alternative', async ({ mainWindow }) => {
    await expect(mainWindow.getByRole('img', { name: /Token usage chart/ })).toBeAttached();
  });

  test('the command palette says when nothing matches', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.CommandPalette.show([{ label: 'Alpha', action() {} }]));
    await mainWindow.keyboard.type('zzzz-no-such-command');
    await expect(mainWindow.locator('.palette-empty')).toHaveText('No matching commands');
    expect(await announced(mainWindow)).toContain('No matching commands');
    await mainWindow.keyboard.press('Escape');
  });
});
