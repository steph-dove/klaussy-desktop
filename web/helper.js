// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Browser-mode helper: runs the desktop app's main process without Electron and
// serves the renderer to a browser tab on 127.0.0.1.
//
//   npm run web            (ELECTRON_RUN_AS_NODE=1 electron web/helper.js)
//
// It runs under Electron's Node so node-pty keeps the ABI it was rebuilt for.
// require('electron') resolves to web/electron-shim.js, so main.js and every
// handler in main/ipc load unchanged. The browser runs the real preload.js with
// web/bridge.js standing in for ipcRenderer over a WebSocket.
//
// Security (a localhost server that can open shells is remote code execution
// for any page that reaches it). The checks themselves live in web/guards.js:
//   * listens on 127.0.0.1 only;
//   * every HTTP request must carry a Host of 127.0.0.1:<port> or
//     localhost:<port> (DNS rebinding);
//   * the WebSocket and the two POST endpoints require an allowed Origin and
//     the helper's token, compared in constant time;
//   * the token reaches the browser only in the URL fragment the helper opens;
//   * a malformed request gets a 400, never an exception: any website can send
//     requests here, and a crash would take every running agent with it.
// Static files come from an allowlist of folders and are not secret.
//
// Stop it with Ctrl-C or SIGTERM; it saves sessions first.

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const guards = require('./guards');

const SHIM = require.resolve('./electron-shim');
// electron-log picks its plain-Node build outside Electron, which has no
// initialize(); main/ expects the main-process build.
const ELECTRON_LOG_MAIN = require.resolve('electron-log/main');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'electron') return SHIM;
  if (request === 'electron-log') return ELECTRON_LOG_MAIN;
  return originalResolve.call(this, request, ...rest);
};

const electron = require('./electron-shim');
const { WebSocketServer } = require('ws');

const ROOT = path.join(__dirname, '..');
const BASE_PORT = Number(process.env.MAUSSIAN_PORT) || 43117;
const PORT_TRIES = 10;
const HELLO_TIMEOUT_MS = 2000;
const SECONDARY_GRACE_MS = 15000;
const BIND_RESERVE_MS = 10000;
// Before the hello, a socket may only say hello: a few hundred bytes. Anything
// bigger is dropped unparsed, and only a handful may wait at once.
const PRE_AUTH_MAX_BYTES = 4096;
const PRE_AUTH_MAX_SOCKETS = 8;

const args = new Set(process.argv.slice(2));

function openInBrowser(link) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(opener, [link], () => {});
}

// The link carries the token, so it's only printed when asked for (--no-open),
// to keep it out of terminal logs otherwise.
function announce(link, already) {
  const lead = already ? 'Maussian is already running on this computer.' : 'Maussian is running on this computer.';
  if (args.has('--no-open')) {
    console.log(`\n${lead}\nOpen: ${link}\n`);
  } else {
    console.log(`\n${lead} Opened it in your browser.\n`);
    openInBrowser(link);
  }
}

// ---- one Maussian: the desktop app's settings folder ---------------------------

// Resolved exactly as main/bootstrap/single-instance.js does for the desktop
// app, so both see the same projects, sessions and settings. Run from source
// it matches `npm start` (the -dev folder); --installed shares the installed
// app's folder instead.
function resolveUserData() {
  const { legacyUserDataDir } = require(path.join(ROOT, 'main/bootstrap/single-instance'));
  const appData = electron.app.getPath('appData');
  const current = path.join(appData, 'Maussian');
  const dir = legacyUserDataDir(appData, current) || current;
  return args.has('--installed') ? dir : dir + '-dev';
}

const USER_DATA = resolveUserData();
electron.__web.setUserData(USER_DATA);
const instanceLock = require(path.join(ROOT, 'main/util/instance-lock'));

