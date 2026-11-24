require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const { moveOffLegacyTools } = require('../../main/state/repo-intel');

// The old and new PyPI names ship the same files, so the old package has to be
// uninstalled before the new one goes in. These run against a fake exec that
// records every call and answers from a tiny model of the machine.
function machine({ pipx = [], uv = [], pip = [], fail = () => false } = {}) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const line = [cmd, ...args].join(' ');
    if (fail(line)) {
      const err = new Error(`failed: ${line}`);
      err.stderr = fail(line) === 'pep668' ? 'error: externally-managed-environment' : '';
      throw err;
    }
    if (line === 'pipx list --short') return { stdout: pipx.map((p) => `${p} 1.0.0`).join('\n') };
    if (line === 'uv tool list') return { stdout: uv.map((p) => `${p} v1.0.0`).join('\n') };
    if (cmd === 'python3' && args[2] === 'show') {
      if (pip.includes(args[3])) return { stdout: '' };
      throw new Error('not installed');
    }
    return { stdout: '' };
  };
  return { exec, calls };
}
const PY = [{ py: 'python3', pyArgs: [] }];
const noRefresh = () => {};

test('pipx: uninstalls each old package before installing its new name', async () => {
  const m = machine({ pipx: ['klaussy-agents', 'klaussy-repo-conventions'] });
  const moved = await moveOffLegacyTools({ exec: m.exec, candidates: PY, refreshPath: noRefresh });
  assert.deepEqual(moved, ['maussian-repo-conventions', 'mauss']);
  const order = m.calls.filter((c) => c.startsWith('pipx ') && !c.includes('list'));
  assert.deepEqual(order, [
    'pipx uninstall klaussy-repo-conventions',
    'pipx install maussian-repo-conventions',
    'pipx uninstall klaussy-agents',
    'pipx install mauss',
  ]);
});

test('uv: uses uv tool for a uv-owned old package', async () => {
  const m = machine({ uv: ['klaussy-agents'] });
  assert.deepEqual(await moveOffLegacyTools({ exec: m.exec, candidates: PY, refreshPath: noRefresh }), ['mauss']);
  assert.ok(m.calls.indexOf('uv tool uninstall klaussy-agents') < m.calls.indexOf('uv tool install mauss'));
  assert.ok(m.calls.includes('uv tool install mauss'));
});

test('pip --user: uninstalls then installs, retrying with the PEP 668 escape hatch', async () => {
  const m = machine({
    pip: ['klaussy-agents'],
    fail: (line) => (line === 'python3 -m pip install --user mauss' ? 'pep668' : false),
  });
  assert.deepEqual(await moveOffLegacyTools({ exec: m.exec, candidates: PY, refreshPath: noRefresh }), ['mauss']);
  assert.ok(m.calls.includes('python3 -m pip uninstall -y klaussy-agents'));
  assert.ok(m.calls.includes('python3 -m pip install --user mauss --break-system-packages'));
});

test('a machine on the new names is left alone', async () => {
  const m = machine({ pipx: ['mauss', 'maussian-repo-conventions'] });
  assert.deepEqual(await moveOffLegacyTools({ exec: m.exec, candidates: PY, refreshPath: noRefresh }), []);
  assert.ok(!m.calls.some((c) => / (un)?install /.test(c)));
});

test('a failed move is reported, not thrown, and the other tool still moves', async () => {
  const m = machine({
    pipx: ['klaussy-agents', 'klaussy-repo-conventions'],
    fail: (line) => line === 'pipx install maussian-repo-conventions',
  });
  assert.deepEqual(await moveOffLegacyTools({ exec: m.exec, candidates: PY, refreshPath: noRefresh }), ['mauss']);
});

test('uv: a failed install puts the old package back', async () => {
  const m = machine({
    uv: ['klaussy-repo-conventions'],
    fail: (line) => line === 'uv tool install maussian-repo-conventions',
  });
  assert.deepEqual(await moveOffLegacyTools({ exec: m.exec, candidates: PY, refreshPath: noRefresh }), []);
  const order = m.calls.filter((c) => c.startsWith('uv tool ') && !c.includes('list'));
  assert.deepEqual(order, [
    'uv tool uninstall klaussy-repo-conventions',
    'uv tool install maussian-repo-conventions',
    'uv tool install klaussy-repo-conventions',
  ]);
});

test('pipx: a failed install puts the old package back', async () => {
  const m = machine({ pipx: ['klaussy-agents'], fail: (line) => line === 'pipx install mauss' });
  assert.deepEqual(await moveOffLegacyTools({ exec: m.exec, candidates: PY, refreshPath: noRefresh }), []);
  assert.equal(m.calls.at(-1), 'pipx install klaussy-agents');
});

test('pip --user: a failed install puts the old package back', async () => {
  const m = machine({
    pip: ['klaussy-agents'],
    fail: (line) => line === 'python3 -m pip install --user mauss',
  });
  assert.deepEqual(await moveOffLegacyTools({ exec: m.exec, candidates: PY, refreshPath: noRefresh }), []);
  assert.equal(m.calls.at(-1), 'python3 -m pip install --user klaussy-agents');
});

test('a failed restore is logged and does not throw', async () => {
  const m = machine({ pipx: ['klaussy-agents'], fail: (line) => line.startsWith('pipx install') });
  assert.deepEqual(await moveOffLegacyTools({ exec: m.exec, candidates: PY, refreshPath: noRefresh }), []);
  assert.ok(m.calls.includes('pipx install klaussy-agents'));
});
