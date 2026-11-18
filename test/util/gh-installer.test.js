require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  installerAgentsInfo,
  installScriptMac,
  installScriptWin,
  installScriptLinux,
  ghLoginScripts,
  GH_HOSTNAME_RE,
} = require('../../main/ipc/gh');

test('only the ticked agents are installed, unknown ids are dropped', () => {
  const names = installerAgentsInfo(['claude', 'codex', 'not-an-agent']).map((a) => a.bin);
  assert.deepEqual(names.sort(), ['claude', 'codex']);
});

test('no selection installs no agents', () => {
  assert.deepEqual(installerAgentsInfo([]), []);
  assert.deepEqual(installerAgentsInfo(undefined), []);
});

test('the Mac script installs the Command Line Tools first and bails if the installer closes', () => {
  const script = installScriptMac([]);
  assert.match(script, /none selected/);
  const clt = script.indexOf('xcode-select --install');
  assert.ok(clt > 0 && clt < script.indexOf('brew install'));
  assert.match(script, /pgrep -f "Install Command Line Developer Tools"/);
});

test('generated bash scripts parse', { skip: process.platform === 'win32' && 'no bash' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-installer-'));
  const agents = installerAgentsInfo(['claude']);
  for (const [name, body] of [
    ['mac', installScriptMac(agents)],
    ['linux', installScriptLinux(agents)],
    ['login', ghLoginScripts('github.com').mac],
  ]) {
    const file = path.join(dir, `${name}.sh`);
    fs.writeFileSync(file, body);
    execFileSync('bash', ['-n', file]);
  }
});

test('Windows and Linux scripts install git', () => {
  assert.match(installScriptWin([]), /winget install --id Git\.Git/);
  assert.match(installScriptLinux([]), /apt install -y git /);
});

test('hostnames with shell metacharacters are rejected', () => {
  assert.ok(GH_HOSTNAME_RE.test('github.com'));
  assert.ok(GH_HOSTNAME_RE.test('ghe.example.com:8443'));
  for (const bad of ['github.com; rm -rf ~', "x'y", '$(id)', 'a b', '']) {
    assert.equal(GH_HOSTNAME_RE.test(bad), false, bad);
  }
});
