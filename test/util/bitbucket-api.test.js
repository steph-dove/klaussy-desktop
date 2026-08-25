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
