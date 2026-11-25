require('../setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const guards = require('../../web/guards');
const { BrowserWindow } = require('../../web/electron-shim');

// ---- request checks --------------------------------------------------------

test('Host must name 127.0.0.1 or localhost on the helper’s port', () => {
  assert.strictEqual(guards.hostOk('127.0.0.1:43117', 43117), true);
  assert.strictEqual(guards.hostOk('localhost:43117', 43117), true);
  assert.strictEqual(guards.hostOk('evil.example:43117', 43117), false); // DNS rebinding
  assert.strictEqual(guards.hostOk('127.0.0.1:43118', 43117), false);
  assert.strictEqual(guards.hostOk(undefined, 43117), false);
});

test('Origin must be the helper’s own page', () => {
  assert.strictEqual(guards.originOk('http://127.0.0.1:43117', 43117), true);
  assert.strictEqual(guards.originOk('http://localhost:43117', 43117), true);
  assert.strictEqual(guards.originOk('https://evil.example', 43117), false);
  assert.strictEqual(guards.originOk('null', 43117), false);
  assert.strictEqual(guards.originOk(undefined, 43117), false);
});

test('only the preload’s sync channel is reachable synchronously', () => {
  assert.ok(guards.SYNC_CHANNELS.has('get-providers-sync'));
  assert.ok(!guards.SYNC_CHANNELS.has('subscribe-terminal'));
  assert.ok(!guards.SYNC_CHANNELS.has('error'));
});

test('malformed paths come back null instead of throwing', () => {
  assert.strictEqual(guards.decodePath('/%zz'), null);
  assert.strictEqual(guards.decodePath('/renderer/%00.js'), null);
  assert.strictEqual(guards.decodePath('/renderer\\..\\main.js'), null);
  assert.strictEqual(guards.decodePath('/renderer/app.js'), 'renderer/app.js');
  assert.strictEqual(guards.decodePath('/renderer/a%20b.js'), 'renderer/a b.js');
});

// ---- static files ----------------------------------------------------------

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maussian-static-'));
  fs.mkdirSync(path.join(root, 'renderer'));
  fs.writeFileSync(path.join(root, 'renderer', 'app.js'), '');
  fs.writeFileSync(path.join(root, 'renderer', '..notes'), '');
  fs.writeFileSync(path.join(root, 'icon.png'), '');
  fs.writeFileSync(path.join(root, 'main.js'), '');
  fs.mkdirSync(path.join(root, 'renderer-private'));
  fs.writeFileSync(path.join(root, 'renderer-private', 'x.js'), '');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'maussian-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), '');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'renderer', 'link.txt'));
  return root;
}
const ROOTS = ['renderer/', 'icon.png'];

test('files inside an allowed folder or listed by name are served', () => {
  const root = fixture();
  assert.ok(guards.resolveStatic(root, 'renderer/app.js', ROOTS));
  assert.ok(guards.resolveStatic(root, 'icon.png', ROOTS));
  assert.ok(guards.resolveStatic(root, 'renderer/..notes', ROOTS)); // a name starting with ..
});

test('anything else is refused', () => {
  const root = fixture();
  assert.strictEqual(guards.resolveStatic(root, 'main.js', ROOTS), null);
  assert.strictEqual(guards.resolveStatic(root, 'renderer/../main.js', ROOTS), null);
  assert.strictEqual(guards.resolveStatic(root, '../../etc/hosts', ROOTS), null);
  assert.strictEqual(guards.resolveStatic(root, 'renderer-private/x.js', ROOTS), null); // prefix, not folder
  assert.strictEqual(guards.resolveStatic(root, 'renderer/missing.js', ROOTS), null);
});

test('a symlink out of an allowed folder is refused', () => {
  const root = fixture();
  assert.strictEqual(guards.resolveStatic(root, 'renderer/link.txt', ROOTS), null);
});

// ---- terminal replay ---------------------------------------------------------

