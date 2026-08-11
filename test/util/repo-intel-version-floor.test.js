require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  versionBelow, latestKlaussyVersion, _resetLatestCache,
} = require('../../main/state/repo-intel');

function stubFetch(handler) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => { calls.push(String(url)); return handler(String(url), init); };
  return { calls, restore() { global.fetch = real; } };
}

const okJson = (obj) => ({ ok: true, status: 200, json: async () => obj });

// versionBelow gates the "out of date" prompt: parse a triple from whatever
// `klaussy --version` prints, compare per-component (not lexically), and stay
// silent on unparseable input so a weird version string never nags forever

test('versionBelow: strictly-older version is below the floor', () => {
  assert.equal(versionBelow('0.14.9', '0.15.0'), true);
  assert.equal(versionBelow('0.14.0', '0.15.0'), true);
  assert.equal(versionBelow('0.0.1', '0.15.0'), true);
});

test('versionBelow: equal or newer version is NOT below the floor', () => {
  assert.equal(versionBelow('0.15.0', '0.15.0'), false);
  assert.equal(versionBelow('0.15.1', '0.15.0'), false);
  assert.equal(versionBelow('1.0.0', '0.15.0'), false);
});

test('versionBelow: numeric (not lexical) component comparison', () => {
  // Numerically 0.9.0 < 0.15.0 (minor 9 < 15), so it IS below the floor — a
  // naive lexical compare would wrongly say "0.9.0" > "0.15.0" ('9' > '1').
  assert.equal(versionBelow('0.9.0', '0.15.0'), true);
  // ...and 0.15.0 is not below 0.9.0 for the same reason.
  assert.equal(versionBelow('0.15.0', '0.9.0'), false);
});

test('versionBelow: parses a version out of a decorated --version string', () => {
  assert.equal(versionBelow('klaussy, version 0.14.0', '0.15.0'), true);
  assert.equal(versionBelow('klaussy-agents 0.15.0', '0.15.0'), false);
});

test('versionBelow: unparseable input is never "below" (no false nag)', () => {
  assert.equal(versionBelow('', '0.15.0'), false);
  assert.equal(versionBelow(null, '0.15.0'), false);
  assert.equal(versionBelow('dev', '0.15.0'), false);
  assert.equal(versionBelow('0.15.0', 'not-a-version'), false);
});

test('the latest version comes from what PyPI publishes', async () => {
  _resetLatestCache();
  const f = stubFetch(() => okJson({ info: { version: '0.27.0' } }));
  try {
    assert.equal(await latestKlaussyVersion(), '0.27.0');
    assert.equal(versionBelow('0.19.2', '0.27.0'), true, 'the old floor is itself behind');
  } finally {
    f.restore();
  }
});

test('the answer is cached rather than asked on every check', async () => {
  _resetLatestCache();
  const f = stubFetch(() => okJson({ info: { version: '0.27.0' } }));
  try {
    await latestKlaussyVersion();
    await latestKlaussyVersion();
    assert.equal(f.calls.length, 1, 'PyPI is asked once, not once per caller');
  } finally {
    f.restore();
  }
});

test('an unreachable or unhelpful PyPI yields no version, and no nag', async () => {
  const cases = [
    ['network down', () => { throw new Error('getaddrinfo ENOTFOUND pypi.org'); }],
    ['http error', () => ({ ok: false, status: 503, json: async () => ({}) })],
    ['no version in payload', () => okJson({ info: {} })],
    ['malformed body', () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })],
  ];
  for (const [name, handler] of cases) {
    _resetLatestCache();
    const f = stubFetch(handler);
    try {
      const latest = await latestKlaussyVersion();
      assert.equal(latest, '', name + ' yields no version');
      assert.equal(versionBelow('0.1.0', latest), false, name + ' cannot convict an install');
    } finally {
      f.restore();
    }
  }
});

test('a failed lookup is not cached as the answer', async () => {
  _resetLatestCache();
  const down = stubFetch(() => { throw new Error('offline'); });
  try {
    assert.equal(await latestKlaussyVersion(), '');
  } finally {
    down.restore();
  }
  const back = stubFetch(() => okJson({ info: { version: '0.27.0' } }));
  try {
    assert.equal(await latestKlaussyVersion(), '0.27.0', 'the next check asks again');
  } finally {
    back.restore();
  }
});
