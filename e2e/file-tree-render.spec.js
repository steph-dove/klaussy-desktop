// File tree UI rendering: building on list-files.spec, this drives the
// renderer's FileBrowser.loadFileTree against a real worktree and asserts
// the DOM populates correctly — root-level files show, directories
// render as collapsed and expand on click.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

function buildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-tree-'));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\nnode_modules/\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  fs.writeFileSync(path.join(dir, '.env'), 'X=1\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export {};\n');
  fs.writeFileSync(path.join(dir, 'src', 'util.js'), '');
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), '');

  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('file tree renders root files + collapsed dirs, expands on click', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repoDir = buildRepo();
  try {
    await mainWindow.evaluate(
      (repoPath) => window.FileBrowser.loadFileTree(repoPath),
      repoDir,
    );

    // The Files tab is hidden by default (#files-tab-content display:none),
    // so we assert against attachment, not visibility — loadFileTree's job
    // is to populate the DOM regardless of whether the tab is currently
    // showing. The tab system is a separate concern.
    const fileTree = mainWindow.locator('#file-tree');

    // Root-level files render eagerly — gitignored .env included, since
    // list-files surfaces it (see list-files.spec).
    await expect(fileTree.locator('.file-tree-file', { hasText: 'README.md' })).toHaveCount(1);
    await expect(fileTree.locator('.file-tree-file', { hasText: '.env' })).toHaveCount(1);
    await expect(fileTree.locator('.file-tree-file', { hasText: '.gitignore' })).toHaveCount(1);

    // node_modules is filtered at the IPC layer, so it shouldn't appear
    // even as a collapsed directory.
    await expect(fileTree.locator('.file-tree-dir')).toHaveCount(1);
    const srcDir = fileTree.locator('.file-tree-dir').first();
    await expect(srcDir.locator('.file-tree-label', { hasText: 'src' })).toHaveCount(1);

    // Children are lazy — src/index.js shouldn't be in the DOM until expanded.
    await expect(fileTree.locator('.file-tree-file', { hasText: 'index.js' })).toHaveCount(0);

    // dispatchEvent rather than click() because click waits for visibility,
    // and the parent tab is display:none.
    await srcDir.locator('.file-tree-label').dispatchEvent('click');
    await expect(fileTree.locator('.file-tree-file', { hasText: 'index.js' })).toHaveCount(1);
    await expect(fileTree.locator('.file-tree-file', { hasText: 'util.js' })).toHaveCount(1);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
