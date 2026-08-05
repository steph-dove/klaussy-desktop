const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { globalConfigDir, authFilePath, resolveOpenCodeModel } = require('../../main/state/opencode-config');

// The env vars that steer opencode's config/data dirs, restored after each case
// so one test can't leak a fake HOME into the next.
const STEERING = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA'];

function withEnv(vars, fn) {
  const saved = {};
  for (const k of STEERING) saved[k] = process.env[k];
  try {
    for (const k of STEERING) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    fn();
  } finally {
    for (const k of STEERING) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('XDG_CONFIG_HOME wins for the config dir on every platform', () => {
  withEnv({ XDG_CONFIG_HOME: path.join(os.tmpdir(), 'xdg-cfg') }, () => {
    assert.equal(globalConfigDir(), path.join(os.tmpdir(), 'xdg-cfg', 'opencode'));
  });
});

test('XDG_DATA_HOME wins for the auth store on every platform', () => {
  withEnv({ XDG_DATA_HOME: path.join(os.tmpdir(), 'xdg-data') }, () => {
    assert.equal(authFilePath(), path.join(os.tmpdir(), 'xdg-data', 'opencode', 'auth.json'));
  });
});

test('an empty XDG value is ignored rather than treated as the root', () => {
  withEnv({ XDG_CONFIG_HOME: '   ' }, () => {
    assert.ok(globalConfigDir().endsWith(path.join('opencode')));
    assert.notEqual(globalConfigDir(), path.join('   ', 'opencode'));
  });
});

test('on Windows the config dir comes from APPDATA and the auth store from LOCALAPPDATA', () => {
  withEnv({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, () => {
    assert.equal(globalConfigDir('win32'), path.join('C:\\Users\\x\\AppData\\Roaming', 'opencode'));
    assert.equal(authFilePath('win32'), path.join('C:\\Users\\x\\AppData\\Local', 'opencode', 'auth.json'));
  });
});

test('on Windows XDG still wins when the user has set it', () => {
  withEnv({ XDG_CONFIG_HOME: 'C:\\xdg', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, () => {
    assert.equal(globalConfigDir('win32'), path.join('C:\\xdg', 'opencode'));
  });
});

test('on Windows the auth store falls back to APPDATA when LOCALAPPDATA is absent', () => {
  withEnv({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, () => {
    assert.equal(authFilePath('win32'), path.join('C:\\Users\\x\\AppData\\Roaming', 'opencode', 'auth.json'));
  });
});

test('off Windows, APPDATA never hijacks the POSIX paths', () => {
  withEnv({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, () => {
    assert.equal(globalConfigDir('darwin'), path.join(os.homedir(), '.config', 'opencode'));
    assert.equal(authFilePath('linux'), path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'));
  });
});

test('resolveOpenCodeModel reads the top-level model field, project before global', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-model-'));
  const globalDir = path.join(tmp, 'cfg', 'opencode');
  fs.mkdirSync(globalDir, { recursive: true });
  fs.writeFileSync(path.join(globalDir, 'opencode.jsonc'),
    '{\n  // global default\n  "model": "anthropic/claude-sonnet-4-6"\n}\n', 'utf-8');

  const project = path.join(tmp, 'repo');
  fs.mkdirSync(project, { recursive: true });

  try {
    withEnv({ XDG_CONFIG_HOME: path.join(tmp, 'cfg') }, () => {
      assert.equal(resolveOpenCodeModel(project), 'anthropic/claude-sonnet-4-6',
        'falls back to the global config when the project has none');

      fs.writeFileSync(path.join(project, 'opencode.json'),
        JSON.stringify({ model: 'ollama/qwen3-coder:30b' }), 'utf-8');
      assert.equal(resolveOpenCodeModel(project), 'ollama/qwen3-coder:30b',
        'project config wins, matching opencode own merge order');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveOpenCodeModel returns empty when nothing declares a model', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-model-'));
  try {
    withEnv({ XDG_CONFIG_HOME: path.join(tmp, 'cfg') }, () => {
      assert.equal(resolveOpenCodeModel(path.join(tmp, 'nope')), '');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveOpenCodeModel ignores an unparseable config instead of throwing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-model-'));
  const project = path.join(tmp, 'repo');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'opencode.json'), '{ "model": "ollama/x",, }', 'utf-8');
  try {
    withEnv({ XDG_CONFIG_HOME: path.join(tmp, 'cfg') }, () => {
      assert.equal(resolveOpenCodeModel(project), '');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
