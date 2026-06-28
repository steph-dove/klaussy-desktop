// History tab (Feature 11): with a real worktree open in the diff panel, the
// History pane lists commits and its Commits/Tags sub-tabs (#history-sub-tabs)
// swap between #history-list and #tags-list. Proves the commit log renders
// (repo has >=2 commits), the Tags sub-tab loads existing tags, and the
// create-tag form (#tags-create-form) opens, fills, and cancels closed without
// mutating state — then a real create round-trips into #tags-list. AppState is
// pointed at the worktree so the sub-tab loaders / tagCreate read the right
// path (HistoryPanel.loadTags + the submit handler read AppState, not the
// diff-tab's worktree override).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');
const { buildRepo, git, rm } = require('./helpers');

test('History tab lists commits, swaps to tags, and drives the create-tag form', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();

  // Repo with two commits and one pre-existing tag so both lists have content.
  const repo = buildRepo({ 'README.md': '# r\n' }, 'history');
  fs.writeFileSync(path.join(repo, 'second.txt'), 'second\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'second commit');
  const seedTag = `v0.9.0-${process.pid}`;
  git(repo, 'tag', seedTag);

  const taskName = `histtags-${process.pid}-${Date.now()}`;
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
    const worktree = result.worktreePath;

    // Point AppState at the worktree — the Tags sub-tab loader and the create
    // form's submit read AppState.activeTaskId, not the diff-tab worktree arg.
    await mainWindow.evaluate(({ id, wt }) => {
      window.AppState.activeTaskId = id;
      window.AppState.tasks.set(id, { id, worktreePath: wt });
    }, { id: taskId, wt: worktree });

    // Open the diff panel and switch to the History tab (same delegated path
    // the diff-tab strip uses); the History pane only has layout once visible.
    await mainWindow.evaluate((wt) => window.DiffPanel.show(wt), worktree);
    await expect(mainWindow.locator('#diff-panel')).toBeVisible();
    await mainWindow.locator('#diff-tabs .diff-tab[data-tab="history"]').click();
    await expect(mainWindow.locator('#history-tab-content')).toBeVisible();

    // Commits sub-tab is the default; the log renders one row per commit.
    await expect(mainWindow.locator('#history-sub-tabs .history-sub-tab[data-sub="commits"]')).toHaveClass(/active/);
    await expect(mainWindow.locator('#history-commits-content')).toBeVisible();
    const commitItems = mainWindow.locator('#history-list .history-item');
    await expect(commitItems).toHaveCount(2);
    await expect(commitItems.first()).toContainText('second commit');

    // Switch to the Tags sub-tab — loads the seeded tag.
    await mainWindow.locator('#history-sub-tabs .history-sub-tab[data-sub="tags"]').click();
    await expect(mainWindow.locator('#history-tags-content')).toBeVisible();
    await expect(mainWindow.locator('#history-commits-content')).toBeHidden();
    await expect(mainWindow.locator(`#tags-list .tag-item:has-text("${seedTag}")`)).toBeVisible();

    // Create-tag form: opens, then Cancel closes it without creating anything.
    await expect(mainWindow.locator('#tags-create-form')).toBeHidden();
    await mainWindow.locator('#btn-create-tag').click();
    await expect(mainWindow.locator('#tags-create-form')).toBeVisible();
    await mainWindow.locator('#tag-name-input').fill('throwaway-not-created');
    await mainWindow.locator('#btn-tag-cancel').click();
    await expect(mainWindow.locator('#tags-create-form')).toBeHidden();
    // The cancelled name never reached the list.
    await expect(mainWindow.locator('#tags-list .tag-item:has-text("throwaway-not-created")')).toHaveCount(0);

    // Now actually create a tag through the form and confirm it round-trips
    // into #tags-list (and the form auto-closes on success).
    const newTag = `v1.0.0-${process.pid}-${Date.now()}`;
    await mainWindow.locator('#btn-create-tag').click();
    await expect(mainWindow.locator('#tags-create-form')).toBeVisible();
    await mainWindow.locator('#tag-name-input').fill(newTag);
    await mainWindow.locator('#btn-tag-submit').click();
    await expect(mainWindow.locator('#tags-create-form')).toBeHidden();
    await expect(mainWindow.locator(`#tags-list .tag-item:has-text("${newTag}")`)).toBeVisible();
  } finally {
    if (taskId != null) {
      await mainWindow.evaluate((id) => window.klaus.task.kill(id), taskId).catch(() => {});
      await mainWindow.evaluate((id) => {
        if (window.AppState) { window.AppState.activeTaskId = null; window.AppState.tasks.delete(id); }
      }, taskId).catch(() => {});
    }
    try { execFileSync('git', ['worktree', 'remove', '--force', expectedWorktree], { cwd: repo, stdio: 'pipe' }); } catch {}
    try { execFileSync('git', ['branch', '-D', taskName], { cwd: repo, stdio: 'pipe' }); } catch {}
    rm(repo);
    rm(sessionDir);
  }
});
