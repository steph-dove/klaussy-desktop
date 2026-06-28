// Inline (ghost-text) completion over the Ollama HTTP path. Seeds config with
// an ollamaUrl pointing at a local mock that speaks /api/tags + /api/generate
// (newline-delimited JSON), then drives window.klaus.ai.ollama.completeStart and
// asserts onCompleteChunk yields the mocked FIM completion and onCompleteDone
// fires { ok: true }. Proves the renderer streaming-subscription wiring end to
// end against the real main-process generateFIM client.
//
// APPROACH / gotcha: generateFIM reads ollamaUrl from config at spawn time, but
// set-preferences does NOT expose ollamaUrl — so the url must arrive via the
// static configSeed fixture. configSeed is fixed at collection time while a
// listen(0) mock gets a dynamic port, so instead of startOllamaMock() we bind
// our own mock to a DETERMINISTIC high port (derived from process.pid, computed
// at module load in Node) and seed that exact url. The server is brought up in
// beforeAll, which runs before the electronApp fixture launches the app.

const http = require('http');
const { test, expect } = require('./fixtures');

const COMPLETION = ' WORLD';
const MODEL = 'qwen2.5-coder:1.5b';
// Deterministic, process-unique port so concurrent specs don't collide and the
// value is knowable at collection time for the static configSeed below.
const PORT = 20000 + (process.pid % 40000);
const URL = `http://127.0.0.1:${PORT}`;

test.use({ configSeed: { ollamaUrl: URL, ollamaModel: MODEL } });

let server;

test.beforeAll(async () => {
  // Minimal Ollama mock bound to the fixed port. Mirrors helpers.startOllamaMock
  // but with a chosen port instead of listen(0). /api/generate streams one
  // ndjson response delta then a done marker.
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/tags') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: MODEL }] }));
        return;
      }
      if (req.url === '/api/generate') {
        res.setHeader('content-type', 'application/x-ndjson');
        res.write(JSON.stringify({ response: COMPLETION, done: false }) + '\n');
        res.end(JSON.stringify({ response: '', done: true }) + '\n');
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
});

test.afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
});

test('ollama inline completion streams the mocked FIM chunk and a done:ok', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const requestId = `e2e-complete-${process.pid}-${Date.now()}`;

  const result = await mainWindow.evaluate(({ requestId, completion }) => new Promise((resolve) => {
    const out = { chunks: [], done: null, started: null };
    const o = window.klaus.ai.ollama;

    const unsubChunk = o.onCompleteChunk(requestId, (chunk) => { out.chunks.push(chunk); });
    o.onCompleteDone(requestId, (msg) => {
      out.done = msg;
      try { unsubChunk(); } catch {}
      resolve(out);
    });

    o.completeStart({ requestId, prefix: 'hello', suffix: '' })
      .then((r) => { out.started = r; })
      .catch((e) => { out.started = { error: String(e) }; });

    // Safety net so a wiring failure fails loudly instead of hanging the test.
    setTimeout(() => { try { unsubChunk(); } catch {} resolve(out); }, 8000);
  }), { requestId, completion: COMPLETION });

  expect(result.started, `completeStart returned: ${JSON.stringify(result.started)}`).toMatchObject({ ok: true });
  expect(result.chunks.join(''), `chunks: ${JSON.stringify(result.chunks)}`).toBe(COMPLETION);
  expect(result.done, `done payload: ${JSON.stringify(result.done)}`).toMatchObject({ ok: true });
});
