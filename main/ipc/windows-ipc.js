// Small-surface IPC: preferences window, font/theme prefs, about info,
// claude-info, system-theme forwarding, and the log-ring viewer. Handlers
// register on require — main.js just needs to `require()` this file.

const path = require('path');
const { execFileSync } = require('child_process');
const { app, ipcMain, BrowserWindow, nativeTheme } = require('electron');
const { loadConfig, saveConfig, getNemesisConfig, getNemesisProfiles, getNemesisProfile, getNotificationConfig } = require('../util/config');
const { getLogBuffer } = require('../util/logging');
const { allWindows, hardenWindow, getMainWindow } = require('../state/windows');
const { startAutoFetch } = require('../state/ci-poll');
const { allProviders, getProvider, binFor, installCommandFor, docsUrlFor, authMetaFor } = require('../state/ai-providers');
const nemesis = require('../util/nemesis-client');

// Synchronous provider-list handed to the sandboxed preload (which can't
// require local files). Registered on require, before any window/preload runs.
ipcMain.on('get-providers-sync', (event) => {
  try {
    // Expand the single nemesis8 entry into one per configured gateway profile
    // ('nemesis8:<id>', labelled with the profile name), so each is selectable
    // in the picker. No profiles yet → the generic entry that prompts setup.
    const profiles = getNemesisProfiles();
    const out = [];
    for (const p of allProviders()) {
      if (p.id === 'nemesis8' && profiles.length) {
        for (const prof of profiles) {
          out.push({ ...p, id: 'nemesis8:' + prof.id, displayName: 'Nemesis8 Sandbox: ' + prof.name, shortName: 'Nemesis8 Sandbox: ' + prof.name });
        }
      } else {
        out.push(p);
      }
    }
    event.returnValue = out;
  } catch {
    event.returnValue = null;
  }
});

// Probe a provider's binary --version ('not found' on failure). Remote backends
// have no binary — probe the gateway instead.
function probeAgent(providerId, config) {
  const provider = getProvider(providerId);
  if (!provider) return null;
  if (provider.remoteBackend) return probeRemoteAgent(providerId, provider);
  const bin = binFor(providerId, config);
  let version = 'not found';
  try {
    version = execFileSync(bin, provider.versionArgs, { stdio: 'pipe', timeout: 5000 }).toString().trim();
  } catch {}
  return { id: providerId, displayName: provider.displayName, path: bin, version };
}

// Synchronous status for the About panel: reports only whether a gateway is
// configured, since we won't block the panel on a network round-trip. Live
// reachability is the async job of get-agent-info / test-nemesis-connection.
function probeRemoteAgent(providerId, provider) {
  const profiles = getNemesisProfiles();
  const base = profiles.length ? nemesis.normalizeBaseUrl(profiles[0].remote) : '';
  return {
    id: providerId,
    displayName: provider.displayName,
    path: base || '(not configured)',
    version: profiles.length
      ? (profiles.length > 1 ? `${profiles.length} gateways configured` : 'configured')
      : 'not found',
    remoteBackend: true,
  };
}

// ---- About Info (A7) ----

ipcMain.handle('get-about-info', async () => {
  const config = loadConfig();
  const agents = allProviders().map((p) => probeAgent(p.id, config));
  const claude = agents.find((a) => a.id === 'claude') || {};
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    // Per-agent path/version for the About panel's CLI list.
    agents,
    // Back-compat: older renderer code reads these two directly.
    claudePath: claude.path || (config.claudePath || 'claude'),
    claudeVersion: claude.version || 'not found',
  };
});

// ---- E1: Log viewer ----

ipcMain.handle('get-logs', () => {
  return getLogBuffer();
});

// ---- Phase 5: Theme ----

ipcMain.handle('get-theme', () => {
  const config = loadConfig();
  return config.theme || { preset: 'dark' };
});

