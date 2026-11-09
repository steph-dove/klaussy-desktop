// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Forge registry: adapter lookup by id, URL and remote, account ids, and the adapter interface.
require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FORGES, getForge, forgeForUrl, forgeForRemote, parseAccountId, toIpcError,
} = require('../../main/util/forges');

const METHODS = [
  'classifyError', 'listOpen', 'lookupPr', 'loadPr', 'refreshPr', 'reloadMeta',
  'fetchThreads', 'listChecks', 'failedCheckLogs', 'addIssueComment', 'editComment',
  'reply', 'resolveThread', 'submitReview', 'merge', 'currentUser', 'gitAuth',
  'headFetch', 'useAccountForReview', 'restoreAccountAfterReview',
];

test('getForge returns each registered adapter by id', () => {
  for (const id of ['github', 'gitlab', 'bitbucket']) {
    assert.equal(getForge(id).id, id);
  }
});

test('getForge falls back to GitHub for a missing or unknown forge', () => {
  assert.equal(getForge(undefined).id, 'github');
  assert.equal(getForge(null).id, 'github');
  assert.equal(getForge('unknown').id, 'github');
});

test('every adapter exposes the full interface', () => {
  for (const [id, adapter] of Object.entries(FORGES)) {
    assert.equal(adapter.id, id);
    for (const field of ['label', 'itemNoun', 'defaultHost', 'branchPrefix']) {
      assert.equal(typeof adapter[field], 'string', `${id}.${field}`);
      assert.ok(adapter[field], `${id}.${field} is empty`);
    }
    for (const m of METHODS) {
      assert.equal(typeof adapter[m], 'function', `${id}.${m} missing`);
    }
  }
});

test('adapters keep the hosts and branch prefixes the handlers used', () => {
  assert.deepEqual(
    ['github', 'gitlab', 'bitbucket'].map((id) => [getForge(id).defaultHost, getForge(id).branchPrefix]),
    [['github.com', 'pr'], ['gitlab.com', 'mr'], ['bitbucket.org', 'bb']],
  );
});

test('forgeForUrl picks the adapter from a PR or MR URL', () => {
  assert.equal(forgeForUrl('https://github.com/o/r/pull/3').adapter.id, 'github');
  assert.equal(forgeForUrl('https://gitlab.com/g/sub/r/-/merge_requests/9').adapter.id, 'gitlab');
  const bb = forgeForUrl('https://bitbucket.org/ws/repo/pull-requests/12');
  assert.equal(bb.adapter.id, 'bitbucket');
  assert.equal(bb.parsed.projectPath, 'ws/repo');
  assert.equal(bb.parsed.number, 12);
  assert.equal(forgeForUrl('not a url'), null);
});

test('forgeForRemote picks the adapter from a git remote, GitHub for unknown hosts', () => {
  assert.equal(forgeForRemote('git@gitlab.com:g/r.git').adapter.id, 'gitlab');
  assert.equal(forgeForRemote('https://bitbucket.org/ws/r.git').adapter.id, 'bitbucket');
  assert.equal(forgeForRemote('git@github.com:o/r.git').adapter.id, 'github');
  const unknown = forgeForRemote('https://git.example.com/o/r.git');
  assert.equal(unknown.adapter.id, 'github');
  assert.equal(unknown.info.forge, 'unknown');
  assert.equal(forgeForRemote(''), null);
});

test('parseAccountId reads every picker account form', () => {
  assert.deepEqual(parseAccountId('gitlab:gitlab.example.com:dev'), { forge: 'gitlab', host: 'gitlab.example.com', user: 'dev' });
  assert.deepEqual(parseAccountId('bitbucket:bitbucket.org:me'), { forge: 'bitbucket', host: 'bitbucket.org', user: 'me' });
  assert.deepEqual(parseAccountId('github:steph-dove'), { forge: 'github', host: null, user: 'steph-dove' });
  assert.deepEqual(parseAccountId('plain-user'), { forge: null, host: null, user: 'plain-user' });
  assert.deepEqual(parseAccountId({ username: 'obj-user' }), { forge: null, host: null, user: 'obj-user' });
  assert.deepEqual(parseAccountId(undefined), { forge: null, host: null, user: undefined });
});

test('parseAccountId keeps the old fallback for a host-less forge id', () => {
  // "gitlab:me" has no host part; the handler used parts[2] || parts[1] for the user.
  assert.deepEqual(parseAccountId('gitlab:me'), { forge: 'gitlab', host: 'me', user: 'me' });
  assert.deepEqual(parseAccountId('bitbucket::me'), { forge: 'bitbucket', host: null, user: 'me' });
});

test('toIpcError builds the renderer error shape from the adapter classifier', () => {
  const err = Object.assign(new Error('boom'), { responseBody: 'Bitbucket API error (HTTP 404): not found' });
  const res = toIpcError(getForge('bitbucket'), err, { target: 'ws/repo', host: 'bitbucket.org' });
  assert.equal(res.error, 'Bitbucket API error (HTTP 404): not found');
  for (const k of ['errorKind', 'errorSummary', 'errorFix']) assert.ok(k in res, k);
});

test('headFetch gives each forge its refspec', () => {
  const pr = { number: 7, meta: { headRefName: 'feat/x' } };
  assert.deepEqual(getForge('github').headFetch(pr, 'feat/x'), { refspec: '+refs/pull/7/head:refs/heads/feat/x', fetchTarget: 'pull/7/head' });
  assert.deepEqual(getForge('gitlab').headFetch(pr, 'feat/x'), { refspec: '+refs/merge-requests/7/head:refs/heads/feat/x', fetchTarget: 'merge-requests/7/head' });
  assert.deepEqual(getForge('bitbucket').headFetch(pr, 'feat/x'), { refspec: '+refs/heads/feat/x:refs/heads/feat/x', fetchTarget: 'feat/x' });
});
