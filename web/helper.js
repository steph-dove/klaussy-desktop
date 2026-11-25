// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Browser-mode helper: runs the desktop app's main process without Electron and
// serves the renderer to a browser tab on 127.0.0.1.
//
//   npm run web                    (ELECTRON_RUN_AS_NODE=1 electron web/helper.js)
//   npm run web -- --unpair-all    forget every paired browser, open tabs included
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
//   * every POST and the WebSocket require an allowed Origin;
//   * a browser pairs once with a one-time code from the helper's link and a
//     non-extractable WebCrypto key, then signs in by signing a challenge
//     (main/util/web-pairing.js). The session ticket it gets lives only in this
//     process's memory; /__bind, /__sync and the socket all require one;
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
const policy = require('./window-policy');

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
const BIND_RESERVE_MS = 10000;
// A window someone asked for: closed if no tab shows up for it. Longer once a
// popup blocker stopped the tab, since the person then has to click a button.
const OPEN_WAIT_MS = 60000;
const BLOCKED_WAIT_MS = 10 * 60 * 1000;
// Before the hello, a socket may only say hello: a few hundred bytes. Anything
// bigger is dropped unparsed, and only a handful may wait at once.
const PRE_AUTH_MAX_BYTES = 4096;
const PRE_AUTH_MAX_SOCKETS = 8;

const args = new Set(process.argv.slice(2));

function openInBrowser(link) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(opener, [link], () => {});
}

// The link carries a one-time pairing code (5 minutes, single use), so it's only
// printed when asked for (--no-open), to keep it out of terminal logs otherwise.
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
  // Tests (test/web) point the helper at a throwaway folder.
  if (process.env.MAUSSIAN_WEB_USERDATA) return process.env.MAUSSIAN_WEB_USERDATA;
  const { legacyUserDataDir } = require(path.join(ROOT, 'main/bootstrap/single-instance'));
  const appData = electron.app.getPath('appData');
  const current = path.join(appData, 'Maussian');
  const dir = legacyUserDataDir(appData, current) || current;
  return args.has('--installed') ? dir : dir + '-dev';
}

const USER_DATA = resolveUserData();
electron.__web.setUserData(USER_DATA);
const instanceLock = require(path.join(ROOT, 'main/util/instance-lock'));
const pairing = require(path.join(ROOT, 'main/util/web-pairing'));

// The panic button. Works whether or not a helper is running: a running one
// sees the file change and closes every tab it signed in.
if (args.has('--unpair-all')) {
  const n = pairing.removeAllBrowsers(USER_DATA);
  console.log(`\nForgot ${n} paired browser${n === 1 ? '' : 's'}. Running \`npm run web\` pairs this one again.\n`);
  process.exit(0);
}

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

// ---- pairing and sessions ------------------------------------------------------

// Earlier builds kept a long-lived token here; browsers pair now.
fs.rmSync(path.join(USER_DATA, 'web-token'), { force: true });

const { SessionStore } = require('./sessions');
// Re-read on every check rather than cached by mtime: the file is tiny, and an
// unpair followed by a re-pair inside one mtime tick must not slip through.
const isPaired = (browserId) => !!pairing.findBrowser(USER_DATA, browserId);
const sessions = new SessionStore({ isPaired });

// Pairing attempts, all browsers together: a burst of bad codes gets 429.
const PAIR_ATTEMPTS_PER_MINUTE = 20;
let pairAttempts = [];
function pairAllowed() {
  const now = Date.now();
  pairAttempts = pairAttempts.filter((t) => now - t < 60000);
  if (pairAttempts.length >= PAIR_ATTEMPTS_PER_MINUTE) return false;
  pairAttempts.push(now);
  return true;
}

// ---- boot the desktop main process -----------------------------------------

require(path.join(ROOT, 'main.js'));
const windowsState = require(path.join(ROOT, 'main/state/windows'));
const { BrowserWindow, ipcMain } = electron;
electron.__web.setOpenHook((win) => openTabFor(win));

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
// `strict` is a tab opened for one particular window (a pop-out): it gets that
// window or nothing, never the main app in its place.
function pickWindow(wantId, strict) {
  const wanted = wantId ? BrowserWindow.fromId(Number(wantId)) : null;
  if (isFree(wanted, { ownReservation: true })) return wanted;
  if (strict) return null;
  const main = windowsState.getMainWindow();
  if (isFree(main)) return main;
  return windowsState.createWindow({ secondary: true });
}

function queryOf(win) {
  return win._query || '';
}

function pageOf(win) {
  return policy.pageFor(win._page);
}

