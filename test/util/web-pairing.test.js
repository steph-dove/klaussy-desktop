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
