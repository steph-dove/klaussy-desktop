// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Stand-in for the `electron` module when main/ runs inside the browser-mode
// helper. web/helper.js points require('electron') here, so the IPC handlers in
// main/ipc load unchanged: ipcMain registers into a table the WebSocket server
// dispatches from, and each connected browser tab is a virtual BrowserWindow
// whose webContents.send() writes to that tab's socket.
//
// Anything that needs a person (message boxes, file pickers) is forwarded to a
// tab as an RPC and answered by the in-page dialogs in web/bridge.js.

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

// ---- paths ----------------------------------------------------------------

function appDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

// userData is the desktop app's own folder, set by web/helper.js before main.js
// loads (see setUserData below): one set of projects, sessions and settings.
const paths = {
  home: os.homedir(),
  appData: appDataDir(),
  userData: null,
  temp: os.tmpdir(),
  documents: path.join(os.homedir(), 'Documents'),
  downloads: path.join(os.homedir(), 'Downloads'),
  desktop: path.join(os.homedir(), 'Desktop'),
  logs: null,
};

function setUserData(dir) {
  paths.userData = dir;
  // Where Electron puts the desktop app's logs, so both write to one place.
  paths.logs = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Logs', 'Maussian')
    : path.join(dir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(paths.logs, { recursive: true });
}

// ---- app -------------------------------------------------------------------

let markReady;
const readyPromise = new Promise((resolve) => { markReady = resolve; });

const app = new EventEmitter();
Object.assign(app, {
  name: 'Maussian',
  isPackaged: false,
  // Tells main/ it's running inside the browser helper, not the desktop app.
  isWebHelper: true,
  getPath: (name) => {
    if (!(name in paths)) throw new Error(`app.getPath: unknown path "${name}"`);
    if (paths[name] == null) throw new Error(`app.getPath('${name}') before web/helper.js set it`);
    return paths[name];
  },
  // main.js moves userData for dev builds and legacy Klaussy installs; the
  // helper already resolved the same folder the same way, and keeps it.
  setPath: (name, value) => {
    if (name === 'userData') return;
    paths[name] = value;
  },
  setName: (n) => { app.name = n; },
  getName: () => app.name,
  getVersion: () => require(path.join(ROOT, 'package.json')).version,
  getAppPath: () => ROOT,
  getLocale: () => Intl.DateTimeFormat().resolvedOptions().locale || 'en-US',
  whenReady: () => readyPromise,
  isReady: () => app._ready === true,
  // Closing every tab must not stop the helper: agents keep running and the
  // next tab picks them up. Only Ctrl-C or SIGTERM (web/helper.js stop()) ends it.
  quit: () => {
    if (!app._stopping) return console.log('[web] app.quit() ignored; the helper keeps running');
    app.emit('will-quit', { preventDefault() {} });
    process.exit(0);
  },
  exit: (code) => process.exit(code || 0),
  requestSingleInstanceLock: () => true,
  isAccessibilitySupportEnabled: () => false,
  setAppUserModelId: () => {},
  commandLine: { appendSwitch: () => {}, hasSwitch: () => false },
  dock: undefined,
});

// ---- ipcMain ---------------------------------------------------------------

const handlers = new Map();
const ipcMain = new EventEmitter();
ipcMain.setMaxListeners(0);
ipcMain.handle = (channel, fn) => {
  if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
  handlers.set(channel, fn);
};
ipcMain.handleOnce = (channel, fn) => {
  ipcMain.handle(channel, (...args) => { handlers.delete(channel); return fn(...args); });
};
ipcMain.removeHandler = (channel) => { handlers.delete(channel); };

// ---- windows ---------------------------------------------------------------

let nextId = 1;
const windows = new Map(); // id -> BrowserWindow
let focusedId = null;

// Terminal output kept per window so a tab that reloads or reconnects can
// repaint its terminals. Electron keeps a window's webContents across a reload,
// so main/ never replays; tabs come and go far more often.
const REPLAY_CHANNEL_RE = /^terminal-data-\d+(-\d+)?$/;
const REPLAY_CAP = 256 * 1024;        // per terminal
const REPLAY_MAX_CHANNELS = 64;       // per window; the least recently written go first
const REPLAY_MAX_CHUNKS = 512;        // compacted past this, so trimming stays cheap

class WebContents extends EventEmitter {
  constructor(win) {
    super();
    this.setMaxListeners(0);
    this.id = nextId++;
    this._win = win;
    this._destroyed = false;
    this._socket = null;   // set by the helper when a tab binds to this window
    this._url = '';
    this._replay = new Map(); // channel -> { chunks, size, trimmed }
  }
  send(channel, ...args) {
    if (this._destroyed) return;
    // Recorded even with no tab attached: that's the output a returning tab needs.
    if (REPLAY_CHANNEL_RE.test(channel) && typeof args[0] === 'string') this._record(channel, args[0]);
    if (!this._socket) return;
    this._socket.sendMessage({ t: 'evt', ch: channel, args });
  }
  _record(channel, text) {
    let buf = this._replay.get(channel);
    if (buf) {
      this._replay.delete(channel); // re-inserted below: Map order is recency
    } else {
      buf = { chunks: [], size: 0, trimmed: false, at: 0 };
      if (this._replay.size >= REPLAY_MAX_CHANNELS) this._replay.delete(this._replay.keys().next().value);
    }
    this._replay.set(channel, buf);
    buf.at = Date.now();
    buf.chunks.push(text);
    buf.size += text.length;
    if (buf.size > REPLAY_CAP) {
      // Drop whole chunks from the front; at most one string is rebuilt.
      let drop = 0;
      while (buf.size > REPLAY_CAP && drop < buf.chunks.length - 1) buf.size -= buf.chunks[drop++].length;
      if (drop) { buf.chunks = buf.chunks.slice(drop); buf.trimmed = true; }
    }
    if (buf.chunks.length > REPLAY_MAX_CHUNKS) buf.chunks = [buf.chunks.join('')];
  }
  // Terminals this window has recorded output for, oldest first.
  replayChannels() { return [...this._replay.keys()]; }
  // When this window last recorded output for a terminal (0: never); cheap, no join.
  replayAt(channel) {
    const buf = this._replay.get(channel);
    return buf ? buf.at : 0;
  }
  // The recorded output for one terminal, to send ahead of live output.
  replayText(channel) {
    const buf = this._replay.get(channel);
    if (!buf || !buf.size) return '';
    let text = buf.chunks.join('');
    if (buf.trimmed) {
      // Start on a line boundary so a cut escape sequence doesn't garble it.
      const nl = text.indexOf('\n');
      text = '\x1b[0m' + (nl === -1 ? '' : text.slice(nl + 1));
    }
    return text;
  }
  isDestroyed() { return this._destroyed; }
  isLoading() { return false; }
  getURL() { return this._url; }
  setWindowOpenHandler() {}
  focus() {}
  reload() { this.send('__web:reload'); }
  openDevTools() {}
  executeJavaScript() { return Promise.resolve(undefined); }
  getOSProcessId() { return process.pid; }
}

class BrowserWindow extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.setMaxListeners(0);
    this._opts = opts;
    this._destroyed = false;
    this.webContents = new WebContents(this);
    this.id = this.webContents.id;
    windows.set(this.id, this);
    if (focusedId == null) focusedId = this.id;
  }
  // A window has no screen of its own here: the helper opens a browser tab for
  // it (pop-outs, Preferences, New Window) once main/ has set it up.
  loadFile(file, opts) {
    const query = opts && opts.query ? '?' + new URLSearchParams(opts.query).toString() : '';
    this.webContents._url = 'file://' + file + query;
    this._page = path.basename(file);
    this._query = query;
    setImmediate(() => { if (!this._destroyed && openHook) openHook(this); });
    return Promise.resolve();
  }
  loadURL(url) { this.webContents._url = url; return Promise.resolve(); }
  isDestroyed() { return this._destroyed; }
  isFocused() { return focusedId === this.id; }
  isMinimized() { return false; }
  isVisible() { return true; }
  isMaximized() { return false; }
  focus() { focusedId = this.id; this.webContents.send('__web:focus'); }
  show() {}
  hide() {}
  restore() {}
  minimize() {}
  maximize() {}
  setTitle(title) { this.webContents.send('__web:title', title); }
  getTitle() { return this._opts.title || 'Maussian'; }
  getBounds() { return { x: 0, y: 0, width: 1200, height: 800 }; }
  setBounds() {}
  setSize() {}
  getSize() { return [1200, 800]; }
  setBackgroundColor() {}
  setProgressBar() {}
  flashFrame() {}
  close() { this.destroy(); }
  destroy() {
    if (this._destroyed) return;
    // main/ closing a pop-out ("Pop in") or Preferences closes its tab. A full
    // app window's tab stays: closing the person's main tab is never right.
    if (this._page && this._page !== 'index.html') this.webContents.send('__web:close');
    this.emit('close', { preventDefault() {} });
    this._destroyed = true;
    this.webContents._destroyed = true;
    this.webContents.emit('destroyed');
    windows.delete(this.id);
    if (focusedId === this.id) focusedId = windows.size ? windows.keys().next().value : null;
    // No 'window-all-closed': in the desktop app that saves and kills every
    // pty, but closing the last tab must leave agents running.
    this.emit('closed');
  }
  static getAllWindows() { return [...windows.values()]; }
  static getFocusedWindow() { return windows.get(focusedId) || null; }
  static fromWebContents(wc) { return (wc && wc._win) || null; }
  static fromId(id) { return windows.get(id) || null; }
}

