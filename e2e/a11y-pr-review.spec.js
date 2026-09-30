/* global window,document */
const path = require('path');
const { test, expect } = require('./fixtures');

const repoRoot = path.resolve(__dirname, '..');
const SUBMIT = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter';

const STATE = {
  number: 42,
  meta: {
    title: 'Add feature', state: 'OPEN', author: { login: 'dev' },
    headRefName: 'feat', baseRefName: 'main', url: 'https://github.com/o/r/pull/42',
  },
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
  await win.evaluate((s) => window.PrReview.render(s), STATE);
  return win;
}

function focusedLabel(page) {
  return page.evaluate(() => document.activeElement.getAttribute('aria-label') || document.activeElement.textContent.trim());
}

test.describe('PR review keyboard access', () => {
  test('tabs, file rows and focus survive re-renders', async ({ electronApp, mainWindow }) => {
    await mainWindow.waitForLoadState('domcontentloaded');
    const win = await openPrWindow(electronApp);

    await expect(win.getByRole('heading', { level: 1 })).toContainText('Add feature');
    const tabs = win.getByRole('tablist', { name: 'Review sections' });
    const changes = tabs.getByRole('tab', { name: /Changes/ });
    await expect(changes).toHaveAttribute('aria-selected', 'true');

    const row = win.getByRole('button', { name: 'src/a.js, 2 added, 1 removed' });
    await row.focus();
    await win.keyboard.press('Enter');
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(row).toBeFocused();

    await changes.focus();
    await win.keyboard.press('ArrowRight');
    const conversation = tabs.getByRole('tab', { name: /Conversation/ });
    await expect(conversation).toBeFocused();
    await win.keyboard.press('Enter');
    await expect(conversation).toHaveAttribute('aria-selected', 'true');
    await expect(conversation).toBeFocused();
    await win.close();
  });

  test('a line comment can be drafted from the keyboard', async ({ electronApp, mainWindow }) => {
    await mainWindow.waitForLoadState('domcontentloaded');
    const win = await openPrWindow(electronApp);
    await win.getByRole('button', { name: /^src\/a\.js/ }).click();

    await win.locator('.pr-review-diff-pre').focus();
    await win.keyboard.press('Alt+ArrowDown');
    expect(await focusedLabel(win)).toMatch(/^Hunk 1 of 1/);
    let label = '';
    for (let i = 0; i < 6 && !label.startsWith('Added line'); i++) {
      await win.keyboard.press('ArrowDown');
      label = await focusedLabel(win);
    }
    expect(label).toBe('Added line 2: const b = 3;');

    await win.keyboard.press('Enter');
    const box = win.getByRole('textbox', { name: 'Review comment on src/a.js:L2' });
    await expect(box).toBeFocused();
    await box.fill('nit: magic number');
    await win.keyboard.press(SUBMIT);

    await expect.poll(() => win.evaluate(() => window.PrReview.pendingComments.length)).toBe(1);
    expect(await focusedLabel(win)).toMatch(/^Added line 2/);
    await win.close();
  });
});