// main/ opened a window (a pop-out, Preferences, New Window): ask the tab the
// person is using to open a tab for it, bound to that window. Popup blockers
// allow it because it follows their click within moments; if one blocks it
// anyway, bridge.js offers a button and says so ('open-blocked').
// A window /__bind just made for a new tab is reserved for that tab by the
// time this runs (loadFile defers the hook), so it never gets a second tab.
function openTabFor(win) {
  const page = pageOf(win);
  if (page == null) {
    console.warn(`[web] can't show a window that loads ${win._page}; it has no tab`);
    return;
  }
  const isMain = win === windowsState.getMainWindow();
  const reserved = reservedUntil.get(win.id) > Date.now();
  if (!policy.needsTab({ hasTab: !!win.webContents._socket, isMain, reserved, page })) return;
  const candidates = BrowserWindow.getAllWindows()
    .filter((w) => w !== win && w.webContents._socket)
    .map((w) => ({ id: w.id, lastActive: w._lastActive, win: w }));
  const focused = BrowserWindow.getFocusedWindow();
  const opener = policy.pickOpener(candidates, focused && focused.id);
  if (!opener) {
    console.log(`[web] a ${page} window opened with no tab to show it`);
    return;
  }
  opener.win.webContents.send('__web:open-window', {
    winId: win.id,
    path: `/renderer/${page}${queryOf(win)}`,
    title: win.getTitle(),
  });
  scheduleClose(win, OPEN_WAIT_MS); // nobody opened it: close it like an unused window
}

// The tab the person is using: dialogs and new tabs go to it. Set from real
// input in the page (bridge.js 'focus'), never from background calls.
function markActive(win) {
  win._lastActive = Date.now();
  electron.__web.setFocused(win);
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
    this.unloading = false;    // the page said it's going away (pagehide)
    this.loadedSent = false;   // did-finish-load is emitted once per page
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
  markActive(win); // a tab that just opened was opened by the person
  // Pop-outs and Preferences are titled by main/; the main page titles itself.
  if (pageOf(win) !== 'index.html') tab.sendMessage({ t: 'evt', ch: '__web:title', args: [win.getTitle()] });
  // 'did-finish-load' waits for the page's own 'loaded' message: main/ sends
  // on it (popout-init), and the page's listeners don't exist before then.
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
  scheduleClose(win, policy.graceFor(pageOf(win), tab.unloading));
}

// A fresh page builds empty terminals; repaint each from the window's recorded
// output the first time this tab subscribes to it. Sent before the subscribe
// reaches main/, so anything main/ flushes on subscribe lands after it, in
// order. Later subscribes from the same page (rewireTerminal) reuse the
// terminal that already shows it, so they get nothing.
// A window showing this terminal for the first time (a pop-out, a new window)
// has nothing recorded yet; it starts from the window that recorded it most
// recently, and only that one's buffer is joined.
function replayTerminal(win, tab, channel) {
  if (typeof channel !== 'string' || tab.replayed.has(channel)) return;
  tab.replayed.add(channel);
  let source = win;
  if (!win.webContents.replayAt(channel)) {
    let newest = 0;
    for (const other of BrowserWindow.getAllWindows()) {
      const at = other === win ? 0 : other.webContents.replayAt(channel);
      if (at > newest) { newest = at; source = other; }
    }
  }
  const text = source.webContents.replayText(channel);
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
      if (size > limit) return; // already refused; just drain the rest
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { tooLarge: true })); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// A renderer page with the bridge and the wrapped preload ahead of its own
// scripts, which expect window.klaus to exist when they run.
function renderPage(page) {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', page), 'utf8');
  return html.replace('<title>', '<script src="/web/bridge.js"></script><script src="/web/preload.js"></script>\n  <title>');
}

function renderPreload() {
  const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const proc = JSON.stringify({ platform: process.platform, env: {}, versions: {} });
  return `(function (require, process) {\n${src}\n})(window.__maussianRequire, ${proc});\n`;
}

