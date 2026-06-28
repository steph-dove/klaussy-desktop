// Merge-conflict resolver modal end-to-end. Builds a real git repo, creates
// divergent edits to the same file on two branches, attempts a merge to leave
// real conflict markers, then drives ConflictPanel.show() (the same entry the
// diff panel uses). Proves #conflict-overlay opens with its 3 panes, the
// conflicted file is listed in #conflict-file-select, the panes render the
// ours/theirs hunks, and #btn-conflict-resolve writes a resolution + stages it
// so git no longer reports the file as unmerged. Also covers #btn-conflict-close.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

// Build a repo whose worktree is left mid-merge with conflict markers in a.txt.
function buildConflictRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `klaussy-e2e-conflict-${process.pid}-`));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nshared\nline3\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  git('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nTHEIRS-change\nline3\n');
  git('add', '.');
  git('commit', '-q', '-m', 'feature edit');

  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nOURS-change\nline3\n');
  git('add', '.');
  git('commit', '-q', '-m', 'main edit');

  // Merge produces a conflict and exits non-zero — expected, swallow it.
  try { git('merge', 'feature'); } catch { /* conflict expected */ }
  return dir;
}

test('conflict resolver opens, shows panes, lists the file, and resolves', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repo = buildConflictRepo();
  try {
    // Sanity: the conflict really exists on disk before we drive the UI.
    const raw = fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8');
    expect(raw).toContain('<<<<<<<');
    expect(raw).toContain('OURS-change');
    expect(raw).toContain('THEIRS-change');

    // git-conflicts IPC sees a.txt as unmerged.
    const conflicts = await mainWindow.evaluate((wt) => window.klaus.git.conflicts(wt), repo);
    expect(conflicts.files).toContain('a.txt');

    const overlay = mainWindow.locator('#conflict-overlay');
    await expect(overlay).toBeHidden();

    // Drive the real panel entry point (diff-panel-diff.js calls show(worktreePath)).
    await mainWindow.evaluate((wt) => window.ConflictPanel.show(wt), repo);
    await expect(overlay).toBeVisible();

    // Three panes are present and visible.
    await expect(mainWindow.locator('#conflict-ours')).toBeVisible();
    await expect(mainWindow.locator('#conflict-result')).toBeVisible();
    await expect(mainWindow.locator('#conflict-theirs')).toBeVisible();

    // File selector lists the conflicted file.
    const select = mainWindow.locator('#conflict-file-select');
    await expect(select.locator('option')).toHaveCount(1);
    await expect(select.locator('option')).toHaveText('a.txt');

    // Panes render the divergent hunks.
    await expect(mainWindow.locator('#conflict-ours-body')).toContainText('OURS-change');
    await expect(mainWindow.locator('#conflict-theirs-body')).toContainText('THEIRS-change');
    // The result pane offers per-block resolution actions.
    await expect(mainWindow.locator('#conflict-result-body .conflict-action-btn[data-action="ours"]').first()).toBeVisible();

    // Resolve every conflict block by taking "ours", then mark resolved.
    await mainWindow.locator('#conflict-result-body .conflict-action-btn[data-action="ours"]').first().click();
    await mainWindow.locator('#btn-conflict-resolve').click();

    // Only one file -> modal closes once resolved.
    await expect(overlay).toBeHidden();

    // The resolution was written (no markers) and staged: git no longer reports it unmerged.
    const resolved = fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8');
    expect(resolved).not.toContain('<<<<<<<');
    expect(resolved).toContain('OURS-change');
    expect(resolved).not.toContain('THEIRS-change');

    const after = await mainWindow.evaluate((wt) => window.klaus.git.conflicts(wt), repo);
    expect(after.files).not.toContain('a.txt');

    // Close button hides the overlay too (re-open with no remaining conflicts).
    await mainWindow.evaluate((wt) => window.ConflictPanel.show(wt), repo);
    await expect(overlay).toBeVisible();
    await mainWindow.locator('#btn-conflict-close').click();
    await expect(overlay).toBeHidden();
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
