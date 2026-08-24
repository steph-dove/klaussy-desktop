const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyGlabError } = require('../../main/util/glab-error');

test('classifies a 503 error as an outage', () => {
  const cls = classifyGlabError('glab: 503 Service Unavailable');
  assert.equal(cls.kind, 'outage');
  assert.equal(cls.retryable, true);
  assert.match(cls.summary, /outage or server error/i);
});

test('classifies a 401 error as auth', () => {
  const cls = classifyGlabError('glab: 401 Unauthorized: Invalid token');
  assert.equal(cls.kind, 'auth');
  assert.equal(cls.retryable, false);
  assert.match(cls.fix, /glab auth login/);
});

test('classifies a 403 error as scope/permission', () => {
  const cls = classifyGlabError('glab: 403 Forbidden: insufficient_scope');
  assert.equal(cls.kind, 'scope');
  assert.match(cls.summary, /lacks permission/i);
});

test('classifies 404 Project Not Found as not-found', () => {
  const cls = classifyGlabError('glab: 404 Not Found: Project Not Found', { target: 'group/project' });
  assert.equal(cls.kind, 'not-found');
  assert.match(cls.summary, /group\/project/);
});

test('classifies network connection failure as network', () => {
  const cls = classifyGlabError('getaddrinfo ENOTFOUND gitlab.com');
  assert.equal(cls.kind, 'network');
  assert.equal(cls.retryable, true);
});

test('classifies missing glab CLI as missing-cli with install instructions', () => {
  const cls = classifyGlabError('spawn glab ENOENT');
  assert.equal(cls.kind, 'missing-cli');
  assert.equal(cls.retryable, false);
  assert.match(cls.summary, /glab.*not installed/i);
  assert.match(cls.fix, /brew install glab|winget/);
});
