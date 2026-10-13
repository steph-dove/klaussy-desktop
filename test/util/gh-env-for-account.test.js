require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');

const calls = [];
childProcess.execFileSync = (cmd, args) => {
  calls.push([cmd, ...args]);
  return Buffer.from('tok-' + args[args.length - 1]);
};
const { ghEnvForAccount } = require('../../main/util/exec');

test('ghEnvForAccount accepts the picker\'s "github:<user>" account id', () => {
  const env = ghEnvForAccount('github:steph-dove');
  assert.deepEqual(env, { GH_TOKEN: 'tok-steph-dove' });
  assert.deepEqual(calls.at(-1), ['gh', 'auth', 'token', '--user', 'steph-dove']);
});

test('ghEnvForAccount still accepts a bare username', () => {
  assert.deepEqual(ghEnvForAccount('other-user'), { GH_TOKEN: 'tok-other-user' });
});

test('ghEnvForAccount ignores GitLab and Bitbucket account ids', () => {
  const before = calls.length;
  assert.deepEqual(ghEnvForAccount('gitlab:gitlab.com:me'), {});
  assert.deepEqual(ghEnvForAccount('bitbucket:bitbucket.org:me'), {});
  assert.equal(calls.length, before);
});
