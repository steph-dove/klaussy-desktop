/* global window,document */
const path = require('path');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');
const { buildRepo, rm, openShellTask } = require('./helpers');

const repoRoot = path.resolve(__dirname, '..');

test.describe('remaining accessibility gaps', () => {
  let repo;

  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
  });

  test.afterEach(() => { if (repo) rm(repo); repo = null; });

  test('promptDialog is a labelled modal that validates and cancels by keyboard', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => {
      window.__answer = 'pending';
      window.AppUtils.promptDialog({ title: 'Create pull request', fields: [{ label: 'Title', required: true }, { label: 'Description', multiline: true }] })
        .then((v) => { window.__answer = v; });
    });
    const dialog = mainWindow.getByRole('dialog', { name: 'Create pull request' });
    const title = dialog.getByRole('textbox', { name: 'Title' });
    await expect(title).toBeFocused();

    await mainWindow.keyboard.press('Enter');
    await expect(title).toHaveAttribute('aria-invalid', 'true');
    await expect(title).toBeFocused();

    await title.fill('Fix focus');
    await mainWindow.keyboard.press('Enter');
    await expect.poll(() => mainWindow.evaluate(() => window.__answer)).toEqual(['Fix focus', '']);

    await mainWindow.evaluate(() => {
      window.AppUtils.promptDialog({ title: 'View file', fields: [{ label: 'Path' }] }).then((v) => { window.__answer = v; });
    });
    await expect(mainWindow.getByRole('dialog', { name: 'View file' })).toBeVisible();
    await mainWindow.keyboard.press('Escape');
    await expect.poll(() => mainWindow.evaluate(() => window.__answer)).toBeNull();
  });

  test('branch label opens a searchable branch list from the keyboard', async ({ mainWindow }) => {
    repo = buildRepo({ 'a.txt': 'a\n' }, 'gaps-branch');
    execFileSync('git', ['branch', 'feature-x'], { cwd: repo });
    require('fs').writeFileSync(path.join(repo, 'a.txt'), 'b\n');
    await openShellTask(mainWindow, repo);
    await mainWindow.evaluate((wt) => { window.DiffPanel.show(wt); return window.DiffPanel.refresh(); }, repo);

    const label = mainWindow.getByRole('button', { name: /^Switch branch, currently main/ });
    await label.focus();
    await mainWindow.keyboard.press('Enter');
    const list = mainWindow.getByRole('listbox', { name: 'Commands' });
    await expect(list.getByRole('option', { name: 'feature-x' })).toBeVisible();
    await mainWindow.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
  });

  test('terminal search reports its match count', async ({ mainWindow }) => {
    repo = buildRepo({ 'a.txt': 'a\n' }, 'gaps-search');
    const id = await openShellTask(mainWindow, repo);
    await mainWindow.evaluate((taskId) => window.AppState.tasks.get(taskId).terminal.write('needle one\r\nneedle two\r\n'), id);
    await mainWindow.evaluate((taskId) => window.SearchBar.open(taskId), id);
    await mainWindow.locator('#search-input').fill('needle');
    const count = mainWindow.locator('#search-count');
    await expect(count).toHaveAttribute('role', 'status');
    await expect(count).toHaveText(/^\d+ of 2$/);
    await mainWindow.keyboard.press('Escape');
  });

  test('E on a PR diff line explains its hunk', async ({ electronApp, mainWindow }) => {
    await mainWindow.waitForLoadState('domcontentloaded');
    const [pr] = await Promise.all([
      electronApp.waitForEvent('window'),
      electronApp.evaluate(({ BrowserWindow }, a) => {
        const w = new BrowserWindow({ show: false, webPreferences: { preload: a.preload, contextIsolation: true } });
        w.loadFile(a.html);
      }, { preload: path.join(repoRoot, 'preload.js'), html: path.join(repoRoot, 'renderer', 'pr-review.html') }),
    ]);
    await pr.waitForLoadState('domcontentloaded');
    await expect.poll(() => pr.locator('.pr-review-loading').textContent(), { timeout: 8000 }).toMatch(/No active/);
    await pr.evaluate(() => {
      window.PrReview.render({
        number: 3, meta: { title: 'T', state: 'OPEN' }, threads: [],
        diff: 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n',
      });
      window.__explained = null;
      window.PrReview.explainSelection = (text, anchor) => { window.__explained = { text, anchor: anchor.className }; };
    });
    await pr.getByRole('button', { name: /^x\.js/ }).click();
    await pr.locator('.pr-review-diff-pre').focus();
    await pr.keyboard.press('Alt+ArrowDown');
    await pr.keyboard.press('ArrowDown');
    await pr.keyboard.press('e');
    const explained = await pr.evaluate(() => window.__explained);
    expect(explained.text).toBe(' keep\n−old\n+new');
    expect(explained.anchor).toContain('diff-add');
    await pr.close();
  });
});
