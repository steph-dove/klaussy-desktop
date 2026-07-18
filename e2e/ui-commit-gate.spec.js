/* eslint-env browser */ // the evaluate() callbacks below run in the renderer
// The "Enable Commit Review Gate" banner in the repo view. Drives the whole
// real path — renderer module → preload → repo:hook-status / repo:install-hook
// → the shared installer in state/precommit-hook.js — against a throwaway repo.
// The only synthetic step is seeding a sidebar row so the repo appears in the
// filter (rendering a real agent task is orthogonal to this feature).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');
const { buildRepo, rm } = require('./helpers');

// Put a repo into the sidebar filter by appending a bare `.task-item[data-repo]`
// (project-switcher rebuilds #project-select from these), then select it — the
// same change event a real click fires.
async function selectRepoInSidebar(win, repo) {
  await win.evaluate((r) => {
    const item = document.createElement('div');
    item.className = 'task-item';
    item.dataset.repo = r;
    item.dataset.branch = 'main';
    document.getElementById('task-list').appendChild(item);
  }, repo);
  // The native select is hidden behind the SearchableSelect enhancer, so wait
  // for the option to be attached rather than visible.
  await win.waitForSelector(`#project-select option[value="${repo}"]`, { state: 'attached' });
  await win.evaluate((r) => {
    const sel = document.getElementById('project-select');
    sel.value = r;
    sel.dispatchEvent(new Event('change'));
  }, repo);
}

test('banner offers to enable the gate, then installs the hook', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  const artifacts = path.join(os.homedir(), 'Downloads', 'klaussy-desktop-precommit-hook-wizard');
  fs.mkdirSync(artifacts, { recursive: true });

  const repo = buildRepo({ 'README.md': '# gate\n' }, 'commit-gate');
  try {
    // No Klaussy hook yet → banner should appear once the repo is selected.
    await selectRepoInSidebar(mainWindow, repo);
    const banner = mainWindow.locator('#commit-gate-banner');
    await expect(banner).toBeVisible();
    await expect(mainWindow.locator('#btn-enable-commit-gate')).toBeVisible();
    await mainWindow.screenshot({ path: path.join(artifacts, '01-banner-shown.png') });

    // Sanity: the hook really isn't there before we click.
    const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit');
    expect(fs.existsSync(hookPath)).toBe(false);

    // Click Enable → real installer writes the marked, executable hook.
    await mainWindow.locator('#btn-enable-commit-gate').click();
    await expect(banner).toBeHidden();
    await mainWindow.screenshot({ path: path.join(artifacts, '02-after-enable.png') });

    expect(fs.existsSync(hookPath)).toBe(true);
    const contents = fs.readFileSync(hookPath, 'utf-8');
    expect(contents).toContain('# klaussy-precommit v1');
    // Executable bit on POSIX (chmod is a no-op concept on Windows CI).
    if (process.platform !== 'win32') {
      expect(fs.statSync(hookPath).mode & 0o111).toBeTruthy();
    }

    // Re-selecting the same repo now finds it installed → banner stays hidden.
    await mainWindow.evaluate(() => {
      const sel = document.getElementById('project-select');
      sel.value = '';
      sel.dispatchEvent(new Event('change'));
    });
    await selectRepoInSidebar(mainWindow, repo);
    await expect(banner).toBeHidden();
  } finally {
    rm(repo);
  }
});
