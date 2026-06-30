// Per-agent MCP config file + format (JSON `mcpServers` map, or Codex's TOML
// `[mcp_servers.*]`). Paths verified against each CLI's docs (mid-2026).
// Consumed by main/util/mcp-config.js + main/ipc/mcp.js. ollama → null.
const MCP_CONFIGS = {
  claude: { format: 'json', mapKey: 'mcpServers', userFile: ['.claude.json'], projectFile: ['.mcp.json'], verified: true },
  codex: { format: 'toml', mapKey: 'mcp_servers', userFile: ['.codex', 'config.toml'], projectFile: null, verified: true },
  gemini: { format: 'json', mapKey: 'mcpServers', userFile: ['.gemini', 'settings.json'], projectFile: ['.gemini', 'settings.json'], verified: true },
  antigravity: { format: 'json', mapKey: 'mcpServers', userFile: ['.gemini', 'config', 'mcp_config.json'], projectFile: null, verified: true },
  copilot: { format: 'json', mapKey: 'mcpServers', userFile: ['.copilot', 'mcp-config.json'], projectFile: null, verified: true },
  cursor: { format: 'json', mapKey: 'mcpServers', userFile: ['.cursor', 'mcp.json'], projectFile: ['.cursor', 'mcp.json'], verified: true },
  cline: { format: 'json', mapKey: 'mcpServers', userFile: ['.cline', 'data', 'settings', 'cline_mcp_settings.json'], projectFile: null, verified: true },
  ollama: null,
};

function mcpConfigFor(id) { return MCP_CONFIGS[id] || null; }

module.exports = { MCP_CONFIGS, mcpConfigFor };
