// 'Review a Pull Request' picker, driven entirely through the FAKE gh on PATH.
// Proves clicking #btn-review-pr (App.showPrPicker) opens the picker overlay
// and that its three gh-backed sections populate from fixtures:
//   - "Recent pull requests"  <- gh api /user/repos  +  gh pr list  (pr-recent-repos)
//   - "Opened by you"         <- gh search prs       (pr-authored)
// Also proves the client-side search filter hides non-matching rows. No PR is
// actually loaded (no worktree/session is created), so cleanup is just the
// module-level fixed bin dir.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('./fixtures');
const { writeFakeGh, writeGhFixtures, rm } = require('./helpers');

// extraEnv must be static at collection time, so the fake gh + fixtures live on
// a deterministic bin dir created here at module load (pid-scoped so concurrent
// specs don't collide). binFor()/gh calls read these at spawn time.
const FIXED_BIN = path.join(os.tmpdir(), 'klaussy-e2e-ghpicker-bin-' + process.pid);
fs.mkdirSync(FIXED_BIN, { recursive: true });
writeFakeGh(FIXED_BIN);

const FIXTURES = writeGhFixtures(FIXED_BIN, {
  username: 'e2e-user',
  repo: { nameWithOwner: 'e2e-owner/e2e-repo' },
  // pr-recent-repos: `gh api /user/repos?...` resolves to fx.api (no dedicated
  // key in the fake gh for this REST path); each repo's full_name is then fed
  // back into `gh pr list -R <full>` which returns fx.prList.
  api: [{ full_name: 'e2e-owner/e2e-repo' }],
  prList: [
    { number: 101, title: 'Fix the login flow', author: { login: 'octocat' }, state: 'OPEN', url: 'https://github.com/e2e-owner/e2e-repo/pull/101', updatedAt: '2026-06-20T00:00:00Z', isDraft: false },
    { number: 102, title: 'Add dark mode toggle', author: { login: 'hubot' }, state: 'OPEN', url: 'https://github.com/e2e-owner/e2e-repo/pull/102', updatedAt: '2026-06-21T00:00:00Z', isDraft: false },
  ],
  // pr-authored: `gh search prs --author=@me ...`
  searchPrs: [
    { number: 303, title: 'My own draft PR', url: 'https://github.com/e2e-owner/e2e-repo/pull/303', state: 'OPEN', repository: { nameWithOwner: 'e2e-owner/e2e-repo' }, createdAt: '2026-06-22T00:00:00Z', isDraft: true },
  ],
});

test.use({
  extraEnv: {
    PATH: FIXED_BIN + path.delimiter + process.env.PATH,
    FAKE_GH_FIXTURES: FIXTURES,
  },
});

test.afterAll(() => { rm(FIXED_BIN); });

test.beforeEach(async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();
});

test('PR picker lists mocked PRs from the fake gh', async ({ mainWindow }) => {
  await mainWindow.locator('#btn-review-pr').click();

  const overlay = mainWindow.locator('.pr-picker-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('.pr-picker-header')).toHaveText('Review a Pull Request');

  // "Recent pull requests" — grouped by repo (gh api /user/repos -> gh pr list).
  const list = overlay.locator('.pr-picker-list');
  await expect(list.locator('.pr-picker-repo')).toHaveText('e2e-owner/e2e-repo');
  await expect(list.getByText('Fix the login flow')).toBeVisible();
  await expect(list.getByText('Add dark mode toggle')).toBeVisible();
  await expect(list.locator('.pr-picker-item')).toHaveCount(2);

  // "Opened by you" — gh search prs --author=@me.
  const authored = overlay.locator('.pr-picker-authored');
  await expect(authored.getByText('My own draft PR')).toBeVisible();

  // Client-side filter narrows the rendered rows by substring.
  await overlay.locator('.pr-picker-search').fill('login');
  await expect(list.getByText('Fix the login flow')).toBeVisible();
  await expect(list.getByText('Add dark mode toggle')).toBeHidden();

  await overlay.locator('.pr-picker-cancel').click();
  await expect(overlay).toBeHidden();
});
