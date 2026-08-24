const test = require('node:test');
const assert = require('node:assert/strict');

const { parseGlabAuthStatus } = require('../../main/ipc/glab');

test('parseGlabAuthStatus parses multi-host and multi-account output', () => {
  const sample = `
gitlab.com
  ✓ Logged in to gitlab.com as stephanie (/Users/stephaniedover/.config/glab-cli/config.yml)
  ✓ Active account: true
  - Git operations protocol: https
  - API endpoint: https://gitlab.com/api/v4

gitlab.example.corp
  ✓ Logged in to gitlab.example.corp as sdover (/Users/stephaniedover/.config/glab-cli/config.yml)
  - Active account: false
`;

  const accounts = parseGlabAuthStatus(sample);
  assert.equal(accounts.length, 2);

  assert.deepEqual(accounts[0], {
    username: 'stephanie',
    hostname: 'gitlab.com',
    active: true,
    valid: true,
    reason: null,
  });

  assert.deepEqual(accounts[1], {
    username: 'sdover',
    hostname: 'gitlab.example.corp',
    active: false,
    valid: true,
    reason: null,
  });
});

test('parseGlabAuthStatus detects invalid or expired token lines', () => {
  const sample = `
gitlab.com
  X Failed to log in to gitlab.com as olduser
  - The token in keyring is invalid.
`;

  const accounts = parseGlabAuthStatus(sample);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].username, 'olduser');
  assert.equal(accounts[0].valid, false);
  assert.equal(accounts[0].reason, 'Token is invalid');
});
