/* global window */
// File-tree context menu: "Copy Path" on a file row and a folder row copies
// the absolute path to the clipboard and shows a "Copied path" toast.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

function buildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-copypath-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export {};\n');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('Copy Path copies the absolute path for a file and a folder', async ({ electronApp, mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repoDir = fs.realpathSync(buildRepo());
  const savedClipboard = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await mainWindow.evaluate((p) => window.FileBrowser.loadFileTree(p), repoDir);
    const fileTree = mainWindow.locator('#file-tree');

    const readClipboard = () => electronApp.evaluate(({ clipboard }) => clipboard.readText());
    const copyPathVia = async (row) => {
      // The Files tab is display:none, so dispatch the event instead of right-clicking.
      await row.dispatchEvent('contextmenu', { clientX: 20, clientY: 20 });
      await mainWindow.locator('.context-menu-item', { hasText: /^\s*Copy Path$/ }).dispatchEvent('click');
    };

    await copyPathVia(fileTree.locator('.file-tree-file', { hasText: 'README.md' }));
    await expect(mainWindow.locator('.klaussy-toast', { hasText: 'Copied path' }).first()).toBeAttached();
    await expect.poll(readClipboard).toBe(path.join(repoDir, 'README.md'));

    await copyPathVia(fileTree.locator('.file-tree-dir .file-tree-label', { hasText: 'src' }));
    await expect.poll(readClipboard).toBe(path.join(repoDir, 'src'));
    await expect(mainWindow.locator('.klaussy-toast', { hasText: 'Copied path' }).last()).toBeAttached();
  } finally {
    await electronApp.evaluate(({ clipboard }, t) => clipboard.writeText(t), savedClipboard);
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
