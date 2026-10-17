/* global window, document */
const path = require('path');
const { test, expect } = require('./fixtures');

const repoRoot = path.resolve(__dirname, '..');

async function openPrWindow(electronApp) {
  const [win] = await Promise.all([
    electronApp.waitForEvent('window'),
    electronApp.evaluate(({ BrowserWindow }, args) => {
      const w = new BrowserWindow({
        width: 900, height: 900, show: false,
        webPreferences: { preload: args.preload, contextIsolation: true, nodeIntegration: false },
      });
      w.loadFile(args.htmlPath);
    }, {
      preload: path.join(repoRoot, 'preload.js'),
      htmlPath: path.join(repoRoot, 'renderer', 'pr-review.html'),
    }),
  ]);
  await win.waitForLoadState('domcontentloaded');
  await expect.poll(() => win.evaluate(() => typeof window.PrReview?.renderFindingCard), { timeout: 8000 }).toBe('function');
  return win;
}

const FINDING = {
  id: 'f1', severity: 'major', category: 'Correctness', title: 'Off-by-one',
  path: 'src/a.js', line: 2, side: 'RIGHT', postMode: 'inline', locationVerified: true,
  verifiedSnippet: { path: 'src/a.js', startLine: 1, endLine: 2, text: 'const a = 1;\nconst b = a - 1;' },
  text: 'The loop stops one short — it skips the last item.\n\nSuggested change:\n\n```suggestion\nconst b = a;\n```',
};

test.describe('AI finding comment preview', () => {
  test('a finding shows the comment exactly as it will post to GitHub', async ({ electronApp }) => {
    const win = await openPrWindow(electronApp);
    await win.evaluate((f) => {
      const host = document.createElement('div');
      host.id = 'finding-host';
      host.innerHTML = window.PrReview.renderFindingCard(f);
      document.body.innerHTML = '';
      document.body.appendChild(host);
      window.PrReview.hostEl = host;
    }, FINDING);

    const comment = win.locator('#finding-host .pr-ai-finding-gh-comment');
    await expect(comment.locator('.pr-inline-when')).toHaveText('on src/a.js:2');
    await expect(comment.locator('.pr-conv-md')).toHaveCount(1);
    const suggestion = comment.locator('.pr-suggestion');
    await expect(suggestion.locator('.pr-suggestion-head')).toHaveText('Suggested change');
    await expect(suggestion.locator('.pr-suggestion-del code')).toHaveText(['const b = a - 1;']);
    await expect(suggestion.locator('.pr-suggestion-add code')).toHaveText(['const b = a;']);
    await expect(comment.locator('.pr-conv-md p').first()).toHaveText('The loop stops one short, it skips the last item.');

    await win.screenshot({ path: test.info().outputPath('finding-preview.png') });

    // GitHub only applies a suggestion on an inline review comment; elsewhere it's a code block.
    const general = await win.evaluate((f) => window.PrReview.renderFindingCommentPreview(f, 'Why.\n\n```suggestion\nx\n```'),
      { ...FINDING, postMode: 'general' });
    expect(general).toContain('on the PR conversation');
    expect(general).not.toContain('pr-suggestion');
  });
});
