'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gitBinToProbe, gitInstallCommand } = require('../../main/util/git-check');

const has = (...paths) => (p) => paths.includes(p);

test('macOS with Command Line Tools probes plain git', () => {
  assert.equal(gitBinToProbe({ platform: 'darwin', devToolsInstalled: true, envPath: '/usr/bin' }), 'git');
});

test('macOS without Command Line Tools never probes the /usr/bin stub', () => {
  const r = gitBinToProbe({ platform: 'darwin', devToolsInstalled: false, envPath: '/usr/bin:/bin', exists: has('/usr/bin/git') });
  assert.equal(r, null);
});

test('macOS without Command Line Tools still finds a Homebrew git', () => {
  const r = gitBinToProbe({
    platform: 'darwin',
    devToolsInstalled: false,
    envPath: '/usr/bin:/opt/homebrew/bin',
    exists: has('/usr/bin/git', '/opt/homebrew/bin/git'),
  });
  assert.equal(r, '/opt/homebrew/bin/git');
});

test('other platforms always probe plain git', () => {
  assert.equal(gitBinToProbe({ platform: 'linux', devToolsInstalled: null, envPath: '' }), 'git');
  assert.equal(gitBinToProbe({ platform: 'win32', devToolsInstalled: null, envPath: '' }), 'git');
});

test('install command matches the platform', () => {
  assert.equal(gitInstallCommand('darwin'), 'xcode-select --install');
  assert.equal(gitInstallCommand('win32'), 'winget install --id Git.Git -e');
  assert.equal(gitInstallCommand('linux'), 'sudo apt install git');
});
