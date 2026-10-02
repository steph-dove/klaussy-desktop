/* global window,document */
// xterm and Monaco are excluded: third-party widgets with their own accessibility layers.
const path = require('path');
const { test, expect } = require('./fixtures');
const { buildRepo, rm, openShellTask } = require('./helpers');
const AxeBuilder = require('@axe-core/playwright').default;

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control+Shift';

// Legacy mode: the default mode opens a helper page, which Electron doesn't allow.
function axe(page) {
  return new AxeBuilder({ page }).setLegacyMode(true).withTags(TAGS).exclude('.xterm').exclude('.monaco-editor');
}

function describe(violations) {
  return violations.map((v) => `${v.impact} ${v.id}: ${v.help}\n  ` + v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n  ')).join('\n');
}

async function expectClean(page) {
  const { violations } = await axe(page).analyze();
  expect(violations, describe(violations)).toEqual([]);
}

test.describe('axe scans', () => {
  test.setTimeout(120000);
  let repo;

  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
  });

  test.afterEach(() => { if (repo) rm(repo); repo = null; });

  test('dashboard', async ({ mainWindow }) => {
    await expectClean(mainWindow);
  });

  test('task with the side panel, new-session dialog and command palette', async ({ mainWindow }) => {
    repo = buildRepo({ 'src/a.js': 'const a = 1;\n' }, 'axe');
    await openShellTask(mainWindow, repo);
    await mainWindow.evaluate((wt) => { window.DiffPanel.show(wt); window.App.forceFilesTab(); }, repo);
    await expect(mainWindow.getByRole('tree', { name: 'Files' })).toBeVisible();
    await expectClean(mainWindow);

    await mainWindow.evaluate(() => { document.getElementById('modal-overlay').style.display = 'flex'; });
    await expect(mainWindow.locator('#modal')).toHaveAttribute('aria-modal', 'true');
    await expectClean(mainWindow);
    await mainWindow.evaluate(() => { document.getElementById('modal-overlay').style.display = 'none'; });

    await mainWindow.keyboard.press(`${MOD}+k`);
    await expect(mainWindow.getByRole('combobox', { name: 'Commands' })).toBeFocused();
    await expectClean(mainWindow);
  });

  test('colour contrast holds in every theme', async ({ mainWindow }) => {
    repo = buildRepo({ 'src/a.js': 'const a = 1;\n' }, 'axe-themes');
    await openShellTask(mainWindow, repo);
    await mainWindow.evaluate((wt) => { window.DiffPanel.show(wt); window.App.forceFilesTab(); }, repo);
    // Colour transitions would otherwise be mid-flight when each theme is scanned.
    await mainWindow.emulateMedia({ reducedMotion: 'reduce' });
    const presets = await mainWindow.evaluate(() => Object.keys(window.ThemeManager.presets));
    const failures = [];
    for (const preset of presets) {
      await mainWindow.evaluate((p) => window.ThemeManager.apply(p), preset);
      const { violations } = await axe(mainWindow).withRules(['color-contrast']).analyze();
      if (violations.length) failures.push(`${preset}:\n${describe(violations)}`);
    }
    expect(failures, failures.join('\n\n')).toEqual([]);
  });

  test('preferences window', async ({ electronApp, mainWindow }) => {
    const [prefs] = await Promise.all([
      electronApp.waitForEvent('window'),
      mainWindow.evaluate(() => window.klaus.ui.openPreferences()),
    ]);
    await prefs.waitForLoadState('domcontentloaded');
    await expect(prefs.getByRole('radiogroup', { name: 'Window color' })).toBeVisible();
    await expectClean(prefs);
    await prefs.close();
  });

  test('PR review window', async ({ electronApp }) => {
    const [pr] = await Promise.all([
      electronApp.waitForEvent('window'),
      electronApp.evaluate(({ BrowserWindow }, a) => {
        const w = new BrowserWindow({ show: false, webPreferences: { preload: a.preload, contextIsolation: true } });
        w.loadFile(a.html);
      }, {
        preload: path.resolve(__dirname, '..', 'preload.js'),
        html: path.resolve(__dirname, '..', 'renderer', 'pr-review.html'),
      }),
    ]);
    await pr.waitForLoadState('domcontentloaded');
    await expect.poll(() => pr.locator('.pr-review-loading').textContent(), { timeout: 8000 }).toMatch(/No active/);
    await pr.evaluate(() => window.PrReview.render({
      number: 7,
      meta: { title: 'Demo', state: 'OPEN', author: { login: 'dev' }, headRefName: 'f', baseRefName: 'main' },
      diff: 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n',
      threads: [],
    }));
    await expect(pr.getByRole('tablist', { name: 'Review sections' })).toBeVisible();
    await expectClean(pr);
    await pr.close();
  });
});
