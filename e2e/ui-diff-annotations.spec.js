/* global window, AppState */
// These are used inside page.evaluate callbacks (renderer context); the e2e
// eslint override is node-only.
//
// Inline diff annotations end-to-end against a live worktree: the comment
// callback is swapped for a capturing stub so we can assert the exact prompt
// without spawning an agent. Step screenshots land in QA_SHOT_DIR (default: tmp).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

const SHOT_DIR = process.env.QA_SHOT_DIR || path.join(os.tmpdir(), 'klaussy-qa-diff-annotations');

function shot(mainWindow, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return mainWindow.screenshot({ path: path.join(SHOT_DIR, name) });
}

function buildBaseRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-annot-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'sample.js'), 'function a() {\n  return 1;\n}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('inline diff annotations: hover → comment → aggregate → send', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();

  const repo = buildBaseRepo();
  const taskName = `annot-${process.pid}-${Date.now()}`;

  let taskId = null;
  try {
    const result = await mainWindow.evaluate(
      ({ name, repoPath }) => window.klaus.task.create(name, repoPath, 'shell'),
      { name: taskName, repoPath: repo },
    );
    expect(result.error, `create-task error: ${result.error}`).toBeFalsy();
    taskId = result.id;
    const worktree = result.worktreePath;

    // Produce a diff with several added lines to comment on.
    fs.writeFileSync(
      path.join(worktree, 'sample.js'),
      'function a() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}\n',
    );

    // Open the panel on the worktree and render the file's diff.
    await mainWindow.evaluate((wt) => window.DiffPanel.show(wt), worktree);
    await expect(mainWindow.locator('#diff-panel')).toBeVisible();
    await mainWindow.evaluate(() => window.DiffPanel.refresh());
    await mainWindow.locator('#diff-file-list .diff-file[data-file="sample.js"]').click();

    const addLines = mainWindow.locator('#diff-view .diff-line.diff-add');
    await expect(addLines.first()).toBeVisible();

    // --- Step 1: hover a line reveals "+", clicking it opens the editor ---
    const firstLine = addLines.nth(0);
    await firstLine.hover();
    const firstPlus = firstLine.locator('.diff-comment-add');
    await expect(firstPlus).toBeVisible();
    await firstPlus.click();
    await expect(mainWindow.locator('#diff-view .diff-annotation-editor')).toBeVisible();
    await shot(mainWindow, '1-editor-open.png');

    // --- Step 2: type + save → persistent marker + floating bar shows 1 ---
    await mainWindow.locator('.diff-annotation-editor .diff-annotation-input').fill('rename x to something clearer');
    await mainWindow.locator('.diff-annotation-editor .diff-annotation-save').click();
    await expect(mainWindow.locator('#diff-view .diff-annotation')).toHaveCount(1);
    await expect(mainWindow.locator('#diff-annotations-bar')).toBeVisible();
    await expect(mainWindow.locator('#diff-annotations-bar .diff-annotations-count')).toHaveText('1 comment');
    await shot(mainWindow, '2-one-comment.png');

    // --- Step 3: a second comment on another line → count becomes 2 ---
    const secondLine = addLines.nth(1);
    await secondLine.hover();
    const secondPlus = secondLine.locator('.diff-comment-add');
    await expect(secondPlus).toBeVisible();
    await secondPlus.click();
    await mainWindow.locator('.diff-annotation-editor .diff-annotation-input').fill('is y used anywhere else?');
    await mainWindow.locator('.diff-annotation-editor .diff-annotation-save').click();
    await expect(mainWindow.locator('#diff-view .diff-annotation')).toHaveCount(2);
    await expect(mainWindow.locator('#diff-annotations-bar .diff-annotations-count')).toHaveText('2 comments');
    await shot(mainWindow, '3-two-comments.png');

    // --- Step 4: Send formats one prompt through the comment callback ---
    // Swap the callback for a capturing stub and pin an active task so the
    // send guard passes deterministically.
    await mainWindow.evaluate((id) => {
      window.__annotSent = null;
      window.DiffPanel.setCommentCallback((text) => { window.__annotSent = text; });
      if (typeof AppState !== 'undefined') AppState.activeTaskId = id;
    }, taskId);

    await mainWindow.locator('#diff-annotations-bar .diff-annotations-send').click();

    const sent = await mainWindow.evaluate(() => window.__annotSent);
    expect(sent, 'comment callback received the formatted prompt').toBeTruthy();
    expect(sent).toContain('Review feedback on the current diff:');
    expect(sent).toContain('sample.js:');
    expect(sent).toContain('rename x to something clearer');
    expect(sent).toContain('is y used anywhere else?');
    expect(sent).toContain('Please address this feedback.');

    // Sending clears the bar and the inline markers.
    await expect(mainWindow.locator('#diff-annotations-bar')).toHaveCount(0);
    await expect(mainWindow.locator('#diff-view .diff-annotation')).toHaveCount(0);
    await shot(mainWindow, '4-sent-cleared.png');
  } finally {
    if (taskId != null) {
      await mainWindow.evaluate((id) => window.klaus.task.kill(id), taskId).catch(() => {});
    }
  }
});
