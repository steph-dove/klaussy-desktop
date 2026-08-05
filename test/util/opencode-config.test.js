const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ensureOpenCodeOllamaConfig } = require('../../main/state/opencode-config');

// XDG and APPDATA are cleared as well as HOME: configHome()/dataHome() prefer
// them, so overriding HOME alone would let a test write into the developer's
// real ~/.config/opencode and auth.json.
const SANDBOXED = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA'];

function withSandboxedHome(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-test-'));
  const saved = {};
  for (const k of SANDBOXED) saved[k] = process.env[k];
  try {
    for (const k of SANDBOXED) delete process.env[k];
    process.env.HOME = tmpDir;
    fn(tmpDir);
  } finally {
    for (const k of SANDBOXED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

test('an unparseable project opencode.json is left untouched, not overwritten', () => {
  withSandboxedHome((tmpDir) => {
    const worktree = path.join(tmpDir, 'worktree');
    fs.mkdirSync(worktree, { recursive: true });
    const projectConfig = path.join(worktree, 'opencode.json');
    // Valid-looking config with one trailing-comma typo — the shape that
    // previously got silently replaced with a generated stub.
    const original = '{\n  "instructions": ["./rules/a.md",],\n  "plugin": ["./plugins/p.js"]\n}\n';
    fs.writeFileSync(projectConfig, original, 'utf-8');

    ensureOpenCodeOllamaConfig('ollama/qwen3-coder:30b', worktree);

    assert.equal(fs.readFileSync(projectConfig, 'utf-8'), original,
      'a config that failed to parse must survive byte-for-byte');
  });
});

test('an unparseable auth.json is left untouched, preserving other providers credentials', () => {
  withSandboxedHome((tmpDir) => {
    const authDir = path.join(tmpDir, '.local', 'share', 'opencode');
    fs.mkdirSync(authDir, { recursive: true });
    const authFile = path.join(authDir, 'auth.json');
    const original = '{ "anthropic": { "type": "api", "key": "sk-secret" }, }\n';
    fs.writeFileSync(authFile, original, 'utf-8');

    ensureOpenCodeOllamaConfig('ollama/qwen3-coder:30b');

    assert.equal(fs.readFileSync(authFile, 'utf-8'), original,
      'credentials must not be dropped because the file failed to parse');
  });
});

test('a parseable project config keeps unrelated keys while gaining the ollama provider', () => {
  withSandboxedHome((tmpDir) => {
    const worktree = path.join(tmpDir, 'worktree');
    fs.mkdirSync(worktree, { recursive: true });
    const projectConfig = path.join(worktree, 'opencode.json');
    fs.writeFileSync(projectConfig, JSON.stringify({
      instructions: ['./rules/a.md'],
      provider: { anthropic: { name: 'anthropic' } },
    }, null, 2), 'utf-8');

    ensureOpenCodeOllamaConfig('ollama/qwen3-coder:30b', worktree);

    const updated = JSON.parse(fs.readFileSync(projectConfig, 'utf-8'));
    assert.deepEqual(updated.instructions, ['./rules/a.md'], 'unrelated keys survive');
    assert.ok(updated.provider.anthropic, 'other providers survive');
    assert.ok(updated.provider.ollama.models['qwen3-coder:30b'], 'ollama model was added');
  });
});

test('ensureOpenCodeOllamaConfig creates the global config with the ollama provider mapping', () => {
  withSandboxedHome((tmpDir) => {
    ensureOpenCodeOllamaConfig('ollama/qwen3-coder:30b');

    const targetFile = path.join(tmpDir, '.config', 'opencode', 'opencode.jsonc');
    assert.equal(fs.existsSync(targetFile), true, 'opencode.jsonc should be created');

    const content = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
    assert.ok(content.provider.ollama, 'ollama provider block should exist');
    assert.equal(content.provider.ollama.options.baseURL, 'http://127.0.0.1:11434/v1');
    assert.ok(content.provider.ollama.models['qwen3-coder:30b'], 'model mapping should exist');

    const authFile = path.join(tmpDir, '.local', 'share', 'opencode', 'auth.json');
    assert.equal(fs.existsSync(authFile), true, 'auth.json should be created');
    const authContent = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
    assert.equal(authContent.ollama.type, 'api');
  });
});
