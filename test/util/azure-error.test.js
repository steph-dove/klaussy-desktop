const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyAzureError } = require('../../main/util/azure-error');

const kind = (raw, ctx) => classifyAzureError(raw, ctx).kind;

test('classifyAzureError sorts Azure DevOps failures', () => {
  assert.equal(kind('HTTP 401: '), 'auth');
  assert.equal(kind('HTTP 203: expected JSON but got text/html'), 'auth');
  assert.equal(kind('No Azure DevOps credentials for dev.azure.com/contoso.'), 'auth');
  assert.equal(kind('HTTP 403: {"message":"TF401027: You need the Git \'Contribute\' permission"}'), 'scope');
  assert.equal(kind('HTTP 404: {"message":"TF401019: The Git repository with name or identifier x does not exist"}'), 'not-found');
  assert.equal(kind('HTTP 503: Service Unavailable'), 'outage');
  assert.equal(kind('HTTP 429: Too Many Requests'), 'rate-limit');
  assert.equal(kind('fetch failed'), 'network');
  assert.equal(kind('something odd'), 'unknown');
});

test('an old Server gets a version message, not a generic 400', () => {
  const cls = classifyAzureError('HTTP 400: {"typeKey":"VssVersionOutOfRangeException","message":"The requested REST API version of 6.0 is out of range"}', { host: 'tfs.corp' });
  assert.equal(cls.kind, 'server-version');
  assert.match(cls.fix, /2020/);
});

test('a PAT that no longer decrypts says to re-enter it', () => {
  const cls = classifyAzureError("The saved Azure DevOps PAT for me can't be read on this machine. Re-enter the PAT in Git Accounts.");
  assert.equal(cls.kind, 'auth');
  assert.equal(cls.fix, 'Re-enter the PAT in Git Accounts.');
});

test('auth and scope fixes name the PAT scopes', () => {
  assert.match(classifyAzureError('HTTP 401: ').fix, /Code \(Read & write\) and Build \(Read\)/);
  assert.match(classifyAzureError('HTTP 403: ').fix, /Code \(Read & write\) and Build \(Read\)/);
});
