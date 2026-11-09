require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  getBitbucketAuth,
  resolveBitbucketEnv,
  listBitbucketAccounts,
  switchBitbucketAccount,
  saveBitbucketAccount,
  removeBitbucketAccount,
  clearBitbucketAuthCache,
  resolveEmailIfApiToken,
} = require('../../main/util/bitbucket-api');
const { loadConfig, saveConfig, flushSaveConfig } = require('../../main/util/config');

test.beforeEach(() => {
  clearBitbucketAuthCache();
});

test('saveBitbucketAccount saves new account and activates it', async () => {
  const initialConfig = loadConfig();
  try {
    saveBitbucketAccount({
      username: 'testuser',
      appPassword: 'secretapppassword',
      hostname: 'bitbucket.org',
      active: true,
    });
    await flushSaveConfig();

    const accounts = listBitbucketAccounts();
    const found = accounts.find((a) => a.username === 'testuser');
    assert.ok(found);
    assert.equal(found.active, true);
    assert.equal(found.hostname, 'bitbucket.org');

    const auth = getBitbucketAuth({ account: 'testuser' });
    assert.ok(auth);
    assert.equal(auth.username, 'testuser');
    assert.equal(auth.password, 'secretapppassword');
  } finally {
    saveConfig(initialConfig);
    await flushSaveConfig();
    clearBitbucketAuthCache();
  }
});

test('switchBitbucketAccount switches the active account in config', async () => {
  const initialConfig = loadConfig();
  try {
    saveConfig({ bitbucketAccounts: [] });
    await flushSaveConfig();

    saveBitbucketAccount({ username: 'user1', appPassword: 'pw1', active: true });
    await flushSaveConfig();

    saveBitbucketAccount({ username: 'user2', appPassword: 'pw2', active: false });
    await flushSaveConfig();

    switchBitbucketAccount('user2', 'bitbucket.org');
    await flushSaveConfig();

    const accounts = listBitbucketAccounts();
    const u1 = accounts.find((a) => a.username === 'user1');
    const u2 = accounts.find((a) => a.username === 'user2');

    assert.ok(u1);
    assert.ok(u2);
    assert.equal(u1.active, false);
    assert.equal(u2.active, true);
  } finally {
    saveConfig(initialConfig);
    await flushSaveConfig();
    clearBitbucketAuthCache();
  }
});

test('removeBitbucketAccount deletes account and activates remaining if needed', async () => {
  const initialConfig = loadConfig();
  try {
    saveBitbucketAccount({ username: 'deluser', appPassword: 'pw' });
    await flushSaveConfig();

    removeBitbucketAccount('deluser', 'bitbucket.org');
    await flushSaveConfig();

    const accounts = listBitbucketAccounts();
    assert.equal(accounts.some((a) => a.username === 'deluser'), false);
  } finally {
    saveConfig(initialConfig);
    await flushSaveConfig();
    clearBitbucketAuthCache();
  }
});

test('resolveBitbucketEnv returns env vars from active auth', async () => {
  const initialConfig = loadConfig();
  const prevEnv = process.env.BITBUCKET_TOKEN;
  try {
    saveConfig({ bitbucketAccounts: [] });
    await flushSaveConfig();
    process.env.BITBUCKET_TOKEN = 'test-token-123';
    clearBitbucketAuthCache();
    const env = resolveBitbucketEnv();
    assert.equal(env.BITBUCKET_TOKEN, 'test-token-123');
  } finally {
    if (prevEnv !== undefined) process.env.BITBUCKET_TOKEN = prevEnv;
    else delete process.env.BITBUCKET_TOKEN;
    saveConfig(initialConfig);
    await flushSaveConfig();
    clearBitbucketAuthCache();
  }
});

// Runs fn with BITBUCKET_EMAIL set (or unset) and git reading only a temp global
// config, from a cwd outside any repo, so the host's git identity can't leak in.
function withEmailSources({ envEmail, gitEmail }, fn) {
  const keys = ['BITBUCKET_EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CEILING_DIRECTORIES'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const prevCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-email-'));
  const gitConfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(gitConfig, gitEmail ? `[user]\n\temail = ${gitEmail}\n` : '');
  try {
    if (envEmail === undefined) delete process.env.BITBUCKET_EMAIL;
    else process.env.BITBUCKET_EMAIL = envEmail;
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
    process.chdir(dir);
    return fn();
  } finally {
    process.chdir(prevCwd);
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveEmailIfApiToken prefers BITBUCKET_EMAIL for an API token', () => {
  const got = withEmailSources({ envEmail: 'env@example.com', gitEmail: 'git@example.com' },
    () => resolveEmailIfApiToken('someuser', 'ATATT-test'));
  assert.equal(got, 'env@example.com');
});

test('resolveEmailIfApiToken falls back to git user.email', () => {
  const got = withEmailSources({ gitEmail: 'git@example.com' },
    () => resolveEmailIfApiToken('someuser', 'ATATT-test'));
  assert.equal(got, 'git@example.com');
});

test('resolveEmailIfApiToken returns no email when none is configured', () => {
  const withUser = withEmailSources({}, () => resolveEmailIfApiToken('someuser', 'ATATT-test'));
  assert.equal(withUser, 'someuser');
  const noUser = withEmailSources({}, () => resolveEmailIfApiToken(null, 'ATATT-test'));
  assert.equal(noUser, 'x-token-auth');
  assert.ok(!noUser.includes('@'));
});

test('resolveEmailIfApiToken leaves non-API-token usernames alone', () => {
  const got = withEmailSources({ envEmail: 'env@example.com' },
    () => resolveEmailIfApiToken('someuser', 'app-password'));
  assert.equal(got, 'someuser');
});
