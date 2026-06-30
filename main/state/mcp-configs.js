// Per-agent MCP config file + format (JSON `mcpServers` map, or Codex's TOML
// `[mcp_servers.*]`). Paths verified against each CLI's docs (mid-2026).
// `envRef` = how the agent pulls a secret FROM the environment without storing
// it: 'brace' = ${VAR} (Claude, Gemini), 'envcolon' = ${env:VAR} (Cursor),
// 'envvars' = a TOML allowlist forwarded by name (Codex), null = can't (Copilot,
// Cline, Antigravity). Consumed by main/util/mcp-config.js + main/ipc/mcp.js.
const MCP_CONFIGS = {
  claude: { format: 'json', mapKey: 'mcpServers', userFile: ['.claude.json'], projectFile: ['.mcp.json'], envRef: 'brace', verified: true },
  codex: { format: 'toml', mapKey: 'mcp_servers', userFile: ['.codex', 'config.toml'], projectFile: null, envRef: 'envvars', verified: true },
  gemini: { format: 'json', mapKey: 'mcpServers', userFile: ['.gemini', 'settings.json'], projectFile: ['.gemini', 'settings.json'], envRef: 'brace', verified: true },
  antigravity: { format: 'json', mapKey: 'mcpServers', userFile: ['.gemini', 'config', 'mcp_config.json'], projectFile: null, envRef: null, verified: true },
  copilot: { format: 'json', mapKey: 'mcpServers', userFile: ['.copilot', 'mcp-config.json'], projectFile: null, envRef: null, verified: true },
  cursor: { format: 'json', mapKey: 'mcpServers', userFile: ['.cursor', 'mcp.json'], projectFile: ['.cursor', 'mcp.json'], envRef: 'envcolon', verified: true },
  cline: { format: 'json', mapKey: 'mcpServers', userFile: ['.cline', 'data', 'settings', 'cline_mcp_settings.json'], projectFile: null, envRef: null, verified: true },
  ollama: null,
};

function mcpConfigFor(id) { return MCP_CONFIGS[id] || null; }

module.exports = { MCP_CONFIGS, mcpConfigFor };