{
  const taken = instanceLock.acquire(USER_DATA, { kind: 'web' });
  if (!taken.ok) {
    const holder = taken.holder || {};
    if (holder.kind === 'web') {
      const link = instanceLock.browserUrl(USER_DATA, holder);
      if (link) announce(link, true);
      else console.log('\nMaussian is already starting on this computer. Try again in a moment.\n');
      process.exit(0);
    }
    console.error('\nThe Maussian desktop app is running. It shares your projects and sessions with the '
      + 'browser version, so only one runs at a time. Quit the desktop app, then run this again.\n');
    process.exit(1);
  }
  process.on('exit', () => instanceLock.release(USER_DATA));
}

// ---- token -------------------------------------------------------------------

// Kept across restarts, so `npm run web` can reopen a signed-in tab whether or
// not the helper was already running. `--new-token` rotates it.
function loadToken() {
  const file = path.join(USER_DATA, instanceLock.TOKEN_FILE);
  if (!args.has('--new-token')) {
    try {
      const t = fs.readFileSync(file, 'utf8').trim();
      if (/^[A-Za-z0-9_-]{43}$/.test(t)) return t;
    } catch {}
  }
  const t = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}
const TOKEN = loadToken();
const TOKEN_BUF = Buffer.from(TOKEN);
const tokenOk = (candidate) => guards.tokenMatches(candidate, TOKEN_BUF);

// ---- boot the desktop main process -----------------------------------------

require(path.join(ROOT, 'main.js'));
const windowsState = require(path.join(ROOT, 'main/state/windows'));
const { BrowserWindow, ipcMain } = electron;

// Folder browser for the in-page open dialog (web/bridge.js). Limited to the
// home folder: repos live there, and nothing else needs listing.
const HOME = fs.realpathSync.native(os.homedir());
function insideHome(p) {
  const rel = path.relative(HOME, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
ipcMain.handle('__web:list-dir', async (_event, dir) => {
  const target = await fs.promises.realpath(path.resolve(typeof dir === 'string' && dir ? dir : HOME));
  if (!insideHome(target)) throw new Error('Choose a folder inside your home folder');
  const entries = await fs.promises.readdir(target, { withFileTypes: true });
  const visible = entries.filter((e) => !e.name.startsWith('.'));
  return {
    path: target,
    parent: target === HOME ? null : path.dirname(target),
    sep: path.sep,
    dirs: visible.filter((e) => e.isDirectory()).map((e) => e.name).sort(),
    files: visible.filter((e) => e.isFile()).map((e) => e.name).sort(),
  };
});

// ---- wire encoding (Buffers survive as base64) ------------------------------

function encode(obj) {
  return JSON.stringify(obj, (_k, v) => {
    if (v && v.type === 'Buffer' && Array.isArray(v.data)) return { __b64: Buffer.from(v.data).toString('base64') };
    if (v instanceof Uint8Array) return { __b64: Buffer.from(v).toString('base64') };
    return v;
  });
}
function decode(text) {
  return JSON.parse(text, (_k, v) => (v && typeof v.__b64 === 'string' && Object.keys(v).length === 1
    ? Buffer.from(v.__b64, 'base64') : v));
}

// ---- windows <-> tabs -------------------------------------------------------

const reservedUntil = new Map(); // winId -> ms; a /__bind waiting for its socket
const closeTimers = new Map();   // winId -> timeout for an unbound secondary

// A reservation keeps other tabs off a window between /__bind and its socket.
// The tab it was made for asks by id (from its sessionStorage), and may take
// it back: a secondary window's page reloads once to add ?secondary=1.
function isFree(win, { ownReservation = false } = {}) {
  return win && !win.isDestroyed() && !win.webContents._socket
    && (ownReservation || !(reservedUntil.get(win.id) > Date.now()));
}

// A reload asks for the window it had; a new tab takes the main window if no
// tab holds it, else gets a secondary window like a desktop "New Window".
function pickWindow(wantId) {
  const wanted = wantId ? BrowserWindow.fromId(Number(wantId)) : null;
  if (isFree(wanted, { ownReservation: true })) return wanted;
  const main = windowsState.getMainWindow();
  if (isFree(main)) return main;
  return windowsState.createWindow({ secondary: true });
}

function queryOf(win) {
  const url = win.webContents.getURL();
  const i = url.indexOf('?');
  return i === -1 ? '' : url.slice(i);
}

function makeEvent(win) {
  return { sender: win.webContents, senderFrame: { url: win.webContents.getURL() }, frameId: 0, processId: 0, returnValue: undefined };
}

class TabSocket {
  constructor(ws) {
    this.ws = ws;
    this.pending = new Map();
    this.seq = 0;
    this.replayed = new Set(); // terminal channels already repainted for this tab
  }
  sendMessage(obj) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(encode(obj));
  }
  request(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendMessage({ t: 'req', id, method, params });
    });
  }
  failPending() {
    for (const { reject } of this.pending.values()) reject(new Error('Tab disconnected'));
    this.pending.clear();
  }
}

