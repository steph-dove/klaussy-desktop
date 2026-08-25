const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyBitbucketError } = require('../../main/util/bitbucket-error');

test('classifies a 503 error as an outage', () => {
  const cls = classifyBitbucketError('503 Service Unavailable');
  assert.equal(cls.kind, 'outage');
  assert.equal(cls.retryable, true);
  assert.match(cls.summary, /outage or server error/i);
});

test('classifies a 401 error as auth', () => {
  const cls = classifyBitbucketError('401 Unauthorized: Invalid token or app password');
  assert.equal(cls.kind, 'auth');
  assert.equal(cls.retryable, false);
  assert.match(cls.fix, /App Password|BITBUCKET_TOKEN/);
});

test('classifies a 403 error as scope/permission', () => {
  const cls = classifyBitbucketError('403 Forbidden: Insufficient scope');
  assert.equal(cls.kind, 'scope');
  assert.equal(cls.retryable, false);
  assert.match(cls.summary, /lacks permission/i);
});

test('classifies 404 Repository Not Found as not-found', () => {
  const cls = classifyBitbucketError('404 Not Found: Repository not found', { target: 'workspace/repo' });
  assert.equal(cls.kind, 'not-found');
  assert.match(cls.summary, /workspace\/repo/);
});

test('classifies rate limit error as rate-limit', () => {
  const cls = classifyBitbucketError('429 Too Many Requests: Rate limit exceeded');
  assert.equal(cls.kind, 'rate-limit');
  assert.equal(cls.retryable, true);
});

test('classifies network connection failure as network', () => {
  const cls = classifyBitbucketError('getaddrinfo ENOTFOUND api.bitbucket.org');
  assert.equal(cls.kind, 'network');
  assert.equal(cls.retryable, true);
});
