require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAzurePr, transformAzureThreads, bucketFromAzureStatus } = require('../../main/util/forge-adapter');

const PR = {
  pullRequestId: 42,
  status: 'active',
  title: 'Add retries',
  description: 'Body text',
  createdBy: { displayName: 'Dev Person', uniqueName: 'dev@contoso.com' },
  creationDate: '2026-11-01T10:00:00Z',
  sourceRefName: 'refs/heads/feature/retry',
  targetRefName: 'refs/heads/main',
  mergeStatus: 'succeeded',
  isDraft: false,
  lastMergeSourceCommit: { commitId: 'abc123' },
  lastMergeTargetCommit: { commitId: 'def456' },
  reviewers: [{ vote: 0 }, { vote: 10 }],
  repository: {
    name: 'Front-End',
    project: { name: 'Web App' },
    webUrl: 'https://dev.azure.com/Contoso/Web%20App/_git/Front-End',
  },
};

test('normalizeAzurePr maps the PR into the shared meta shape', () => {
  const meta = normalizeAzurePr(PR);
  assert.equal(meta.forge, 'azure');
  assert.equal(meta.host, 'dev.azure.com');
  assert.equal(meta.number, 42);
  assert.equal(meta.state, 'OPEN');
  assert.equal(meta.url, 'https://dev.azure.com/Contoso/Web%20App/_git/Front-End/pullrequest/42');
  assert.equal(meta.headRefName, 'feature/retry');
  assert.equal(meta.baseRefName, 'main');
  assert.equal(meta.headRefOid, 'abc123');
  assert.equal(meta.reviewDecision, 'APPROVED');
  assert.equal(meta.author.login, 'dev@contoso.com');
  assert.deepEqual(meta.headRepositoryOwner, { login: 'contoso/web app' });
  assert.deepEqual(meta.headRepository, { name: 'front-end' });
});

test('normalizeAzurePr builds the URL when webUrl is missing, and reads states and votes', () => {
  const noWeb = { ...PR, repository: { name: 'r', project: { name: 'p' } } };
  assert.equal(normalizeAzurePr(noWeb, { collectionUrl: 'https://tfs.corp/tfs/Coll' }).url,
    'https://tfs.corp/tfs/Coll/p/_git/r/pullrequest/42');
  assert.equal(normalizeAzurePr({ ...PR, status: 'completed' }).state, 'MERGED');
  assert.equal(normalizeAzurePr({ ...PR, status: 'abandoned' }).state, 'CLOSED');
  assert.equal(normalizeAzurePr({ ...PR, reviewers: [{ vote: 10 }, { vote: -5 }] }).reviewDecision, 'CHANGES_REQUESTED');
  assert.equal(normalizeAzurePr({ ...PR, mergeStatus: 'conflicts' }).mergeable, 'CONFLICTING');
  assert.equal(normalizeAzurePr(PR).mergeable, 'MERGEABLE');
  assert.equal(normalizeAzurePr({ ...PR, mergeStatus: 'rejectedByPolicy' }).mergeStateStatus, 'BLOCKED');
  assert.equal(normalizeAzurePr({ ...PR, mergeStatus: 'failure' }).mergeable, 'UNKNOWN');
  assert.deepEqual([normalizeAzurePr({ ...PR, mergeStatus: 'queued' }).mergeable, normalizeAzurePr({ ...PR, mergeStatus: 'queued' }).mergeStateStatus], ['UNKNOWN', '']);
});

test('normalizeAzurePr throws when it cannot place the repo', () => {
  assert.throws(() => normalizeAzurePr({ ...PR, repository: { name: 'r', project: { name: 'p' } } }), /Azure DevOps repository/);
});

test('a PR from a fork pushes to the fork', () => {
  const meta = normalizeAzurePr({ ...PR, forkSource: { repository: { name: 'Front-End-Fork', project: { name: 'Sandbox' } } } });
  assert.deepEqual(meta.headRepositoryOwner, { login: 'contoso/sandbox' });
  assert.deepEqual(meta.headRepository, { name: 'front-end-fork' });
});

test('transformAzureThreads splits review threads from PR comments and drops system comments', () => {
  const { threads, issueComments } = transformAzureThreads({
    value: [
      {
        id: 7,
        status: 'active',
        threadContext: { filePath: '/src/a.js', rightFileStart: { line: 12, offset: 1 } },
        comments: [
          { id: 1, content: 'Null here?', author: { uniqueName: 'rev@contoso.com' }, publishedDate: 't1', commentType: 'text' },
          { id: 2, parentCommentId: 1, content: 'Fixed', author: { displayName: 'Dev' }, commentType: 'text' },
        ],
      },
      { id: 8, status: 'fixed', threadContext: { filePath: '/b.js', leftFileStart: { line: 3 } }, comments: [{ id: 1, content: 'old', commentType: 'text' }] },
      { id: 9, comments: [{ id: 1, content: 'Looks good overall', commentType: 'text' }] },
      { id: 10, comments: [{ id: 1, content: 'Dev updated the pull request', commentType: 'system' }] },
      { id: 11, isDeleted: true, comments: [{ id: 1, content: 'gone' }] },
      { id: 12, status: 'active', threadContext: { filePath: '/c.js', rightFileStart: { line: 1 } }, comments: [{ id: 1, content: 'x', isDeleted: true }] },
    ],
  });
  assert.equal(threads.length, 2);
  assert.deepEqual(threads[0].comments.map((c) => c.databaseId), ['7:1', '7:2']);
  assert.equal(threads[0].path, 'src/a.js');
  assert.equal(threads[0].line, 12);
  assert.equal(threads[0].diffSide, 'RIGHT');
  assert.equal(threads[0].isResolved, false);
  assert.equal(threads[1].diffSide, 'LEFT');
  assert.equal(threads[1].isResolved, true);
  assert.equal(issueComments.length, 1);
  assert.equal(issueComments[0].body, 'Looks good overall');
  assert.equal(issueComments[0].databaseId, '9:1');
});

test('every resolved status counts as resolved', () => {
  for (const status of ['fixed', 'closed', 'wontFix', 'byDesign']) {
    const { threads } = transformAzureThreads([{ id: 1, status, threadContext: { filePath: '/a', rightFileStart: { line: 1 } }, comments: [{ id: 1, content: 'x' }] }]);
    assert.equal(threads[0].isResolved, true, status);
  }
});

test('bucketFromAzureStatus', () => {
  assert.equal(bucketFromAzureStatus('succeeded'), 'pass');
  assert.equal(bucketFromAzureStatus('partiallySucceeded'), 'pass');
  assert.equal(bucketFromAzureStatus('failed'), 'fail');
  assert.equal(bucketFromAzureStatus('error'), 'fail');
  assert.equal(bucketFromAzureStatus('canceled'), 'cancel');
  assert.equal(bucketFromAzureStatus('pending'), 'pending');
  assert.equal(bucketFromAzureStatus(undefined), 'pending');
});
