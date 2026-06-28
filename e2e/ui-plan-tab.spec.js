// Plan tab + Plan/Design source switch. A real shell task gives a live worktree
// whose root carries plan.md and design.md; opening the Plan diff-tab loads the
// plan markdown into #plan-markdown-view (no checkboxes, so the doc body renders
// rather than the progress card). With both docs present #plan-source-switch
// shows; clicking the Design button swaps the view to the design content, and
// #btn-refresh-plan re-reads the file from disk. Mirrors ui-diff-tabs.spec.js
// for the panel/task plumbing.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');
const { buildRepo, rm } = require('./helpers');

const PLAN_BODY = 'PLAN-DOC-BODY-alpha unique marker';
const DESIGN_BODY = 'DESIGN-DOC-BODY-beta unique marker';

test('plan tab renders plan markdown and switches between plan and design sources', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();

  // No task-list checkboxes in plan.md → PlanPanel falls back to rendering the
  // document body into #plan-markdown-view (the progress card stays hidden).
  const repo = buildRepo({
    'README.md': '# r\n',
    'plan.md': `# Project Plan\n\n${PLAN_BODY}\n`,
    'design.md': `# Design Document\n\n${DESIGN_BODY}\n`,
  }, 'plan-tab');

  const taskName = `plantab-${process.pid}-${Date.now()}`;
  const sessionDir = path.join(os.homedir(), 'klaussy', 'sessions', taskName);
  const expectedWorktree = path.join(sessionDir, path.basename(repo));

  let taskId = null;
  let worktreePath = null;
  try {
    const result = await mainWindow.evaluate(
      ({ name, repoPath }) => window.klaus.task.create(name, repoPath, 'shell'),
      { name: taskName, repoPath: repo },
    );
    expect(result.error, `create-task error: ${result.error}`).toBeFalsy();
    taskId = result.id;
    worktreePath = result.worktreePath;

    // The worktree branches off main, so plan.md / design.md are present at root.
    expect(fs.existsSync(path.join(worktreePath, 'plan.md'))).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, 'design.md'))).toBe(true);

    // Open the diff panel + Plan tab the same way the UI does. Creating the task
    // over IPC skips the renderer's switchToTask path that normally emits
    // `task:switched` (which is what hands PlanPanel the worktree), so set it
    // directly — the same call that event handler makes.
    await mainWindow.evaluate((wt) => window.DiffPanel.show(wt), worktreePath);
    await mainWindow.evaluate((wt) => window.PlanPanel.setWorktree(wt), worktreePath);
    await expect(mainWindow.locator('#diff-panel')).toBeVisible();

    await mainWindow.locator('#diff-tabs .diff-tab[data-tab="plan"]').click();
    await expect(mainWindow.locator('#diff-tabs .diff-tab[data-tab="plan"]')).toHaveClass(/active/);
    await expect(mainWindow.locator('#plan-tab-content')).toBeVisible();

    // Plan source renders the plan document body into the markdown view.
    const view = mainWindow.locator('#plan-markdown-view');
    await expect(view).toContainText(PLAN_BODY);
    await expect(view).not.toContainText(DESIGN_BODY);

    // Both docs exist → the source switcher is shown with Plan active.
    const switcher = mainWindow.locator('#plan-source-switch');
    await expect(switcher).toBeVisible();
    await expect(mainWindow.locator('.plan-source-btn[data-source="plan"]')).toHaveClass(/active/);

    // Switch to Design → view swaps to the design document content.
    await mainWindow.locator('.plan-source-btn[data-source="design"]').click();
    await expect(mainWindow.locator('.plan-source-btn[data-source="design"]')).toHaveClass(/active/);
    await expect(view).toContainText(DESIGN_BODY);
    await expect(view).not.toContainText(PLAN_BODY);

    // Refresh re-reads design.md from disk: edit the file, then click refresh.
    const REFRESHED = 'DESIGN-DOC-REFRESHED-gamma';
    fs.writeFileSync(path.join(worktreePath, 'design.md'), `# Design Document\n\n${REFRESHED}\n`);
    await mainWindow.locator('#btn-refresh-plan').click();
    await expect(view).toContainText(REFRESHED);
    await expect(view).not.toContainText(DESIGN_BODY);
  } finally {
    if (taskId != null) {
      await mainWindow.evaluate((id) => window.klaus.task.kill(id), taskId).catch(() => {});
    }
    try { execFileSync('git', ['worktree', 'remove', '--force', expectedWorktree], { cwd: repo, stdio: 'pipe' }); } catch {}
    try { execFileSync('git', ['branch', '-D', taskName], { cwd: repo, stdio: 'pipe' }); } catch {}
    rm(repo);
    rm(sessionDir);
  }
});
