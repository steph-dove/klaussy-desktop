// File-tree CRUD: create-file / create-dir / rename-path / delete-path.
// These shipped with the file-tree create/rename/delete work — pin the
// IPC contract so future refactors don't silently regress the tree's
// context-menu actions or drag-to-move flow.
//
// delete-path uses shell.trashItem by default (recoverable from Finder
// Trash); we pass permanent: true here to keep tests hermetic.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

function buildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-crud-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', '.keep'), '');
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', '.keep'), '');
  git('add', '.'); git('commit', '-q', '-m', 'init');
  return dir;
}

test('create-file, create-dir, rename-path, delete-path round-trip', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repo = buildRepo();
  try {
    // create-file
    const create = await mainWindow.evaluate(
      ({ wt, rel }) => window.klaus.fs.createFile(wt, rel),
      { wt: repo, rel: 'src/new.js' },
    );
    expect(create.error).toBeFalsy();
    expect(fs.existsSync(path.join(repo, 'src', 'new.js'))).toBe(true);

    // Duplicate create rejected.
    const dupe = await mainWindow.evaluate(
      ({ wt, rel }) => window.klaus.fs.createFile(wt, rel),
      { wt: repo, rel: 'src/new.js' },
    );
    expect(dupe.error).toMatch(/already exists/);

    // Path-escape rejected.
    const escape = await mainWindow.evaluate(
      ({ wt, rel }) => window.klaus.fs.createFile(wt, rel),
      { wt: repo, rel: '../escaped.js' },
    );
    expect(escape.error).toMatch(/escapes worktree/);

    // create-dir
    const mkdir = await mainWindow.evaluate(
      ({ wt, rel }) => window.klaus.fs.createDir(wt, rel),
      { wt: repo, rel: 'docs' },
    );
    expect(mkdir.error).toBeFalsy();
    expect(fs.statSync(path.join(repo, 'docs')).isDirectory()).toBe(true);

    // rename-path: rename within a dir.
    const ren = await mainWindow.evaluate(
      ({ wt, from, to }) => window.klaus.fs.renamePath(wt, from, to),
      { wt: repo, from: 'src/new.js', to: 'src/renamed.js' },
    );
    expect(ren.error).toBeFalsy();
    expect(fs.existsSync(path.join(repo, 'src', 'new.js'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'src', 'renamed.js'))).toBe(true);

    // rename-path: move across dirs (drag-to-move case). Auto-creates
    // the parent dir if it doesn't exist.
    const mv = await mainWindow.evaluate(
      ({ wt, from, to }) => window.klaus.fs.renamePath(wt, from, to),
      { wt: repo, from: 'src/renamed.js', to: 'lib/moved.js' },
    );
    expect(mv.error).toBeFalsy();
    expect(fs.existsSync(path.join(repo, 'lib', 'moved.js'))).toBe(true);

    // rename-path: refuse to overwrite.
    fs.writeFileSync(path.join(repo, 'occupied.txt'), 'busy\n');
    const overwrite = await mainWindow.evaluate(
      ({ wt, from, to }) => window.klaus.fs.renamePath(wt, from, to),
      { wt: repo, from: 'lib/moved.js', to: 'occupied.txt' },
    );
    expect(overwrite.error).toMatch(/already exists/);

    // delete-path with permanent: true (skip Trash).
    const del = await mainWindow.evaluate(
      ({ wt, rel }) => window.klaus.fs.deletePath(wt, rel, true),
      { wt: repo, rel: 'occupied.txt' },
    );
    expect(del.error).toBeFalsy();
    expect(fs.existsSync(path.join(repo, 'occupied.txt'))).toBe(false);

    // delete-path: refuse to delete the worktree root.
    const rootDel = await mainWindow.evaluate(
      ({ wt }) => window.klaus.fs.deletePath(wt, '.', true),
      { wt: repo },
    );
    expect(rootDel.error).toMatch(/refusing to delete worktree root/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
