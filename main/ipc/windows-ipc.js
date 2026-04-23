// Small-surface IPC: preferences window, font/theme prefs, about info,
// claude-info, system-theme forwarding, and the log-ring viewer. Handlers
// register on require — main.js just needs to `require()` this file.

const path = require('path');
const { execFileSync } = require('child_process');
const { app, ipcMain, BrowserWindow, nativeTheme } = require('electron');
const { loadConfig, saveConfig } = require('../util/config');
const { getLogBuffer } = require('../util/logging');
const { allWindows, hardenWindow } = require('../state/windows');
const { startAutoFetch } = require('../state/ci-poll');

// ---- About Info (A7) ----

ipcMain.handle('get-about-info', async () => {
  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  let claudeVersion = 'not found';
  try {
    claudeVersion = execFileSync(claudeBin, ['--version'], { stdio: 'pipe', timeout: 5000 }).toString().trim();
  } catch {}
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    claudePath: claudeBin,
    claudeVersion,
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

// ---- Preferences Window (B1-B4) ----

let prefsWindow = null;

ipcMain.handle('open-preferences', () => {
  if (prefsWindow && !prefsWindow.isDestroyed()) {
    prefsWindow.focus();
    return { ok: true };
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
    defaultMode: config.defaultMode || 'claude',
    theme: config.theme || { preset: 'dark' },
    keybindings: config.keybindings || {},
    autoFetchInterval: config.autoFetchInterval || 60000,
  };
});

ipcMain.handle('set-preferences', (_event, prefs) => {
  const config = loadConfig();
  if (prefs.fontFamily !== undefined) config.fontFamily = prefs.fontFamily;
  if (prefs.fontSize !== undefined) config.fontSize = prefs.fontSize;
  if (prefs.lineHeight !== undefined) config.lineHeight = prefs.lineHeight;
  if (prefs.cursorStyle !== undefined) config.cursorStyle = prefs.cursorStyle;
  if (prefs.claudePath !== undefined) config.claudePath = prefs.claudePath;
  if (prefs.defaultMode !== undefined) config.defaultMode = prefs.defaultMode;
  if (prefs.theme !== undefined) config.theme = prefs.theme;
  if (prefs.keybindings !== undefined) config.keybindings = prefs.keybindings;
  if (prefs.autoFetchInterval !== undefined) {
    config.autoFetchInterval = prefs.autoFetchInterval;
    startAutoFetch(); // Reset the auto-fetch timer
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
  const claudeBin = config.claudePath || 'claude';
  try {
    const version = execFileSync(claudeBin, ['--version'], { stdio: 'pipe', timeout: 5000 }).toString().trim();
    return { path: claudeBin, version };
  } catch {
    return { path: claudeBin, version: 'not found' };
  }
});
