// "Collapse All" in a folder's context menu closes that folder and every
// open folder beneath it; files don't get the item.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

function buildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-collapse-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  fs.mkdirSync(path.join(dir, 'src', 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a', 'b', 'deep.js'), '');
  fs.writeFileSync(path.join(dir, 'src', 'a', 'mid.js'), '');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('Collapse All closes a folder and its open descendants; files lack the item', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  const repo = buildRepo();
  try {
    await mainWindow.evaluate((p) => window.FileBrowser.loadFileTree(p), repo);
    const tree = mainWindow.locator('#file-tree');
    const dir = (rel) => tree.locator(`[data-kind="dir"][data-path="${rel}"]`);

    for (const rel of ['src', 'src/a', 'src/a/b']) await dir(rel).dispatchEvent('click');
    for (const rel of ['src', 'src/a', 'src/a/b']) await expect(dir(rel)).toHaveAttribute('aria-expanded', 'true');

    // A file's menu has no Collapse All.
    await tree.locator('[data-kind="file"][data-path="README.md"]').dispatchEvent('contextmenu');
    await expect(mainWindow.locator('.context-menu')).toBeVisible();
    await expect(mainWindow.locator('.context-menu [role^="menuitem"]', { hasText: 'Collapse All' })).toHaveCount(0);
    await mainWindow.keyboard.press('Escape');

    // Menu on the middle folder collapses it and b, leaving src open.
    await dir('src/a').dispatchEvent('contextmenu');
    await mainWindow.locator('.context-menu [role^="menuitem"]', { hasText: 'Collapse All' }).dispatchEvent('click');
    await expect(dir('src/a')).toHaveAttribute('aria-expanded', 'false');
    await expect(dir('src/a/b')).toHaveAttribute('aria-expanded', 'false');
    await expect(dir('src')).toHaveAttribute('aria-expanded', 'true');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
