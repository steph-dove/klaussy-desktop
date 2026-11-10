require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { saveError } = require('../../main/ipc/azure');
const { AzureAuthError } = require('../../main/util/azure-api');
const { ForgeHttpError } = require('../../main/util/forge-http');

test('a secure-storage refusal reaches the dialog with its own kind and message', () => {
  const res = saveError(new AzureAuthError('No secure storage. Set $AZURE_DEVOPS_EXT_PAT instead.', 'unavailable'));
  assert.equal(res.errorKind, 'unavailable');
  assert.match(res.errorSummary, /AZURE_DEVOPS_EXT_PAT/);
});

test('a rejected PAT is classified as an auth error with the scopes to use', () => {
  const res = saveError(new ForgeHttpError('HTTP 401: ', { status: 401 }));
  assert.equal(res.errorKind, 'auth');
  assert.match(res.errorFix, /Code \(Read & write\)/);
});
