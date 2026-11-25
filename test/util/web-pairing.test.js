require('../setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pairing = require('../../main/util/web-pairing');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'maussian-pairing-'));

// What a browser's WebCrypto key looks like from the helper's side.
function browserKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const sign = (text) => crypto.sign('sha256', Buffer.from(text), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { jwk, sign };
}

test('a pairing code works once, and only before it expires', () => {
  const dir = tmpDir();
  const now = 1_000_000;
  const code = pairing.mintPairCode(dir, now);
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pairing.consumePairCode(dir, code, now + 1000), true);
  assert.equal(pairing.consumePairCode(dir, code, now + 2000), false); // single use

  const late = pairing.mintPairCode(dir, now);
  assert.equal(pairing.consumePairCode(dir, late, now + pairing.PAIR_CODE_TTL_MS + 1), false);
});

test('a wrong or malformed code is refused, and codes are stored hashed', () => {
  const dir = tmpDir();
  const code = pairing.mintPairCode(dir);
  assert.equal(pairing.consumePairCode(dir, 'x'.repeat(43)), false);
  assert.equal(pairing.consumePairCode(dir, undefined), false);
  assert.equal(pairing.consumePairCode(dir, { code }), false);
  assert.ok(!fs.readFileSync(path.join(dir, pairing.CODES_FILE), 'utf8').includes(code));
  assert.equal(fs.statSync(path.join(dir, pairing.CODES_FILE)).mode & 0o777, 0o600);
});

test('a paired browser signs a challenge with its key; anything else fails', () => {
  const dir = tmpDir();
  const key = browserKey();
  const { browserId } = pairing.pairBrowser(dir, pairing.mintPairCode(dir), key.jwk, 'Chrome on macOS');
  const browser = pairing.findBrowser(dir, browserId);
  assert.equal(browser.label, 'Chrome on macOS');
  assert.equal(pairing.verifyChallenge(browser.jwk, 'challenge-1', key.sign('challenge-1')), true);
  assert.equal(pairing.verifyChallenge(browser.jwk, 'challenge-2', key.sign('challenge-1')), false);
  assert.equal(pairing.verifyChallenge(browser.jwk, 'challenge-1', browserKey().sign('challenge-1')), false);
  assert.equal(pairing.verifyChallenge(browser.jwk, 'challenge-1', 'not a signature'), false);
});

