/* global window,document */
// xterm and Monaco are excluded: third-party widgets with their own accessibility layers.
const fs = require('fs');
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

// Applies each preset without persisting it and returns one entry per theme with colour-contrast violations.
async function contrastInEveryTheme(page, label) {
  const presets = await page.evaluate(() => Object.keys(window.ThemeManager.presets));
  const failures = [];
  for (const preset of presets) {
    await page.evaluate((p) => window.ThemeManager.apply(p, { persist: false }), preset);
    const { violations } = await axe(page).withRules(['color-contrast']).analyze();
    if (violations.length) failures.push(`${label} / ${preset}:\n${describe(violations)}`);
  }
  return failures;
}

const SOURCE_BEFORE = [
  '// Greets a user.',
  'function greet(name) {',
  "  const prefix = 'Hello';",
  '  return `${prefix}, ${name}!`;',
  '}',
  'const RETRIES = 3;',
  'module.exports = { greet, RETRIES };',
  '',
].join('\n');

const SOURCE_AFTER = SOURCE_BEFORE
  .replace("const prefix = 'Hello';", "const prefix = /^dr/i.test(name) ? 'Good day' : 'Hi';")
  .replace('const RETRIES = 3;', 'const RETRIES = 5; // tuned for CI');

const PR_STATE = {
  number: 7,
  meta: {
    title: 'Tune retries', state: 'OPEN', author: { login: 'dev' }, headRefName: 'f', baseRefName: 'main',
    body: 'Raises the retry count.\n\n```js\n// before\nconst RETRIES = 3; /* old */\nif (x) return `n=${RETRIES}`;\n```\n',
  },
  diff: [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -4,3 +4,3 @@',
    '   return `${prefix}, ${name}!`;',
    ' }',
    '-const RETRIES = 3;',
    '+const RETRIES = 5;',
    '',
  ].join('\n'),
  threads: [],
};

const PR_CHECKS = [
  { name: 'build', bucket: 'pass', workflow: 'CI', runId: 1, link: 'https://example.com/1', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:02:00Z' },
  { name: 'lint', bucket: 'fail', workflow: 'CI', runId: 1, id: 11, link: 'https://example.com/2', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z' },
  { name: 'e2e', bucket: 'pending', workflow: 'E2E', runId: 2, link: 'https://example.com/3', startedAt: '2026-01-01T00:00:00Z' },
  { name: 'docs', bucket: 'skipping' },
  { name: 'old', bucket: 'cancel' },
];

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
    test.setTimeout(480000);
    repo = buildRepo({ 'src/a.js': SOURCE_BEFORE }, 'axe-themes');
    await openShellTask(mainWindow, repo);
    // Colour transitions would otherwise be mid-flight when each theme is scanned.
    await mainWindow.emulateMedia({ reducedMotion: 'reduce' });
    const failures = [];

    await mainWindow.evaluate((wt) => { window.DiffPanel.show(wt); window.App.forceFilesTab(); }, repo);
    await expect(mainWindow.getByRole('tree', { name: 'Files' })).toBeVisible();
    failures.push(...await contrastInEveryTheme(mainWindow, 'Files tab'));

    fs.writeFileSync(path.join(repo, 'src/a.js'), SOURCE_AFTER);
    await mainWindow.evaluate(() => {
      document.querySelector('#diff-tabs .diff-tab[data-tab="changes"]').click();
      return window.DiffPanel.refresh();
    });
    await mainWindow.getByRole('button', { name: /a\.js.*modified/ }).click();
    for (const kind of ['diff-add', 'diff-del', 'diff-context']) {
      await expect(mainWindow.locator(`#diff-view .diff-line.${kind}`).first()).toBeVisible();
    }
    await expect(mainWindow.locator('#diff-view .hljs-string').first()).toBeVisible();
    failures.push(...await contrastInEveryTheme(mainWindow, 'Changes diff'));

    await mainWindow.evaluate((checks) => {
      const root = document.getElementById('pr-review-root');
      root.style.display = '';
      const PR = window.PrReview;
      PR.mount({ host: root, isPopout: false });
      // Feed a fixed CI payload instead of asking gh.
      PR.fetchAndRenderChecks = async () => {
        PR.currentChecks = { checks };
        PR.currentRequiredChecks = ['build', 'lint', 'deploy'];
        PR.currentRequiredChecksError = '';
        PR.renderChecksIntoSlot();
      };
    }, PR_CHECKS);
    await expect.poll(() => mainWindow.locator('#pr-review-root .pr-review-loading').textContent(), { timeout: 8000 }).toMatch(/No active/);
    for (const tab of ['files', 'conversation', 'checks']) {
      await mainWindow.evaluate(({ s, t }) => {
        window.PrReview.activeTab = t;
        window.PrReview.render(s);
        if (t === 'checks') return window.PrReview.fetchAndRenderChecks(s.number);
      }, { s: PR_STATE, t: tab });
      await expect(mainWindow.locator('#pr-review-root .pr-review-tab.active')).toHaveAttribute('data-tab', tab);
      if (tab === 'conversation') await expect(mainWindow.locator('#pr-review-root .pr-conv-md pre .hljs-keyword').first()).toBeVisible();
      if (tab === 'checks') await expect(mainWindow.locator('#pr-review-root .pr-required-chip').first()).toBeVisible();
      failures.push(...await contrastInEveryTheme(mainWindow, `PR review ${tab} tab`));
    }
    expect(failures, failures.join('\n\n')).toEqual([]);
  });

  test('preferences window keeps contrast in every theme', async ({ electronApp, mainWindow }) => {
    const [prefs] = await Promise.all([
      electronApp.waitForEvent('window'),
      mainWindow.evaluate(() => window.klaus.ui.openPreferences()),
    ]);
    await prefs.waitForLoadState('domcontentloaded');
    await prefs.emulateMedia({ reducedMotion: 'reduce' });
    await expect(prefs.getByRole('radiogroup', { name: 'Window color' })).toBeVisible();
    await expect.poll(() => prefs.evaluate(() => !!window.ThemeManager)).toBe(true);
    const failures = await contrastInEveryTheme(prefs, 'Preferences');
    expect(failures, failures.join('\n\n')).toEqual([]);
    await prefs.close();
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
