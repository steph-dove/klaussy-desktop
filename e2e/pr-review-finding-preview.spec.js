/* global window */
const path = require('path');
const { test, expect } = require('./fixtures');

const repoRoot = path.resolve(__dirname, '..');

const STATE = {
  number: 42,
  meta: {
    title: 'Add feature', state: 'OPEN', author: { login: 'dev' }, headRefOid: 'e58245e1234567',
    headRefName: 'feat', baseRefName: 'main', url: 'https://github.com/o/r/pull/42',
  },
  diff: [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,3 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = a - 1;',
    '+const c = 4;',
    '',
  ].join('\n'),
  threads: [],
};

const FINDING = {
  id: 'f1', severity: 'medium', category: 'Correctness', title: 'Off-by-one',
  path: 'src/a.js', line: 2, side: 'RIGHT', postMode: 'inline', locationVerified: true,
  text: 'The loop stops one short — it skips the last item. It only shows up on the final page.'
    + '\n\nSuggested change:\n\n```suggestion\nconst b = a;\n```',
};

async function openPrWindow(electronApp) {
  const before = new Set(electronApp.windows());
  await electronApp.evaluate(({ BrowserWindow }, args) => {
    const w = new BrowserWindow({
      width: 1000, height: 1100, show: false,
      webPreferences: { preload: args.preload, contextIsolation: true, nodeIntegration: false },
    });
    w.loadFile(args.htmlPath);
  }, {
    preload: path.join(repoRoot, 'preload.js'),
    htmlPath: path.join(repoRoot, 'renderer', 'pr-review.html'),
  });
  let win;
  await expect.poll(() => {
    win = electronApp.windows().find((w) => !before.has(w) && w.url().endsWith('pr-review.html'));
    return !!win;
  }, { timeout: 8000 }).toBe(true);
  await win.waitForLoadState('domcontentloaded');
  await expect.poll(() => win.evaluate(() => !!(window.PrReview && window.PrReview.hostEl)), { timeout: 8000 }).toBe(true);
  return win;
}

async function showAiReview(win) {
  await win.evaluate(({ state, finding }) => {
    const PR = window.PrReview;
    PR.render(state);
    PR.pendingComments = [];
    Object.assign(PR.aiReview, {
      finalText: 'done', findings: [finding],
      summary: { verdict: 'Request Changes', highestRisk: ['The off-by-one drops the last item.'], testCoverage: 'none for the last page' },
    });
    PR.activeTab = 'ai-review';
    PR.render(state);
  }, { state: STATE, finding: FINDING });
}

test.describe('AI review drawn as the GitHub review', () => {
  test('a finding is a review thread on its diff lines, posting the bot’s comment shape', async ({ electronApp }) => {
    const win = await openPrWindow(electronApp);
    await showAiReview(win);

    const thread = win.locator('.pr-ai-finding[data-finding-id="f1"] .pr-gh-thread');
    await expect(thread.locator('.pr-gh-thread-path')).toHaveText('src/a.js');
    await expect(thread.locator('.pr-gh-hunk-row')).toHaveCount(3);
    await expect(thread.locator('.pr-gh-hunk-add .pr-gh-hunk-code').last()).toHaveText('const b = a - 1;');
    const suggestion = thread.locator('.pr-suggestion');
    await expect(suggestion.locator('.pr-suggestion-del code')).toHaveText(['const b = a - 1;']);
    await expect(suggestion.locator('.pr-suggestion-add code')).toHaveText(['const b = a;']);
    // Lead sentence humanized, the full explanation collapsed behind a <details>.
    await expect(thread.locator('.pr-gh-comment-body .pr-conv-md > p').first()).toHaveText('The loop stops one short, it skips the last item.');
    await expect(thread.locator('details.pr-gh-details')).toContainText('It only shows up on the final page.');

    const summary = win.locator('.pr-gh-review');
    await expect(summary).toContainText('Verdict: Request Changes · reviewed at e58245e');
    await expect(summary).toContainText('Reviewed by klaussy.');

    await thread.locator('details.pr-gh-details > summary').click();
    await win.screenshot({ path: test.info().outputPath('ai-review.png'), fullPage: true });

    const general = await win.evaluate((f) => window.PrReview.renderFindingCommentPreview(f, 'Why.\n\n```suggestion\nx\n```'),
      { ...FINDING, postMode: 'issue', locationVerified: false });
    expect(general).toContain('Not in diff');
    expect(general).not.toContain('pr-suggestion');
  });

  test('Add all to review stages every open finding and opens Submit review pre-filled', async ({ electronApp }) => {
    const win = await openPrWindow(electronApp);
    await showAiReview(win);

    await win.locator('.pr-ai-add-all').click();
    const pending = await win.evaluate(() => window.PrReview.pendingComments.map((c) => ({ path: c.path, line: c.line, body: c.body })));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ path: 'src/a.js', line: 2 });
    expect(pending[0].body).toContain('<details>\n<summary></summary>');

    const dialog = win.locator('.pr-submit-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.pr-submit-body')).toHaveValue(/^\*\*Verdict:\*\* Request Changes/);
    await expect(dialog.locator('input[value="REQUEST_CHANGES"]')).toBeChecked();
    await win.screenshot({ path: test.info().outputPath('submit.png') });
  });
});
