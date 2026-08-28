require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const { qaMediaUrl, SCHEME } = require('../../main/bootstrap/qa-media-protocol');

// What the protocol handler does with an incoming request URL.
function decode(url) {
  const encoded = new URL(url).pathname.replace(/^\//, '');
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

test('a minted URL round-trips back to the original path', () => {
  const p = '/Users/someone/Downloads/repo-branch/01-login.png';
  assert.equal(decode(qaMediaUrl(p)), p);
});

test('paths that would break a hand-built file: URL survive', () => {
  for (const p of [
    '/Users/a b/Downloads/my repo-my branch/before & after.png',
    '/Users/a/Downloads/repo/shot#1?v=2.png',
    '/Users/a/Downloads/repo/café-скриншот.png',
  ]) {
    assert.equal(decode(qaMediaUrl(p)), p, p);
  }
});

test('a minted URL uses the dedicated scheme the CSP allows', () => {
  const url = qaMediaUrl('/tmp/x.png');
  assert.ok(url.startsWith(SCHEME + '://'), url);
  assert.equal(SCHEME, 'klaussy-qa');
});

test('an empty path mints nothing rather than a servable URL', () => {
  assert.equal(qaMediaUrl(''), '');
  assert.equal(qaMediaUrl(null), '');
});
