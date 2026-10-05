/* global window,document */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');
const { buildRepo, rm, openShellTask } = require('./helpers');

const repoRoot = path.resolve(__dirname, '..');

const announced = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('.a11y-live')).map((el) => el.textContent).join(' | '));

test.describe('announcements and focus after actions', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
  });

  test.describe('with a task', () => {
    let repo;
    let taskId;

    test.beforeEach(async ({ mainWindow }) => {
      repo = buildRepo({ 'src/app.js': 'l1\nl2\nl3\n', 'README.md': '# demo\n' }, 'a11y-announce');
      taskId = await openShellTask(mainWindow, repo);
    });

    test.afterEach(async ({ mainWindow }) => {
      await mainWindow.evaluate((id) => window.klaus.task.kill(id), taskId).catch(() => {});
      rm(repo);
    });

    test('staging a file announces it and keeps focus on the moved row', async ({ mainWindow }) => {
      fs.writeFileSync(path.join(repo, 'src/app.js'), 'l1\nl3\n');
      await mainWindow.evaluate((wt) => { window.DiffPanel.show(wt); return window.DiffPanel.refresh(); }, repo);
      await mainWindow.getByRole('button', { name: 'Stage src/app.js' }).click();
      await expect.poll(() => announced(mainWindow)).toContain('Staged src/app.js');
      await expect(mainWindow.getByRole('button', { name: 'Unstage src/app.js' })).toBeVisible();
      await expect.poll(() => mainWindow.evaluate(() => {
        const row = document.activeElement.closest('.diff-file');
        return !!row && row.dataset.staged === 'true' && document.activeElement.classList.contains('diff-file-main');
      })).toBe(true);
    });

    test('split diff lines skip blank cells and the duplicate context copy', async ({ mainWindow }) => {
      fs.writeFileSync(path.join(repo, 'src/app.js'), 'l1\nl3\nadd1\n');
      await mainWindow.evaluate((wt) => { window.DiffPanel.show(wt); return window.DiffPanel.refresh(); }, repo);
      await mainWindow.getByRole('button', { name: /app\.js.*modified/ }).click();
      await mainWindow.locator('.js-view-mode-split').click();
      await expect(mainWindow.locator('#diff-view .diff-split-grid .diff-blank').first()).toBeAttached();

      await mainWindow.locator('#diff-view').focus();
      const labels = [];
      for (let i = 0; i < 6; i++) {
        await mainWindow.keyboard.press('ArrowDown');
        labels.push(await mainWindow.evaluate(() => document.activeElement.getAttribute('aria-label') || ''));
      }
      expect(labels.every(Boolean)).toBe(true);
      expect(labels.filter((l) => l.startsWith('Line 1:'))).toHaveLength(1);
      expect(labels).toContain('Removed line 2, old side: l2');
      expect(labels).toContain('Added line 3, new side: add1');
    });

    test('renaming in the file tree focuses the renamed item and announces it', async ({ mainWindow }) => {
      await mainWindow.evaluate((wt) => window.DiffPanel.show(wt), repo);
      await mainWindow.evaluate(() => window.App.forceFilesTab());
      const tree = mainWindow.getByRole('tree', { name: 'Files' });
      await tree.getByRole('treeitem', { name: 'src' }).click();
      const appJs = tree.getByRole('treeitem', { name: 'app.js' });
      await appJs.focus();
      await mainWindow.keyboard.press('F2');
      const input = mainWindow.locator('.file-tree-rename-input');
      await expect(input).toBeFocused();
      await input.fill('main.js');
      await mainWindow.keyboard.press('Enter');

      const renamed = tree.getByRole('treeitem', { name: 'main.js' });
      await expect(renamed).toBeFocused();
      await expect(renamed).toHaveAttribute('data-path', 'src/main.js');
      expect(await announced(mainWindow)).toContain('Renamed app.js to main.js');
    });
  });

  test('dismissing the last toast returns focus to where the user was', async ({ mainWindow }) => {
    const origin = mainWindow.locator('#btn-sidebar-toggle');
    await origin.focus();
    await mainWindow.evaluate(() => window.toast.error('Push failed: remote rejected'));
    const toast = mainWindow.locator('.klaussy-toast', { hasText: 'Push failed: remote rejected' });
    await expect(toast).toContainText('Error:');
    await toast.getByRole('button', { name: 'Dismiss notification' }).focus();
    await mainWindow.keyboard.press('Enter');
    await expect(toast).toHaveCount(0);
    await expect(origin).toBeFocused();
  });

  test('the sidebar toggle exposes its state and full name', async ({ mainWindow }) => {
    const toggle = mainWindow.locator('#btn-sidebar-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute('aria-controls', 'sidebar');
    await expect(mainWindow.getByRole('button', { name: 'Hide sidebar' })).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(mainWindow.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test('the window has a visible level-one heading', async ({ mainWindow }) => {
    await expect(mainWindow.getByRole('heading', { level: 1, name: 'Klaussy' })).toBeVisible();
  });

  test('an empty PR review comment shows an inline error instead of doing nothing', async ({ electronApp, mainWindow }) => {
    await mainWindow.waitForLoadState('domcontentloaded');
    const [win] = await Promise.all([
      electronApp.waitForEvent('window'),
      electronApp.evaluate(({ BrowserWindow }, args) => {
        const w = new BrowserWindow({
          width: 1100, height: 800, show: false,
          webPreferences: { preload: args.preload, contextIsolation: true, nodeIntegration: false },
        });
        w.loadFile(args.htmlPath);
      }, {
        preload: path.join(repoRoot, 'preload.js'),
        htmlPath: path.join(repoRoot, 'renderer', 'pr-review.html'),
      }),
    ]);
    await win.waitForLoadState('domcontentloaded');
    await expect.poll(() => win.locator('.pr-review-loading').textContent(), { timeout: 8000 }).toMatch(/No active PR review/);
    await win.evaluate(() => window.PrReview.render({
      number: 42,
      meta: { title: 'Add feature', state: 'OPEN', author: { login: 'dev' }, headRefName: 'feat', baseRefName: 'main' },
      diff: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-a\n+b\n',
      threads: [],
    }));
    await win.getByRole('tab', { name: /Conversation/ }).click();
    await win.locator('.pr-conv-new-post').click();
    const box = win.locator('.pr-conv-new-body');
    await expect(box).toHaveAttribute('aria-invalid', 'true');
    await expect(box).toBeFocused();
    const errId = await box.getAttribute('aria-describedby');
    await expect(win.locator('#' + errId)).toHaveText('Write a comment before posting.');
    await box.pressSequentially('x');
    await expect(box).not.toHaveAttribute('aria-invalid', 'true');
    await win.close();
  });
});
