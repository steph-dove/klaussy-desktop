// PR tab populated through a FAKE gh CLI. Drives PRPanel against a real
// worktree dir whose branch has a mocked open PR, and asserts the three
// render targets light up from the gh fixtures: #pr-info (title/state/#num),
// #pr-checks (CI rollup: passing/failing counts + job names), and
// #pr-comments-list (issue/review comments + inline GraphQL review threads).
// Exercises pr-for-branch + pr-checks + pr-review-threads end to end without
// touching GitHub. Fixed-bin-dir + test.use pattern so the fake gh is on PATH
// at launch (extraEnv must be static at collection time).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { test, expect } = require('./fixtures');
const { buildRepo, writeFakeGh, writeGhFixtures, rm } = require('./helpers');

// Deterministic, per-process bin + fixtures dir created at collection time so
// it can be referenced from the static test.use() below.
const FIXED_DIR = path.join(os.tmpdir(), `klaussy-e2e-ghpr-${process.pid}`);
fs.mkdirSync(FIXED_DIR, { recursive: true });
writeFakeGh(FIXED_DIR);

const SHA = 'deadbeefcafef00d';
const FIXTURES = {
  repo: { nameWithOwner: 'octo/widget' },
  // Single object served for every `gh pr view --json ...` call (carries the
  // superset of fields pr-for-branch + pr-checks + pr-required-checks ask for).
  pr: {
    number: 4242,
    title: 'Add sparkle to the widget',
    state: 'OPEN',
    body: 'This PR adds **sparkle** to the widget.',
    url: 'https://github.com/octo/widget/pull/4242',
    headRefName: 'feat/sparkle',
    baseRefName: 'main',
    headRefOid: SHA,
    additions: 12,
    deletions: 3,
    reviewDecision: 'REVIEW_REQUIRED',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    headRepository: { name: 'widget' },
    headRepositoryOwner: { login: 'octo' },
    comments: [
      { author: { login: 'reviewer-amy' }, body: 'Nice work overall!', createdAt: '2026-06-20T10:00:00Z' },
    ],
    reviews: [
      { author: { login: 'reviewer-bob' }, body: 'Please tweak the naming.', state: 'COMMENTED', submittedAt: '2026-06-20T11:00:00Z' },
    ],
  },
  diff: 'diff --git a/widget.js b/widget.js\n',
  // check-runs endpoint is called with `--jq '.check_runs[]'`, so fake gh emits
  // these lines verbatim (one normalized check-run per line = JSONL).
  checkRuns: [
    JSON.stringify({
      id: 1, name: 'build', status: 'completed', conclusion: 'success',
      app: { name: 'GitHub Actions', slug: 'github-actions' },
      started_at: '2026-06-20T10:00:00Z', completed_at: '2026-06-20T10:02:00Z',
      details_url: 'https://github.com/octo/widget/actions/runs/1/job/2',
    }),
    JSON.stringify({
      id: 2, name: 'unit-tests', status: 'completed', conclusion: 'failure',
      app: { name: 'GitHub Actions', slug: 'github-actions' },
      started_at: '2026-06-20T10:00:00Z', completed_at: '2026-06-20T10:03:00Z',
      details_url: 'https://github.com/octo/widget/actions/runs/1/job/3',
    }),
  ].join('\n') + '\n',
  commitStatus: { statuses: [] },
  requiredChecks: { contexts: [] },
  graphql: {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'THREAD_1',
                isResolved: false,
                isOutdated: false,
                path: 'src/widget.js',
                line: 10,
                originalLine: 10,
                startLine: null,
                originalStartLine: null,
                diffSide: 'RIGHT',
                comments: {
                  nodes: [
                    {
                      databaseId: 555,
                      author: { login: 'reviewer-amy' },
                      createdAt: '2026-06-20T12:00:00Z',
                      body: 'Consider renaming this variable.',
                      diffHunk: '@@ -8,3 +8,4 @@\n+const sparkle = true;',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  },
};
const FIXTURES_PATH = writeGhFixtures(FIXED_DIR, FIXTURES);

test.use({
  extraEnv: {
    PATH: `${FIXED_DIR}${path.delimiter}${process.env.PATH}`,
    FAKE_GH_FIXTURES: FIXTURES_PATH,
  },
});

test.afterAll(() => { rm(FIXED_DIR); });

test('PR tab renders info, CI checks, and review threads from fake gh', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();

  const repo = buildRepo({ 'README.md': '# widget\n' }, 'ghpr-wt');
  try {
    // Drive the PR panel directly against the worktree dir (the real UI sets
    // this from a task switch / PR-tab click; both routes call the same
    // setWorktree + loadPR). loadPR awaits the full forBranch + checks +
    // threads round-trip, so the DOM is settled when it resolves.
    await mainWindow.evaluate(async (wt) => {
      window.PRPanel.setWorktree(wt);
      await window.PRPanel.loadPR();
    }, repo);

    // #pr-info: state badge, number, title.
    const info = mainWindow.locator('#pr-info');
    await expect(info).toContainText('Add sparkle to the widget');
    await expect(info).toContainText('#4242');
    await expect(info.locator('.pr-state-badge')).toHaveText('OPEN');

    // #pr-checks: CI rollup with one passing + one failing run, named rows.
    const checks = mainWindow.locator('#pr-checks');
    await expect(checks).toContainText('1 passing');
    await expect(checks).toContainText('1 failing');
    await expect(checks).toContainText('build');
    await expect(checks).toContainText('unit-tests');

    // #pr-comments-list: general comment + review body, plus the inline
    // GraphQL review thread (path:line + thread comment body).
    const comments = mainWindow.locator('#pr-comments-list');
    await expect(comments).toContainText('Nice work overall!');
    await expect(comments).toContainText('Please tweak the naming.');
    await expect(comments).toContainText('Inline Review Comments');
    await expect(comments).toContainText('src/widget.js:10');
    await expect(comments).toContainText('Consider renaming this variable.');
  } finally {
    rm(repo);
  }
});
