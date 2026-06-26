// PR review popout smoke test: pr-review.html boots in its own
// BrowserWindow, the PrReview module mounts against #pr-review-root, and
// without an active review state it lands on the empty placeholder.
//
// This catches CSP regressions, preload wiring breakage, and any rename
// of window.PrReview / its mount contract. Richer flows would need a gh
// mock layer; that's a follow-up if/when one materializes.

const path = require('path');
const { test, expect } = require('./fixtures');

const repoRoot = path.resolve(__dirname, '..');

async function openPrReviewPopout(electronApp) {
  const [popout] = await Promise.all([
    electronApp.waitForEvent('window'),
    electronApp.evaluate(({ BrowserWindow }, args) => {
      const win = new BrowserWindow({
        width: 1000, height: 800, show: false,
        webPreferences: {
          preload: args.preload,
          contextIsolation: true, nodeIntegration: false,
        },
      });
      win.loadFile(args.htmlPath);
    }, {
      preload: path.join(repoRoot, 'preload.js'),
      htmlPath: path.join(repoRoot, 'renderer', 'pr-review.html'),
    }),
  ]);
  await popout.waitForLoadState('domcontentloaded');
  return popout;
}

test('pr-review popout loads and renders empty state', async ({ electronApp, mainWindow }) => {
  // The popout is created via electronApp.evaluate (main process), so it doesn't
  // depend on the main window's network state — only that the app has booted.
  // `domcontentloaded` is deterministic; `networkidle` flakes under background polling.
  await mainWindow.waitForLoadState('domcontentloaded');

  const errors = [];
  const popoutPromise = openPrReviewPopout(electronApp);
  const popout = await popoutPromise;
  popout.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  popout.on('pageerror', (err) => errors.push(err.message));

  await expect(popout.locator('#pr-review-root.pr-review-host')).toBeAttached();
  await expect(popout.locator('.pr-review-loading')).toContainText(/No active PR review|Loading PR/);

  // Settle deterministically: PrReview.mount kicks off async fetches, so poll
  // until the placeholder resolves to the empty state (any handler errors
  // surface via the listeners above). This replaces a flaky networkidle wait —
  // the poll IS the settle, with margin for the mount's async work.
  await expect.poll(() => popout.locator('.pr-review-loading').textContent(), { timeout: 8000 })
    .toMatch(/No active PR review/);

  expect(errors, `Popout console errors:\n${errors.join('\n')}`).toEqual([]);

  await popout.close();
});
