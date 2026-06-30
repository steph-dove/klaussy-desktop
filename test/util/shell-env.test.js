require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { detectShellProfile, exportLine } = require('../../main/util/shell-env');

test('detectShellProfile maps each shell to its rc file + syntax', () => {
  const zsh = detectShellProfile({ platform: 'darwin', shell: '/bin/zsh', home: '/h' });
  assert.equal(zsh.shell, 'zsh');
  assert.equal(zsh.profilePath, path.join('/h', '.zshrc'));
  assert.equal(zsh.syntax, 'posix');

  const bashMac = detectShellProfile({ platform: 'darwin', shell: '/bin/bash', home: '/h' });
  assert.equal(bashMac.profilePath, path.join('/h', '.bash_profile'));

  const bashLinux = detectShellProfile({ platform: 'linux', shell: '/usr/bin/bash', home: '/h' });
  assert.equal(bashLinux.profilePath, path.join('/h', '.bashrc'));

  const fish = detectShellProfile({ platform: 'linux', shell: '/usr/bin/fish', home: '/h' });
  assert.equal(fish.syntax, 'fish');
  assert.equal(fish.profilePath, path.join('/h', '.config', 'fish', 'config.fish'));
});

test('detectShellProfile defaults to zsh when shell is unknown', () => {
  const r = detectShellProfile({ platform: 'darwin', shell: undefined, home: '/h' });
  assert.equal(r.shell, 'zsh');
});

test('detectShellProfile on Windows has no rc file', () => {
  const r = detectShellProfile({ platform: 'win32', home: 'C:\\Users\\me' });
  assert.equal(r.profilePath, null);
  assert.equal(r.syntax, 'powershell');
});

test('exportLine renders per-shell syntax and never embeds a real value', () => {
  assert.equal(exportLine('posix', 'DD_API_KEY', 'xxx'), 'export DD_API_KEY="xxx"');
  assert.equal(exportLine('fish', 'DD_API_KEY', 'xxx'), 'set -Ux DD_API_KEY "xxx"');
  assert.match(exportLine('powershell', 'DD_API_KEY', 'xxx'), /SetEnvironmentVariable\("DD_API_KEY", "xxx", "User"\)/);
  // Falls back to a generated placeholder, not a blank value.
  assert.equal(exportLine('posix', 'GRAFANA_URL'), 'export GRAFANA_URL="your-grafana-url"');
});
