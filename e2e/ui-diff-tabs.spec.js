// Diff/PR panel tab strip: with a real worktree open, the #diff-tabs buttons
// drive which #<tab>-tab-content pane shows. Proves the default is Changes and
// that clicking each tab (plan/changes/pr/files/search/history/stash) flips
// the matching pane visible and marks the tab .active. Pure renderer wiring
// (PRPanel.init delegates the clicks); a real shell task gives a live worktree
// so DiffPanel.show + the per-tab loaders don't error.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

function buildBaseRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-difftabs-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'README.md'), '# base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('diff panel tab strip switches panes and defaults to Changes', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();

  const repo = buildBaseRepo();
  // Unique per-run session name so concurrent specs don't collide on the
  // shared ~/klaussy/sessions/<name> directory.
  const taskName = `difftabs-${process.pid}-${Date.now()}`;
  const sessionDir = path.join(os.homedir(), 'klaussy', 'sessions', taskName);
  const expectedWorktree = path.join(sessionDir, path.basename(repo));

  let taskId = null;
  try {
    const result = await mainWindow.evaluate(
      ({ name, repoPath }) => window.klaus.task.create(name, repoPath, 'shell'),
      { name: taskName, repoPath: repo },
    );
    expect(result.error, `create-task error: ${result.error}`).toBeFalsy();
    taskId = result.id;

    // Open the diff panel against the new worktree (the same call the sidebar
    // and terminal use). The tab-content panes only have layout once the panel
    // carries .visible.
    await mainWindow.evaluate((wt) => window.DiffPanel.show(wt), result.worktreePath);
    await expect(mainWindow.locator('#diff-panel')).toBeVisible();

    // Default pane is Changes — its tab is pre-marked .active and its content
    // has no display:none, every other pane starts hidden.
    await expect(mainWindow.locator('#diff-tabs .diff-tab[data-tab="changes"]')).toHaveClass(/active/);
    await expect(mainWindow.locator('#changes-tab-content')).toBeVisible();

    const tabs = ['plan', 'changes', 'pr', 'files', 'search', 'history', 'stash'];
    for (const tab of tabs) {
      await mainWindow.locator(`#diff-tabs .diff-tab[data-tab="${tab}"]`).click();
      await expect(mainWindow.locator(`#diff-tabs .diff-tab[data-tab="${tab}"]`)).toHaveClass(/active/);
      await expect(mainWindow.locator(`#${tab}-tab-content`)).toBeVisible();
      // Selecting a tab is exclusive — the previously-default Changes pane is
      // hidden whenever some other tab is active.
      if (tab !== 'changes') {
        await expect(mainWindow.locator('#changes-tab-content')).toBeHidden();
      }
    }
  } finally {
    if (taskId != null) {
      await mainWindow.evaluate((id) => window.klaus.task.kill(id), taskId).catch(() => {});
    }
    try { execFileSync('git', ['worktree', 'remove', '--force', expectedWorktree], { cwd: repo, stdio: 'pipe' }); } catch {}
    try { execFileSync('git', ['branch', '-D', taskName], { cwd: repo, stdio: 'pipe' }); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
