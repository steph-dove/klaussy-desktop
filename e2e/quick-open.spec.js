// Quick-open palette: shows a fuzzy filename picker over the active
// worktree, types narrow the list, Escape closes. UI-driven test —
// drives QuickOpen.show against a stubbed AppState pointing at a real
// repo so the listFiles IPC actually returns content.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

function buildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-qo-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'auth.js'), '');
  fs.writeFileSync(path.join(dir, 'src', 'router.js'), '');
  fs.writeFileSync(path.join(dir, 'src', 'utils.js'), '');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('quick-open palette opens, filters, and closes on Escape', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repo = buildRepo();
  try {
    await mainWindow.evaluate((wt) => {
      window.AppState.activeTaskId = 999;
      window.AppState.tasks.set(999, { id: 999, worktreePath: wt });
      window.QuickOpen.invalidate();
    }, repo);

    await mainWindow.evaluate(() => window.QuickOpen.show());

    const overlay = mainWindow.locator('.palette-overlay');
    const input = overlay.locator('.palette-input');
    const items = overlay.locator('.quick-open-item');

    await expect(overlay).toBeVisible();
    await expect(input).toBeFocused();
    // All four files render initially (README + three under src/).
    await expect(items).toHaveCount(4);

    await input.fill('aut');
    await expect(items).toHaveCount(1);
    await expect(items.first().locator('.quick-open-basename')).toHaveText('auth.js');

    await input.fill('');
    await expect(items).toHaveCount(4);

    await input.press('Escape');
    await expect(overlay).toHaveCount(0);
  } finally {
    await mainWindow.evaluate(() => {
      window.AppState.activeTaskId = null;
      window.AppState.tasks.delete(999);
      window.QuickOpen.invalidate();
    });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
