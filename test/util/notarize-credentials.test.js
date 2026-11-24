require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const { notaryCredentials } = require('../../build/notarize');

const VARS = { APPLE_ID: 'me@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'pw', APPLE_TEAM_ID: 'TEAM' };

function run(env) {
  const lines = [];
  const result = notaryCredentials(env, (line) => lines.push(line));
  return { result, lines };
}

test('a keychain profile on its own is used', () => {
  const { result, lines } = run({ APPLE_KEYCHAIN_PROFILE: 'maussian-notary' });
  assert.deepEqual(result, { keychainProfile: 'maussian-notary' });
  assert.match(lines[0], /keychain profile maussian-notary/);
});

test('the three variables are used when there is no profile', () => {
  const { result, lines } = run(VARS);
  assert.deepEqual(result, { appleId: 'me@example.com', appleIdPassword: 'pw', teamId: 'TEAM' });
  assert.match(lines[0], /APPLE_ID/);
});

test('a profile wins over the variables and says it is ignoring them', () => {
  const { result, lines } = run({ ...VARS, APPLE_KEYCHAIN_PROFILE: 'maussian-notary' });
  assert.deepEqual(result, { keychainProfile: 'maussian-notary' });
  assert.match(lines[1], /ignoring APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID/);
});

test('only some of the variables is an error naming the missing ones', () => {
  assert.throws(() => run({ APPLE_ID: 'me@example.com' }), /APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID missing/);
});

test('nothing set skips notarization', () => {
  const { result, lines } = run({});
  assert.equal(result, null);
  assert.deepEqual(lines, []);
});
