const test = require('node:test');
const assert = require('node:assert/strict');

const { parseForgeUrl, detectForgeFromRemote } = require('../../main/util/forge-url');

test('parseForgeUrl parses GitLab MR URLs with group and subgroup', () => {
  const parsed1 = parseForgeUrl('https://gitlab.com/gitlab-org/gitlab/-/merge_requests/123');
  assert.deepEqual(parsed1, {
    forge: 'gitlab',
    host: 'gitlab.com',
    projectPath: 'gitlab-org/gitlab',
    owner: 'gitlab-org',
    repo: 'gitlab',
    number: 123,
    type: 'mr',
  });

  const parsed2 = parseForgeUrl('https://gitlab.corp.example.com/platform/infra/core-api/merge_requests/456?tab=diffs#note_789');
  assert.deepEqual(parsed2, {
    forge: 'gitlab',
    host: 'gitlab.corp.example.com',
    projectPath: 'platform/infra/core-api',
    owner: 'platform/infra',
    repo: 'core-api',
    number: 456,
    type: 'mr',
  });
});

test('parseForgeUrl parses GitHub PR URLs', () => {
  const parsed = parseForgeUrl('https://github.com/steph-dove/klaussy-desktop/pull/42');
  assert.deepEqual(parsed, {
    forge: 'github',
    host: 'github.com',
    projectPath: 'steph-dove/klaussy-desktop',
    owner: 'steph-dove',
    repo: 'klaussy-desktop',
    number: 42,
    type: 'pr',
  });
});

test('parseForgeUrl parses Bitbucket PR URLs', () => {
  const parsed = parseForgeUrl('https://bitbucket.org/myorg/my-repo/pull-requests/10');
  assert.deepEqual(parsed, {
    forge: 'bitbucket',
    host: 'bitbucket.org',
    projectPath: 'myorg/my-repo',
    owner: 'myorg',
    repo: 'my-repo',
    number: 10,
    type: 'pr',
  });
});

test('parseForgeUrl returns null for non-PR/MR URLs or invalid inputs', () => {
  assert.equal(parseForgeUrl('https://gitlab.com/group/repo'), null);
  assert.equal(parseForgeUrl('https://google.com'), null);
  assert.equal(parseForgeUrl(''), null);
  assert.equal(parseForgeUrl(null), null);
});

test('detectForgeFromRemote identifies GitLab HTTPS and SSH remotes', () => {
  const https = detectForgeFromRemote('https://gitlab.com/my-group/sub-team/project.git');
  assert.deepEqual(https, {
    forge: 'gitlab',
    host: 'gitlab.com',
    projectPath: 'my-group/sub-team/project',
    owner: 'my-group/sub-team',
    repo: 'project',
  });

  const ssh = detectForgeFromRemote('git@gitlab.com:my-group/project.git');
  assert.deepEqual(ssh, {
    forge: 'gitlab',
    host: 'gitlab.com',
    projectPath: 'my-group/project',
    owner: 'my-group',
    repo: 'project',
  });
});

test('detectForgeFromRemote identifies GitHub and Bitbucket remotes', () => {
  const gh = detectForgeFromRemote('git@github.com:owner/repo.git');
  assert.deepEqual(gh, {
    forge: 'github',
    host: 'github.com',
    projectPath: 'owner/repo',
    owner: 'owner',
    repo: 'repo',
  });

  const bb = detectForgeFromRemote('https://bitbucket.org/workspace/repo.git');
  assert.deepEqual(bb, {
    forge: 'bitbucket',
    host: 'bitbucket.org',
    projectPath: 'workspace/repo',
    owner: 'workspace',
    repo: 'repo',
  });
});