async function handlePost(req, res, url) {
  if (!originOk(req.headers.origin)) return send(res, 401, 'Unauthorized');
  let body;
  try {
    body = decode(await readBody(req, 64 * 1024) || '{}');
  } catch (err) {
    return send(res, err && err.tooLarge ? 413 : 400, err && err.tooLarge ? 'Too large' : 'Bad request');
  }
  if (!body || typeof body !== 'object') return send(res, 400, 'Bad request');

  // Pairing: a one-time code from the helper's link registers the public half
  // of the page's WebCrypto key.
  if (url.pathname === '/__pair') {
    if (!pairAllowed()) return send(res, 429, 'Too many attempts');
    const r = pairing.pairBrowser(USER_DATA, body.code, body.publicKey, body.label);
    if (r.error === 'bad-key') return send(res, 400, 'Bad key');      // the code is still good
    if (r.error === 'full') return send(res, 409, 'Too many paired browsers'); // and here
    if (r.error) return send(res, 401, 'Unauthorized');
    return send(res, 200, encode({ browserId: r.browserId }), 'application/json');
  }

  // Signing in: a fresh challenge, signed with that key, buys a session ticket.
  if (url.pathname === '/__challenge') {
    if (!pairing.findBrowser(USER_DATA, body.browserId)) return send(res, 401, 'Unauthorized');
    const r = sessions.challengeFor(body.browserId);
    if (r.error) return send(res, 429, 'Too many attempts');
    return send(res, 200, encode({ challenge: r.challenge }), 'application/json');
  }
  if (url.pathname === '/__session') {
    const browser = pairing.findBrowser(USER_DATA, body.browserId);
    if (!browser) return send(res, 401, 'Unauthorized');
    const r = sessions.signIn(browser.id, body.challenge,
      () => pairing.verifyChallenge(browser.jwk, body.challenge, body.signature));
    if (r.error === 'limited') return send(res, 429, 'Too many attempts');
    if (r.error) return send(res, 401, 'Unauthorized');
    return send(res, 200, encode({ ticket: r.ticket }), 'application/json');
  }

  // Everything else needs a session.
  if (!sessions.browserFor(req.headers['x-maussian-ticket'])) return send(res, 401, 'Unauthorized');

  if (url.pathname === '/__bind') {
    // A tab opened for a particular window that's gone (closed, or it waited
    // too long behind a popup blocker) gets 410 and says so, rather than
    // showing the main app or a page that can't be served in its place.
    const win = pickWindow(body.winId, body.forWin === true);
    if (!win || pageOf(win) == null) return send(res, 410, 'Gone');
    reservedUntil.set(win.id, Date.now() + BIND_RESERVE_MS);
    // If its tab never connects, don't keep it forever.
    if (!win.webContents._socket) scheduleClose(win, BIND_RESERVE_MS + policy.GRACE_MS.closingWindow);
    return send(res, 200, encode({
      winId: win.id, page: pageOf(win), query: queryOf(win), platform: process.platform, home: HOME,
    }), 'application/json');
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
  const page = rel.startsWith('renderer/') && rel.slice('renderer/'.length);
  if (page && policy.PAGES.has(page)) {
    // frame-ancestors only works as a header; the page's <meta> CSP can't set it.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    return send(res, 200, renderPage(page), TYPES['.html']);
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
  ws.tab = tab;
  let win = null;
  const helloTimer = setTimeout(() => ws.close(4401, 'No hello'), HELLO_TIMEOUT_MS);

  ws.on('message', (data) => {
    if (!win && data.length > PRE_AUTH_MAX_BYTES) return ws.close(1009, 'Too big');
    let msg;
    try { msg = decode(data.toString()); } catch { return ws.close(4400, 'Bad message'); }
    if (!msg || typeof msg !== 'object') return ws.close(4400, 'Bad message');

    if (!win) {
      const browserId = msg.t === 'hello' ? sessions.browserFor(msg.ticket) : null;
      if (!browserId) return ws.close(4401, 'Unauthorized');
      tab.browserId = browserId;
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
      case 'focus': markActive(win); break;
      case 'unloading': tab.unloading = true; break;
      // Once per page, however often a page (or a raw socket) says it.
      case 'loaded':
        if (!tab.loadedSent) { tab.loadedSent = true; win.webContents.emit('did-finish-load'); }
        break;
      // A popup blocker stopped a tab for this window; the person now has to
      // click the page's button, so give them longer before it closes.
      case 'open-blocked': {
        const target = BrowserWindow.fromId(Number(msg.winId));
        if (target && target !== win && !target.webContents._socket) scheduleClose(target, BLOCKED_WAIT_MS);
        break;
      }
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
  announce(`http://127.0.0.1:${port}/renderer/index.html#pair=${pairing.mintPairCode(USER_DATA)}`, false);
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

// --unpair-all from another terminal: tabs signed in by a browser that's no
// longer paired are closed, not just refused next time. Expired challenges and
// idle sessions are dropped on the same beat.
setInterval(() => {
  const ids = new Set(pairing.listBrowsers(USER_DATA).map((b) => b.id));
  for (const ws of wss.clients) {
    if (ws.tab && ws.tab.browserId && !ids.has(ws.tab.browserId)) ws.close(4401, 'Unpaired');
  }
  sessions.prune();
}, 2000).unref();

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
