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

test('the token must match exactly', () => {
  const token = Buffer.from('a'.repeat(43));
  assert.strictEqual(guards.tokenMatches('a'.repeat(43), token), true);
  assert.strictEqual(guards.tokenMatches('a'.repeat(42) + 'b', token), false);
  assert.strictEqual(guards.tokenMatches('a'.repeat(42), token), false);
  assert.strictEqual(guards.tokenMatches(undefined, token), false);
  assert.strictEqual(guards.tokenMatches({ length: 43 }, token), false);
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