const webContents = {
  fromId: (id) => { const w = windows.get(id); return w ? w.webContents : undefined; },
  getAllWebContents: () => [...windows.values()].map((w) => w.webContents),
  getFocusedWebContents: () => { const w = windows.get(focusedId); return w ? w.webContents : null; },
};

function setFocused(win) { if (win) focusedId = win.id; }

// Set by web/helper.js: called once a window has loaded its page.
let openHook = null;

// ---- dialogs (answered by a tab) -------------------------------------------

function targetWindow(winOrOpts) {
  if (winOrOpts instanceof BrowserWindow && winOrOpts.webContents._socket) return winOrOpts;
  const focused = windows.get(focusedId);
  if (focused && focused.webContents._socket) return focused;
  return [...windows.values()].find((w) => w.webContents._socket) || null;
}

function splitArgs(a, b) {
  return a instanceof BrowserWindow || a == null ? [a, b || {}] : [null, a || {}];
}

function askTab(win, kind, opts, fallback) {
  if (!win) {
    console.warn(`[web] ${kind} dialog with no tab connected:`, opts.title || opts.message || '');
    return Promise.resolve(fallback);
  }
  return win.webContents._socket.request('dialog', { kind, opts }).catch((err) => {
    console.warn(`[web] ${kind} dialog failed:`, err.message);
    return fallback;
  });
}

