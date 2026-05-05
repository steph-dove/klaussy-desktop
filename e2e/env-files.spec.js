// .env file IPCs: list / read / write, plus the path-traversal and
// dotfile-prefix safety checks that gate the env panel. All values
// here are dummy strings — no real secrets are touched.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { test, expect } = require('./fixtures');

test('env files: list, read, write with traversal guard', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-env-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'FOO=fake-value\n');
    fs.writeFileSync(path.join(dir, '.env.local'), 'BAR=fake-local\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');

    const list = await mainWindow.evaluate(
      (wt) => window.klaus.fs.listEnvFiles(wt),
      dir,
    );
    expect(list.error).toBeUndefined();
    expect(list.files.sort()).toEqual(['.env', '.env.local']);

    const read = await mainWindow.evaluate(
      ({ wt, f }) => window.klaus.fs.readEnvFile(wt, f),
      { wt: dir, f: '.env' },
    );
    expect(read.content).toBe('FOO=fake-value\n');

    // Round-trip: write then read.
    const write = await mainWindow.evaluate(
      ({ wt, f, c }) => window.klaus.fs.writeEnvFile(wt, f, c),
      { wt: dir, f: '.env.test', c: 'BAZ=fake-write\n' },
    );
    expect(write.error).toBeFalsy();
    const readBack = await mainWindow.evaluate(
      ({ wt, f }) => window.klaus.fs.readEnvFile(wt, f),
      { wt: dir, f: '.env.test' },
    );
    expect(readBack.content).toBe('BAZ=fake-write\n');

    // Traversal guard: slashes rejected.
    const traverse = await mainWindow.evaluate(
      ({ wt, f }) => window.klaus.fs.readEnvFile(wt, f),
      { wt: dir, f: '../escape' },
    );
    expect(traverse.error).toBe('Invalid filename');

    // Dotfile-prefix guard: non-.env names rejected even without slashes.
    const wrongPrefix = await mainWindow.evaluate(
      ({ wt, f }) => window.klaus.fs.readEnvFile(wt, f),
      { wt: dir, f: 'README.md' },
    );
    expect(wrongPrefix.error).toBe('Invalid filename');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