function windowWithTab() {
  const win = new BrowserWindow();
  const sent = [];
  win.webContents._socket = { sendMessage: (m) => sent.push(m) };
  return { win, sent };
}

test('terminal output is recorded with or without a tab attached', () => {
  const { win, sent } = windowWithTab();
  win.webContents.send('terminal-data-1', 'one\r\n');
  win.webContents._socket = null;
  win.webContents.send('terminal-data-1', 'two\r\n');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(win.webContents.replayText('terminal-data-1'), 'one\r\ntwo\r\n');
  win.destroy();
});

test('only terminal channels are recorded', () => {
  const { win } = windowWithTab();
  win.webContents.send('task-converted-to-shell', 'x');
  assert.deepStrictEqual(win.webContents.replayChannels(), []);
  win.destroy();
});

test('a terminal past 256 KB keeps its tail, starting on a line boundary', () => {
  const { win } = windowWithTab();
  const line = 'x'.repeat(1023) + '\n';
  for (let i = 0; i < 300; i++) win.webContents.send('terminal-data-2', line);
  win.webContents.send('terminal-data-2', 'LAST\n');
  const text = win.webContents.replayText('terminal-data-2');
  assert.ok(text.length <= 256 * 1024 + 8);
  assert.ok(text.startsWith('\x1b[0m'));
  assert.ok(text.endsWith('LAST\n'));
  win.destroy();
});

test('at most 64 terminals are kept per window, least recently written dropped first', () => {
  const { win } = windowWithTab();
  for (let i = 0; i < 70; i++) win.webContents.send(`terminal-data-${i}`, 'x');
  win.webContents.send('terminal-data-6', 'again'); // touch an old one
  const channels = win.webContents.replayChannels();
  assert.strictEqual(channels.length, 64);
  assert.ok(!channels.includes('terminal-data-0'));
  assert.ok(channels.includes('terminal-data-6'));
  assert.strictEqual(channels[channels.length - 1], 'terminal-data-6');
  win.destroy();
});

// ---- windows that main/ opens --------------------------------------------------

const shim = require('../../web/electron-shim');

// The hook is global; restore it even when an assertion fails.
async function withOpenHook(fn) {
  const opened = [];
  shim.__web.setOpenHook((w) => opened.push([w._page, w._query]));
  try {
    await fn();
    await new Promise((r) => setImmediate(r));
  } finally {
    shim.__web.setOpenHook(null);
  }
  return opened;
}

test('a window that loads a page is reported once, with its page and query', async () => {
  let win;
  const opened = await withOpenHook(() => {
    win = new BrowserWindow();
    win.loadFile('/app/renderer/index.html', { query: { secondary: '1' } });
  });
  assert.deepStrictEqual(opened, [['index.html', '?secondary=1']]);
  win.destroy();
});

test('a window closed before it is shown is never reported', async () => {
  const opened = await withOpenHook(() => {
    const win = new BrowserWindow();
    win.loadFile('/app/renderer/preferences.html');
    win.destroy();
  });
  assert.deepStrictEqual(opened, []);
});

function closeMessages(sent) {
  return sent.filter((m) => m.t === 'evt' && m.ch === '__web:close').length;
}

test('main/ closing a pop-out closes its tab, once', () => {
  const { win, sent } = windowWithTab();
  win.loadFile('/app/renderer/popout.html');
  win.close();
  win.close(); // already destroyed: nothing more is sent
  assert.equal(closeMessages(sent), 1);
});

test('closing a full app window never closes its tab', () => {
  const { win, sent } = windowWithTab();
  win.loadFile('/app/renderer/index.html', { query: { secondary: '1' } });
  win.close();
  assert.equal(closeMessages(sent), 0);
});

test('replayAt says when a window last recorded a terminal, without joining it', () => {
  const { win } = windowWithTab();
  assert.equal(win.webContents.replayAt('terminal-data-9'), 0);
  const before = Date.now();
  win.webContents.send('terminal-data-9', 'x');
  assert.ok(win.webContents.replayAt('terminal-data-9') >= before);
  win.destroy();
});
