require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  bucketFromGitLabStatus,
  normalizeGitLabMr,
  transformGitLabDiscussions,
  bucketFromBitbucketStatus,
  normalizeBitbucketPr,
  transformBitbucketComments,
} = require('../../main/util/forge-adapter');

test('bucketFromGitLabStatus maps GitLab statuses to Klaussy buckets', () => {
  assert.equal(bucketFromGitLabStatus('success'), 'pass');
  assert.equal(bucketFromGitLabStatus('failed'), 'fail');
  assert.equal(bucketFromGitLabStatus('running'), 'pending');
  assert.equal(bucketFromGitLabStatus('pending'), 'pending');
  assert.equal(bucketFromGitLabStatus('canceled'), 'cancel');
});

test('bucketFromBitbucketStatus maps Bitbucket commit statuses to Klaussy buckets', () => {
  assert.equal(bucketFromBitbucketStatus('SUCCESSFUL'), 'pass');
  assert.equal(bucketFromBitbucketStatus('FAILED'), 'fail');
  assert.equal(bucketFromBitbucketStatus('INPROGRESS'), 'pending');
  assert.equal(bucketFromBitbucketStatus('STOPPED'), 'cancel');
});

test('normalizeGitLabMr converts GitLab MR structure to unified review metadata', () => {
  const gitlabMr = {
    id: 12345,
    iid: 42,
    title: 'Fix authentication timeout',
    description: 'Resolves issue with slow token validation.',
    state: 'opened',
    created_at: '2026-08-20T10:00:00Z',
    updated_at: '2026-08-22T14:30:00Z',
    source_branch: 'fix/auth-timeout',
    target_branch: 'main',
    sha: 'abcdef1234567890',
    draft: false,
    web_url: 'https://gitlab.com/org/repo/-/merge_requests/42',
    author: { username: 'stephanie', name: 'Stephanie Dover' },
    has_conflicts: false,
    detailed_merge_status: 'mergeable',
  };

  const meta = normalizeGitLabMr(gitlabMr, 'gitlab.com');
  assert.equal(meta.forge, 'gitlab');
  assert.equal(meta.number, 42);
  assert.equal(meta.title, 'Fix authentication timeout');
  assert.equal(meta.author.login, 'stephanie');
  assert.equal(meta.headRefName, 'fix/auth-timeout');
  assert.equal(meta.baseRefName, 'main');
  assert.equal(meta.headRefOid, 'abcdef1234567890');
  assert.equal(meta.isDraft, false);
  assert.equal(meta.state, 'OPEN');
});

test('normalizeBitbucketPr converts Bitbucket PR structure to unified review metadata', () => {
  const bbPr = {
    id: 10,
    title: 'Add webhook verification',
    description: { raw: 'Implements HMAC signature verification.' },
    state: 'OPEN',
    created_on: '2026-08-20T10:00:00Z',
    updated_on: '2026-08-22T14:30:00Z',
    source: {
      branch: { name: 'feat/webhooks' },
      commit: { hash: '9876543210fedcba' },
      repository: { full_name: 'steph/repo', name: 'repo' },
    },
    destination: {
      branch: { name: 'main' },
      repository: { full_name: 'myorg/repo', name: 'repo' },
    },
    author: {
      nickname: 'stephanie',
      display_name: 'Stephanie Dover',
    },
    links: {
      html: { href: 'https://bitbucket.org/myorg/repo/pull-requests/10' },
    },
  };

  const meta = normalizeBitbucketPr(bbPr, 'bitbucket.org');
  assert.equal(meta.forge, 'bitbucket');
  assert.equal(meta.number, 10);
  assert.equal(meta.title, 'Add webhook verification');
  assert.equal(meta.author.login, 'stephanie');
  assert.equal(meta.headRefName, 'feat/webhooks');
  assert.equal(meta.baseRefName, 'main');
  assert.equal(meta.headRefOid, '9876543210fedcba');
  assert.equal(meta.body, 'Implements HMAC signature verification.');
  assert.equal(meta.state, 'OPEN');
  assert.equal(meta.url, 'https://bitbucket.org/myorg/repo/pull-requests/10');
});

