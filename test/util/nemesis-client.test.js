require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { fakeApp } = require('../setup');
const config = require('../../main/util/config');
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

test('parseInputChunk accumulates printable chars and emits a line on Enter', () => {
  let r = nemesis.parseInputChunk('', 'hi');
  assert.equal(r.buf, 'hi');
  assert.equal(r.echo, 'hi');
  assert.deepEqual(r.lines, []);

  r = nemesis.parseInputChunk('hi', '\r');
  assert.equal(r.buf, '');
  assert.deepEqual(r.lines, ['hi']);
  assert.equal(r.echo, '\r\n');
});

test('parseInputChunk handles backspace and ignores stray control bytes', () => {
  let r = nemesis.parseInputChunk('abc', '\x7f');
  assert.equal(r.buf, 'ab');
  assert.equal(r.echo, '\b \b');

  // backspace on empty buffer is a no-op
  r = nemesis.parseInputChunk('', '\b');
  assert.equal(r.buf, '');
  assert.equal(r.echo, '');

  // a whole arrow-key escape sequence is dropped, trailing printable kept
  r = nemesis.parseInputChunk('', '\x1b[Dx');
  assert.equal(r.buf, 'x');
  assert.equal(r.echo, 'x');
  // bare ESC is swallowed too
  r = nemesis.parseInputChunk('ab', '\x1b');
  assert.equal(r.buf, 'ab');
  assert.equal(r.echo, '');
});

// ---- HTTP client + bridge against a live mock gateway ----

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
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ nemesisEnabled: true, ...overrides }));
  return () => { fakeApp.getPath = origGetPath; };
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
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

test('complete() posts the prompt and threads the session id', async () => {
  const seen = [];
  const { server, url } = await withMockGateway(async (req, res) => {
    if (req.url === '/completion' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      seen.push(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ session_id: body.session_id || 'sess-1', status: 'completed', output: 'echo: ' + body.prompt }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  const restore = useConfig({ nemesisRemote: url, nemesisModel: 'sonnet' });
  try {
    const first = await nemesis.complete({ prompt: 'hello' });
    assert.equal(first.output, 'echo: hello');
    assert.equal(first.session_id, 'sess-1');
    const second = await nemesis.complete({ prompt: 'again', sessionId: first.session_id });
    assert.equal(second.session_id, 'sess-1');
    // model from config is forwarded; session id is threaded on the follow-up
    assert.equal(seen[0].model, 'sonnet');
    assert.equal(seen[1].session_id, 'sess-1');
  } finally { restore(); server.close(); }
});

test('complete() maps 401 and 429 to readable errors', async () => {
  const { server, url } = await withMockGateway((req, res) => {
    res.statusCode = req.headers.authorization === 'Bearer good' ? 429 : 401;
    res.end();
  });
  try {
    const restore = useConfig({ nemesisRemote: url, nemesisToken: 'good' });
    try {
      const r = await nemesis.complete({ prompt: 'x' });
      assert.match(r.error, /max concurrent runs/);
    } finally { restore(); }

    const restore2 = useConfig({ nemesisRemote: url, nemesisToken: 'bad' });
    try {
      const r = await nemesis.complete({ prompt: 'x' });
      assert.match(r.error, /unauthorized/);
    } finally { restore2(); }
  } finally { server.close(); }
});

test('complete() reports cancellation when its signal aborts', async () => {
  const { server, url } = await withMockGateway((req, res) => {
    // never respond — force the client to abort
    setTimeout(() => { try { res.end(); } catch {} }, 5000).unref();
  });
  const restore = useConfig({ nemesisRemote: url });
  try {
    const ctrl = new AbortController();
    const p = nemesis.complete({ prompt: 'x', signal: ctrl.signal });
    ctrl.abort();
    const r = await p;
    assert.equal(r.cancelled, true);
  } finally { restore(); server.close(); }
});

test('createNemesisTerminal runs a prompt and streams output like a pty', async () => {
  const { server, url } = await withMockGateway(async (req, res) => {
    if (req.url === '/health') { res.end(JSON.stringify({ status: 'ok', version: '9' })); return; }
    if (req.url === '/completion') {
      const body = JSON.parse(await readBody(req));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ session_id: 'S1', status: 'completed', output: 'result for ' + body.prompt }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  const restore = useConfig({ nemesisRemote: url });
  try {
    const term = nemesis.createNemesisTerminal({ worktreePath: '/wt', initialPrompt: 'boot' });
    let out = '';
    let exitCode = null;
    term.onData((d) => { out += d; });
    term.onExit(({ exitCode: c }) => { exitCode = c; });

    await waitFor(() => out.includes('result for boot'));
    assert.match(out, /Nemesis8 remote session/);
    assert.match(out, /connected/);
    assert.equal(term.sessionId, 'S1');

    // typed input echoes and, on Enter, runs another completion in the session
    term.write('hi');
    assert.match(out, /hi/);
    term.write('\r');
    await waitFor(() => out.includes('result for hi'));

    term.kill();
    assert.equal(exitCode, 0);
  } finally { restore(); server.close(); }
});

test('createNemesisTerminal ignores input typed during boot (no double-submit)', async () => {
  let completions = 0;
  const { server, url } = await withMockGateway(async (req, res) => {
    if (req.url === '/health') {
      // slow health round-trip: the window where a user could race the boot
      setTimeout(() => res.end(JSON.stringify({ status: 'ok', version: '1' })), 60);
      return;
    }
    if (req.url === '/completion') {
      completions++;
      const body = JSON.parse(await readBody(req));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ session_id: 'S1', status: 'completed', output: 'ran ' + body.prompt }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  const restore = useConfig({ nemesisRemote: url });
  try {
    const term = nemesis.createNemesisTerminal({ worktreePath: '/wt', initialPrompt: 'boot' });
    let out = '';
    term.onData((d) => { out += d; });
    // type a full line while /health is still in flight — must be dropped
    term.write('typed\r');

    await waitFor(() => out.includes('ran boot'));
    await new Promise((r) => setTimeout(r, 50)); // let any stray completion land
    assert.equal(completions, 1);
    assert.ok(!out.includes('ran typed'), 'input during boot must not run a completion');
  } finally { restore(); server.close(); }
});

test('createNemesisTerminal exits non-zero when the gateway is unreachable', async () => {
  const restore = useConfig({ nemesisRemote: 'http://127.0.0.1:1' });
  try {
    const term = nemesis.createNemesisTerminal({ worktreePath: '/wt' });
    let out = '';
    let exitCode = null;
    term.onData((d) => { out += d; });
    term.onExit(({ exitCode: c }) => { exitCode = c; });
    await waitFor(() => exitCode !== null);
    assert.equal(exitCode, 1);
    assert.match(out, /Cannot reach nemesis8 gateway/);
  } finally { restore(); }
});

function waitFor(pred, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = pred(); } catch {}
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}