ipcMain.handle('set-theme', (_event, { theme }) => {
  const config = loadConfig();
  config.theme = theme;
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('get-system-theme', () => {
  return nativeTheme.shouldUseDarkColors;
});

// Listen for system theme changes and forward to renderer
nativeTheme.on('updated', () => {
  for (const win of allWindows) {
    if (!win.isDestroyed()) win.webContents.send('system-theme-changed', nativeTheme.shouldUseDarkColors);
  }
});

// ---- Per-window top-bar color ----
//
// Each window can carry an accent color so multiple windows are easy to tell
// apart. The main window persists it in config.windowColor; secondary windows
// are session-only (Map keyed by webContents id). The picker lives in Preferences.
const windowColors = new Map(); // webContents.id -> color string

function windowColorFor(win) {
  if (!win || win.isDestroyed()) return null;
  const id = win.webContents.id;
  if (windowColors.has(id)) return windowColors.get(id);
  if (win === getMainWindow()) return loadConfig().windowColor || null;
  return null;
}

function setWindowColor(win, color) {
  if (!win || win.isDestroyed()) return;
  const id = win.webContents.id;
  if (color) windowColors.set(id, color); else windowColors.delete(id);
  // The main window's color survives restarts; secondary windows don't reopen,
  // so they stay session-only.
  if (win === getMainWindow()) {
    const config = loadConfig();
    config.windowColor = color || null;
    saveConfig(config);
  }
  win.webContents.send('window-color-changed', color || null);
}

// An app window applies its own color on load.
ipcMain.handle('window-color-get', (event) => {
  return windowColorFor(BrowserWindow.fromWebContents(event.sender));
});

// ---- Preferences Window (B1-B4) ----

let prefsWindow = null;
// The app window that opened Preferences — the target of the window-color
// picker (Preferences is a single shared window).
let prefsOwner = null;

// Open (or focus) the shared Preferences window, remembering which app window
// opened it so the color picker targets the right one. Exported so the app
// menu's "Preferences…" item can call it (a menu click has no event.sender).
function openPreferencesWindow(ownerWin) {
  if (ownerWin && !ownerWin.isDestroyed()) prefsOwner = ownerWin;
  if (prefsWindow && !prefsWindow.isDestroyed()) {
    prefsWindow.focus();
    return;
  }

  prefsWindow = new BrowserWindow({
    width: 520,
    height: 560,
    title: 'Preferences',
    icon: path.join(__dirname, '..', '..', 'icon.icns'),
    backgroundColor: '#1a1a2e',
    resizable: true,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(prefsWindow);

  prefsWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'preferences.html'));
  prefsWindow.on('closed', () => { prefsWindow = null; });
}

ipcMain.handle('open-preferences', (event) => {
  openPreferencesWindow(BrowserWindow.fromWebContents(event.sender));
  return { ok: true };
});

// The Preferences window's window-color picker reads/writes the owner window.
ipcMain.handle('prefs-window-color-get', () => windowColorFor(prefsOwner));
ipcMain.handle('prefs-window-color-set', (_event, { color }) => {
  if (prefsOwner && !prefsOwner.isDestroyed()) setWindowColor(prefsOwner, color || null);
  return { ok: true };
});

// null = "couldn't read it", which the renderer must render as unknown rather
// than unticked: a false here would let the next Save revoke a live grant.
function kimiBashGranted() {
  try {
    return require('../state/kimi-permissions').isGranted();
  } catch (err) {
    console.warn('[kimi-permissions] could not read config.toml:', err.message);
    return null;
  }
}

ipcMain.handle('get-preferences', () => {
  const config = loadConfig();
  return {
    fontFamily: config.fontFamily || "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    fontSize: config.fontSize || 13,
    lineHeight: config.lineHeight || 1.2,
    cursorStyle: config.cursorStyle || 'block',
    // Inline-autocomplete (Ollama FIM) model tag; base = FIM-tuned.
    ollamaModel: config.ollamaModel || 'qwen2.5-coder:1.5b-base',
    claudePath: config.claudePath || '',
    codexPath: config.codexPath || '',
    geminiPath: config.geminiPath || '',
    antigravityPath: config.antigravityPath || '',
    copilotPath: config.copilotPath || '',
    cursorPath: config.cursorPath || '',
    clinePath: config.clinePath || '',
    opencodePath: config.opencodePath || '',
    kimiPath: config.kimiPath || '',
    // Read from kimi's own config.toml rather than mirrored here, so the
    // checkbox can't drift from the file the user may edit by hand.
    kimiAutonomousBash: kimiBashGranted(),
    aiderPath: config.aiderPath || '',
    // defaultProvider supersedes defaultMode; fall back for un-migrated configs.
    defaultProvider: config.defaultProvider || config.defaultMode || 'claude',
    defaultMode: config.defaultProvider || config.defaultMode || 'claude',
    // Per-agent pinned model/version: { <agentId>: '<modelId>' }.
    agentModel: config.agentModel || {},
    theme: config.theme || { preset: 'dark' },
    keybindings: config.keybindings || {},
    autoFetchInterval: config.autoFetchInterval || 60000,
    // Pre-commit silent-failure review (app commit flow + git hook). On by
    // default; explicit false opts out.
    preCommitReview: config.preCommitReview !== false,
    // Keep comments concise (≤2 sentences; docstrings ≤5) before commit.
    // On by default — only an explicit false opts out.
    stripComments: config.stripComments !== false,
    // Klaussy CLAUDE.md enrichment runs the Claude CLI = API spend on the
    // user's machine, so it's OFF by default — opt in explicitly.
    repoIntelEnrich: config.repoIntelEnrich === true,
    // Nemesis8 named gateway profiles (migrates the legacy single-gateway keys
    // into one profile when none exist yet).
    nemesisProfiles: getNemesisProfiles(),
    // Slack/Discord webhook gateway (URLs, per-event mutes, new-session default).
    notificationGateway: getNotificationConfig(config),
  };
});

// Long enough to outlast typing or pasting a token, short enough that the new
// credentials are live before the user goes to test them.
const GATEWAY_RESTART_DEBOUNCE_MS = 2000;
let _gatewayRestartTimer = null;

function scheduleGatewayRestart() {
  if (_gatewayRestartTimer) clearTimeout(_gatewayRestartTimer);
  _gatewayRestartTimer = setTimeout(() => {
    _gatewayRestartTimer = null;
    try { require('../util/notification-gateway').restart(); } catch (e) {
      console.warn('[notification-gateway] restart failed:', e.message);
    }
  }, GATEWAY_RESTART_DEBOUNCE_MS);
  _gatewayRestartTimer.unref?.();
}

// Whether the two-way sockets connected; null per platform when not configured.
ipcMain.handle('get-notification-status', () => {
  try {
    return require('../util/notification-gateway').getSocketStatus();
  } catch (e) {
    return { error: e.message };
  }
});

// Fires a sample event at the on-screen webhook URLs, so a URL can be checked
// before it's saved.
ipcMain.handle('test-notification', async (_event, cfg) => {
  const { dispatchEvent } = require('../util/notification-gateway');
  const { EVENT_TYPES } = require('../util/nemesis-events');
  const merged = {
    slackWebhookUrl: (cfg && cfg.slackWebhookUrl) || '',
    discordWebhookUrl: (cfg && cfg.discordWebhookUrl) || '',
    events: { completed: true, failed: true, approvalRequired: true },
  };
  if (!merged.slackWebhookUrl && !merged.discordWebhookUrl) {
    return { ok: false, error: 'no webhook URL configured' };
  }
  try {
    const results = await dispatchEvent({
      type: EVENT_TYPES.COMPLETED,
      containerId: 'test',
      workspacePath: 'Klaussy preferences',
      agentName: 'Klaussy test',
      exitCode: 0,
      logsTail: 'If you can read this, the webhook works.',
      ts: Date.now(),
      notify: true,
    }, merged);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      return { ok: false, error: failed.map((f) => `${f.target}: ${f.error || 'HTTP ' + f.status}`).join('; ') };
    }
    return { ok: true, sent: results.map((r) => r.target) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('set-preferences', (_event, prefs) => {
  const config = loadConfig();
  if (prefs.fontFamily !== undefined) config.fontFamily = prefs.fontFamily;
  if (prefs.fontSize !== undefined) config.fontSize = prefs.fontSize;
  if (prefs.lineHeight !== undefined) config.lineHeight = prefs.lineHeight;
  if (prefs.cursorStyle !== undefined) config.cursorStyle = prefs.cursorStyle;
  if (prefs.ollamaModel !== undefined) config.ollamaModel = prefs.ollamaModel;
  if (prefs.claudePath !== undefined) config.claudePath = prefs.claudePath;
  if (prefs.codexPath !== undefined) config.codexPath = prefs.codexPath;
  if (prefs.geminiPath !== undefined) config.geminiPath = prefs.geminiPath;
  if (prefs.antigravityPath !== undefined) config.antigravityPath = prefs.antigravityPath;
  if (prefs.copilotPath !== undefined) config.copilotPath = prefs.copilotPath;
  if (prefs.cursorPath !== undefined) config.cursorPath = prefs.cursorPath;
  if (prefs.clinePath !== undefined) config.clinePath = prefs.clinePath;
  if (prefs.opencodePath !== undefined) config.opencodePath = prefs.opencodePath;
  if (prefs.kimiPath !== undefined) config.kimiPath = prefs.kimiPath;
  // Collected, not returned early, so the other prefs still save while a failed
  // revoke still reaches the user instead of showing "Saved".
  let kimiError = null;
  if (prefs.kimiAutonomousBash !== undefined) {
    const r = require('../state/kimi-permissions').setGranted(prefs.kimiAutonomousBash);
    if (r.error) kimiError = `Could not update kimi's config.toml: ${r.error}`;
  }
  if (prefs.aiderPath !== undefined) config.aiderPath = prefs.aiderPath;
  if (prefs.defaultProvider !== undefined) {
    config.defaultProvider = prefs.defaultProvider;
    config.defaultMode = prefs.defaultProvider; // keep legacy key in sync
  } else if (prefs.defaultMode !== undefined) {
    config.defaultMode = prefs.defaultMode;
    config.defaultProvider = prefs.defaultMode;
  }
  // Per-agent model selection. Merge so setting one agent's model doesn't drop
  // the others.
  if (prefs.agentModel !== undefined) {
    config.agentModel = Object.assign({}, config.agentModel, prefs.agentModel);
  }
  if (prefs.opencodeModel !== undefined) {
    config.opencodeModel = prefs.opencodeModel;
  }
  // 0 = auto; stored as 0 rather than deleted so "auto" is an explicit choice.
  if (prefs.agentContextLength !== undefined) {
    const n = Number(prefs.agentContextLength);
    config.agentContextLength = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  const effectiveOpencodeModel = (config.agentModel && config.agentModel.opencode) || config.opencodeModel;
  if (effectiveOpencodeModel) {
    try { require('../state/opencode-config').ensureOpenCodeOllamaConfig(effectiveOpencodeModel); } catch (e) { console.warn('[opencode-config] provider config failed:', e.message); }
  }
  if (prefs.theme !== undefined) config.theme = prefs.theme;
  if (prefs.keybindings !== undefined) config.keybindings = prefs.keybindings;
  if (prefs.autoFetchInterval !== undefined) {
    config.autoFetchInterval = prefs.autoFetchInterval;
    startAutoFetch(); // Reset the auto-fetch timer
  }
  if (prefs.preCommitReview !== undefined) {
    config.preCommitReview = !!prefs.preCommitReview;
    // Opting out removes installed git hooks — UNLESS comment cleanup still
    // needs them (it's on unless explicitly false). Opting back in re-installs
    // on the next session create.
    if (!config.preCommitReview && config.stripComments === false) {
      try {
        require('../state/precommit-hook').uninstallAllHooks();
      } catch (e) {
        console.warn('[precommit-hook] uninstall failed:', e.message);
      }
    }
  }
  if (prefs.stripComments !== undefined) {
    config.stripComments = !!prefs.stripComments;
    if (config.stripComments) {
      // Enabling strip needs the same hook the review uses. Re-arm the server
      // and re-install for repos we already track so it works without waiting
      // for the next session create.
      try {
        const hook = require('../state/precommit-hook');
        hook.startPrecommitServer();
        for (const repo of (config.precommitHookRepos || [])) hook.installHookForRepo(repo);
      } catch (e) {
        console.warn('[precommit-hook] strip re-arm failed:', e.message);
      }
    } else if (config.preCommitReview === false) {
      // Both off now → remove the hooks.
      try { require('../state/precommit-hook').uninstallAllHooks(); } catch (e) {
        console.warn('[precommit-hook] uninstall failed:', e.message);
      }
    }
  }
  if (prefs.repoIntelEnrich !== undefined) {
    config.repoIntelEnrich = !!prefs.repoIntelEnrich;
  }
  // Merged, not replaced, so a partial update (or a key the UI doesn't expose,
  // like nemesisUrl) survives a save from the prefs window.
  if (prefs.notificationGateway !== undefined && prefs.notificationGateway !== null) {
    const ng = prefs.notificationGateway;
    const prev = config.notificationGateway || {};
    config.notificationGateway = Object.assign({}, prev, ng, {
      events: Object.assign({}, prev.events, ng.events),
    });
    // Sockets capture credentials at connect time. This save fires per
    // keystroke, so debounce or typing a token means a reconnect per character.
    const socketKeys = ['slackAppToken', 'slackBotToken', 'slackChannel', 'discordBotToken', 'discordChannel'];
    if (socketKeys.some((k) => (prev[k] || '') !== (config.notificationGateway[k] || ''))) {
      scheduleGatewayRestart();
    }
  }
  // Nemesis8 gateway profiles: store the whole list (sanitized), and retire the
  // legacy single-gateway keys so getNemesisProfiles() reads only the list.
  if (Array.isArray(prefs.nemesisProfiles)) {
    config.nemesisProfiles = prefs.nemesisProfiles.map((p, i) => ({
      id: String((p && p.id) || `n8-${i}`),
      name: String((p && p.name) || `Nemesis8 ${i + 1}`),
      remote: String((p && p.remote) || '').trim(),
      token: String((p && p.token) || ''),
      provider: String((p && p.provider) || '').trim(),
      model: String((p && p.model) || '').trim(),
    }));
    config.nemesisRemote = undefined;
    config.nemesisToken = undefined;
    config.nemesisProvider = undefined;
    config.nemesisModel = undefined;
  }
  saveConfig(config);

  // Broadcast to all windows so they can apply changes live
  for (const win of allWindows) {
    if (!win.isDestroyed()) win.webContents.send('preferences-changed', prefs);
  }
  return kimiError ? { ok: false, error: kimiError } : { ok: true };
});

ipcMain.handle('get-claude-info', async () => {
  const config = loadConfig();
  const info = probeAgent('claude', config);
  return { path: info.path, version: info.version };
});

// Per-provider version probe for the preferences UI and "agent not installed"
// prompt. { provider } in; { id, displayName, path, version, installed,
// installCommand, docsUrl, loginCommand } out. Install/docs fields guide setup.
ipcMain.handle('get-agent-info', async (_event, { provider } = {}) => {
  const config = loadConfig();
  const prov = getProvider(provider);
  // Remote backends resolve "installed" via a live gateway health check.
  if (prov && prov.remoteBackend) return remoteAgentInfo(provider, prov);
  const info = probeAgent(provider, config)
    || { id: provider, displayName: (prov && prov.displayName) || provider, path: '', version: 'not found' };
  return {
    ...info,
    installed: info.version !== 'not found',
    installCommand: installCommandFor(provider) || null,
    docsUrl: docsUrlFor(provider) || null,
    loginCommand: (authMetaFor(provider) || {}).loginCommand || null,
  };
});

// Enriched agent-info for a remote backend: "installed" = configured AND a
// health check succeeds; otherwise installed:false plus setup guidance.
async function remoteAgentInfo(providerId, provider) {
  // providerId is the picked mode ('nemesis8' or 'nemesis8:<id>') — resolve its
  // gateway profile so the health check hits the right one.
  const prof = getNemesisProfile(providerId) || { remote: '', token: '', provider: '' };
  const base = prof.remote ? nemesis.normalizeBaseUrl(prof.remote) : '';
  const h = base ? await nemesis.health({ remote: prof.remote, token: prof.token }) : { ok: false, error: 'not configured' };
  return {
    id: providerId,
    displayName: provider.displayName,
    remoteBackend: true,
    path: base || '',
    installed: !!(h && h.ok),
    version: h && h.ok ? (h.version ? 'gateway v' + h.version : 'reachable') : 'not found',
    reason: h && h.ok ? null : (h && h.error) || 'unreachable',
    insecure: base ? nemesis.isInsecureRemote(base, prof.token) : false,
    docsUrl: docsUrlFor('nemesis8') || null,
    // HTTP-only client — no install command; setup is a URL + token in Prefs.
    installCommand: null,
    loginCommand: null,
    setupSteps: remoteSetupSteps(process.platform, prof.provider, prof.token),
  };
}

// Copy-paste gateway bring-up commands for the setup modal, matched to the host
// OS. `provider` sets the sandbox agent via `serve --provider`; token is inlined.
function remoteSetupSteps(platform = process.platform, provider = '', token = '') {
  const win = platform === 'win32';
  const flag = provider ? ` --provider ${provider}` : '';
  const install = win
    ? 'powershell -c "irm https://nemesis8.nuts.services/install.ps1 | iex"'
    : 'curl -fsSL https://nemesis8.nuts.services/install.sh | sh';
  // Sign the agent in with its subscription — required, or the agent hangs and
  // its container is killed after 120s. Interactive, so it's a step we can't run.
  const login = `nemesis8 login${flag}   # sign in to the agent (interactive) — required`;
  // Inline the token Klaussy stores so the gateway and app can't drift.
  const tok = token || '<generate one in Preferences>';
  const tokenLine = win ? `$env:NEMESIS8_AUTH_TOKEN="${tok}"` : `export NEMESIS8_AUTH_TOKEN="${tok}"`;
  return [install, login, tokenLine, `nemesis8 serve${flag}`];
}

// "Test connection" for the prefs section. Tests the values passed from the
// form directly (not saved config) so it can't race the async config write.
ipcMain.handle('test-nemesis-connection', async (_event, { remote, token } = {}) => {
  const url = remote !== undefined ? remote : getNemesisConfig().remote;
  const tok = token !== undefined ? token : getNemesisConfig().token;
  if (!url) return { ok: false, error: 'Enter a gateway URL first.' };
  const base = nemesis.normalizeBaseUrl(url);
  if (!base) return { ok: false, error: 'That gateway URL doesn’t look valid.' };
  const h = await nemesis.health({ remote: url, token: tok });
  return {
    ok: !!(h && h.ok),
    version: (h && h.version) || null,
    error: h && h.ok ? null : (h && h.error) || 'unreachable',
    insecure: nemesis.isInsecureRemote(base, tok),
    url: base,
  };
});

module.exports = { openPreferencesWindow };
