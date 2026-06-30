require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { mcpConfigFor } = require('../../main/state/mcp-configs');
const { PROVIDER_IDS } = require('../../main/state/ai-providers');

test('every provider maps to a valid MCP config or null', () => {
  for (const id of PROVIDER_IDS) {
    const cfg = mcpConfigFor(id);
    if (cfg === null) continue;
    assert.ok(['json', 'toml'].includes(cfg.format), `${id}: bad format`);
    assert.ok(typeof cfg.mapKey === 'string' && cfg.mapKey.length, `${id}: bad mapKey`);
    assert.ok(Array.isArray(cfg.userFile) && cfg.userFile.length, `${id}: bad userFile`);
    assert.ok(cfg.projectFile === null || Array.isArray(cfg.projectFile), `${id}: bad projectFile`);
  }
});

test('ollama is not MCP-capable; codex is TOML, claude is JSON', () => {
  assert.equal(mcpConfigFor('ollama'), null);
  assert.equal(mcpConfigFor('codex').format, 'toml');
  assert.equal(mcpConfigFor('claude').format, 'json');
});