function bindSocket(win, tab) {
  clearTimeout(closeTimers.get(win.id));
  closeTimers.delete(win.id);
  reservedUntil.delete(win.id);
  win.webContents._socket = tab;
  electron.__web.setFocused(win);
  win.webContents.emit('did-finish-load');
}

// A secondary window with no tab for a while is closed, like closing a desktop
// window. The main window outlives its tabs.
function scheduleClose(win, delayMs) {
  if (win === windowsState.getMainWindow()) return;
  clearTimeout(closeTimers.get(win.id));
  closeTimers.set(win.id, setTimeout(() => {
    closeTimers.delete(win.id);
    if (isFree(win)) win.destroy();
  }, delayMs));
}

function unbindSocket(win, tab) {
  if (win.webContents._socket !== tab) return;
  win.webContents._socket = null;
  scheduleClose(win, SECONDARY_GRACE_MS);
}

// A fresh page builds empty terminals; repaint each from the window's recorded
// output the first time this tab subscribes to it. Sent before the subscribe
// reaches main/, so anything main/ flushes on subscribe lands after it, in
// order. Later subscribes from the same page (rewireTerminal) reuse the
// terminal that already shows it, so they get nothing.
function replayTerminal(win, tab, channel) {
  if (typeof channel !== 'string' || tab.replayed.has(channel)) return;
  tab.replayed.add(channel);
  const text = win.webContents.replayText(channel);
  if (text) tab.sendMessage({ t: 'evt', ch: channel, args: [text] });
}

// A page that kept running through a dropped connection still has its
// terminals, but missed whatever they printed meanwhile, and won't subscribe
// again. Reset each one (ESC c) and repaint it from the recorded output.
function resyncTerminals(win, tab) {
  for (const channel of win.webContents.replayChannels()) {
    tab.replayed.add(channel);
    tab.sendMessage({ t: 'evt', ch: channel, args: ['\x1bc' + win.webContents.replayText(channel)] });
  }
}

