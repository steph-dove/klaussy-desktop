// Per-agent MCP config file + format (JSON `mcpServers` map, or Codex's TOML
// `[mcp_servers.*]`). Antigravity shares Gemini's settings.json; ollama → null.
// Consumed by main/util/mcp-config.js + main/ipc/mcp.js.
const MCP_CONFIGS = {
  claude: { format: 'json', mapKey: 'mcpServers', userFile: ['.claude.json'], projectFile: ['.mcp.json'], verified: true },
  codex: { format: 'toml', mapKey: 'mcp_servers', userFile: ['.codex', 'config.toml'], projectFile: null, verified: true },
  gemini: { format: 'json', mapKey: 'mcpServers', userFile: ['.gemini', 'settings.json'], projectFile: ['.gemini', 'settings.json'], verified: true },
  antigravity: { format: 'json', mapKey: 'mcpServers', userFile: ['.gemini', 'settings.json'], projectFile: null, verified: true, sharesWith: 'gemini' },
  copilot: { format: 'json', mapKey: 'mcpServers', userFile: ['.copilot', 'mcp-config.json'], projectFile: null, verified: false },
  cursor: { format: 'json', mapKey: 'mcpServers', userFile: ['.cursor', 'mcp.json'], projectFile: ['.cursor', 'mcp.json'], verified: true },
  cline: { format: 'json', mapKey: 'mcpServers', userFile: ['.cline', 'data', 'mcp_settings.json'], projectFile: null, verified: false },
  ollama: null,
};

function mcpConfigFor(id) { return MCP_CONFIGS[id] || null; }

module.exports = { MCP_CONFIGS, mcpConfigFor };
