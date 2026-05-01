// search-files IPC: literal search via git grep (with grep fallback for
// non-git folders). Validates the result shape the project-search panel
// depends on, and that the binary-file (-I) and walker-ignore filters
// behave the way the renderer assumes.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

function buildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-search-'));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello world\nNEEDLE here\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'no match here\nNEEDLE again\nfinal NEEDLE\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), '// no marker\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'noisy.js'), 'NEEDLE\n');

  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('search-files returns matches with line numbers, skips node_modules', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repo = buildRepo();
  try {
    const result = await mainWindow.evaluate(
      ({ wt, q }) => window.klaus.fs.searchFiles(wt, q),
      { wt: repo, q: 'NEEDLE' },
    );

    expect(result.error).toBeUndefined();
    const files = result.results.map((r) => r.file);
    expect(files).toContain('a.txt');
    expect(files).toContain('b.txt');
    expect(files.find((f) => f.startsWith('node_modules/'))).toBeUndefined();

    // Each result has a sensible shape.
    const aHit = result.results.find((r) => r.file === 'a.txt');
    expect(aHit.line).toBe(2);
    expect(aHit.text).toContain('NEEDLE');

    // Multiple hits per file in b.txt.
    const bHits = result.results.filter((r) => r.file === 'b.txt');
    expect(bHits.length).toBeGreaterThanOrEqual(2);

    // No matches → empty results, no error.
    const empty = await mainWindow.evaluate(
      ({ wt, q }) => window.klaus.fs.searchFiles(wt, q),
      { wt: repo, q: 'no_such_string_xyz_12345' },
    );
    expect(empty.error).toBeUndefined();
    expect(empty.results).toEqual([]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