const dialog = {
  showMessageBox(a, b) {
    const [win, opts] = splitArgs(a, b);
    const cancel = opts.cancelId != null ? opts.cancelId : 0;
    return askTab(targetWindow(win), 'message', opts, { response: cancel, checkboxChecked: false });
  },
  // A synchronous answer can't come from a tab; take the default button.
  showMessageBoxSync(a, b) {
    const [, opts] = splitArgs(a, b);
    console.warn('[web] showMessageBoxSync answered with its default:', opts.message || '');
    return opts.defaultId != null ? opts.defaultId : 0;
  },
  // One-way: nothing waits on an error box, so nothing is left pending.
  showErrorBox(title, content) {
    const win = targetWindow(null);
    if (win) win.webContents.send('__web:error-box', { title, message: content });
    else console.error('[web] error box:', title, content);
  },
  showOpenDialog(a, b) {
    const [win, opts] = splitArgs(a, b);
    return askTab(targetWindow(win), 'open', opts, { canceled: true, filePaths: [] });
  },
  showSaveDialog(a, b) {
    const [win, opts] = splitArgs(a, b);
    return askTab(targetWindow(win), 'save', opts, { canceled: true, filePath: undefined });
  },
};

// ---- shell, clipboard, notifications ---------------------------------------

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
  });
}

// Never through `cmd /c start`: cmd re-parses its arguments, so a URL with `&`
// in it would run a second command.
function openWithOS(target) {
  if (process.platform === 'darwin') return run('open', [target]);
  if (process.platform === 'win32') return run('explorer.exe', [target]);
  return run('xdg-open', [target]);
}

