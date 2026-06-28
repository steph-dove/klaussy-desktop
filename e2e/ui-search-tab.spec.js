// Project Search tab (UI side; search-files.spec.js covers the IPC). Drives
// the real diff-panel Search tab against a stubbed AppState pointing at a real
// repo: clicking the Search diff-tab reveals #search-tab-content, typing into
// #project-search-input populates #project-search-results with grouped file +
// line hits, and the #project-replace-btn stays disabled until there is both a
// replacement and live matches (re-disabling on a no-match query).

const { test, expect } = require('./fixtures');
const { buildRepo, rm } = require('./helpers');

test.beforeEach(async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();
});

test('Search tab finds matches and gates the Replace button on matches + replacement', async ({ mainWindow }) => {
  // Unique id so concurrent specs sharing AppState don't collide.
  const taskId = 700000 + (process.pid % 100000);
  const repo = buildRepo({
    'a.txt': 'hello world\nNEEDLE here\n',
    'b.txt': 'no match here\nNEEDLE again\nfinal NEEDLE\n',
    'src/index.js': '// no marker\n',
  }, 'ui-search');

  try {
    // Stub an active task on a real worktree — doProjectSearch reads the active
    // task's worktreePath when no override is passed.
    await mainWindow.evaluate(({ wt, id }) => {
      window.AppState.activeTaskId = id;
      window.AppState.tasks.set(id, { id, worktreePath: wt, branch: 'main' });
    }, { wt: repo, id: taskId });

    // Open the diff panel (gives the tab strip + content area real width) and
    // switch to the Search tab via its real click handler.
    await mainWindow.evaluate((wt) => window.DiffPanel.show(wt), repo);
    await mainWindow.locator('#diff-tabs .diff-tab[data-tab="search"]').click();

    const searchContent = mainWindow.locator('#search-tab-content');
    const input = mainWindow.locator('#project-search-input');
    const results = mainWindow.locator('#project-search-results');
    const replaceInput = mainWindow.locator('#project-replace-input');
    const replaceBtn = mainWindow.locator('#project-replace-btn');

    await expect(searchContent).toBeVisible();
    await expect(input).toBeVisible();
    // Nothing searched yet → replace stays disabled.
    await expect(replaceBtn).toBeDisabled();

    // Type a query; Enter bypasses the input debounce and runs immediately.
    await input.fill('NEEDLE');
    await input.press('Enter');

    // Two files matched (a.txt + b.txt); src/index.js has no marker.
    await expect(results.locator('.search-result-file')).toHaveCount(2);
    await expect(results.locator('.search-result-line').first()).toBeVisible();
    // Hits are highlighted with the query text.
    await expect(results.locator('mark.search-hit-match').first()).toHaveText('NEEDLE');

    // Matches exist but no replacement text yet → still disabled.
    await expect(replaceBtn).toBeDisabled();

    // Adding replacement text enables Replace and updates its label.
    await replaceInput.fill('REPLACED');
    await expect(replaceBtn).toBeEnabled();
    await expect(replaceBtn).toHaveText(/Replace in \d+ file/);

    // A no-match query clears the hit set → Replace disables again even though
    // the replacement field still has content.
    await input.fill('zzz_no_such_token_' + taskId);
    await input.press('Enter');
    await expect(results).toContainText('No matches found');
    await expect(replaceBtn).toBeDisabled();
  } finally {
    await mainWindow.evaluate((id) => {
      try { window.DiffPanel.hide(); } catch (_) {}
      var input = document.getElementById('project-search-input');
      var replace = document.getElementById('project-replace-input');
      if (input) input.value = '';
      if (replace) replace.value = '';
      window.AppState.activeTaskId = null;
      window.AppState.tasks.delete(id);
    }, taskId);
    rm(repo);
  }
});
