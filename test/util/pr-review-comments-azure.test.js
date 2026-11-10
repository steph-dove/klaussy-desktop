const { electronStub } = require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const handlers = {};
const origHandle = electronStub.ipcMain.handle;
electronStub.ipcMain.handle = (channel, fn) => { handlers[channel] = fn; };
require('../../main/ipc/pr-review-comments');
electronStub.ipcMain.handle = origHandle;

const { prReview } = require('../../main/state/pr-review');
const azure = require('../../main/util/forges/azure');
const github = require('../../main/util/forges/github');

function stub(adapter, method, fn) {
  const orig = adapter[method];
  adapter[method] = fn;
  return () => { adapter[method] = orig; };
}

test.afterEach(() => { prReview.active = null; });

test('editing an Azure comment passes the "{thread}:{comment}" id through intact', async () => {
  prReview.active = { forge: 'azure', baseOwner: 'contoso/web app', projectPath: 'contoso/web app/front', meta: {} };
  let seen;
  const restore = stub(azure, 'editComment', async (_pr, { id }) => { seen = id; return { ok: true }; });
  try {
    await handlers['pr-edit-review-comment'](null, { commentId: '7:2', body: 'Edited' });
    assert.equal(seen, '7:2');
  } finally {
    restore();
  }
});

test('other forges still get a numeric comment id', async () => {
  prReview.active = { forge: 'github', baseOwner: 'o', baseRepo: 'r', meta: {} };
  let seen;
  const restore = stub(github, 'editComment', async (_pr, { id }) => { seen = id; return { ok: true }; });
  try {
    await handlers['pr-edit-issue-comment'](null, { commentId: '123', body: 'Edited' });
    assert.equal(seen, 123);
  } finally {
    restore();
  }
});

test('the current user is cached per Azure organization, not per host', async () => {
  let n = 0;
  const restore = stub(azure, 'currentUser', async () => ({ login: `user${++n}` }));
  try {
    prReview.active = { forge: 'azure', host: 'dev.azure.com', baseOwner: 'orga/p', meta: {} };
    assert.equal((await handlers['pr-current-user']()).login, 'user1');
    prReview.active = { forge: 'azure', host: 'dev.azure.com', baseOwner: 'orgb/p', meta: {} };
    assert.equal((await handlers['pr-current-user']()).login, 'user2');
    prReview.active = { forge: 'azure', host: 'dev.azure.com', baseOwner: 'orga/p', meta: {} };
    assert.equal((await handlers['pr-current-user']()).login, 'user1');
  } finally {
    restore();
  }
});
