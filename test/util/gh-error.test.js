const test = require('node:test');
const assert = require('node:assert');

const { classifyGhError } = require('../../main/util/gh-error');

test('classifies a REST 503 as an outage, not a network fault', () => {
  // Verbatim stderr from `gh api repos/o/r/pulls/27` during the 2026-07-16
  // "Degraded REST API Availability" incident.
  const cls = classifyGhError('gh: HTTP 503');

  assert.equal(cls.kind, 'outage');
  assert.equal(cls.retryable, true);
  assert.match(cls.summary, /isn't your connection or your login/i);
});

test("an outage carrying gh's re-auth hint is not classified as auth", () => {
  // The regression this ordering exists to prevent: gh staples its own
  // "run: gh auth login" hint onto failures it blames on the token, and during
  // an outage it blames the token. The auth branch would match that phrase and
  // demand a login that cannot help.
  const raw = [
    'gh: HTTP 503',
    'The token in keyring is invalid.',
    'To re-authenticate, run: gh auth login -h github.com',
  ].join('\n');

  const cls = classifyGhError(raw);

  assert.equal(cls.kind, 'outage', 'a 5xx must outrank the auth hint text');
  assert.notEqual(cls.fix, 'gh auth login');
});

test('still classifies a real 401 as auth', () => {
  const cls = classifyGhError('gh: HTTP 401: Bad credentials');

  assert.equal(cls.kind, 'auth');
  assert.equal(cls.fix, 'gh auth login');
});

test('other 5xx codes are outages too', () => {
  for (const raw of ['gh: HTTP 500', 'gh: HTTP 502 Bad Gateway', 'gh: HTTP 504']) {
    assert.equal(classifyGhError(raw).kind, 'outage', raw);
  }
});

test('the unicorn error page is an outage', () => {
  // GitHub serves an HTML "Unicorn!" page for 5xx; the body has no status code
  // in it, so the page itself has to be recognisable.
  const cls = classifyGhError('<!DOCTYPE html><title>Unicorn! &middot; GitHub</title>');

  assert.equal(cls.kind, 'outage');
});

test('genuine network faults stay network, not outage', () => {
  for (const raw of ['getaddrinfo ENOTFOUND api.github.com', 'socket hang up', 'ETIMEDOUT']) {
    assert.equal(classifyGhError(raw).kind, 'network', raw);
  }
});

test('SSO and scope errors are unaffected by the outage branch', () => {
  assert.equal(classifyGhError('SAML enforcement').kind, 'sso');
  assert.equal(classifyGhError('missing required scopes').kind, 'scope');
});

// --- an env token overrides the signed-in account -------------------------

function withEnv(vars, fn) {
  const saved = {};
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// The reported bug: a PAT's 404 was blamed on the account, advising `gh auth
// switch`, which gh ignores while GH_TOKEN is set.
test('a 404 under GH_TOKEN blames the token, not the account', () => {
  const cls = withEnv({ GH_TOKEN: 'github_pat_11ABCDEF' }, () => classifyGhError(
    "GraphQL: Could not resolve to a Repository with the name 'steph-dove/interview-train'. (repository)",
    { target: 'steph-dove/interview-train' },
  ));

  assert.strictEqual(cls.kind, 'not-found');
  assert.match(cls.summary, /\$GH_TOKEN/);
  assert.match(cls.summary, /fine-grained PAT/);
  assert.match(cls.summary, /switching accounts won't help/);
  assert.match(cls.fix, /unset GH_TOKEN/);
  // The advice that cannot work must not be offered.
  assert.doesNotMatch(cls.fix, /gh auth switch/);
  assert.doesNotMatch(cls.summary, /wrong gh account/);
});

test("a 403 naming the PAT is classified the same way", () => {
  const cls = withEnv({ GH_TOKEN: 'github_pat_11ABCDEF' }, () => classifyGhError(
    'GraphQL: Resource not accessible by personal access token (createPullRequest)',
    { target: 'steph-dove/klaussy-agents' },
  ));

  assert.strictEqual(cls.kind, 'not-found');
  assert.match(cls.fix, /unset GH_TOKEN/);
});

test('GITHUB_TOKEN is honoured the same as GH_TOKEN', () => {
  const cls = withEnv({ GITHUB_TOKEN: 'ghp_classic' }, () => classifyGhError(
    'gh: HTTP 404', { target: 'o/r' },
  ));

  assert.match(cls.summary, /\$GITHUB_TOKEN/);
  assert.match(cls.fix, /unset GITHUB_TOKEN/);
  // A classic token has no repository allow-list, so don't claim it does.
  assert.doesNotMatch(cls.summary, /fine-grained/);
  assert.match(cls.fix, /reissue the token/);
});

test('with no env token the account advice is unchanged', () => {
  const cls = withEnv({}, () => classifyGhError('gh: HTTP 404', { target: 'o/r' }));

  assert.strictEqual(cls.kind, 'not-found');
  assert.match(cls.summary, /for the signed-in account/);
  assert.doesNotMatch(cls.summary, /GH_TOKEN/);
});