function openUrlWithOS(url) {
  if (process.platform === 'win32') return run('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  return openWithOS(url);
}

// PowerShell single-quoted string: only ' needs escaping, by doubling it.
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

const shell = {
  openExternal(url) {
    let parsed;
    try { parsed = new URL(String(url)); } catch { return Promise.reject(new Error('Not a URL')); }
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return Promise.reject(new Error('Blocked URL scheme'));
    return openUrlWithOS(parsed.href);
  },
  // Same contract as Electron's: main/ decides which paths it opens.
  openPath(p) { return openWithOS(p).then(() => '', (e) => e.message); },
  showItemInFolder(p) {
    if (process.platform === 'darwin') run('open', ['-R', p]).catch(() => {});
    else if (process.platform === 'win32') run('explorer', ['/select,', p]).catch(() => {});
    else openWithOS(path.dirname(p)).catch(() => {});
  },
  // The OS's own trash on every platform, so it works across volumes and the
  // item can be put back. Never falls back to deleting.
  async trashItem(p) {
    const target = path.resolve(String(p));
    if (process.platform === 'darwin') {
      if (fs.existsSync('/usr/bin/trash')) return run('/usr/bin/trash', [target]);
      // The path goes in as an argument, never into the script text.
      return run('osascript', ['-e', 'on run argv',
        '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
        '-e', 'end run', target]);
    }
    if (process.platform === 'win32') {
      const script = 'Add-Type -AssemblyName Microsoft.VisualBasic; $p = ' + psQuote(target) + '; '
        + 'if (Test-Path -LiteralPath $p -PathType Container) '
        + "{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } "
        + "else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }";
      return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')]);
    }
    return run('gio', ['trash', target]);
  },
  beep() {},
};

const clipboard = {
  writeText(text) {
    const cmd = process.platform === 'darwin' ? ['pbcopy', []]
      : process.platform === 'win32' ? ['clip', []] : ['xclip', ['-selection', 'clipboard']];
    try {
      const child = spawn(cmd[0], cmd[1], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => {});
      child.stdin.end(String(text));
    } catch {}
  },
  readText() { return ''; },
};

class Notification extends EventEmitter {
  constructor(opts = {}) { super(); this._opts = opts; }
  static isSupported() { return true; }
  show() {
    const win = targetWindow(null);
    if (win) win.webContents.send('__web:notification', { title: this._opts.title, body: this._opts.body });
  }
  close() {}
}

// ---- the rest: harmless stand-ins -----------------------------------------

const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false, themeSource: 'system' });
const powerMonitor = new EventEmitter();
const systemPreferences = Object.assign(new EventEmitter(), {
  getMediaAccessStatus: () => 'granted',
  askForMediaAccess: () => Promise.resolve(true),
  isTrustedAccessibilityClient: () => false,
  getUserDefault: () => undefined,
});
const emptyImage = { isEmpty: () => true, toDataURL: () => '', toPNG: () => Buffer.alloc(0), resize: () => emptyImage };
const nativeImage = { createFromPath: () => emptyImage, createEmpty: () => emptyImage, createFromDataURL: () => emptyImage };
class MenuItem { constructor(opts) { Object.assign(this, opts); } }
const Menu = {
  buildFromTemplate: (items) => ({ items: items || [], popup() {}, append() {} }),
  setApplicationMenu() {},
  getApplicationMenu: () => null,
};
const protocol = { registerSchemesAsPrivileged() {}, handle() {}, registerFileProtocol() {}, unhandle() {} };
const defaultSession = {
  setPermissionRequestHandler() {},
  setPermissionCheckHandler() {},
  setDevicePermissionHandler() {},
  getPreloads: () => [],
  setPreloads() {},
  registerPreloadScript() {},
  getPreloadScripts: () => [],
  protocol,
  webRequest: { onHeadersReceived() {}, onBeforeRequest() {} },
};
const session = { defaultSession, fromPartition: () => defaultSession };
const net = { fetch: (...args) => globalThis.fetch(...args) };
const crashReporter = { start() {} };
const autoUpdater = Object.assign(new EventEmitter(), { checkForUpdates() {}, setFeedURL() {} });

module.exports = {
  app, ipcMain, BrowserWindow, webContents, dialog, shell, clipboard, Notification,
  nativeTheme, powerMonitor, systemPreferences, nativeImage, Menu, MenuItem, protocol,
  session, net, crashReporter, autoUpdater,
  // For web/helper.js only.
  __web: {
    handlers,
    setFocused,
    setUserData,
    setOpenHook: (fn) => { openHook = fn; },
    markReady: () => { app._ready = true; app.emit('ready'); markReady(); },
  },
};