test('only a public P-256 key pairs, and a bad one leaves the code unspent', () => {
  const dir = tmpDir();
  const code = pairing.mintPairCode(dir);
  const { jwk } = browserKey();
  for (const bad of [{ ...jwk, crv: 'P-384' }, { ...jwk, d: 'private-part' }, { kty: 'EC', crv: 'P-256', x: 'no', y: 'no' }, null]) {
    assert.deepEqual(pairing.pairBrowser(dir, code, bad), { error: 'bad-key' });
  }
  const r = pairing.pairBrowser(dir, code, { ...jwk, extra: 'dropped' });
  assert.match(r.browserId, /^[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(pairing.findBrowser(dir, r.browserId).jwk).sort(), ['crv', 'kty', 'x', 'y']);
  assert.deepEqual(pairing.pairBrowser(dir, code, browserKey().jwk), { error: 'bad-code' }); // spent now
});

test('when full, pairing is refused (no one is evicted) and the code stays good', () => {
  const dir = tmpDir();
  for (let i = 0; i < pairing.MAX_BROWSERS; i++) pairing.pairBrowser(dir, pairing.mintPairCode(dir), browserKey().jwk);
  const first = pairing.listBrowsers(dir)[0].id;
  const code = pairing.mintPairCode(dir);
  assert.deepEqual(pairing.pairBrowser(dir, code, browserKey().jwk), { error: 'full' });
  assert.ok(pairing.findBrowser(dir, first));
  assert.equal(pairing.consumePairCode(dir, code), true);
});

test('only the newest few codes stay live', () => {
  const dir = tmpDir();
  const codes = Array.from({ length: pairing.MAX_PENDING_CODES + 2 }, () => pairing.mintPairCode(dir));
  assert.equal(pairing.consumePairCode(dir, codes[0]), false);
  assert.equal(pairing.consumePairCode(dir, codes[1]), false);
  assert.equal(pairing.consumePairCode(dir, codes.at(-1)), true);
});

test('a lock left by a crashed process is taken over, and none is left behind', () => {
  const dir = tmpDir();
  const lock = path.join(dir, pairing.LOCK_FILE);
  fs.writeFileSync(lock, '999999');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.equal(pairing.consumePairCode(dir, pairing.mintPairCode(dir)), true);
  assert.equal(fs.existsSync(lock), false);
});

test('a sign-in is recorded on the browser', () => {
  const dir = tmpDir();
  const { browserId } = pairing.pairBrowser(dir, pairing.mintPairCode(dir), browserKey().jwk);
  assert.equal(pairing.findBrowser(dir, browserId).lastSignIn, undefined);
  assert.equal(pairing.touchBrowser(dir, browserId, Date.UTC(2026, 10, 24, 12)), true);
  assert.equal(pairing.findBrowser(dir, browserId).lastSignIn, '2026-11-24T12:00:00.000Z');
  assert.equal(pairing.touchBrowser(dir, 'gone'), false);
});

test('one browser can be forgotten by its id or a unique prefix', () => {
  const dir = tmpDir();
  const a = pairing.pairBrowser(dir, pairing.mintPairCode(dir), browserKey().jwk, 'A').browserId;
  const b = pairing.pairBrowser(dir, pairing.mintPairCode(dir), browserKey().jwk, 'B').browserId;
  assert.deepEqual(pairing.removeBrowser(dir, 'ab'), { error: 'too-short' });
  assert.deepEqual(pairing.removeBrowser(dir, 'zzzzzzzz'), { error: 'not-found' });
  assert.equal(pairing.removeBrowser(dir, a.slice(0, 8).toUpperCase()).removed.label, 'A');
  assert.equal(pairing.findBrowser(dir, a), null);
  assert.ok(pairing.findBrowser(dir, b));
});

test('labels lose control characters, so they can\u2019t forge rows or rewrite the terminal', () => {
  assert.equal(pairing.cleanLabel('Chrome\nb00000000  Fake row'), 'Chrome b00000000 Fake row');
  assert.equal(pairing.cleanLabel('A\u001b[2J\u001b[HB'), 'A [2J [HB');
  assert.equal(pairing.cleanLabel('x'.repeat(500)).length, 120);
  assert.equal(pairing.cleanLabel(undefined), '');
  const dir = tmpDir();
  const { browserId } = pairing.pairBrowser(dir, pairing.mintPairCode(dir), browserKey().jwk, 'Line one\r\nLine two');
  assert.equal(pairing.findBrowser(dir, browserId).label, 'Line one Line two');
});

test('a sign-in is recorded at most every few minutes, and not for a forgotten browser', () => {
  const dir = tmpDir();
  const { browserId } = pairing.pairBrowser(dir, pairing.mintPairCode(dir), browserKey().jwk);
  const t0 = Date.UTC(2026, 10, 25, 9);
  pairing.touchBrowser(dir, browserId, t0);
  pairing.touchBrowser(dir, browserId, t0 + 60 * 1000);
  assert.equal(pairing.findBrowser(dir, browserId).lastSignIn, new Date(t0).toISOString());
  pairing.touchBrowser(dir, browserId, t0 + pairing.SIGN_IN_RECORD_MS + 1);
  assert.equal(pairing.findBrowser(dir, browserId).lastSignIn, new Date(t0 + pairing.SIGN_IN_RECORD_MS + 1).toISOString());
  pairing.removeBrowser(dir, browserId);
  assert.equal(pairing.touchBrowser(dir, browserId), false);
});

test('a full id wins over prefixes, and odd input is refused clearly', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, pairing.BROWSERS_FILE), JSON.stringify([
    { id: 'abcd', jwk: {}, label: 'short' }, { id: 'abcd5678', jwk: {}, label: 'long' },
  ]));
  assert.equal(pairing.removeBrowser(dir, 'abcd').removed.label, 'short');
  assert.deepEqual(pairing.listBrowsers(dir).map((b) => b.id), ['abcd5678']);
  assert.ok(!fs.readFileSync(path.join(dir, pairing.BROWSERS_FILE), 'utf8').includes('"short"'));
  for (const bad of [undefined, null, 42, '', '   ']) assert.deepEqual(pairing.removeBrowser(dir, bad), { error: 'missing' });
  assert.deepEqual(pairing.removeBrowser(dir, ' ab '), { error: 'too-short' });
});

test('an ambiguous prefix forgets nothing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, pairing.BROWSERS_FILE), JSON.stringify([
    { id: 'abcd1111', jwk: {}, label: 'one' }, { id: 'abcd2222', jwk: {}, label: 'two' },
  ]));
  assert.deepEqual(pairing.removeBrowser(dir, 'abcd'), { error: 'ambiguous' });
  assert.equal(pairing.listBrowsers(dir).length, 2);
});

test('unpairing forgets every browser and every pending code', () => {
  const dir = tmpDir();
  pairing.pairBrowser(dir, pairing.mintPairCode(dir), browserKey().jwk);
  pairing.pairBrowser(dir, pairing.mintPairCode(dir), browserKey().jwk);
  const code = pairing.mintPairCode(dir);
  assert.equal(pairing.removeAllBrowsers(dir), 2);
  assert.deepEqual(pairing.listBrowsers(dir), []);
  assert.equal(pairing.consumePairCode(dir, code), false);
  assert.equal(pairing.findBrowser(dir, 'anything'), null);
});
