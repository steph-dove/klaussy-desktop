require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const mcp = require('../../main/util/mcp-config');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-home-'));
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---- configFile resolution ----

test('configFile resolves each agent + scope correctly', () => {
  const home = '/h';
  assert.equal(mcp.configFile('claude', 'user', null, home), path.join(home, '.claude.json'));
  assert.equal(mcp.configFile('claude', 'project', '/repo', home), path.join('/repo', '.mcp.json'));
  assert.equal(mcp.configFile('gemini', 'user', null, home), path.join(home, '.gemini', 'settings.json'));
  // Antigravity has its own file under ~/.gemini (not Gemini's settings.json).
  assert.equal(mcp.configFile('antigravity', 'user', null, home), path.join(home, '.gemini', 'config', 'mcp_config.json'));
  assert.equal(mcp.configFile('cline', 'user', null, home), path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'));
  assert.equal(mcp.configFile('codex', 'user', null, home), path.join(home, '.codex', 'config.toml'));
  // No project file for an agent that lacks one, or when no repo is given.
  assert.equal(mcp.configFile('copilot', 'project', '/repo', home), null);
  assert.equal(mcp.configFile('claude', 'project', null, home), null);
  // ollama is not MCP-capable.
  assert.equal(mcp.configFile('ollama', 'user', null, home), null);
});

// ---- JSON agents: round trip ----

test('JSON add → list → remove round trips (claude user scope)', () => {
  const home = tmpHome();
  let r = mcp.addServer({ agentId: 'claude', scope: 'user', homedir: home, server: { name: 'gh', type: 'http', url: 'https://api.example/mcp' } });
  assert.ok(r.ok, 'add should succeed');

  const file = path.join(home, '.claude.json');
  assert.ok(fs.existsSync(file), 'config file created');
  assert.equal(readJson(file).mcpServers.gh.url, 'https://api.example/mcp');

  const listed = mcp.listServers({ homedir: home }).servers;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'gh');
  assert.equal(listed[0].agentId, 'claude');
  assert.equal(listed[0].scope, 'user');
  assert.equal(listed[0].type, 'http');

  r = mcp.removeServer({ agentId: 'claude', scope: 'user', homedir: home, name: 'gh' });
  assert.ok(r.ok && r.removed, 'remove should report removed');
  assert.equal(mcp.listServers({ homedir: home }).servers.length, 0);
});

test('stdio server stores env values on disk but list returns keys only', () => {
  const home = tmpHome();
  mcp.addServer({
    agentId: 'claude', scope: 'user', homedir: home,
    server: { name: 'slack', type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { SLACK_BOT_TOKEN: 'xoxb-secret' } },
  });
  const def = readJson(path.join(home, '.claude.json')).mcpServers.slack;
  assert.deepEqual(def.args, ['-y', 'pkg']);
  assert.equal(def.env.SLACK_BOT_TOKEN, 'xoxb-secret', 'value persisted to disk');

  const entry = mcp.listServers({ homedir: home }).servers[0];
  assert.deepEqual(entry.envKeys, ['SLACK_BOT_TOKEN']);
  assert.ok(!JSON.stringify(entry).includes('xoxb-secret'), 'env values must never round-trip to the UI');
});

test('add preserves unrelated keys and existing servers', () => {
  const home = tmpHome();
  const file = path.join(home, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', mcpServers: { existing: { command: 'old' } } }, null, 2));

  mcp.addServer({ agentId: 'gemini', scope: 'user', homedir: home, server: { name: 'fresh', type: 'stdio', command: 'npx' } });

  const obj = readJson(file);
  assert.equal(obj.theme, 'dark', 'unrelated key preserved');
  assert.ok(obj.mcpServers.existing, 'existing server preserved');
  assert.ok(obj.mcpServers.fresh, 'new server added');
});

test('project scope writes to the repo config file', () => {
  const home = tmpHome();
  const repo = tmpHome();
  const r = mcp.addServer({ agentId: 'claude', scope: 'project', repoPath: repo, homedir: home, server: { name: 'p', type: 'stdio', command: 'x' } });
  assert.ok(r.ok);
  assert.ok(fs.existsSync(path.join(repo, '.mcp.json')), 'project file written under repo');
  assert.ok(!fs.existsSync(path.join(home, '.mcp.json')), 'nothing written to home');

  const listed = mcp.listServers({ homedir: home, projects: [{ name: 'proj', path: repo }] }).servers;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].scope, 'project');
  assert.equal(listed[0].projectName, 'proj');
});

test('removing a nonexistent server is a no-op success', () => {
  const home = tmpHome();
  const r = mcp.removeServer({ agentId: 'claude', scope: 'user', homedir: home, name: 'nope' });
  assert.ok(r.ok, 'should not error');
  assert.equal(r.removed, false);
});

