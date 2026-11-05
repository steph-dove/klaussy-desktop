// File tree right-click menu: "Copy Name" copies only the last path segment
// to the clipboard and confirms with a toast.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

// Unique per process so concurrent specs / reruns never collide on names.
const UNIQ = process.pid + '-' + Date.now();
const TASK_ID = 'uft-' + UNIQ;

function buildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-uft-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'alpha.js'), 'export {};\n');
  fs.writeFileSync(path.join(dir, 'src', 'beta.js'), 'export {};\n');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

// Stub an active task at `wt`, force the diff panel + Files tab visible (so the
// header controls are real-clickable), and populate the tree. Returns once
// loadFileTree resolves.
async function openFilesTab(mainWindow, wt, taskId) {
  await mainWindow.evaluate(async ({ wt, taskId }) => {
    // Creating a file opens the viewer → Monaco init → InlineComplete.attach,
    // which pops the async Ollama-consent modal. That overlay intercepts later
    // header clicks. Stub the consent gate (read dynamically by inline-complete)
    // to a no-op and hide any overlay that already showed.
    window.OllamaConsent = { openIfNeeded: function () { return Promise.resolve({ ok: false, declined: true }); } };
    var ov = document.getElementById('ollama-consent-overlay');
    if (ov) ov.style.display = 'none';
    window.AppState.activeTaskId = taskId;
    window.AppState.tasks.set(taskId, { id: taskId, worktreePath: wt, branch: 'main' });
    document.getElementById('diff-panel').classList.add('visible');
    document.querySelectorAll('#diff-tabs .diff-tab').forEach(function (t) { t.classList.remove('active'); });
    var ft = document.querySelector('#diff-tabs .diff-tab[data-tab="files"]');
    if (ft) ft.classList.add('active');
    ['changes-tab-content', 'pr-tab-content', 'search-tab-content'].forEach(function (id) {
      var e = document.getElementById(id);
      if (e) e.style.display = 'none';
    });
    var fc = document.getElementById('files-tab-content');
    fc.style.display = '';
    fc.classList.remove('tree-collapsed');
    await window.FileBrowser.loadFileTree(wt);
  }, { wt, taskId });
}

async function cleanup(mainWindow, repo, taskId) {
  await mainWindow.evaluate((id) => {
    window.AppState.activeTaskId = null;
    window.AppState.tasks.delete(id);
  }, taskId);
  fs.rmSync(repo, { recursive: true, force: true });
}

test('tree context menu: Copy Name copies just the name and toasts', async ({ electronApp, mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  const repo = buildRepo();
  const taskId = TASK_ID + '-a';
  try {
    await openFilesTab(mainWindow, repo, taskId);
    const fileTree = mainWindow.locator('#file-tree');
    const readClipboard = () => electronApp.evaluate(({ clipboard }) => clipboard.readText());

    // Nested file: expand src, then right-click alpha.js.
    await fileTree.locator('[data-kind="dir"][data-path="src"]').first().click();
    const file = fileTree.locator('[role="treeitem"][data-path="src/alpha.js"]');
    await file.click({ button: 'right' });
    await mainWindow.locator('.context-menu [role="menuitem"]', { hasText: 'Copy Name' }).click();
    await expect.poll(readClipboard).toBe('alpha.js');
    await expect(mainWindow.locator('.klaussy-toast', { hasText: 'Copied name' })).toBeVisible();

    // Folder: name only, no parent path.
    await fileTree.locator('[role="treeitem"][data-path="src"]').click({ button: 'right' });
    await mainWindow.locator('.context-menu [role="menuitem"]', { hasText: 'Copy Name' }).click();
    await expect.poll(readClipboard).toBe('src');
  } finally {
    await cleanup(mainWindow, repo, taskId);
  }
});
