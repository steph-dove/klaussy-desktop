require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const { probeRepoAccess, pruneUnreachableHistory, withoutUrls, cachedProbe } = require('../../main/util/review-history');

function fakeFetch(statusByToken) {
  return async (_url, opts) => {
    const token = opts.headers.Authorization.replace('Bearer ', '');
    const s = statusByToken[token];
    if (s instanceof Error) throw s;
    return { status: s };
  };
}

test('probeRepoAccess: any account seeing the repo means ok', async () => {
  const r = await probeRepoAccess('o', 'r', ['a', 'b'], fakeFetch({ a: 404, b: 200 }));
  assert.equal(r, 'ok');
});

test('probeRepoAccess: every account 404 means gone', async () => {
  const r = await probeRepoAccess('o', 'r', ['a', 'b'], fakeFetch({ a: 404, b: 404 }));
  assert.equal(r, 'gone');
});

test('probeRepoAccess: a network error or 5xx is unknown, never gone', async () => {
  assert.equal(await probeRepoAccess('o', 'r', ['a', 'b'], fakeFetch({ a: 404, b: new Error('offline') })), 'unknown');
  assert.equal(await probeRepoAccess('o', 'r', ['a'], fakeFetch({ a: 503 })), 'unknown');
  assert.equal(await probeRepoAccess('o', 'r', ['a'], fakeFetch({ a: 401 })), 'unknown');
});

test('probeRepoAccess: no tokens is unknown', async () => {
  assert.equal(await probeRepoAccess('o', 'r', [], fakeFetch({})), 'unknown');
});

test('pruneUnreachableHistory drops PRs from repos no account can see', async () => {
  const items = [
    { url: 'https://github.com/me/keep/pull/1' },
    { url: 'https://github.com/OldOrg/property/pull/11196' },
    { url: 'https://github.com/OldOrg/property/pull/11138' },
    { url: 'https://github.com/me/flaky/pull/2' },
    { url: 'https://gitlab.com/me/proj/-/merge_requests/1' },
  ];
  const probed = [];
  const verdicts = { 'me/keep': 'ok', 'OldOrg/property': 'gone', 'me/flaky': 'unknown' };
  const { items: kept, removed } = await pruneUnreachableHistory(items, async (owner, repo) => {
    probed.push(owner + '/' + repo);
    return verdicts[owner + '/' + repo];
  });
  assert.deepEqual(kept.map((i) => i.url), [
    'https://github.com/me/keep/pull/1',
    'https://github.com/me/flaky/pull/2',
    'https://gitlab.com/me/proj/-/merge_requests/1',
  ]);
  assert.equal(removed, 2);
  assert.deepEqual(probed.sort(), ['OldOrg/property', 'me/flaky', 'me/keep']);
});

test('probeRepoAccess answers as soon as one account sees the repo, without waiting on a slow one', async () => {
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({ status: 404 }), 1000));
  const fetchFn = async (_url, opts) => (opts.headers.Authorization.endsWith('slow') ? slow() : { status: 200 });
  const started = Date.now();
  assert.equal(await probeRepoAccess('o', 'r', ['slow', 'fast'], fetchFn), 'ok');
  assert.ok(Date.now() - started < 500);
});

test('pruneUnreachableHistory reports the URLs it dropped', async () => {
  const items = [{ url: 'https://github.com/me/keep/pull/1' }, { url: 'https://github.com/Old/gone/pull/2' }];
  const { dropped } = await pruneUnreachableHistory(items, async (o) => (o === 'Old' ? 'gone' : 'ok'));
  assert.deepEqual(dropped, ['https://github.com/Old/gone/pull/2']);
});

test('dropping pruned URLs keeps an entry added while the probes ran', () => {
  const now = [{ url: 'https://github.com/me/new/pull/9' }, { url: 'https://github.com/me/keep/pull/1' }, { url: 'https://github.com/Old/gone/pull/2' }];
  assert.deepEqual(withoutUrls(now, ['https://github.com/Old/gone/pull/2']).map((e) => e.url),
    ['https://github.com/me/new/pull/9', 'https://github.com/me/keep/pull/1']);
});

test('cachedProbe reuses a definite verdict within its TTL but asks again after an unknown', async () => {
  let calls = 0;
  let verdict = 'unknown';
  let now = 0;
  const probe = cachedProbe(async () => { calls++; return verdict; }, 1000, () => now);
  await probe('o', 'r');
  await probe('o', 'r');
  assert.equal(calls, 2);
  verdict = 'gone';
  await probe('o', 'r');
  await probe('o', 'r');
  assert.equal(calls, 3);
  now = 2000;
  await probe('o', 'r');
  assert.equal(calls, 4);
});
