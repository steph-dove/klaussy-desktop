/* global window,document,MutationObserver */
const path = require('path');
const { test, expect } = require('./fixtures');

const repoRoot = path.resolve(__dirname, '..');

const STATE = {
  number: 42,
  meta: {
    title: 'Add feature', state: 'OPEN', isDraft: true, author: { login: 'dev' },
    headRefName: 'feat', baseRefName: 'main', url: 'https://github.com/o/r/pull/42',
  },
  diff: [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,1 +1,1 @@',
    '-const b = 2;',
    '+const b = 3;',
    '',
  ].join('\n'),
  threads: [],
  issueComments: [
    { databaseId: 7, author: { login: 'me' }, body: 'Looks good', createdAt: '2026-01-01T00:00:00Z' },
  ],
};

async function openPrWindow(electronApp) {
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
  await win.evaluate((s) => window.PrReview.render(s), STATE);
  return win;
}

async function openPrefs(electronApp, mainWindow) {
  const [prefsWin] = await Promise.all([
    electronApp.waitForEvent('window'),
    mainWindow.evaluate(() => window.klaus.ui.openPreferences()),
  ]);
  await prefsWin.waitForLoadState('domcontentloaded');
  await expect(prefsWin.locator('.key-input').first()).toBeVisible();
  return prefsWin;
}

test.describe('PR review announcements and error states', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('domcontentloaded');
  });

  test('a blocked Merge stays focusable and explains why', async ({ electronApp }) => {
    const win = await openPrWindow(electronApp);
    const merge = win.getByRole('button', { name: /^Merge/ });
    await expect(merge).toHaveAttribute('aria-disabled', 'true');
    await expect(merge).toHaveAccessibleDescription('Merge unavailable: PR is a draft');
    await merge.focus();
    await expect(merge).toBeFocused();
    await win.keyboard.press('Enter');
    await expect(win.locator('.pr-merge-menu')).toBeHidden();
    await win.close();
  });

  test('a failed comment edit is an alert tied to the field', async ({ electronApp }) => {
    const win = await openPrWindow(electronApp);
    await win.evaluate((s) => {
      const PR = window.PrReview;
      PR.currentUserLogin = 'me';
      PR.editingCommentId = 7;
      PR.editingCommentKind = 'issue';
      PR.render(s);
    }, STATE);
    await win.getByRole('tab', { name: /Conversation/ }).click();

    const field = win.getByRole('textbox', { name: 'Edit comment' });
    await field.fill('   ');
    await win.locator('.pr-conv-edit-save').click();
    const error = win.getByRole('alert').filter({ hasText: 'Comment body cannot be empty.' });
    await expect(error).toBeVisible();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveAccessibleDescription('Comment body cannot be empty.');
    await expect(field).toBeFocused();
    await win.close();
  });

  test('submitting a review without a required summary marks the field invalid', async ({ electronApp }) => {
    const win = await openPrWindow(electronApp);
    await win.evaluate(() => {
      window.PrReview.pendingComments = [{ path: 'src/a.js', line: 1, side: 'RIGHT', body: 'nit' }];
      window.PrReview.openSubmitReviewDialog();
    });
    const dialog = win.getByRole('dialog', { name: 'Submit review' });
    await dialog.locator('input[value="REQUEST_CHANGES"]').check();
    await dialog.getByRole('button', { name: 'Submit review' }).click();
    const summary = dialog.getByRole('textbox', { name: 'Review summary' });
    await expect(summary).toHaveAttribute('aria-invalid', 'true');
    await expect(summary).toHaveAccessibleDescription('Please provide a summary when requesting changes.');
    await summary.fill('Please rename this');
    await expect(summary).not.toHaveAttribute('aria-invalid', 'true');
    await win.close();
  });

  test('the watch-log toggle reports its state and keeps focus on Stop', async ({ electronApp }) => {
    const win = await openPrWindow(electronApp);
    await win.evaluate(() => {
      const PR = window.PrReview;
      const row = document.createElement('div');
      row.className = 'pr-check-row';
      row.innerHTML = '<div class="pr-check-actions"><button type="button" class="pr-check-action-watch" data-run-id="9" data-name="build" aria-label="Watch log for build" aria-expanded="false">Watch log</button></div>';
      PR.hostEl.appendChild(row);
      const btn = row.querySelector('button');
      btn.addEventListener('click', () => PR.toggleLogWatch(btn));
    });
    const toggle = win.locator('.pr-check-action-watch');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panelId = await toggle.getAttribute('aria-controls');
    await expect(win.locator('#' + panelId)).toBeVisible();

    await win.locator('.pr-check-log-watch-stop').click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAccessibleName('Watch log for build');
    await expect(toggle).toBeFocused();
    await win.close();
  });
});

test.describe('Preferences announcements', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
  });

  test('page structure and the autosave status', async ({ electronApp, mainWindow }) => {
    const prefs = await openPrefs(electronApp, mainWindow);
    await expect(prefs.getByRole('main')).toBeVisible();
    await expect(prefs.getByRole('heading', { name: 'Preferences', level: 1 })).toBeVisible();

    const status = prefs.locator('#status-msg');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveText('');
    await prefs.evaluate(() => {
      window.__statusWrites = 0;
      new MutationObserver((records) => { window.__statusWrites += records.length; })
        .observe(document.getElementById('status-msg'), { childList: true, characterData: true, subtree: true });
    });
    const fontSize = prefs.getByLabel('Font Size');
    await fontSize.fill('13');
    await fontSize.fill('14');
    await fontSize.fill('15');
    await expect(status).toHaveText('Saved');
    expect(await prefs.evaluate(() => window.__statusWrites)).toBe(1);
    await expect(status).toHaveText('', { timeout: 4000 });
    await prefs.close();
  });

  test('gateway card controls carry the gateway name', async ({ electronApp, mainWindow }) => {
    const prefs = await openPrefs(electronApp, mainWindow);
    await prefs.getByRole('button', { name: '+ Add a gateway' }).click();
    await expect(prefs.getByRole('button', { name: 'Remove gateway 1' })).toBeVisible();

    await prefs.getByRole('textbox', { name: 'Gateway name' }).fill('Claude');
    await expect(prefs.getByRole('button', { name: 'Remove Claude' })).toBeVisible();
    await expect(prefs.getByRole('button', { name: 'Test connection for Claude' })).toBeVisible();
    await expect(prefs.getByRole('textbox', { name: 'Gateway URL for Claude' })).toBeVisible();
    await prefs.close();
  });

  test('agent path fields are described by their status line', async ({ electronApp, mainWindow }) => {
    const prefs = await openPrefs(electronApp, mainWindow);
    const pathInput = prefs.locator('#pref-codex-path');
    await expect(pathInput).toHaveAttribute('aria-describedby', 'agent-info-codex');
    await expect(pathInput).toHaveAccessibleDescription(/^Status:/);
    await prefs.close();
  });
});
