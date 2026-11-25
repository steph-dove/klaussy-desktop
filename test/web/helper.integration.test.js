// Integration test for the browser-mode helper: starts a real one (under
// Electron's Node, as `npm run web` does) against a throwaway settings folder
// and home, then checks every way in is refused unless a paired browser signed
// in, and that the helper survives the attempts.
//
//   npm run test:web
//
// Needs the repo's node_modules with node-pty rebuilt for Electron (`npm ci`
// and `npm run rebuild`), so it isn't part of `npm test`.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..', '..');
const START = path.join(ROOT, 'web', 'start.js');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'maussian-web-userdata-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maussian-web-home-'));
const env = {
  ...process.env,
  MAUSSIAN_WEB_USERDATA: userData,
  MAUSSIAN_PORT: String(45000 + Math.floor(Math.random() * 10000)),
  HOME: home,
  USERPROFILE: home,
  KLAUSSY_E2E: '1', // no first-run installs or CLI checks
};

let helper;
let port;
let origin;
let firstCode;

function run(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [START, '--no-open', ...args], { env, cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out }));
  });
}

const linkCode = (text) => {
  const m = /Open: http:\/\/127\.0\.0\.1:(\d+)\/renderer\/index\.html#pair=([A-Za-z0-9_-]{43})/.exec(text);
  return m ? { port: Number(m[1]), code: m[2] } : null;
};

test.before(async () => {
  helper = spawn(process.execPath, [START, '--no-open'], { env, cwd: ROOT });
  let out = '';
  const found = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`helper didn't start:\n${out}`)), 60000);
    const onData = (d) => {
      out += d;
      const l = linkCode(out);
      if (l) { clearTimeout(timer); resolve(l); }
    };
    helper.stdout.on('data', onData);
    helper.stderr.on('data', (d) => { out += d; });
    helper.on('exit', (code) => { clearTimeout(timer); reject(new Error(`helper exited ${code}:\n${out}`)); });
  });
  port = found.port;
  firstCode = found.code;
  origin = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (helper && helper.exitCode == null) {
    helper.removeAllListeners('exit');
    const exited = new Promise((r) => helper.on('exit', r));
    helper.kill('SIGTERM');
    await exited;
  }
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// ---- tiny clients ------------------------------------------------------------

