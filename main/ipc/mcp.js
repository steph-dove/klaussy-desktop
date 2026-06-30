// IPC surface for the MCP server manager: list/add/remove servers across every
// agent's config, plus the built-in catalog and the list of installable
// targets. The format-aware read/write lives in main/util/mcp-config.js; this
// file just wires it to the renderer with the project/active-repo context.

const fs = require('fs');
const { execFileSync, execFile, spawn } = require('child_process');
const { ipcMain, shell } = require('electron');
const { loadConfig } = require('../util/config');
const { currentRepoPath } = require('../state/pr-review');
const { allProviders, getProvider, binFor } = require('../state/ai-providers');
const { mcpConfigFor } = require('../state/mcp-configs');
const mcp = require('../util/mcp-config');
const { CATALOG, CATEGORIES } = require('../state/mcp-catalog');
const { detectShellProfile } = require('../util/shell-env');

// Is an agent's CLI on PATH? Mirrors windows-ipc's probeAgent (kept local to
// avoid a cross-IPC require) — used only to default the add form's target
// checkboxes to installed agents.
function isInstalled(providerId, config) {
  const provider = getProvider(providerId);
  if (!provider) return false;
  try {
    execFileSync(binFor(providerId, config), provider.versionArgs, { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

ipcMain.handle('mcp-list', () => {
  const config = loadConfig();
  return mcp.listServers({ projects: config.projects || [], activeRepo: currentRepoPath() });
});

ipcMain.handle('mcp-catalog', () => ({ catalog: CATALOG, categories: CATEGORIES }));

// MCP-capable agents + whether they're installed and which scopes they support,
// so the add form can render and pre-select targets.
ipcMain.handle('mcp-targets', () => {
  const config = loadConfig();
  const hasRepo = !!currentRepoPath();
  const defaultProvider = config.defaultProvider || config.defaultMode || 'claude';
  const targets = allProviders()
    .map((p) => ({ p, cfg: mcpConfigFor(p.id) }))
    .filter(({ cfg }) => cfg)
    .map(({ p, cfg }) => ({
      id: p.id,
      name: p.shortName || p.displayName,
      format: cfg.format,
      verified: cfg.verified !== false,
      hasProjectScope: !!cfg.projectFile && hasRepo,
      installed: isInstalled(p.id, config),
      isDefault: p.id === defaultProvider,
    }));
  return { targets };
});

ipcMain.handle('mcp-add', (_event, { agentId, scope, server }) => {
  const repoPath = scope === 'project' ? currentRepoPath() : null;
  if (scope === 'project' && !repoPath) return { error: 'No active repository for project scope' };
  return mcp.addServer({ agentId, scope, repoPath, server });
});

ipcMain.handle('mcp-remove', (_event, { agentId, scope, name }) => {
  const repoPath = scope === 'project' ? currentRepoPath() : null;
  if (scope === 'project' && !repoPath) return { error: 'No active repository for project scope' };
  return mcp.removeServer({ agentId, scope, repoPath, name });
});

// Live status from `claude mcp list`, which health-checks each server Claude has
// configured. Returns a name→status map (Claude-sourced — other agents have no
// universal equivalent).
function parseMcpList(stdout) {
  const byName = {};
  for (const line of String(stdout || '').split('\n')) {
    // Shape: "<name>: <url-or-command> - <status text>"
    const m = line.match(/^(.+?):\s+.*\s+-\s+(.+?)\s*$/);
    if (!m) continue;
    const name = m[1].trim();
    const text = m[2].trim();
    let status = 'unknown';
    if (/needs?\s+authentication/i.test(text)) status = 'auth';
    else if (/fail|error|✗|✘|could not|unable/i.test(text)) status = /connected/i.test(text) ? 'partial' : 'failed';
    else if (/✔|✓|connected|ready/i.test(text)) status = 'connected';
    byName[name] = { status, text };
  }
  return byName;
}

ipcMain.handle('mcp-status', () => new Promise((resolve) => {
  const config = loadConfig();
  const bin = binFor('claude', config);
  execFile(bin, ['mcp', 'list'], { timeout: 30000 }, (err, stdout) => {
    if (err && !stdout) return resolve({ error: 'Could not run claude mcp list', byName: {}, source: 'claude' });
    resolve({ byName: parseMcpList(stdout), source: 'claude' });
  });
}));

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// `claude mcp login` is interactive (prompts to paste the redirect URL), so it
// needs a real TTY — headless fails with "stdin isn't a terminal". Launch it in
// the OS terminal where the user completes the flow; return the cmd for show/copy.
ipcMain.handle('mcp-login-terminal', (_event, { name }) => {
  if (!name) return { error: 'No server name' };
  const config = loadConfig();
  const bin = binFor('claude', config);
  const displayCmd = `${bin} mcp login ${name}`;
  const shellCmd = `${shQuote(bin)} mcp login ${shQuote(name)}`;
  try {
    if (process.platform === 'darwin') {
      const inner = `${shellCmd}; echo; echo '— sign-in finished; you can close this window —'`;
      const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(inner)}\nend tell`;
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', 'cmd', '/k', displayCmd], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const term = process.env.TERMINAL || 'x-terminal-emulator';
      spawn(term, ['-e', 'bash', '-lc', `${shellCmd}; echo; read -n1 -p 'Sign-in finished — press any key to close'`], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, command: displayCmd };
  } catch (e) {
    return { error: e.message };
  }
});

// Shell-profile info so the add form can tell the user exactly where to set the
// env vars an stdio server needs (we write ${VAR} refs, not the secrets).
ipcMain.handle('mcp-env-info', () => detectShellProfile({ shell: process.env.SHELL }));

// Open the user's shell profile so they can paste in their export lines,
// creating an empty file first if it doesn't exist. Falls back to revealing it
// in the file manager when the OS has no default opener for a dotfile.
ipcMain.handle('mcp-open-profile', async () => {
  const info = detectShellProfile({ shell: process.env.SHELL });
  if (!info.profilePath) return { error: 'On this platform set env vars with setx or your PowerShell profile.' };
  try {
    if (!fs.existsSync(info.profilePath)) fs.writeFileSync(info.profilePath, '');
    const err = await shell.openPath(info.profilePath);
    if (err) shell.showItemInFolder(info.profilePath);
    return { ok: true, profilePath: info.profilePath };
  } catch (e) {
    return { error: e.message };
  }
});

module.exports = { parseMcpList };
