// "Open in Terminal" on a folder's right-click menu: folders get the item,

/* global window */
// files don't, and the new tab's shell starts in that folder.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');
const { buildRepo, rm, openShellTask } = require('./helpers');

test('folder menu opens a terminal tab in that folder; files have no such item', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  const repo = buildRepo({ 'README.md': '# r\n', 'src/index.js': 'x\n' }, 'open-term');
  try {
    const id = await openShellTask(mainWindow, repo);
    await mainWindow.evaluate((wt) => window.FileBrowser.loadFileTree(wt), repo);
    const tree = mainWindow.locator('#file-tree');
    const item = mainWindow.getByRole('menuitem', { name: 'Open in Terminal' });

    await tree.locator('.file-tree-file', { hasText: 'README.md' }).dispatchEvent('contextmenu');
    await expect(mainWindow.getByRole('menuitem', { name: 'Copy Path' })).toBeVisible();
    await expect(item).toHaveCount(0);
    await mainWindow.keyboard.press('Escape');

    await tree.locator('.file-tree-dir .file-tree-label', { hasText: 'src' }).first().dispatchEvent('contextmenu');
    await item.click();

    const tab = mainWindow.locator('.sub-tab', { hasText: 'src' });
    await expect(tab).toHaveCount(1);
    const marker = path.join(repo, 'cwd.txt');
    const subId = await mainWindow.evaluate((tid) => {
      const subs = window.AppState.tasks.get(tid).subTerminals;
      return subs[subs.length - 1].subId;
    }, id);
    await expect(async () => {
      await mainWindow.evaluate(({ tid, sid, m }) => window.klaus.terminal.write(tid, `pwd -P > '${m}'\r`, sid), { tid: id, sid: subId, m: marker });
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe(fs.realpathSync(path.join(repo, 'src')));
    }).toPass({ timeout: 20000 });

    const bad = await mainWindow.evaluate(({ tid }) => window.klaus.terminal.addSub(tid, 'x', 'shell', null, null, '../..'), { tid: id });
    expect(bad.error).toMatch(/not inside/);
  } finally { rm(repo); }
});
