// Ollama consent / setup modal. Proves the consent pane shows when setup is
// needed, that Decline persists ollamaConsent='declined' (setupStatus reflects
// it) and closes, and that Enable kicks off setup — flipping to the progress
// pane and, with a mocked Ollama HTTP backend, running to completion
// (setupStatus.consent becomes 'accepted').
//
// We drive the flow via window.OllamaConsent.openIfNeeded() — the same entry
// the editor uses on first inline completion. State is steered through a mock
// HTTP server: probe reports the server *running* but the configured model
// *absent* → getSetupState() returns 'needs-model', which keeps Enable on the
// HTTP-only pullModel path (no brew/winget/serve spawns).

const http = require('http');
const { test, expect } = require('./fixtures');

// Deterministic port per worker process — avoids the dynamic-port-in-test.use
// problem (configSeed must be static at collection time) while staying clear of
// other concurrent spec processes (distinct pids → distinct ports).
const PORT = 20000 + (process.pid % 40000);
const MOCK_URL = `http://127.0.0.1:${PORT}`;

// A model name that does NOT match the default ollamaModel (qwen2.5-coder:1.5b)
// so probe.modelPresent is false → state 'needs-model'.
function startMock(port) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/tags') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: 'llama3:8b' }] }));
        return;
      }
      if (req.url === '/api/pull') {
        res.setHeader('content-type', 'application/x-ndjson');
        res.end(JSON.stringify({ status: 'success' }) + '\n');
        return;
      }
      if (req.url === '/api/generate') {
        // warmup() may fire after pull; answer harmlessly.
        res.setHeader('content-type', 'application/x-ndjson');
        res.end(JSON.stringify({ response: '', done: true }) + '\n');
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function readyForConsent(win) {
  await win.waitForLoadState('networkidle');
  await expect(win.locator('#btn-new-task')).toBeVisible();
  await win.waitForFunction(() => !!(window.OllamaConsent && window.klaus && window.klaus.ai && window.klaus.ai.ollama));
}

// ---- Decline path: dead URL → setup needed → consent shows → declined saved ----
test.describe('decline', () => {
  // Unreachable Ollama: probe fails → needs-install / needs-server, never ready.
  test.use({ configSeed: { ollamaUrl: 'http://127.0.0.1:1' } });

  test('consent pane shows and Decline persists declined + closes', async ({ mainWindow }) => {
    await readyForConsent(mainWindow);

    const overlay = mainWindow.locator('#ollama-consent-overlay');
    const consentPane = mainWindow.locator('#ollama-consent-pane');
    await expect(overlay).toBeHidden();

    // openIfNeeded resolves only on decline/complete — don't await it here.
    await mainWindow.evaluate(() => { window.__consent = window.OllamaConsent.openIfNeeded(); });

    await expect(overlay).toBeVisible();
    await expect(consentPane).toBeVisible();
    await expect(mainWindow.locator('#ollama-consent-enable')).toBeVisible();

    await mainWindow.locator('#ollama-consent-decline').click();

    const result = await mainWindow.evaluate(() => window.__consent);
    expect(result).toMatchObject({ ok: false, declined: true });

    await expect(overlay).toBeHidden();

    const status = await mainWindow.evaluate(() => window.klaus.ai.ollama.setupStatus());
    expect(status.consent).toBe('declined');
    expect(status.state).toBe('declined');
  });
});

// ---- Enable path: mock running-but-model-missing → consent → Enable → progress ----
test.describe('enable', () => {
  test.use({ configSeed: { ollamaUrl: MOCK_URL } });

  let server;
  test.beforeAll(async () => { server = await startMock(PORT); });
  test.afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

  test('Enable shows the progress pane and runs setup to acceptance', async ({ mainWindow }) => {
    await readyForConsent(mainWindow);

    const overlay = mainWindow.locator('#ollama-consent-overlay');
    const consentPane = mainWindow.locator('#ollama-consent-pane');
    const progressPane = mainWindow.locator('#ollama-progress-pane');

    await mainWindow.evaluate(() => { window.__consent = window.OllamaConsent.openIfNeeded(); });
    await expect(overlay).toBeVisible();
    await expect(consentPane).toBeVisible();

    await mainWindow.locator('#ollama-consent-enable').click();

    // Progress UI begins immediately (show('progress') runs before the await).
    await expect(progressPane).toBeVisible();
    await expect(consentPane).toBeHidden();

    // With the mock backend, setup completes: pullModel succeeds → consent saved.
    const result = await mainWindow.evaluate(() => window.__consent);
    expect(result).toMatchObject({ ok: true });

    const status = await mainWindow.evaluate(() => window.klaus.ai.ollama.setupStatus());
    expect(status.consent).toBe('accepted');

    // Modal auto-hides ~500ms after success.
    await expect(overlay).toBeHidden();
  });
});
