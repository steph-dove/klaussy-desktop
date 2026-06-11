// Small-surface IPC: preferences window, font/theme prefs, about info,
// claude-info, system-theme forwarding, and the log-ring viewer. Handlers
// register on require — main.js just needs to `require()` this file.

const path = require('path');
const { execFileSync } = require('child_process');
const { app, ipcMain, BrowserWindow, nativeTheme } = require('electron');
const { loadConfig, saveConfig } = require('../util/config');
const { getLogBuffer } = require('../util/logging');
const { allWindows, hardenWindow, getMainWindow } = require('../state/windows');
const { startAutoFetch } = require('../state/ci-poll');
const { allProviders, getProvider, binFor } = require('../state/ai-providers');

// Synchronous provider-list handed to the sandboxed preload (which can't
// require local files). Registered on require, before any window/preload runs.
ipcMain.on('get-providers-sync', (event) => {
  try {
    event.returnValue = allProviders();
  } catch {
    event.returnValue = null;
  }
});

// Resolve a provider's configured binary and probe its --version. Returns
// 'not found' if the binary isn't on PATH / errors out.
function probeAgent(providerId, config) {
  const provider = getProvider(providerId);
  if (!provider) return null;
  const bin = binFor(providerId, config);
  let version = 'not found';
  try {
    version = execFileSync(bin, provider.versionArgs, { stdio: 'pipe', timeout: 5000 }).toString().trim();
  } catch {}
  return { id: providerId, displayName: provider.displayName, path: bin, version };
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
// Each app window can carry an accent color (shown as a top strip + header
// tint) so multiple windows — e.g. a work project vs a side project, each with
// its own terminals — are easy to tell apart. The color is per-window: the
// main window persists its choice in config.windowColor; secondary windows are
// session-only (kept in a Map keyed by webContents id). The picker lives in the
// (global) Preferences window, so we remember which window opened it and apply
// the color to that owner.
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
// it was opened from so the per-window color picker targets the right window.
// Exported so the app menu's "Preferences…" item can call it directly with the
// focused window (a menu click has no event.sender).
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

ipcMain.handle('get-preferences', () => {
  const config = loadConfig();
  return {
    fontFamily: config.fontFamily || "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    fontSize: config.fontSize || 13,
    lineHeight: config.lineHeight || 1.2,
    cursorStyle: config.cursorStyle || 'block',
    claudePath: config.claudePath || '',
    codexPath: config.codexPath || '',
    geminiPath: config.geminiPath || '',
    copilotPath: config.copilotPath || '',
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
  };
});

ipcMain.handle('set-preferences', (_event, prefs) => {
  const config = loadConfig();
  if (prefs.fontFamily !== undefined) config.fontFamily = prefs.fontFamily;
  if (prefs.fontSize !== undefined) config.fontSize = prefs.fontSize;
  if (prefs.lineHeight !== undefined) config.lineHeight = prefs.lineHeight;
  if (prefs.cursorStyle !== undefined) config.cursorStyle = prefs.cursorStyle;
  if (prefs.claudePath !== undefined) config.claudePath = prefs.claudePath;
  if (prefs.codexPath !== undefined) config.codexPath = prefs.codexPath;
  if (prefs.geminiPath !== undefined) config.geminiPath = prefs.geminiPath;
  if (prefs.copilotPath !== undefined) config.copilotPath = prefs.copilotPath;
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
  if (prefs.theme !== undefined) config.theme = prefs.theme;
  if (prefs.keybindings !== undefined) config.keybindings = prefs.keybindings;
  if (prefs.autoFetchInterval !== undefined) {
    config.autoFetchInterval = prefs.autoFetchInterval;
    startAutoFetch(); // Reset the auto-fetch timer
  }
  if (prefs.preCommitReview !== undefined) {
    config.preCommitReview = !!prefs.preCommitReview;
    // Opting out removes installed git hooks; opting back in re-installs on
    // the next session create.
    if (!config.preCommitReview) {
      try {
        require('../state/precommit-hook').uninstallAllHooks();
      } catch (e) {
        console.warn('[precommit-hook] uninstall failed:', e.message);
      }
    }
  }
  saveConfig(config);

  // Broadcast to all windows so they can apply changes live
  for (const win of allWindows) {
    if (!win.isDestroyed()) win.webContents.send('preferences-changed', prefs);
  }
  return { ok: true };
});

ipcMain.handle('get-claude-info', async () => {
  const config = loadConfig();
  const info = probeAgent('claude', config);
  return { path: info.path, version: info.version };
});

// Per-provider version probe for the preferences UI. { provider } in,
// { id, displayName, path, version } out (version='not found' on failure).
ipcMain.handle('get-agent-info', async (_event, { provider } = {}) => {
  const config = loadConfig();
  const info = probeAgent(provider, config);
  if (!info) return { id: provider, path: '', version: 'not found' };
  return info;
});

module.exports = { openPreferencesWindow };