async function dispatchInvoke(win, msg, tab) {
  try {
    const fn = electron.__web.handlers.get(msg.ch);
    if (!fn) throw new Error(`No handler registered for '${msg.ch}'`);
    const value = await fn(makeEvent(win), ...(msg.args || []));
    tab.sendMessage({ t: 'res', id: msg.id, ok: true, value });
  } catch (err) {
    tab.sendMessage({ t: 'res', id: msg.id, ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ipcRenderer.send(): a listener that throws must not reach the socket's
// 'message' handler, where it would crash the helper and every agent with it.
function dispatchSend(win, msg, tab) {
  if (typeof msg.ch !== 'string' || msg.ch === 'error') return;
  if (msg.ch === 'subscribe-terminal') replayTerminal(win, tab, msg.args && msg.args[0]);
  try {
    ipcMain.emit(msg.ch, makeEvent(win), ...(Array.isArray(msg.args) ? msg.args : []));
  } catch (err) {
    console.error(`[web] listener for '${msg.ch}' threw:`, err);
  }
}

// ---- http -------------------------------------------------------------------

const STATIC_ROOTS = [
  'renderer/',
  'web/bridge.js',
  'node_modules/@xterm/',
  'node_modules/dompurify/',
  'node_modules/highlight.js/',
  'node_modules/markdown-it/',
  'node_modules/monaco-editor/',
  'icon.png',
  'brand-mark.png',
];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.map': 'application/json',
  '.ico': 'image/x-icon', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

let port = null; // set once listening; every check before then fails closed
const hostOk = (host) => port != null && guards.hostOk(host, port);
const originOk = (origin) => port != null && guards.originOk(origin, port);

function send(res, status, body, type) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function renderIndex() {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  return html.replace('<title>', '<script src="/web/bridge.js"></script><script src="/web/preload.js"></script>\n  <title>');
}

function renderPreload() {
  const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const proc = JSON.stringify({ platform: process.platform, env: {}, versions: {} });
  return `(function (require, process) {\n${src}\n})(window.__maussianRequire, ${proc});\n`;
}

async function handlePost(req, res, url) {
  if (!originOk(req.headers.origin) || !tokenOk(req.headers['x-maussian-token'])) return send(res, 401, 'Unauthorized');
  let body;
  try { body = decode(await readBody(req) || '{}'); } catch { return send(res, 400, 'Bad request'); }
  if (!body || typeof body !== 'object') return send(res, 400, 'Bad request');

  if (url.pathname === '/__bind') {
    const win = pickWindow(body.winId);
    reservedUntil.set(win.id, Date.now() + BIND_RESERVE_MS);
    // If its tab never connects, don't keep it forever.
    if (!win.webContents._socket) scheduleClose(win, BIND_RESERVE_MS + SECONDARY_GRACE_MS);
    return send(res, 200, encode({ winId: win.id, query: queryOf(win), platform: process.platform, home: HOME }), 'application/json');
  }

  if (url.pathname === '/__sync') {
    const win = BrowserWindow.fromId(Number(body.winId));
    if (!win || !guards.SYNC_CHANNELS.has(body.ch)) return send(res, 400, 'Bad request');
    const event = makeEvent(win);
    try {
      ipcMain.emit(body.ch, event, ...(Array.isArray(body.args) ? body.args : []));
    } catch (err) {
      console.error(`[web] sync listener for '${body.ch}' threw:`, err);
      return send(res, 500, 'Sync handler failed');
    }
    return send(res, 200, encode({ value: event.returnValue }), 'application/json');
  }
  return send(res, 404, 'Not found');
}

function handleGet(req, res, url) {
  let rel = guards.decodePath(url.pathname);
  if (rel == null) return send(res, 400, 'Bad request');
  if (rel === '') {
    res.writeHead(302, { Location: '/renderer/index.html' });
    return res.end();
  }
  if (rel === 'favicon.ico') rel = 'icon.png';
  if (rel === 'renderer/index.html') {
    // frame-ancestors only works as a header; the page's <meta> CSP can't set it.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    return send(res, 200, renderIndex(), TYPES['.html']);
  }
  if (rel === 'web/preload.js') return send(res, 200, renderPreload(), TYPES['.js']);

  const real = guards.resolveStatic(ROOT, rel, STATIC_ROOTS);
  if (!real) return send(res, 404, 'Not found');
  fs.stat(real, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  try {
    if (!hostOk(req.headers.host)) return send(res, 403, 'Forbidden');
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'POST') {
      handlePost(req, res, url).catch((err) => {
        console.error('[web] POST failed:', err);
        send(res, 500, 'Internal error');
      });
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') return handleGet(req, res, url);
    return send(res, 405, 'Method not allowed');
  } catch (err) {
    // Any website can send requests here; a bad one gets a 400, not a crash.
    console.error('[web] bad request:', err.message);
    return send(res, 400, 'Bad request');
  }
});

// ---- websocket ----------------------------------------------------------------

let preAuthSockets = 0;

const wss = new WebSocketServer({
  server,
  path: '/__ws',
  maxPayload: 64 * 1024 * 1024,
  verifyClient: ({ origin, req }) => hostOk(req.headers.host) && originOk(origin),
});

wss.on('connection', (ws) => {
  if (preAuthSockets >= PRE_AUTH_MAX_SOCKETS) return ws.close(1013, 'Busy');
  preAuthSockets++;
  let authed = false;
  const tab = new TabSocket(ws);
  let win = null;
  const helloTimer = setTimeout(() => ws.close(4401, 'No hello'), HELLO_TIMEOUT_MS);

  ws.on('message', (data) => {
    if (!win && data.length > PRE_AUTH_MAX_BYTES) return ws.close(1009, 'Too big');
    let msg;
    try { msg = decode(data.toString()); } catch { return ws.close(4400, 'Bad message'); }
    if (!msg || typeof msg !== 'object') return ws.close(4400, 'Bad message');

    if (!win) {
      if (msg.t !== 'hello' || !tokenOk(msg.token)) return ws.close(4401, 'Unauthorized');
      const wanted = BrowserWindow.fromId(Number(msg.winId));
      if (!wanted || wanted.isDestroyed() || (wanted.webContents._socket && wanted.webContents._socket !== tab)) {
        return ws.close(4409, 'Window unavailable');
      }
      clearTimeout(helloTimer);
      authed = true;
      preAuthSockets--;
      win = wanted;
      bindSocket(win, tab);
      tab.sendMessage({ t: 'welcome', winId: win.id });
      if (msg.resume === true) resyncTerminals(win, tab);
      return;
    }

    switch (msg.t) {
      case 'invoke': dispatchInvoke(win, msg, tab); break;
      case 'send': dispatchSend(win, msg, tab); break;
      case 'res': {
        const p = tab.pending.get(msg.id);
        if (p) { tab.pending.delete(msg.id); (msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error))); }
        break;
      }
      case 'focus': electron.__web.setFocused(win); break;
      default: break;
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (!authed) preAuthSockets--;
    tab.failPending();
    if (win) unbindSocket(win, tab);
  });
});

// ---- start / stop -------------------------------------------------------------

function onListening() {
  // The desktop app and a second `npm run web` find us through the lock.
  instanceLock.update(USER_DATA, { port });
  electron.__web.markReady();
  announce(`http://127.0.0.1:${port}/renderer/index.html#token=${TOKEN}`, false);
}

// Another program may own the default port; the lock file records the one we
// got, which is how the desktop app and a second start find us.
function listen(attempt) {
  const candidate = BASE_PORT + attempt;
  const onError = (err) => {
    server.removeListener('listening', onListeningOnce);
    if (err.code === 'EADDRINUSE' && attempt + 1 < PORT_TRIES) return listen(attempt + 1);
    console.error('[web] could not listen:', err.message);
    process.exit(1);
  };
  const onListeningOnce = () => {
    server.removeListener('error', onError);
    port = candidate;
    onListening();
  };
  server.once('error', onError);
  server.once('listening', onListeningOnce);
  server.listen(candidate, '127.0.0.1');
}

// app-events' before-quit handler cancels the first quit, awaits the session
// save, then quits again; only that second quit exits (see electron-shim's
// app.quit). The timer is the backstop if the save hangs.
function stop() {
  if (electron.app._stopping) return;
  electron.app._stopping = true;
  setTimeout(() => process.exit(0), 5000).unref();
  const evt = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  electron.app.emit('before-quit', evt);
  if (!evt.defaultPrevented) electron.app.quit();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

listen(0);
