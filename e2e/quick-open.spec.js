/* global window */
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

    // Target the QuickOpen overlay specifically — `.palette-overlay` is the
    // shared backdrop class used by Setup-check / About / etc., and on first
    // launch in CI the Setup-check dialog appears asynchronously and would
    // otherwise pollute the count assertions below.
    const overlay = mainWindow.locator('.quick-open-overlay');
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

test('arrowing with the mouse resting on the list keeps the selection where the keys put it', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  // Enough files that the list overflows its max-height (results cap at 50).
  const repo = buildRepo();
  for (let i = 1; i <= 40; i++) {
    fs.writeFileSync(path.join(repo, 'src', 'file' + String(i).padStart(2, '0') + '.js'), '');
  }
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'more'], { cwd: repo, stdio: 'pipe' });

  try {
    await mainWindow.evaluate((wt) => {
      window.AppState.activeTaskId = 999;
      window.AppState.tasks.set(999, { id: 999, worktreePath: wt });
      window.QuickOpen.invalidate();
    }, repo);

    await mainWindow.evaluate(() => window.QuickOpen.show());

    const overlay = mainWindow.locator('.quick-open-overlay');
    const input = overlay.locator('.palette-input');
    const list = overlay.locator('.palette-list');
    const items = overlay.locator('.quick-open-item');
    const selected = overlay.locator('.quick-open-item.selected .quick-open-basename');

    await expect(overlay).toBeVisible();
    await expect(input).toBeFocused();
    await expect(items).toHaveCount(44);
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    const third = await items.nth(2).locator('.quick-open-basename').textContent();
    const target = await items.nth(27).locator('.quick-open-basename').textContent();

    await items.nth(2).hover();
    await expect(selected).toHaveText(third);

    for (let i = 0; i < 25; i++) await input.press('ArrowDown');
    await expect(selected).toHaveText(target);

    // toBeInViewport checks the page viewport, not the scroll container.
    const inView = await list.evaluate((el) => {
      const a = el.getBoundingClientRect();
      const b = el.querySelector('.quick-open-item.selected').getBoundingClientRect();
      return b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
    });
    expect(inView).toBe(true);

    // Point at a half-clipped row; hover() would scroll it in, so move the mouse.
    const point = await list.evaluate((el) => {
      const row = el.querySelectorAll('.quick-open-item')[10];
      const r = row.getBoundingClientRect();
      el.scrollTop += r.top - el.getBoundingClientRect().top - el.clientTop + r.height / 2;
      const a = el.getBoundingClientRect();
      const b = row.getBoundingClientRect();
      return { x: b.left + 20, y: (a.top + b.bottom) / 2, scrollTop: el.scrollTop };
    });
    await mainWindow.mouse.move(point.x, point.y);
    await expect(selected).toHaveText(await items.nth(10).locator('.quick-open-basename').textContent());
    expect(await list.evaluate((el) => el.scrollTop)).toBe(point.scrollTop);

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

async function pointAt(mainWindow, wt) {
  await mainWindow.evaluate((p) => {
    window.AppState.activeTaskId = 999;
    window.AppState.tasks.set(999, { id: 999, worktreePath: p });
    window.QuickOpen.invalidate();
  }, wt);
}

async function unpoint(mainWindow) {
  await mainWindow.evaluate(() => {
    window.AppState.activeTaskId = null;
    window.AppState.tasks.delete(999);
    window.QuickOpen.invalidate();
  });
}

test('a query that matches nothing says so, and Enter does nothing', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repo = buildRepo();
  try {
    await pointAt(mainWindow, repo);
    await mainWindow.evaluate(() => window.QuickOpen.show());

    const overlay = mainWindow.locator('.quick-open-overlay');
    const input = overlay.locator('.palette-input');
    const items = overlay.locator('.quick-open-item');
    const empty = overlay.locator('.palette-empty');

    await expect(items).toHaveCount(4);
    await expect(empty).toHaveCount(0);

    await input.fill('  Zzz<b>  ');
    await expect(items).toHaveCount(0);
    await expect(empty).toHaveCount(1);
    await expect(empty).toHaveText('No files match "Zzz<b>"');

    await input.press('Enter');
    await expect(overlay).toBeVisible();
    await expect(empty).toHaveText('No files match "Zzz<b>"');

    await input.fill('');
    await expect(items).toHaveCount(4);
    await expect(empty).toHaveCount(0);
  } finally {
    await unpoint(mainWindow);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a worktree with no files says so', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-qo-empty-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
  try {
    await pointAt(mainWindow, repo);
    await mainWindow.evaluate(() => window.QuickOpen.show());

    const overlay = mainWindow.locator('.quick-open-overlay');
    await expect(overlay.locator('.palette-empty')).toHaveText('No files in this worktree');
    await overlay.locator('.palette-input').fill('readme');
    await expect(overlay.locator('.palette-empty')).toHaveText('No files in this worktree');
    await expect(overlay.locator('.quick-open-item')).toHaveCount(0);
  } finally {
    await unpoint(mainWindow);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('the palette opens straight away and says it is loading until the file list arrives', async ({ electronApp, mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  // Hold the list-files reply until the test releases it. The app is
  // launched per test, so the real handler needs no restoring.
  await electronApp.evaluate(({ ipcMain }) => {
    const held = new Promise((resolve) => { globalThis.__releaseListFiles = resolve; });
    ipcMain.removeHandler('list-files');
    ipcMain.handle('list-files', async () => {
      await held;
      return { files: ['README.md', 'src/auth.js'] };
    });
  });

  try {
    await pointAt(mainWindow, '/tmp/klaussy-e2e-qo-loading');
    await mainWindow.evaluate(() => { window.QuickOpen.show(); });

    const overlay = mainWindow.locator('.quick-open-overlay');
    const input = overlay.locator('.palette-input');
    await expect(overlay.locator('.palette-empty')).toHaveText('Loading files…');
    await expect(input).toBeFocused();
    await input.fill('aut');
    await input.press('Enter');
    await expect(overlay).toBeVisible();

    await electronApp.evaluate(() => globalThis.__releaseListFiles());
    await expect(overlay.locator('.quick-open-item')).toHaveCount(1);
    await expect(overlay.locator('.quick-open-basename')).toHaveText('auth.js');
    await expect(overlay.locator('.palette-empty')).toHaveCount(0);
  } finally {
    await unpoint(mainWindow);
  }
});

test('a file created after the first open shows up on the next open', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repo = buildRepo();
  try {
    // A stubbed task isn't watched by the sidebar, so watch it here.
    await mainWindow.evaluate(async (wt) => {
      window.AppState.activeTaskId = 999;
      window.AppState.tasks.set(999, { id: 999, worktreePath: wt });
      window.QuickOpen.invalidate();
      await window.klaus.fs.watchWorktree(wt);
    }, repo);

    const overlay = mainWindow.locator('.quick-open-overlay');
    const input = overlay.locator('.palette-input');
    const items = overlay.locator('.quick-open-item');

    await mainWindow.evaluate(() => window.QuickOpen.show());
    await expect(items).toHaveCount(4);
    await input.press('Escape');
    await expect(overlay).toHaveCount(0);

    fs.writeFileSync(path.join(repo, 'src', 'brand-new.js'), '');

    // The watcher debounces, so retry until the change has landed.
    await expect(async () => {
      await mainWindow.evaluate(() => window.QuickOpen.show());
      try {
        await input.fill('brand-new');
        await expect(items).toHaveCount(1, { timeout: 500 });
        await expect(items.first().locator('.quick-open-basename')).toHaveText('brand-new.js');
      } finally {
        await mainWindow.evaluate(() => window.QuickOpen.hide());
      }
    }).toPass({ timeout: 10_000 });
  } finally {
    await mainWindow.evaluate(async (wt) => {
      await window.klaus.fs.unwatchWorktree(wt);
      window.AppState.activeTaskId = null;
      window.AppState.tasks.delete(999);
      window.QuickOpen.invalidate();
    }, repo);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a change in another worktree keeps this worktree\'s file list', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repo = buildRepo();
  const other = buildRepo();
  try {
    await mainWindow.evaluate(async (paths) => {
      window.AppState.activeTaskId = 999;
      window.AppState.tasks.set(999, { id: 999, worktreePath: paths.repo });
      window.QuickOpen.invalidate();
      await window.klaus.fs.watchWorktree(paths.other);
      window.__otherChanged = false;
      window.__stopOtherWatch = window.klaus.fs.onWorktreeChanged((data) => {
        if (data && data.worktreePath === paths.other && (data.changedFiles || []).includes('src/elsewhere.js')) {
          window.__otherChanged = true;
        }
      });
    }, { repo, other });

    const overlay = mainWindow.locator('.quick-open-overlay');
    const input = overlay.locator('.palette-input');
    const items = overlay.locator('.quick-open-item');

    await mainWindow.evaluate(() => window.QuickOpen.show());
    await expect(items).toHaveCount(4);
    await input.press('Escape');
    await expect(overlay).toHaveCount(0);

    // `repo` is unwatched, so a file added there only appears if something
    // else throws the cache away — like the change in `other` below.
    fs.writeFileSync(path.join(repo, 'src', 'unseen.js'), '');
    fs.writeFileSync(path.join(other, 'src', 'elsewhere.js'), '');
    await expect.poll(() => mainWindow.evaluate(() => window.__otherChanged), { timeout: 10_000 }).toBe(true);

    await mainWindow.evaluate(() => window.QuickOpen.show());
    await expect(items).toHaveCount(4);
    await input.fill('unseen');
    await expect(items).toHaveCount(0);
    await input.press('Escape');
  } finally {
    await mainWindow.evaluate(async (paths) => {
      if (window.__stopOtherWatch) window.__stopOtherWatch();
      delete window.__stopOtherWatch;
      delete window.__otherChanged;
      await window.klaus.fs.unwatchWorktree(paths.other);
      window.AppState.activeTaskId = null;
      window.AppState.tasks.delete(999);
      window.QuickOpen.invalidate();
    }, { repo, other });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});
