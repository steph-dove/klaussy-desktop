require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { renameNotice } = require('../../main/ipc/rename-notice');

const org = (over) => ({
  host: 'dev.azure.com',
  collectionPath: '/acme',
  collectionUrl: 'https://dev.azure.com/acme',
  needsReentry: true,
  ...over,
});

test('a fresh install never sees the card', () => {
  assert.equal(renameNotice({ legacy: false, config: {}, azureAccounts: [org()] }), null);
});

test('an upgraded install sees it once', () => {
  assert.deepEqual(renameNotice({ legacy: true, config: {}, azureAccounts: [] }), { reconnect: [] });
  assert.equal(renameNotice({ legacy: true, config: { renameNoticeSeen: true }, azureAccounts: [] }), null);
});

test('only orgs with an unreadable token get a reconnect button, one per org', () => {
  const notice = renameNotice({
    legacy: true,
    config: {},
    azureAccounts: [
      org({ user: 'a@acme.dev' }),
      org({ user: 'b@acme.dev' }),
      org({ collectionPath: '/fine', collectionUrl: 'https://dev.azure.com/fine', needsReentry: false }),
    ],
  });
  assert.deepEqual(notice.reconnect, [
    { collectionUrl: 'https://dev.azure.com/acme', collectionPath: '/acme', host: 'dev.azure.com' },
  ]);
});
