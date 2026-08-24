const test = require('node:test');
const assert = require('node:assert/strict');

const {
  glabEnvForRepo,
  glabEnvForAccount,
  resolveGlabEnv,
  clearGlabTokenCache,
} = require('../../main/util/glab-exec');

test('resolveGlabEnv returns empty object when no account or cwd provided', () => {
  clearGlabTokenCache();
  const env = resolveGlabEnv();
  assert.deepEqual(env, {});
});

test('glabEnvForAccount returns empty when no account passed', () => {
  assert.deepEqual(glabEnvForAccount(null), {});
  assert.deepEqual(glabEnvForAccount(''), {});
});

test('glabEnvForRepo returns empty for non-existent or non-gitlab repo', () => {
  assert.deepEqual(glabEnvForRepo('/non/existent/path'), {});
});
