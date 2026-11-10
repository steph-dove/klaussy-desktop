const { fakeSafeStorage } = require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const secretStore = require('../../main/util/secret-store');

function withPlatform(platform, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', desc); }
}

test.afterEach(() => {
  fakeSafeStorage.available = true;
  fakeSafeStorage.backend = 'gnome_libsecret';
});

test('encrypt and decrypt round-trip, and the stored form is not the secret', () => {
  const stored = secretStore.encrypt('pat-value-123');
  assert.ok(!stored.includes('pat-value-123'));
  assert.equal(secretStore.decrypt(stored), 'pat-value-123');
});

test('encrypt refuses when encryption is unavailable', () => {
  fakeSafeStorage.available = false;
  assert.equal(secretStore.available(), false);
  assert.throws(() => secretStore.encrypt('x'), (err) => err.kind === 'unavailable');
});

test('the Linux basic_text backend counts as unavailable', () => {
  fakeSafeStorage.backend = 'basic_text';
  withPlatform('linux', () => {
    assert.equal(secretStore.available(), false);
    assert.throws(() => secretStore.encrypt('x'), (err) => err.kind === 'unavailable');
  });
});

test('a value that cannot be decrypted becomes an undecryptable error', () => {
  const garbage = Buffer.from('not-ours').toString('base64');
  assert.throws(() => secretStore.decrypt(garbage), (err) => err.kind === 'undecryptable');
  assert.throws(() => secretStore.decrypt(''), (err) => err.kind === 'missing');
});
