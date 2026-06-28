// Files tab HEADER controls (distinct from file-tree-render.spec, which
// covers tree rendering/expansion). With a stubbed active task pointing at a
// real worktree and the Files tab open, this drives the header surface:
//   #file-tree-filter   — typing narrows the rendered tree (auto-expanded)
//   #btn-tree-new-file  — inline input → fs.createFile → new row in tree
//   #btn-tree-new-folder— inline input → fs.createDir → new dir in tree
//   #btn-tree-refresh   — re-fetches, surfacing a file created out-of-band
//   #btn-tree-collapse  — toggles #files-tab-content.tree-collapsed (hides tree)
// Each assertion checks an observable DOM effect.

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

test('Files tab header: filter, new file/folder, and refresh mutate the tree', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  const repo = buildRepo();
  const taskId = TASK_ID + '-a';
  try {
    await openFilesTab(mainWindow, repo, taskId);

    const fileTree = mainWindow.locator('#file-tree');
    const filter = mainWindow.locator('#file-tree-filter');
    await expect(filter).toBeVisible();

    // ---- #file-tree-filter ----
    // Typing a fragment of a nested path filters and auto-expands so matches
    // are visible without manual directory clicks.
    await filter.fill('alpha');
    await expect(fileTree.locator('.file-tree-file', { hasText: 'alpha.js' })).toHaveCount(1);
    await expect(fileTree.locator('.file-tree-file', { hasText: 'beta.js' })).toHaveCount(0);
    await expect(fileTree.locator('.file-tree-file', { hasText: 'README.md' })).toHaveCount(0);
    // Clearing the filter restores the full root view.
    await filter.fill('');
    await expect(fileTree.locator('.file-tree-file', { hasText: 'README.md' })).toHaveCount(1);

    // ---- #btn-tree-new-file ----
    const newFileName = 'created-' + UNIQ + '.txt';
    await mainWindow.locator('#btn-tree-new-file').click();
    const fileInput = fileTree.locator('.file-tree-rename-input');
    await expect(fileInput).toBeVisible();
    await fileInput.fill(newFileName);
    await fileInput.press('Enter');
    await expect(fileTree.locator('.file-tree-file', { hasText: newFileName })).toHaveCount(1);
    expect(fs.existsSync(path.join(repo, newFileName))).toBe(true);

    // ---- #btn-tree-new-folder ----
    // listFiles is `git ls-files`, which never reports an EMPTY directory, so
    // a freshly-created folder won't render as a tree row. The observable
    // header-button effects we can assert: the inline input appears on click,
    // is consumed on Enter, and the directory lands on disk.
    const newFolderName = 'folder-' + UNIQ;
    await mainWindow.locator('#btn-tree-new-folder').click();
    const folderInput = fileTree.locator('.file-tree-rename-input');
    await expect(folderInput).toBeVisible();
    await folderInput.fill(newFolderName);
    await folderInput.press('Enter');
    await expect(folderInput).toHaveCount(0);
    expect(fs.statSync(path.join(repo, newFolderName)).isDirectory()).toBe(true);

    // ---- #btn-tree-refresh ----
    // A file written out-of-band isn't in the tree until refresh re-fetches.
    const outOfBand = 'outofband-' + UNIQ + '.md';
    fs.writeFileSync(path.join(repo, outOfBand), '# ext\n');
    await expect(fileTree.locator('.file-tree-file', { hasText: outOfBand })).toHaveCount(0);
    await mainWindow.locator('#btn-tree-refresh').click();
    await expect(fileTree.locator('.file-tree-file', { hasText: outOfBand })).toHaveCount(1);
  } finally {
    await cleanup(mainWindow, repo, taskId);
  }
});

test('Files tab header: #btn-tree-collapse hides and restores the tree', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  const repo = buildRepo();
  const taskId = TASK_ID + '-b';
  try {
    await openFilesTab(mainWindow, repo, taskId);

    const filesTab = mainWindow.locator('#files-tab-content');
    const fileTree = mainWindow.locator('#file-tree');
    const collapseBtn = mainWindow.locator('#btn-tree-collapse');

    // Starts expanded (tree visible).
    await expect(fileTree).toBeVisible();
    await expect(filesTab).not.toHaveClass(/tree-collapsed/);

    // Collapse: class flips, tree + filter bar hide (CSS), button label updates.
    await collapseBtn.click();
    await expect(filesTab).toHaveClass(/tree-collapsed/);
    await expect(fileTree).toBeHidden();
    await expect(collapseBtn).toHaveText('▸');

    // Expand again: tree comes back.
    await collapseBtn.click();
    await expect(filesTab).not.toHaveClass(/tree-collapsed/);
    await expect(fileTree).toBeVisible();
    await expect(collapseBtn).toHaveText('▾');
  } finally {
    await cleanup(mainWindow, repo, taskId);
  }
});
