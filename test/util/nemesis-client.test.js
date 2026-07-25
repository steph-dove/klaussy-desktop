require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { fakeApp } = require('../setup');
const nemesis = require('../../main/util/nemesis-client');

// ---- Pure helpers ----

test('normalizeBaseUrl adds scheme and default port, trims trailing slash', () => {
  assert.equal(nemesis.normalizeBaseUrl('host'), 'http://host:9801');
  assert.equal(nemesis.normalizeBaseUrl('host:9801/'), 'http://host:9801');
  assert.equal(nemesis.normalizeBaseUrl('http://host:4000'), 'http://host:4000');
  assert.equal(nemesis.normalizeBaseUrl('https://gw.example.com'), 'https://gw.example.com:9801');
  assert.equal(nemesis.normalizeBaseUrl('http://1.2.3.4:9801//'), 'http://1.2.3.4:9801');
  assert.equal(nemesis.normalizeBaseUrl(''), '');
  assert.equal(nemesis.normalizeBaseUrl('   '), '');
});

test('authHeaders only sets Authorization when a token is present', () => {
  assert.deepEqual(nemesis.authHeaders('abc'), { authorization: 'Bearer abc' });
  assert.deepEqual(nemesis.authHeaders(''), {});
  assert.deepEqual(nemesis.authHeaders(undefined), {});
});

test('isInsecureRemote flags a token over http to a non-loopback host only', () => {
  assert.equal(nemesis.isInsecureRemote('http://gw.example.com:9801', 'tok'), true);
  assert.equal(nemesis.isInsecureRemote('http://127.0.0.1:9801', 'tok'), false);
  assert.equal(nemesis.isInsecureRemote('http://localhost:9801', 'tok'), false);
  assert.equal(nemesis.isInsecureRemote('https://gw.example.com:9801', 'tok'), false);
  assert.equal(nemesis.isInsecureRemote('http://gw.example.com:9801', ''), false);
  assert.equal(nemesis.isInsecureRemote('', 'tok'), false);
});

test('shouldUseNemesis routes the nemesis8 picker choice and per-profile ids', () => {
  // Per-tab: base id, and one id per named gateway profile (nemesis8:<id>).
  assert.equal(nemesis.shouldUseNemesis('nemesis8'), true);
  assert.equal(nemesis.shouldUseNemesis(nemesis.NEMESIS_MODE), true);
  assert.equal(nemesis.shouldUseNemesis('nemesis8:claude-prod'), true);
  assert.equal(nemesis.shouldUseNemesis('claude'), false);
  assert.equal(nemesis.shouldUseNemesis('shell'), false);
  assert.equal(nemesis.shouldUseNemesis('nemesis8extra'), false); // must be exact or prefixed with ':'
  assert.equal(nemesis.shouldUseNemesis(undefined), false);
});

// ---- /health probe (used by the prefs "Test connection" button) ----

function withMockGateway(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// Point config at a mock gateway in an isolated userData dir; returns restore().
function useConfig(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-test-'));
  const origGetPath = fakeApp.getPath;
  fakeApp.getPath = (name) => (name === 'userData' ? dir : origGetPath(name));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(overrides));
  return () => { fakeApp.getPath = origGetPath; };
}

test('health() reports ok and version from a live gateway', async () => {
  const { server, url } = await withMockGateway((req, res) => {
    if (req.url === '/health') { res.end(JSON.stringify({ status: 'ok', version: '1.2.3' })); return; }
    res.statusCode = 404; res.end();
  });
  const restore = useConfig({ nemesisRemote: url });
  try {
    const h = await nemesis.health();
    assert.equal(h.ok, true);
    assert.equal(h.version, '1.2.3');
  } finally { restore(); server.close(); }
});

test('health() surfaces an error when the gateway is unreachable', async () => {
  const restore = useConfig({ nemesisRemote: 'http://127.0.0.1:1' });
  try {
    const h = await nemesis.health();
    assert.equal(h.ok, false);
    assert.ok(h.error);
  } finally { restore(); }
});

test('health({remote}) probes the passed connection (not saved config)', async () => {
  const { server, url } = await withMockGateway((req, res) => {
    if (req.url === '/health') { res.end(JSON.stringify({ status: 'ok', version: '7' })); return; }
    res.statusCode = 404; res.end();
  });
  try {
    const h = await nemesis.health({ remote: url, token: 't' });
    assert.equal(h.ok, true);
    assert.equal(h.version, '7');
  } finally { server.close(); }
});
