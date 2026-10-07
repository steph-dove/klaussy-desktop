/* global window,document */
const path = require('path');
const { test, expect } = require('./fixtures');
const { buildRepo, rm, openShellTask } = require('./helpers');

const repoRoot = path.resolve(__dirname, '..');

const announced = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('.a11y-live')).map((el) => el.textContent).join(' | '));

async function openPrWindow(electronApp) {
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
    diff: '',
    threads: [],
    issueComments: [],
  }));
  return win;
}

test.describe('focus and announcements, round 4', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.evaluate(() => { const o = document.getElementById('ollama-consent-overlay'); if (o) o.remove(); });
  });

  test('cancelling a session delete puts focus back on its Delete button', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => {
      const wts = [{ repoName: 'repo', path: '/tmp/klaussy-demo-session', active: false }];
      window.App.getDiscoveredWorktrees = () => Promise.resolve([]);
      window.App.groupWorktreesIntoSessions = () => ({ sessions: { demo: wts }, legacy: {} });
      window.App.btnManageSessions.click();
    });
    const del = mainWindow.getByRole('button', { name: 'Delete session demo' });
    await expect(del).toBeVisible();
    await del.focus();
    await mainWindow.keyboard.press('Enter');
    const confirm = mainWindow.locator('#delete-session-overlay');
    await expect(confirm).toBeVisible();
    await expect(mainWindow.locator('#delete-session-input')).toBeFocused();

    await mainWindow.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await expect(del).toBeFocused();
  });

  test('a second Copy click during the flash still restores the original label', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => {
      // writeText can hang when the window isn't focused (CI), so the flash would never start.
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.resolve() } });
      const btn = document.createElement('button');
      btn.id = 'copy-probe';
      btn.textContent = 'Copy command';
      document.body.appendChild(btn);
      window.AppUtils.copyText(btn, 'one', 600);
    });
    const btn = mainWindow.locator('#copy-probe');
    await expect(btn).not.toHaveText('Copy command');
    await mainWindow.evaluate(() => window.AppUtils.copyText(document.getElementById('copy-probe'), 'two', 1000));
    await expect(btn).toHaveText('Copy command', { timeout: 3000 });
    await mainWindow.waitForTimeout(1200);
    await expect(btn).toHaveText('Copy command');
  });

  test('a toast holding focus is not collapsed when newer ones arrive, and its close button says what it dismisses', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.toast.error('Push failed: remote rejected'));
    const stack = mainWindow.locator('#klaussy-toast-stack');
    const close = stack.getByRole('button', { name: 'Dismiss: Error: Push failed: remote rejected' });
    await close.focus();
    await mainWindow.evaluate(() => { for (let i = 1; i <= 3; i++) window.toast.error('Error ' + i); });
    await expect(stack.getByRole('button', { name: '+1 more' })).toBeVisible();
    await expect(close).toBeVisible();
    await expect(close).toBeFocused();
    await expect(stack.locator('.klaussy-toast:visible')).toHaveCount(3);
    await expect(stack.locator('.klaussy-toast', { hasText: 'Error 1' })).toBeHidden();
  });

  test('instruction toasts can be made sticky', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.toast.info('Run glab auth login', { sticky: true }));
    const toast = mainWindow.locator('.klaussy-toast', { hasText: 'Run glab auth login' });
    await expect(toast).toBeVisible();
    await mainWindow.waitForTimeout(5500);
    await expect(toast).toBeVisible();
  });

  test('the New Session dialog has a name', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.App.showModal());
    await expect(mainWindow.getByRole('dialog', { name: 'New session' })).toBeVisible();
  });

  test('F6 reaches notifications in the PR review pop-out', async ({ electronApp }) => {
    const win = await openPrWindow(electronApp);
    await win.evaluate(() => window.toast.error('Checks failed'));
    let inToast = false;
    for (let i = 0; i < 6 && !inToast; i++) {
      await win.keyboard.press('F6');
      inToast = await win.evaluate(() => !!document.activeElement.closest('#klaussy-toast-stack'));
    }
    expect(inToast).toBe(true);
    await win.close();
  });

  test.describe('with a task', () => {
    let repo;
    let taskId;

    test.beforeEach(async ({ mainWindow }) => {
      repo = buildRepo({ 'src/app.js': 'const a = 1;\nconst b = 2;\n' }, 'a11y-round4');
      taskId = await openShellTask(mainWindow, repo);
    });

    test.afterEach(async ({ mainWindow }) => {
      await mainWindow.evaluate((id) => window.klaus.task.kill(id), taskId).catch(() => {});
      rm(repo);
    });

    test('inline edit keeps focus through submit and lands on Accept when ready', async ({ electronApp, mainWindow }) => {
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('inline-edit-start');
        ipcMain.handle('inline-edit-start', (event, { requestId }) => {
          setTimeout(() => {
            event.sender.send('inline-edit-chunk-' + requestId, 'const a = 42;');
            event.sender.send('inline-edit-done-' + requestId, {});
          }, 400);
          return { ok: true };
        });
      });
      await mainWindow.evaluate((p) => window.openFileViewer(p, 'app.js'), path.join(repo, 'src/app.js'));
      await expect.poll(() => mainWindow.evaluate(() => !!(window.FileBrowser.getActiveEditor && window.FileBrowser.getActiveEditor())), { timeout: 15000 }).toBe(true);
      await mainWindow.evaluate(() => {
        const ed = window.FileBrowser.getActiveEditor();
        ed.focus();
        ed.setPosition({ lineNumber: 1, column: 1 });
        window.InlineEdit.start(ed);
      });
      const input = mainWindow.getByRole('textbox', { name: 'Tell the agent what to change' });
      await expect(input).toBeFocused();
      await input.fill('use 42');
      await mainWindow.keyboard.press('Enter');
      await expect.poll(() => mainWindow.evaluate(() => !!document.activeElement.closest('.inline-edit-stream'))).toBe(true);

      const accept = mainWindow.getByRole('button', { name: /^Accept/ });
      await expect(accept).toBeEnabled();
      await expect(accept).toBeFocused();
      await expect.poll(() => announced(mainWindow)).toContain('Press Enter to accept');
      await mainWindow.keyboard.press('Enter');
      await expect(mainWindow.locator('.inline-edit-stream')).toHaveCount(0);
      expect(await mainWindow.evaluate(() => window.FileBrowser.getActiveEditor().getModel().getLineContent(1))).toBe('const a = 42;');
    });
  });
});
