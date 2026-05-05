// Project list management: list / add / remove / switch. Persists to
// config.json the same way the project switcher's UI does. Catches
// regressions in the config schema (projects[] shape) and the repoPath
// auto-update on remove.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

function buildRepo(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `klaussy-e2e-proj-${label}-`));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${label}\n`);
  git('add', '.'); git('commit', '-q', '-m', 'init');
  return dir;
}

function readConfig(userDataDir) {
  const cfg = path.join(userDataDir, 'config.json');
  if (!fs.existsSync(cfg)) return {};
  try { return JSON.parse(fs.readFileSync(cfg, 'utf-8')); } catch { return {}; }
}

test('add, list, switch, remove projects via the repo IPCs', async ({ mainWindow, userDataDir }) => {
  await mainWindow.waitForLoadState('networkidle');

  const a = buildRepo('a');
  const b = buildRepo('b');
  try {
    let list = await mainWindow.evaluate(() => window.klaus.repo.listProjects());
    expect(list).toEqual([]);

    const added = await mainWindow.evaluate(
      (folderPath) => window.klaus.repo.addProject(folderPath),
      a,
    );
    expect(added).toBeTruthy();
    expect(added.path).toBe(a);
    expect(added.name).toBe(path.basename(a));

    expect(readConfig(userDataDir).repoPath).toBe(a);

    list = await mainWindow.evaluate(() => window.klaus.repo.listProjects());
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe(a);

    // Idempotent add — same path, no duplicate row.
    await mainWindow.evaluate((p) => window.klaus.repo.addProject(p), a);
    list = await mainWindow.evaluate(() => window.klaus.repo.listProjects());
    expect(list).toHaveLength(1);

    await mainWindow.evaluate((p) => window.klaus.repo.addProject(p), b);
    list = await mainWindow.evaluate(() => window.klaus.repo.listProjects());
    expect(list).toHaveLength(2);

    // addProject sets repoPath as a side effect — last-added wins.
    expect(readConfig(userDataDir).repoPath).toBe(b);

    // Switch back to A.
    await mainWindow.evaluate((p) => window.klaus.repo.switchProject(p), a);
    expect(readConfig(userDataDir).repoPath).toBe(a);

    // Remove A: repoPath rolls over to B (the only remaining project).
    await mainWindow.evaluate((p) => window.klaus.repo.removeProject(p), a);
    list = await mainWindow.evaluate(() => window.klaus.repo.listProjects());
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe(b);
    expect(readConfig(userDataDir).repoPath).toBe(b);

    // Remove the last project: repoPath becomes null, not stuck on a deleted path.
    await mainWindow.evaluate((p) => window.klaus.repo.removeProject(p), b);
    list = await mainWindow.evaluate(() => window.klaus.repo.listProjects());
    expect(list).toEqual([]);
    expect(readConfig(userDataDir).repoPath).toBeNull();
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});
