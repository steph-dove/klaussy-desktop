// Owns every BrowserWindow reference the rest of main cares about: the
// primary window, the set of all live windows (for broadcasts), and the
// hardening + construction helpers.
//
// mainWindow is exposed via getter/setter rather than a bare export because
// CommonJS destructuring snapshots values at require time, and main.js
// reassigns mainWindow whenever the first window is (re)created. allWindows
// is a Set — its reference never changes, so exporting it directly is safe.

const path = require('path');
const { BrowserWindow } = require('electron');
const lspManager = require('../../lsp-manager');

let _mainWindow = null;
const allWindows = new Set();

function getMainWindow() { return _mainWindow; }
function setMainWindow(win) { _mainWindow = win; }

// Harden every BrowserWindow we create:
//  * deny `window.open` / `target="_blank"` — renderer must go through the
//    scheme-allowlisted `open-external` IPC for outbound links.
//  * block navigation away from file:// — otherwise an XSS can set
//    `window.location = 'https://evil'` and the attacker page inherits the
//    preload (and thus `window.klaus.*`).
//  * when the webContents is destroyed (reload, close, crash), kill any
//    LSP subprocesses it started so they don't leak as zombie processes.
function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  win.webContents.on('destroyed', () => {
    try { lspManager.stopServersForWebContents(win.webContents); } catch {}
  });
}

function createWindow(opts) {
  opts = opts || {};
  // macOS: hide the native title bar and inset the traffic lights so the
  // renderer can paint its own full-width top bar (the per-window accent color,
  // Chrome-profile style). The renderer mirrors this by adding a
  // `custom-titlebar` body class on darwin so it reserves space + makes the bar
  // draggable.
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Klaussy',
    icon: path.join(__dirname, '..', '..', 'icon.icns'),
    backgroundColor: '#1a1a2e',
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 19, y: 12 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(win);

  var url = path.join(__dirname, '..', '..', 'renderer', 'index.html');
  if (opts.secondary) {
    win.loadFile(url, { query: { secondary: '1' } });
  } else {
    win.loadFile(url);
  }
  allWindows.add(win);
  win.on('closed', () => { allWindows.delete(win); });

  if (!_mainWindow || _mainWindow.isDestroyed()) {
    _mainWindow = win;
  }

  return win;
}

module.exports = {
  allWindows,
  getMainWindow,
  setMainWindow,
  hardenWindow,
  createWindow,
};
