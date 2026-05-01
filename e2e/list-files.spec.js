// Regression test for the file-tree-show-gitignored fix: list-files must
// return gitignored entries (.env, generated pr-review.md, etc.) but still
// suppress heavy walker dirs (node_modules, dist, .next, ...).
//
// Drives window.klaus.fs.listFiles via the real preload bridge against a
// freshly-built temp git repo, so any change to the IPC contract or the
// pathspec filter is caught here.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

function buildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-repo-'));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\nnode_modules/\ndist/\n');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'tracked\n');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'foo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'foo', 'index.js'), '');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), '');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export {};\n');

  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('list-files returns gitignored files but skips node_modules/dist', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repoDir = buildRepo();
  try {
    const result = await mainWindow.evaluate(
      (repoPath) => window.klaus.fs.listFiles(repoPath),
      repoDir,
    );

    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.files)).toBe(true);

    const files = result.files;
    expect(files).toContain('tracked.txt');
    expect(files).toContain('.env');
    expect(files).toContain('src/index.js');
    expect(files).toContain('.gitignore');

    expect(files.find((f) => f.startsWith('node_modules/'))).toBeUndefined();
    expect(files.find((f) => f.startsWith('dist/'))).toBeUndefined();
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