test('transformBitbucketComments handles inline threads and issue comments', () => {
  const comments = [
    {
      id: 1001,
      deleted: false,
      content: { raw: 'Top-level general comment on the PR' },
      user: { nickname: 'reviewer1' },
      created_on: '2026-08-21T09:00:00Z',
      links: { html: { href: 'https://bitbucket.org/myorg/repo/pull-requests/10#comment-1001' } },
    },
    {
      id: 1002,
      deleted: false,
      content: { raw: 'Consider error handling here' },
      user: { nickname: 'reviewer2' },
      created_on: '2026-08-21T10:00:00Z',
      inline: {
        path: 'src/webhook.js',
        to: 45,
      },
      resolved: false,
    },
    {
      id: 1003,
      deleted: false,
      content: { raw: 'Good catch, will update' },
      user: { nickname: 'stephanie' },
      created_on: '2026-08-21T10:30:00Z',
      parent: { id: 1002 },
      resolved: true,
    },
  ];

  const { threads, issueComments } = transformBitbucketComments(comments);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, '1002');
  assert.equal(threads[0].path, 'src/webhook.js');
  assert.equal(threads[0].line, 45);
  assert.equal(threads[0].diffSide, 'RIGHT');
  assert.equal(threads[0].isResolved, true);
  assert.equal(threads[0].comments.length, 2);
  assert.equal(threads[0].comments[1].body, 'Good catch, will update');

  assert.equal(issueComments.length, 1);
  assert.equal(issueComments[0].databaseId, 1001);
  assert.equal(issueComments[0].body, 'Top-level general comment on the PR');
});

test('normalizeGitLabMr converts GitLab MR structure to unified review metadata', () => {
  const gitlabMr = {
    id: 12345,
    iid: 42,
    title: 'Fix authentication timeout',
    description: 'Resolves issue with slow token validation.',
    state: 'opened',
    created_at: '2026-08-20T10:00:00Z',
    updated_at: '2026-08-22T14:30:00Z',
    source_branch: 'fix/auth-timeout',
    target_branch: 'main',
    sha: 'abcdef1234567890',
    draft: false,
    web_url: 'https://gitlab.com/org/repo/-/merge_requests/42',
    author: { username: 'stephanie', name: 'Stephanie Dover' },
    has_conflicts: false,
    detailed_merge_status: 'mergeable',
  };

  const meta = normalizeGitLabMr(gitlabMr, 'gitlab.com');
  assert.equal(meta.forge, 'gitlab');
  assert.equal(meta.number, 42);
  assert.equal(meta.title, 'Fix authentication timeout');
  assert.equal(meta.author.login, 'stephanie');
  assert.equal(meta.headRefName, 'fix/auth-timeout');
  assert.equal(meta.baseRefName, 'main');
  assert.equal(meta.headRefOid, 'abcdef1234567890');
  assert.equal(meta.isDraft, false);
  assert.equal(meta.state, 'OPEN');
});

test('transformGitLabDiscussions separates diff discussions and issue notes', () => {
  const discussions = [
    {
      id: 'disc-diff-1',
      notes: [
        {
          id: 101,
          system: false,
          body: 'Consider adding a fallback here',
          author: { username: 'reviewer1' },
          created_at: '2026-08-21T09:00:00Z',
          resolvable: true,
          resolved: false,
          position: {
            new_path: 'src/auth.js',
            old_path: 'src/auth.js',
            new_line: 55,
            old_line: null,
          },
        },
      ],
    },
    {
      id: 'disc-general-2',
      notes: [
        {
          id: 202,
          system: false,
          body: 'Overall looks solid, ready to merge.',
          author: { username: 'reviewer2' },
          created_at: '2026-08-21T11:00:00Z',
          resolvable: false,
          resolved: false,
        },
      ],
    },
    {
      id: 'disc-system-3',
      notes: [
        {
          id: 303,
          system: true,
          body: 'assigned to @stephanie',
          author: { username: 'gitlab-bot' },
        },
      ],
    },
  ];

  const { threads, issueComments } = transformGitLabDiscussions(discussions);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, 'disc-diff-1');
  assert.equal(threads[0].path, 'src/auth.js');
  assert.equal(threads[0].line, 55);
  assert.equal(threads[0].diffSide, 'RIGHT');
  assert.equal(threads[0].isResolved, false);

  assert.equal(issueComments.length, 1);
  assert.equal(issueComments[0].databaseId, 202);
  assert.equal(issueComments[0].body, 'Overall looks solid, ready to merge.');
});
