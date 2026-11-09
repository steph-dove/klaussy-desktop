/* global window,document */
const path = require('path');
const { test, expect } = require('./fixtures');

const repoRoot = path.resolve(__dirname, '..');

function stateFor(forge, url) {
  return {
    number: 42,
    forge,
    meta: {
      title: 'Add feature', state: 'OPEN', author: { login: 'dev' },
      headRefName: 'feat', baseRefName: 'main', url,
    },
    diff: '',
    threads: [],
    issueComments: [],
  };
}

const CHECKS = {
  checks: [
    { id: 11, name: 'build', state: 'FAILURE', bucket: 'fail', runId: 5, link: 'https://ci.example/5' },
    { id: 12, name: 'lint', state: 'IN_PROGRESS', bucket: 'pending', runId: 6, link: 'https://ci.example/6' },
  ],
};

async function openPrWindow(electronApp, state) {
  const [win] = await Promise.all([
    electronApp.waitForEvent('window'),
    electronApp.evaluate(({ BrowserWindow }, args) => {
      const w = new BrowserWindow({
        width: 1100, height: 800, show: false,
        webPreferences: { preload: args.preload, contextIsolation: true, nodeIntegration: false },
      });
      w.loadFile(args.htmlPath);
    }, {
      preload: path.join(repoRoot, 'preload.js'),
      htmlPath: path.join(repoRoot, 'renderer', 'pr-review.html'),
    }),
  ]);
  await win.waitForLoadState('domcontentloaded');
  await expect.poll(() => win.locator('.pr-review-loading').textContent(), { timeout: 8000 }).toMatch(/No active PR review/);
  await win.evaluate((s) => window.PrReview.render(s), state);
  // Render the Checks tab body on its own so no IPC refresh overwrites it.
  await win.evaluate((checks) => {
    const PR = window.PrReview;
    PR.currentChecks = checks;
    PR.currentRequiredChecks = [];
    PR.currentRequiredChecksError = '';
    const slot = document.createElement('div');
    slot.id = 'checks-under-test';
    slot.innerHTML = PR.renderChecksTab();
    document.body.appendChild(slot);
  }, CHECKS);
  return win.locator('#checks-under-test');
}

// Replies to the checks channels in the main process, counting required-checks
// calls. contextBridge objects are frozen, so the renderer side can't be stubbed.
async function stubChecksIpc(electronApp) {
  await electronApp.evaluate(({ ipcMain }, checks) => {
    globalThis.__requiredChecksCalls = 0;
    ipcMain.removeHandler('pr-review-checks');
    ipcMain.handle('pr-review-checks', () => checks);
    ipcMain.removeHandler('pr-review-required-checks');
    ipcMain.handle('pr-review-required-checks', () => {
      globalThis.__requiredChecksCalls += 1;
      return { required: ['build'] };
    });
  }, CHECKS);
}

// Renders the PR, which fetches its checks, and waits for them to land.
async function renderAndFetchChecks(electronApp, state) {
  await stubChecksIpc(electronApp);
  const [win] = await Promise.all([
    electronApp.waitForEvent('window'),
    electronApp.evaluate(({ BrowserWindow }, args) => {
      const w = new BrowserWindow({
        width: 1100, height: 800, show: false,
        webPreferences: { preload: args.preload, contextIsolation: true, nodeIntegration: false },
      });
      w.loadFile(args.htmlPath);
    }, {
      preload: path.join(repoRoot, 'preload.js'),
      htmlPath: path.join(repoRoot, 'renderer', 'pr-review.html'),
    }),
  ]);
  await win.waitForLoadState('domcontentloaded');
  await expect.poll(() => win.locator('.pr-review-loading').textContent(), { timeout: 8000 }).toMatch(/No active PR review/);
  await win.evaluate((s) => window.PrReview.render(s), state);
  await expect.poll(() => win.evaluate(() => !!window.PrReview.currentChecks), { timeout: 8000 }).toBe(true);
  return win;
}

function requiredChecksCalls(electronApp) {
  return electronApp.evaluate(() => globalThis.__requiredChecksCalls);
}

test.describe('required checks fetch by forge', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('domcontentloaded');
  });

  test('a PR with only a Bitbucket URL skips the required-checks fetch', async ({ electronApp }) => {
    // Off GitHub, the required list is set in the same tick the checks land.
    const win = await renderAndFetchChecks(electronApp, stateFor(undefined, 'https://bitbucket.org/o/r/pull-requests/42'));
    expect(await win.evaluate(() => window.PrReview.currentRequiredChecks)).toEqual([]);
    expect(await requiredChecksCalls(electronApp)).toBe(0);
  });

  test('a GitHub PR fetches its required checks', async ({ electronApp }) => {
    const win = await renderAndFetchChecks(electronApp, stateFor('github', 'https://github.com/o/r/pull/42'));
    await expect.poll(() => win.evaluate(() => window.PrReview.currentRequiredChecks)).toEqual(['build']);
    expect(await requiredChecksCalls(electronApp)).toBe(1);
  });
});

test.describe('PR review check actions by forge', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('domcontentloaded');
  });

  test('a Bitbucket PR has no gh-backed check actions, but keeps Fix', async ({ electronApp }) => {
    const slot = await openPrWindow(electronApp, stateFor('bitbucket', 'https://bitbucket.org/o/r/pull-requests/42'));
    await expect(slot.locator('.pr-check-row')).toHaveCount(2);
    await expect(slot.locator('.pr-checks-dispatch')).toHaveCount(0);
    await expect(slot.locator('.pr-check-action-rerun')).toHaveCount(0);
    await expect(slot.locator('.pr-check-action-cancel')).toHaveCount(0);
    await expect(slot.locator('.pr-check-action-watch')).toHaveCount(0);
    await expect(slot.locator('.pr-check-expandable')).toHaveCount(0);
    await expect(slot.locator('.pr-check-fix-btn')).toHaveCount(1);
  });

  test('a GitHub PR still has every check action', async ({ electronApp }) => {
    const slot = await openPrWindow(electronApp, stateFor('github', 'https://github.com/o/r/pull/42'));
    await expect(slot.locator('.pr-checks-dispatch')).toHaveCount(1);
    await expect(slot.locator('.pr-check-action-rerun')).toHaveCount(1);
    await expect(slot.locator('.pr-check-action-cancel')).toHaveCount(1);
    await expect(slot.locator('.pr-check-action-watch')).toHaveCount(1);
    await expect(slot.locator('.pr-check-expandable')).toHaveCount(1);
    await expect(slot.locator('.pr-check-fix-btn')).toHaveCount(1);
  });
});