function request(method, reqPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: reqPath,
      headers: { Host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const post = (p, body, headers = {}) => request('POST', p, { body, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers } });
const json = (r) => JSON.parse(r.body);

// wsOrigin null sends no Origin header at all.
function socket({ wsOrigin = origin, host, send } = {}) {
  return new Promise((resolve) => {
    const headers = host ? { Host: host } : {};
    const opts = wsOrigin === null ? { headers } : { origin: wsOrigin, headers };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__ws`, opts);
    const done = (r) => { resolve(r); try { ws.terminate(); } catch {} };
    ws.on('unexpected-response', (_q, res) => done({ refusedAt: 'upgrade', status: res.statusCode }));
    ws.on('open', () => { if (send) ws.send(typeof send === 'string' ? send : JSON.stringify(send)); });
    ws.on('message', (d) => done({ message: JSON.parse(String(d)) }));
    ws.on('close', (code) => done({ closed: code }));
    ws.on('error', () => {});
    setTimeout(() => done({ timeout: true }), 5000);
  });
}

// A browser: a P-256 key, as WebCrypto makes one, that can pair and sign in.
function newBrowser() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicKey: publicKey.export({ format: 'jwk' }),
    sign: (text) => crypto.sign('sha256', Buffer.from(text), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
  };
}

async function signIn(browser, browserId) {
  const { challenge } = json(await post('/__challenge', { browserId }));
  const r = await post('/__session', { browserId, challenge, signature: browser.sign(challenge) });
  assert.equal(r.status, 200);
  return json(r).ticket;
}

// ---- HTTP ------------------------------------------------------------------------

test('a request naming another host is refused (DNS rebinding)', async () => {
  assert.equal((await request('GET', '/renderer/index.html', { headers: { Host: `evil.example:${port}` } })).status, 403);
});

test('malformed paths get a 400 and traversal a 404, and the helper stays up', async () => {
  assert.equal((await request('GET', '/%zz')).status, 400);
  assert.equal((await request('GET', '/renderer/%00.js')).status, 400);
  assert.equal((await request('GET', '/renderer/../main.js')).status, 404);
  assert.equal((await request('GET', '/renderer/index.html')).status, 200);
  assert.equal(helper.exitCode, null);
});

test('binding needs an allowed Origin and a session', async () => {
  assert.equal((await request('POST', '/__bind', { body: '{}' })).status, 401); // no Origin
  assert.equal((await post('/__bind', {}, { Origin: 'https://evil.example' })).status, 401);
  assert.equal((await post('/__bind', {})).status, 401); // no ticket
  assert.equal((await post('/__bind', {}, { 'X-Maussian-Ticket': 'x'.repeat(43) })).status, 401);
});

// ---- pairing and signing in ---------------------------------------------------------

test('pairing: a wrong code fails, the link’s code works once', async () => {
  const b = newBrowser();
  assert.equal((await post('/__pair', { code: 'x'.repeat(43), publicKey: b.publicKey })).status, 401);
  const ok = await post('/__pair', { code: firstCode, publicKey: b.publicKey, label: 'test' });
  assert.equal(ok.status, 200);
  assert.match(json(ok).browserId, /^[0-9a-f]{32}$/);
  assert.equal((await post('/__pair', { code: firstCode, publicKey: newBrowser().publicKey })).status, 401);
});

test('a bad key or an oversized request leaves the code unspent', async () => {
  const code = linkCode((await run([])).out).code;
  const bad = { ...newBrowser().publicKey, crv: 'P-384' };
  assert.equal((await post('/__pair', { code, publicKey: bad })).status, 400);
  assert.equal((await post('/__pair', { code, publicKey: newBrowser().publicKey, label: 'x'.repeat(70 * 1024) })).status, 413);
  assert.equal((await post('/__pair', { code, publicKey: newBrowser().publicKey })).status, 200);
});

test('a second `npm run web` hands out a fresh pairing code for the running helper', async () => {
  const { out } = await run([]);
  const l = linkCode(out);
  assert.ok(l, out);
  assert.equal(l.port, port);
  assert.equal((await post('/__pair', { code: l.code, publicKey: newBrowser().publicKey })).status, 200);
});

test('signing in: only the paired key’s signature on a fresh challenge gets a ticket', async () => {
  const b = newBrowser();
  const code = linkCode((await run([])).out).code;
  const { browserId } = json(await post('/__pair', { code, publicKey: b.publicKey }));

  assert.equal((await post('/__challenge', { browserId: 'f'.repeat(32) })).status, 401); // unknown browser

  const { challenge } = json(await post('/__challenge', { browserId }));
  const forged = newBrowser().sign(challenge);
  assert.equal((await post('/__session', { browserId, challenge, signature: forged })).status, 401);
  // A challenge is spent by any attempt, so the forgery can't be retried with it.
  assert.equal((await post('/__session', { browserId, challenge, signature: b.sign(challenge) })).status, 401);

  // A challenge issued to one browser can't sign in another, even with that
  // other browser's own valid signature.
  const other = newBrowser();
  const otherId = json(await post('/__pair', { code: linkCode((await run([])).out).code, publicKey: other.publicKey })).browserId;
  const borrowed = json(await post('/__challenge', { browserId })).challenge;
  assert.equal((await post('/__session', { browserId: otherId, challenge: borrowed, signature: other.sign(borrowed) })).status, 401);

  const ticket = await signIn(b, browserId);
  const bind = await post('/__bind', {}, { 'X-Maussian-Ticket': ticket });
  assert.equal(bind.status, 200);
  const { winId } = json(bind);

  // /__sync answers the one channel the preload needs, nothing else.
  assert.equal((await post('/__sync', { winId, ch: 'subscribe-terminal', args: ['x'] }, { 'X-Maussian-Ticket': ticket })).status, 400);
  assert.equal((await post('/__sync', { winId, ch: 'get-providers-sync' }, { 'X-Maussian-Ticket': ticket })).status, 200);
});

// ---- the socket ---------------------------------------------------------------------

test('the socket refuses every way in without a session', async () => {
  assert.equal((await socket({ wsOrigin: 'https://evil.example' })).status, 401);
  assert.equal((await socket({ wsOrigin: null })).status, 401);
  assert.equal((await socket({ host: `evil.example:${port}` })).status, 401);
  assert.equal((await socket({})).closed, 4401); // no hello
  assert.equal((await socket({ send: { t: 'hello', ticket: 'x'.repeat(43), winId: 1 } })).closed, 4401);
  assert.equal((await socket({ send: { t: 'invoke', id: 1, ch: 'list-tasks', args: [] } })).closed, 4401);
  assert.equal((await socket({ send: 'x'.repeat(5000) })).closed, 1009); // too big before hello
});

// A tab signed in by a freshly paired browser; resolves with the open socket.
async function signedInTab(label = 'Test browser') {
  const b = newBrowser();
  const code = linkCode((await run([])).out).code;
  const { browserId } = json(await post('/__pair', { code, publicKey: b.publicKey, label }));
  const ticket = await signIn(b, browserId);
  const { winId } = json(await post('/__bind', {}, { 'X-Maussian-Ticket': ticket }));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/__ws`, { origin });
  await new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', ticket, winId })));
    ws.on('message', resolve);
    ws.on('close', (c) => reject(new Error(`closed ${c}`)));
  });
  const closed = Promise.race([
    new Promise((resolve) => ws.on('close', resolve)),
    new Promise((resolve) => setTimeout(() => resolve('still open'), 8000)),
  ]);
  return { browserId, ticket, ws, closed };
}

