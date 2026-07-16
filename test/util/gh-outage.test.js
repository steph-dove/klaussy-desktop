const test = require('node:test');
const assert = require('node:assert');

const { reconcileOutage, ANON_CORE_LIMIT } = require('../../main/util/gh-outage');

// Each test gets its own cache + clock so TTL behaviour is deterministic and
// tests can't leak verdicts into each other.
function harness({ status = 200, limit = 5000, token = 'gho_valid', json, fetchImpl } = {}) {
  const calls = { fetch: 0, token: 0 };
  return {
    calls,
    deps: {
      cache: new Map(),
      now: () => 1_000_000,
      getToken: (u) => { calls.token += 1; return typeof token === 'function' ? token(u) : token; },
      fetchImpl: fetchImpl || (async () => {
        calls.fetch += 1;
        return {
          status,
          json: async () => (json || { resources: { core: { limit } } }),
        };
      }),
    },
  };
}

const invalid = (username) => ({ username, active: false, valid: false, reason: 'Token is invalid' });

test('rescues an account when GitHub still accepts the token (outage)', async () => {
  const h = harness({ status: 200, limit: 5000 });
  const accounts = [invalid('stephanie913')];

  await reconcileOutage(accounts, h.deps);

  assert.equal(accounts[0].valid, true, 'token GitHub accepts must not be treated as dead');
  assert.equal(accounts[0].outage, true);
  assert.match(accounts[0].reason, /degraded/i);
});

test('leaves a genuinely revoked token invalid (401)', async () => {
  const h = harness({ status: 401 });
  const accounts = [invalid('stephanie913')];

  await reconcileOutage(accounts, h.deps);

  assert.equal(accounts[0].valid, false, 'a 401 is real evidence the token is dead');
  assert.equal(accounts[0].outage, undefined);
});

test('does not rescue on an anonymous-ceiling 200', async () => {
  // Defensive: if a proxy or future gh behaviour ever answers /rate_limit
  // without our credential, the anonymous limit must not read as "signed in".
  const h = harness({ status: 200, limit: ANON_CORE_LIMIT });
  const accounts = [invalid('stephanie913')];

  await reconcileOutage(accounts, h.deps);

  assert.equal(accounts[0].valid, false);
});

test('keeps gh verdict when the probe itself fails', async () => {
  const h = harness({ fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  const accounts = [invalid('stephanie913')];

  await reconcileOutage(accounts, h.deps);

  assert.equal(accounts[0].valid, false, 'no evidence must not rescue');
});

test('keeps gh verdict when no token can be read', async () => {
  const h = harness({ token: '' });
  const accounts = [invalid('stephanie913')];

  await reconcileOutage(accounts, h.deps);

  assert.equal(accounts[0].valid, false);
  assert.equal(h.calls.fetch, 0, 'must not probe without a token');
});

test('healthy accounts cost no network calls', async () => {
  const h = harness();
  const accounts = [{ username: 'steph-dove', active: true, valid: true, reason: null }];

  await reconcileOutage(accounts, h.deps);

  assert.equal(h.calls.fetch, 0);
  assert.equal(h.calls.token, 0);
});

test('probes each suspect account independently', async () => {
  const h = harness({
    token: (u) => (u === 'steph-dove' ? 'gho_valid' : ''),
    status: 200,
    limit: 5000,
  });
  const accounts = [invalid('stephanie913'), invalid('steph-dove')];

  await reconcileOutage(accounts, h.deps);

  assert.equal(accounts[0].valid, false, 'no token → stays invalid');
  assert.equal(accounts[1].valid, true, 'live token → rescued');
});

test('caches a verdict within the TTL', async () => {
  const h = harness({ status: 200, limit: 5000 });

  await reconcileOutage([invalid('stephanie913')], h.deps);
  await reconcileOutage([invalid('stephanie913')], h.deps);

  assert.equal(h.calls.fetch, 1, 'second read inside the TTL must reuse the verdict');
});
