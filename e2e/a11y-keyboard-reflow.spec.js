/* global window,document,getComputedStyle */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');
const { buildRepo, rm, openShellTask } = require('./helpers');

const repoRoot = path.resolve(__dirname, '..');

const PR_STATE = {
  number: 42,
  meta: { title: 'Add feature', state: 'OPEN', author: { login: 'dev' }, headRefName: 'feat', baseRefName: 'main' },
  diff: [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,3 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    '',
  ].join('\n'),
  threads: [],
};

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
  await win.evaluate((s) => window.PrReview.render(s), PR_STATE);
  return win;
}

const focusedLabel = (page) => page.evaluate(() => document.activeElement.getAttribute('aria-label') || document.activeElement.textContent.trim());

test.describe('keyboard alternatives, reflow and display settings', () => {
  let repo;

  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
  });

  test.afterEach(() => { if (repo) rm(repo); repo = null; });

  test('Shift+Down selects diff lines and C drafts a multi-line PR comment', async ({ electronApp, mainWindow }) => {
    await mainWindow.waitForLoadState('domcontentloaded');
    const win = await openPrWindow(electronApp);
    expect(await win.evaluate(() => typeof window.Terminal)).toBe('function');
    await win.getByRole('button', { name: /^src\/a\.js/ }).click();

    await win.locator('.pr-review-diff-pre').focus();
    let label = '';
    for (let i = 0; i < 8 && !label.startsWith('Added line 2'); i++) {
      await win.keyboard.press('ArrowDown');
      label = await focusedLabel(win);
    }
    await win.keyboard.press('Shift+ArrowDown');
    expect(await win.evaluate(() => window.getSelection().toString())).toContain('const c = 4;');
    await win.keyboard.press('c');
    await expect(win.getByRole('textbox', { name: 'Review comment on src/a.js:L2-L3' })).toBeFocused();
    await win.close();
  });

  test('terminal panes reorder with Alt+Arrow keys', async ({ mainWindow }) => {
    repo = buildRepo({ 'a.txt': 'a\n' }, 'panes');
    const second = buildRepo({ 'b.txt': 'b\n' }, 'panes2');
    try {
      const first = await openShellTask(mainWindow, repo);
      await openShellTask(mainWindow, second);
      await mainWindow.evaluate(() => window.TerminalManager.setLayout('columns'));
      const order = () => mainWindow.evaluate(() =>
        Array.from(document.querySelectorAll('#terminals .terminal-container')).map((el) => el.dataset.id));
      const before = await order();
      const pane = mainWindow.locator(`.terminal-container[data-id="${before[0]}"] .grid-label-name`);
      await expect(pane).toHaveAttribute('role', 'button');
      await pane.focus();
      await mainWindow.keyboard.press('Alt+ArrowRight');
      expect(await order()).toEqual([before[1], before[0]]);
      await expect(pane).toBeFocused();
      expect(first).toBeTruthy();
    } finally {
      rm(second);
    }
  });

  test('files move through the "Move to…" dialog', async ({ mainWindow }) => {
    repo = buildRepo({ 'src/a.js': 'a\n', 'lib/keep.txt': 'k\n' }, 'move');
    await openShellTask(mainWindow, repo);
    await mainWindow.evaluate((wt) => { window.DiffPanel.show(wt); window.App.forceFilesTab(); }, repo);
    const tree = mainWindow.getByRole('tree', { name: 'Files' });
    await tree.getByRole('treeitem', { name: /^src/ }).click();
    const file = tree.getByRole('treeitem', { name: /^a\.js/ });
    await file.focus();
    await mainWindow.keyboard.press('Shift+F10');
    await mainWindow.getByRole('menuitem', { name: 'Move to…' }).click();
    const field = mainWindow.getByRole('textbox', { name: /Destination folder/ });
    await expect(field).toHaveValue('src');
    await field.fill('lib');
    await mainWindow.keyboard.press('Enter');
    await expect.poll(() => fs.existsSync(path.join(repo, 'lib', 'a.js'))).toBe(true);
  });

  test('side panels give way at narrow widths', async ({ electronApp, mainWindow }) => {
    repo = buildRepo({ 'a.txt': 'a\n' }, 'reflow');
    await openShellTask(mainWindow, repo);
    await mainWindow.evaluate((wt) => window.DiffPanel.show(wt), repo);
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(640, 700));
    await expect.poll(() => mainWindow.evaluate(() => window.innerWidth)).toBeLessThan(700);
    const widths = await mainWindow.evaluate(() => ({
      view: window.innerWidth,
      terminals: document.getElementById('terminal-area').getBoundingClientRect().width,
    }));
    expect(widths.terminals).toBeGreaterThanOrEqual(widths.view * 0.2);
  });

  test('forced colours keep status dots and reduced motion stops the cursor blink', async ({ mainWindow }) => {
    await mainWindow.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    repo = buildRepo({ 'a.txt': 'a\n' }, 'display');
    const id = await openShellTask(mainWindow, repo);
    const adjust = await mainWindow.evaluate((tid) =>
      getComputedStyle(document.querySelector(`.task-item[data-id="${tid}"] .status-dot`)).forcedColorAdjust, id);
    expect(adjust).toBe('none');
    expect(await mainWindow.evaluate((tid) => window.AppState.tasks.get(tid).terminal.options.cursorBlink, id)).toBe(false);
  });

  test('F6 reaches error toasts so they can be dismissed', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.toast.error('Push failed: rejected'));
    const toast = mainWindow.locator('.klaussy-toast.error', { hasText: 'Push failed' });
    await expect(toast).toBeVisible();
    let inToast = false;
    for (let i = 0; i < 8 && !inToast; i++) {
      await mainWindow.keyboard.press('F6');
      inToast = await mainWindow.evaluate(() => !!document.activeElement.closest('#klaussy-toast-stack'));
    }
    expect(inToast).toBe(true);
    await mainWindow.keyboard.press('Enter');
    await expect(toast).toHaveCount(0);
  });

  test('the artifact preview divider resizes from the keyboard', async ({ mainWindow }) => {
    repo = buildRepo({ 'page.html': '<h1>Hi</h1>\n' }, 'artifact');
    await openShellTask(mainWindow, repo);
    await mainWindow.evaluate((p) => window.openFileViewer(p, 'page.html'), path.join(repo, 'page.html'));
    await mainWindow.locator('.file-viewer-split-btn').click();
    const handle = mainWindow.getByRole('separator', { name: 'Resize preview' });
    await expect(handle).toBeVisible();
    const before = Number(await handle.getAttribute('aria-valuenow'));
    await handle.focus();
    await mainWindow.keyboard.press('Shift+ArrowLeft');
    await expect.poll(async () => Number(await handle.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
  });
});