test('malformed JSON config errors without clobbering the file', () => {
  const home = tmpHome();
  const file = path.join(home, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');

  const r = mcp.addServer({ agentId: 'cursor', scope: 'user', homedir: home, server: { name: 'x', type: 'stdio', command: 'y' } });
  assert.ok(r.error, 'should surface a parse error');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json', 'file left untouched');
});

test('Gemini and Antigravity write separate files', () => {
  const home = tmpHome();
  mcp.addServer({ agentId: 'gemini', scope: 'user', homedir: home, server: { name: 'g', type: 'stdio', command: 'x' } });
  mcp.addServer({ agentId: 'antigravity', scope: 'user', homedir: home, server: { name: 'a', type: 'stdio', command: 'y' } });
  assert.ok(fs.existsSync(path.join(home, '.gemini', 'settings.json')), 'gemini file');
  assert.ok(fs.existsSync(path.join(home, '.gemini', 'config', 'mcp_config.json')), 'antigravity file');
  const byAgent = mcp.listServers({ homedir: home }).servers.map((s) => s.agentId).sort();
  assert.deepEqual(byAgent, ['antigravity', 'gemini']);
});

test('listServers dedups duplicate locations by file path', () => {
  const home = tmpHome();
  const repo = tmpHome();
  mcp.addServer({ agentId: 'claude', scope: 'project', repoPath: repo, homedir: home, server: { name: 'p', type: 'stdio', command: 'x' } });
  // Same repo passed as both a project and the active repo — must list once.
  const listed = mcp.listServers({ homedir: home, projects: [{ name: 'r', path: repo }], activeRepo: repo }).servers;
  assert.equal(listed.length, 1, 'duplicate location deduped');
});

// ---- Codex (TOML) ----

test('codex TOML: add appends a block, preserving surrounding config', () => {
  const home = tmpHome();
  const file = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'model = "gpt-5"\n\n[history]\npersistence = "save"\n');

  const r = mcp.addServer({
    agentId: 'codex', scope: 'user', homedir: home,
    server: { name: 'datadog', type: 'stdio', command: 'npx', args: ['-y', 'dd'], env: { DD_API_KEY: 'k' } },
  });
  assert.ok(r.ok);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /model = "gpt-5"/, 'unrelated top-level key preserved');
  assert.match(text, /\[history\]/, 'unrelated table preserved');
  assert.match(text, /\[mcp_servers\.datadog\]/);
  assert.match(text, /command = "npx"/);
  assert.match(text, /args = \["-y", "dd"\]/);
  assert.match(text, /\[mcp_servers\.datadog\.env\]/);
  assert.match(text, /DD_API_KEY = "k"/);

  const entry = mcp.listServers({ homedir: home }).servers.find((s) => s.name === 'datadog');
  assert.ok(entry, 'codex server listed');
  assert.equal(entry.agentId, 'codex');
  assert.equal(entry.command, 'npx');
  assert.deepEqual(entry.args, ['-y', 'dd']);
  assert.deepEqual(entry.envKeys, ['DD_API_KEY']);
  assert.ok(!JSON.stringify(entry).includes('"k"'), 'codex env values not surfaced');
});

test('codex TOML: re-adding replaces the existing block', () => {
  const home = tmpHome();
  mcp.addServer({ agentId: 'codex', scope: 'user', homedir: home, server: { name: 'a', type: 'stdio', command: 'first' } });
  mcp.addServer({ agentId: 'codex', scope: 'user', homedir: home, server: { name: 'a', type: 'stdio', command: 'second' } });
  const text = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.equal((text.match(/\[mcp_servers\.a\]/g) || []).length, 1, 'only one block');
  assert.match(text, /command = "second"/);
  assert.doesNotMatch(text, /command = "first"/);
});

test('codex TOML: remove splices the block, keeping other config', () => {
  const home = tmpHome();
  const file = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'model = "gpt-5"\n');
  mcp.addServer({ agentId: 'codex', scope: 'user', homedir: home, server: { name: 'gone', type: 'stdio', command: 'x', env: { K: 'v' } } });

  const r = mcp.removeServer({ agentId: 'codex', scope: 'user', homedir: home, name: 'gone' });
  assert.ok(r.ok && r.removed);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /model = "gpt-5"/, 'unrelated config kept');
  assert.doesNotMatch(text, /mcp_servers\.gone/, 'block removed');
});

test('codex TOML: remote server writes a url', () => {
  const home = tmpHome();
  mcp.addServer({ agentId: 'codex', scope: 'user', homedir: home, server: { name: 'sentry', type: 'http', url: 'https://mcp.example/mcp' } });
  const text = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(text, /\[mcp_servers\.sentry\]/);
  assert.match(text, /url = "https:\/\/mcp\.example\/mcp"/);
});

test('parseCodexServers reads inline env tables and sub-tables', () => {
  const inline = mcp.parseCodexServers('[mcp_servers.a]\ncommand = "x"\nenv = { A = "1", B = "2" }\n');
  assert.deepEqual(Object.keys(inline.map.a.env).sort(), ['A', 'B']);

  const sub = mcp.parseCodexServers('[mcp_servers.b]\ncommand = "y"\n\n[mcp_servers.b.env]\nC = "3"\n');
  assert.deepEqual(Object.keys(sub.map.b.env), ['C']);
});

// ---- validation ----

test('validateServer rejects bad input', () => {
  assert.ok(mcp.validateServer({ type: 'stdio', command: 'x' }), 'missing name rejected');
  assert.ok(mcp.validateServer({ name: 'bad name', type: 'stdio', command: 'x' }), 'spaces in name rejected');
  assert.ok(mcp.validateServer({ name: 'ok', type: 'stdio' }), 'stdio without command rejected');
  assert.ok(mcp.validateServer({ name: 'ok', type: 'http' }), 'http without url rejected');
  assert.equal(mcp.validateServer({ name: 'ok', type: 'stdio', command: 'x' }), null, 'valid stdio accepted');
  assert.equal(mcp.validateServer({ name: 'ok', type: 'http', url: 'https://x' }), null, 'valid http accepted');
});

test('addServer rejects an MCP-incapable agent', () => {
  const home = tmpHome();
  const r = mcp.addServer({ agentId: 'ollama', scope: 'user', homedir: home, server: { name: 'x', type: 'stdio', command: 'y' } });
  assert.ok(r.error, 'ollama add should error');
});
