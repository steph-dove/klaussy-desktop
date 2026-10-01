/* global window,document */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');
const { buildRepo, rm, openShellTask } = require('./helpers');

function focused(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    return { label: el.getAttribute('aria-label') || '', text: el.textContent.trim(), cls: el.className };
  });
}

test.describe('diff, file tree and editor keyboard access', () => {
  let repo;
  let taskId;

  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
    repo = buildRepo({ 'src/app.js': 'const a = 1;\nconst b = 2;\n', 'README.md': '# demo\n' }, 'a11y-diff');
    taskId = await openShellTask(mainWindow, repo);
  });

  test.afterEach(async ({ mainWindow }) => {
    await mainWindow.evaluate((id) => window.klaus.task.kill(id), taskId).catch(() => {});
    rm(repo);
  });

  test('Changes list and diff lines are reachable, and a line comment opens by keyboard', async ({ mainWindow }) => {
    fs.writeFileSync(path.join(repo, 'src/app.js'), 'const a = 1;\nconst b = 3;\nconst c = 4;\n');
    await mainWindow.evaluate((wt) => { window.DiffPanel.show(wt); return window.DiffPanel.refresh(); }, repo);

    const row = mainWindow.getByRole('button', { name: /app\.js.*modified/ });
    await row.focus();
    await mainWindow.keyboard.press('Enter');
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(mainWindow.locator('#diff-view .diff-line.diff-add').first()).toBeVisible();

    await mainWindow.locator('#diff-view').focus();
    await mainWindow.keyboard.press('Alt+ArrowDown');
    expect((await focused(mainWindow)).label).toMatch(/^Hunk 1 of 1/);

    let label = '';
    for (let i = 0; i < 6 && !label.startsWith('Added line'); i++) {
      await mainWindow.keyboard.press('ArrowDown');
      label = (await focused(mainWindow)).label;
    }
    expect(label).toMatch(/^Added line \d+: const b = 3;/);

    await mainWindow.keyboard.press('Enter');
    const editor = mainWindow.getByRole('textbox', { name: /^Comment on Added line/ });
    await expect(editor).toBeFocused();
    await editor.fill('why 3?');
    await mainWindow.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await expect(mainWindow.getByRole('button', { name: 'Edit comment: why 3?' })).toBeVisible();
    expect((await focused(mainWindow)).label).toMatch(/^Added line/);

    await mainWindow.evaluate(() => window.DiffPanel.refresh());
    await expect(mainWindow.getByRole('button', { name: 'Edit comment: why 3?' })).toBeVisible();
    expect((await focused(mainWindow)).label).toMatch(/^Added line \d+: const b = 3;/);
  });

  test('file tree is an ARIA tree and opens files into a tab strip', async ({ mainWindow }) => {
    await mainWindow.evaluate((wt) => window.DiffPanel.show(wt), repo);
    await mainWindow.evaluate(() => window.App.forceFilesTab());

    const tree = mainWindow.getByRole('tree', { name: 'Files' });
    await expect(tree.getByRole('treeitem', { name: 'src' })).toBeVisible();

    await mainWindow.locator('#file-tree-filter').focus();
    await mainWindow.keyboard.press('ArrowDown');
    const src = tree.getByRole('treeitem', { name: 'src' });
    await expect(src).toBeFocused();
    await expect(src).toHaveAttribute('aria-expanded', 'false');

    await mainWindow.keyboard.press('ArrowRight');
    await expect(src).toHaveAttribute('aria-expanded', 'true');
    await mainWindow.keyboard.press('ArrowRight');
    const appJs = tree.getByRole('treeitem', { name: 'app.js' });
    await expect(appJs).toBeFocused();
    await expect(appJs).toHaveAttribute('aria-level', '2');

    await mainWindow.keyboard.press('ArrowLeft');
    await expect(src).toBeFocused();
    await mainWindow.keyboard.press('ArrowRight');
    await mainWindow.keyboard.press('ArrowRight');
    await mainWindow.keyboard.press('Enter');

    const tabs = mainWindow.getByRole('tablist', { name: 'Open files' });
    await expect(tabs.getByRole('tab', { name: /app\.js/ })).toHaveAttribute('aria-selected', 'true');
  });
});
