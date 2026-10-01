/* global window,document */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { test, expect } = require('./fixtures');
const { openShellTask } = require('./helpers');

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control+Shift';

test.describe('main window keyboard access', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
  });

  test.describe('with two open tasks', () => {
    const dirs = [];
    const ids = [];

    test.beforeEach(async ({ mainWindow }) => {
      for (const name of ['alpha', 'beta']) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `klaussy-e2e-${name}-`));
        dirs.push(dir);
        ids.push(await openShellTask(mainWindow, dir));
      }
      await expect(mainWindow.locator('#task-list .task-main')).toHaveCount(2);
      // Opening tasks queues terminal-focus timers; let the last one land before driving the sidebar.
      await expect.poll(() => mainWindow.evaluate(
        (id) => document.activeElement.closest('.terminal-container')?.dataset.id === id, ids[ids.length - 1],
      )).toBe(true);
    });

    test.afterEach(async ({ mainWindow }) => {
      for (const id of ids.splice(0)) {
        await mainWindow.evaluate((i) => window.klaus.task.kill(i), id).catch(() => {});
      }
      dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
    });

    test('rows are buttons: arrows move, Enter switches, F2 renames, Alt+Up reorders', async ({ mainWindow }) => {
      const rows = mainWindow.locator('#task-list .task-main');
      await rows.first().focus();
      await mainWindow.keyboard.press('ArrowDown');
      await expect(rows.nth(1)).toBeFocused();

      await mainWindow.keyboard.press('ArrowUp');
      await mainWindow.keyboard.press('Enter');
      await expect(rows.first()).toHaveAttribute('aria-current', 'true');
      await expect(rows.nth(1)).not.toHaveAttribute('aria-current', 'true');
      // Opening a task hands focus to its terminal.
      await expect.poll(() => mainWindow.evaluate(() => !!document.activeElement.closest('.xterm'))).toBe(true);

      await rows.first().focus();
      await mainWindow.keyboard.press('F2');
      const input = mainWindow.getByRole('textbox', { name: 'Rename task' });
      await expect(input).toBeFocused();
      await input.fill('renamed-by-keyboard');
      await mainWindow.keyboard.press('Enter');
      await expect(rows.first().locator('.task-name')).toHaveText('renamed-by-keyboard');
      await expect(rows.first()).toBeFocused();

      await rows.nth(1).focus();
      const secondName = await rows.nth(1).locator('.task-name').textContent();
      await mainWindow.keyboard.press('Alt+ArrowUp');
      await expect(rows.first().locator('.task-name')).toHaveText(secondName);
      await expect(rows.first()).toBeFocused();
    });

    test('Escape cancels a rename and returns focus to the row', async ({ mainWindow }) => {
      const rows = mainWindow.locator('#task-list .task-main');
      const original = await rows.first().locator('.task-name').textContent();
      await rows.first().focus();
      await mainWindow.keyboard.press('F2');
      const input = mainWindow.getByRole('textbox', { name: 'Rename task' });
      await expect(input).toBeFocused();
      await input.fill('discarded-name');
      await mainWindow.keyboard.press('Escape');
      await expect(input).toHaveCount(0);
      await expect(rows.first().locator('.task-name')).toHaveText(original);
      await expect(rows.first()).toBeFocused();
    });

    test('clicking away commits a rename without pulling focus back to the row', async ({ mainWindow }) => {
      const rows = mainWindow.locator('#task-list .task-main');
      await rows.first().focus();
      await mainWindow.keyboard.press('F2');
      const input = mainWindow.getByRole('textbox', { name: 'Rename task' });
      await input.fill('renamed-by-blur');
      await mainWindow.locator('.xterm:visible').first().click();
      await expect(input).toHaveCount(0);
      await expect(rows.first().locator('.task-name')).toHaveText('renamed-by-blur');
      await expect(rows.first()).not.toBeFocused();
      await expect.poll(() => mainWindow.evaluate(() => !!document.activeElement.closest('.xterm'))).toBe(true);
    });

    test('side panel tabs and splitter work from the keyboard', async ({ mainWindow }) => {
      await mainWindow.keyboard.press(`${MOD}+g`);
      await expect(mainWindow.locator('#diff-panel')).toHaveClass(/\bvisible\b/);

      // A plain folder (no git) shows only Files, Search and Notes.
      const tablist = mainWindow.getByRole('tablist', { name: 'Side panel' });
      const files = tablist.getByRole('tab', { name: 'Files' });
      await expect(files).toHaveAttribute('aria-selected', 'true');
      await files.focus();
      await mainWindow.keyboard.press('ArrowRight');
      const search = tablist.getByRole('tab', { name: 'Search' });
      await expect(search).toBeFocused();
      await expect(search).toHaveAttribute('aria-selected', 'false');
      await mainWindow.keyboard.press('Enter');
      await expect(search).toHaveAttribute('aria-selected', 'true');
      await expect(mainWindow.locator('#search-tab-content')).toHaveAttribute('role', 'tabpanel');

      const handle = mainWindow.getByRole('separator', { name: 'Resize changes panel' });
      await handle.focus();
      const before = await mainWindow.locator('#diff-panel').evaluate((el) => el.getBoundingClientRect().width);
      await mainWindow.keyboard.press('Shift+ArrowLeft');
      await expect.poll(() => mainWindow.locator('#diff-panel').evaluate((el) => el.getBoundingClientRect().width))
        .toBeGreaterThan(before);
      await expect(handle).toHaveAttribute('aria-valuenow', /\d+/);
    });
  });

  test('command palette exposes the highlighted command to screen readers', async ({ mainWindow }) => {
    await mainWindow.locator('#btn-prefs').focus();
    await mainWindow.keyboard.press(`${MOD}+k`);
    const input = mainWindow.getByRole('combobox', { name: 'Commands' });
    await expect(input).toBeFocused();
    const first = await input.getAttribute('aria-activedescendant');
    expect(first).toBeTruthy();
    await mainWindow.keyboard.press('ArrowDown');
    await expect(input).not.toHaveAttribute('aria-activedescendant', first);
    const activeId = await input.getAttribute('aria-activedescendant');
    await expect(mainWindow.locator('#' + activeId)).toHaveAttribute('aria-selected', 'true');
    await mainWindow.keyboard.press('Escape');
  });

  test('agent choice in the new-session dialog is a radio group', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => {
      document.getElementById('modal-overlay').style.display = 'flex';
      document.querySelector('#modal-tabs .modal-tab[data-tab="existing"]').click();
      window.App.shellUserPicked = false;
    });
    const group = mainWindow.getByRole('radiogroup', { name: 'Run' });
    const checked = group.locator('[aria-checked="true"]');
    await checked.focus();
    const before = await checked.getAttribute('data-shell');
    await mainWindow.keyboard.press('ArrowRight');
    await expect(group.locator('[aria-checked="true"]')).not.toHaveAttribute('data-shell', before);
    await expect(group.locator('[aria-checked="true"]')).toBeFocused();
    expect(await mainWindow.evaluate(() => !!window.App.shellUserPicked)).toBe(false);
    await expect(mainWindow.locator('.klaus-modal-overlay:visible')).toHaveCount(0);
    await mainWindow.evaluate(() => { document.getElementById('modal-overlay').style.display = 'none'; });
  });

  test('dashboard cards are named buttons', async ({ mainWindow }) => {
    await expect(mainWindow.getByRole('button', { name: 'Open Local Folder or File' })).toBeVisible();
    const cards = mainWindow.locator('.empty-dashboard-grid .dashboard-card:visible');
    await cards.first().focus();
    await mainWindow.keyboard.press('ArrowDown');
    await expect(cards.nth(1)).toBeFocused();
  });
});
