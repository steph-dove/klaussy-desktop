const test = require('node:test');
const assert = require('node:assert/strict');

const {
  bucketFromGitLabStatus,
  normalizeGitLabMr,
  transformGitLabDiscussions,
} = require('../../main/util/forge-adapter');

test('bucketFromGitLabStatus maps GitLab statuses to Klaussy buckets', () => {
  assert.equal(bucketFromGitLabStatus('success'), 'pass');
  assert.equal(bucketFromGitLabStatus('failed'), 'fail');
  assert.equal(bucketFromGitLabStatus('running'), 'pending');
  assert.equal(bucketFromGitLabStatus('pending'), 'pending');
  assert.equal(bucketFromGitLabStatus('canceled'), 'cancel');
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