test('--status shows the helper and paired browsers; --unpair signs out just one', async () => {
  const keep = await signedInTab();
  // A label trying to forge a row: --status must print it on one line.
  const drop = await signedInTab('Test browser\n  ffffffff  Forged row\u001b[2J');

  const status = (await run(['--status'])).out;
  assert.match(status, new RegExp(`Running on http://127\\.0\\.0\\.1:${port}`));
  const row = status.split('\n').find((l) => l.includes(drop.browserId.slice(0, 8)));
  assert.ok(row && row.includes('Test browser') && row.includes('last signed in'), status);
  assert.ok(!status.split('\n').some((l) => /^\s+ffffffff\b/.test(l)), 'no forged row');
  assert.ok(!status.includes('\u001b'), 'no escape sequences');

  const r = await run(['--unpair', drop.browserId.slice(0, 8)]);
  assert.match(r.out, /Forgot Test browser/);
  assert.equal(await drop.closed, 4401);
  assert.equal((await post('/__bind', {}, { 'X-Maussian-Ticket': drop.ticket })).status, 401);
  // The other browser's tab and ticket are untouched, a full sweep later too.
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(keep.ws.readyState, WebSocket.OPEN);
  assert.equal((await post('/__bind', {}, { 'X-Maussian-Ticket': keep.ticket })).status, 200);
  keep.ws.close();

  for (const [args, said] of [
    [['--unpair', 'zz'], /at least the first 4 characters/],
    [['--unpair', 'ffffffff'], /No paired browser has that id/],
    [['--unpair'], /Say which browser/],
    [['--unpair', '--no-open'], /Say which browser/],
  ]) {
    const r2 = await run(args);
    assert.equal(r2.code, 1, args.join(' '));
    assert.match(r2.out, said);
  }
});

// Unpairs every browser, so it runs after every test that pairs one.
test('a signed-in tab gets in, and --unpair-all throws it out', async () => {
  const b = newBrowser();
  const code = linkCode((await run([])).out).code;
  const { browserId } = json(await post('/__pair', { code, publicKey: b.publicKey }));
  const ticket = await signIn(b, browserId);
  const { winId } = json(await post('/__bind', {}, { 'X-Maussian-Ticket': ticket }));

  const ws = new WebSocket(`ws://127.0.0.1:${port}/__ws`, { origin });
  const welcome = await new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', ticket, winId })));
    ws.on('message', (d) => resolve(JSON.parse(String(d))));
    ws.on('close', (c) => reject(new Error(`closed ${c}`)));
  });
  assert.equal(welcome.t, 'welcome');

  // The helper sweeps every 2 s; give it a few rounds, then fail rather than hang.
  const closed = Promise.race([
    new Promise((resolve) => ws.on('close', resolve)),
    new Promise((resolve) => setTimeout(() => resolve('still open after 8 s'), 8000)),
  ]);
  const unpair = await run(['--unpair-all']);
  assert.match(unpair.out, /Forgot \d+ paired browsers?/);
  assert.equal(await closed, 4401);
  assert.equal((await post('/__bind', {}, { 'X-Maussian-Ticket': ticket })).status, 401);
  assert.equal((await post('/__challenge', { browserId })).status, 401);
});

test('the helper is still running after all of it', () => {
  assert.equal(helper.exitCode, null);
});
