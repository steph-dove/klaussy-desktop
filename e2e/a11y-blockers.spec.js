/* global window,document */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');
const { buildRepo, rm, openShellTask } = require('./helpers');

const repoRoot = path.resolve(__dirname, '..');

const PR_STATE = {
  number: 42,
  meta: { title: 'Add feature', state: 'OPEN', author: { login: 'dev' }, headRefName: 'feat', baseRefName: 'main' },
  diff: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-a\n+b\n',
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

test.describe('blockers', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
  });

  test('Tab leaves a diff line through its comment button instead of looping back', async ({ mainWindow }) => {
    const repo = buildRepo({ 'src/app.js': 'const a = 1;\n' }, 'tab-trap');
    try {
      await openShellTask(mainWindow, repo);
      fs.writeFileSync(path.join(repo, 'src/app.js'), 'const a = 2;\n');
      await mainWindow.evaluate((wt) => { window.DiffPanel.show(wt); return window.DiffPanel.refresh(); }, repo);
      await mainWindow.getByRole('button', { name: /app\.js.*modified/ }).click();
      const added = mainWindow.locator('#diff-view .diff-line.diff-add').first();
      await expect(added).toBeVisible();
      await mainWindow.evaluate(() => {
        const line = document.querySelector('#diff-view .diff-line.diff-add');
        line.tabIndex = -1;
        line.focus();
      });
      await mainWindow.keyboard.press('Tab');
      await expect(mainWindow.getByRole('button', { name: 'Add a comment on this line' })).toBeFocused();
      await mainWindow.keyboard.press('Tab');
      await mainWindow.waitForTimeout(100);
      expect(await mainWindow.evaluate(() => !document.getElementById('diff-view').contains(document.activeElement))).toBe(true);
    } finally {
      rm(repo);
    }
  });

  test('a new Shift+arrow range starts at the current line once the old selection is gone', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => {
      const pre = document.createElement('pre');
      pre.id = 'range-fixture';
      pre.innerHTML = ['l1', 'l2', 'l3', 'l4', 'l5'].map((t) => '<div class="diff-line" id="' + t + '">' + t + '</div>').join('');
      document.getElementById('app').appendChild(pre);
      window.A11y.lineNav(pre, { lineSelector: '.diff-line', hunkSelector: '.diff-hunk', label: 'Diff' });
    });
    await mainWindow.locator('#range-fixture').focus();
    await mainWindow.keyboard.press('ArrowDown');
    await mainWindow.keyboard.press('Shift+ArrowDown');
    await mainWindow.evaluate(() => window.getSelection().removeAllRanges());
    await mainWindow.keyboard.press('Shift+ArrowDown');
    const text = await mainWindow.evaluate(() => window.getSelection().toString());
    expect(text).toContain('l2');
    expect(text).toContain('l3');
    expect(text).not.toContain('l1');
    await mainWindow.evaluate(() => document.getElementById('range-fixture').remove());
  });

  test('the PR review pop-out loads its prefs, Humanize and F6 regions', async ({ electronApp, mainWindow }) => {
    await mainWindow.waitForLoadState('domcontentloaded');
    const win = await openPrWindow(electronApp);
    expect(await win.evaluate(() => ({
      state: typeof window.AppState,
      humanize: typeof window.PrReview.humanizeFinding,
    }))).toEqual({ state: 'object', humanize: 'function' });

    await win.getByRole('tab', { name: /Changes/ }).focus();
    await win.keyboard.press('F6');
    await expect.poll(() => win.evaluate(() => !!document.activeElement.closest('.pr-review-body'))).toBe(true);
    await win.keyboard.press('Shift+F6');
    await expect.poll(() => win.evaluate(() => !!document.activeElement.closest('.pr-review-tabs'))).toBe(true);
    await win.close();
  });

  test('typing in a Conversation comment survives a repaint and keeps focus', async ({ electronApp, mainWindow }) => {
    await mainWindow.waitForLoadState('domcontentloaded');
    const win = await openPrWindow(electronApp);
    await win.getByRole('tab', { name: /Conversation/ }).click();
    const box = win.locator('.pr-conv-new-body');
    await box.click();
    await box.pressSequentially('half a thought');
    await win.evaluate(() => window.PrReview.repaintConversationTab());
    await expect(win.locator('.pr-conv-new-body')).toHaveValue('half a thought');
    await expect(win.locator('.pr-conv-new-body')).toBeFocused();
    await win.evaluate((s) => window.PrReview.render(s), PR_STATE);
    await expect(win.locator('.pr-conv-new-body')).toHaveValue('half a thought');
    await win.close();
  });
});
