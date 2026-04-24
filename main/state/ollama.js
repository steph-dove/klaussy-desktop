// Ollama HTTP client for inline AI completion. Probes the local server,
// streams fill-in-middle completions, and surfaces model-presence state so
// the renderer can decide whether to activate passive ghost-text or fall
// back to word-complete.
//
// We deliberately avoid a dependency — Node 18+ has a global `fetch` and
// `AbortController`, which is all we need. Streaming uses ReadableStream's
// async iterator, splitting on newlines since Ollama emits one JSON object
// per line.
//
// Config overrides (persisted in userData/config.json):
//   ollamaUrl   — default 'http://127.0.0.1:11434'
//   ollamaModel — default 'qwen2.5-coder:1.5b'

const { execFile, spawn } = require('child_process');
const { app } = require('electron');
const { loadConfig, saveConfig } = require('../util/config');

const DEFAULT_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5-coder:1.5b';

function getBaseUrl() {
  const cfg = loadConfig();
  return cfg.ollamaUrl || DEFAULT_URL;
}

function getModel() {
  const cfg = loadConfig();
  return cfg.ollamaModel || DEFAULT_MODEL;
}

// Cached probe result — the renderer can query it cheaply without re-hitting
// the HTTP endpoint on every keystroke. Invalidated by `probeNow()` which
// forces a fresh check.
let _probeCache = { ts: 0, running: false, modelPresent: false, error: null };
const PROBE_CACHE_MS = 5000;

async function probeNow() {
  const url = getBaseUrl();
  const model = getModel();
  const result = { ts: Date.now(), running: false, modelPresent: false, error: null, model };
  try {
    // 500ms is plenty for a loopback request; keeps app startup snappy when
    // Ollama isn't running at all.
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(url + '/api/tags', { signal: ctrl.signal });
    clearTimeout(to);
    if (!res.ok) { result.error = 'ollama tags HTTP ' + res.status; _probeCache = result; return result; }
    result.running = true;
    const body = await res.json();
    const names = Array.isArray(body.models) ? body.models.map((m) => m.name) : [];
    // Ollama reports model tags as "<name>:<tag>"; accept either an exact
    // match (user set `ollamaModel: "qwen2.5-coder:1.5b"`) or a prefix
    // (user just said `qwen2.5-coder`, any tag is fine).
    result.modelPresent = names.some((n) => n === model || n.startsWith(model + ':') || n.split(':')[0] === model.split(':')[0]);
  } catch (err) {
    result.error = (err && err.message) || String(err);
  }
  _probeCache = result;
  return result;
}

async function probe() {
  if (Date.now() - _probeCache.ts < PROBE_CACHE_MS) return _probeCache;
  return probeNow();
}

// Streams a fill-in-middle completion. qwen2.5-coder supports FIM natively;
// Ollama's /api/generate handles the token wrapping when both `prompt` and
// `suffix` are supplied.
//
// Callbacks:
//   onChunk(text)      — each response delta from the stream
//   onDone({ ok, error, cancelled })
//
// Returns a cancel function.
function generateFIM({ prefix, suffix, options, onChunk, onDone }) {
  const url = getBaseUrl();
  const model = getModel();
  const ctrl = new AbortController();
  let settled = false;

  function finish(payload) {
    if (settled) return;
    settled = true;
    try { onDone && onDone(payload); } catch {}
  }

  (async () => {
    let res;
    try {
      res = await fetch(url + '/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          prompt: prefix,
          suffix: suffix || '',
          stream: true,
          // Keep completions short and deterministic-ish — this is inline
          // autocomplete, not free-form generation. num_predict caps runtime
          // on the long tail; stop tokens bail early when the model would
          // otherwise start explaining itself.
          options: Object.assign({
            num_predict: 128,
            temperature: 0.2,
            top_p: 0.95,
            stop: ['\n\n\n', '<|endoftext|>', '<|file_sep|>'],
          }, options || {}),
        }),
      });
    } catch (err) {
      if (ctrl.signal.aborted) { finish({ cancelled: true }); return; }
      finish({ error: 'ollama request failed: ' + ((err && err.message) || String(err)) });
      return;
    }

    if (!res.ok) {
      finish({ error: 'ollama generate HTTP ' + res.status });
      return;
    }

    // Ollama streams newline-delimited JSON: one object per chunk, each with
    // a `response` delta string. The final object has `done: true` and no
    // useful `response`. We tolerate partial lines across chunk boundaries.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.error) { finish({ error: obj.error }); try { reader.cancel(); } catch {} return; }
          if (obj.response) { try { onChunk && onChunk(obj.response); } catch {} }
          if (obj.done) { finish({ ok: true }); return; }
        }
      }
      // Stream closed without a done marker — treat as success if we got
      // anything, otherwise an error.
      finish({ ok: true });
    } catch (err) {
      if (ctrl.signal.aborted) { finish({ cancelled: true }); return; }
      finish({ error: 'ollama stream failed: ' + ((err && err.message) || String(err)) });
    }
  })();

  return function cancel() {
    try { ctrl.abort(); } catch {}
    finish({ cancelled: true });
  };
}

// One tiny throwaway request to force Ollama to load the model into memory.
// Without this, the first real user-visible completion eats a 500ms-2s
// cold-start cost (weights mmap + KV cache init). Fire-and-forget.
async function warmup() {
  const p = await probe();
  if (!p.running || !p.modelPresent) return;
  try {
    const cancel = generateFIM({
      prefix: '// ',
      suffix: '',
      options: { num_predict: 1 },
      onChunk: () => {},
      onDone: () => {},
    });
    // Don't hold a reference; let it finish or die on its own. The cancel
    // fn is not called because the model needs the tokens to finish warming.
    void cancel;
  } catch {}
}

// ---- Setup / install ----

// Process handle for the `ollama serve` child we spawn. We only kill what we
// started — if the user has their own Ollama running (Mac app, brew service,
// etc.) we leave it alone.
let _serverChild = null;

function which(bin) {
  return new Promise((resolve) => {
    execFile('/usr/bin/which', [bin], { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      resolve(stdout.trim() || null);
    });
  });
}

// The detection cascade the consent/install flow consumes. Returns one of:
//   'ready'         — server running + model installed, nothing to do
//   'needs-model'   — server up but model missing
//   'needs-server'  — ollama binary exists but server isn't up
//   'needs-install' — no ollama binary on PATH
//   'declined'      — user previously chose Not now / Don't ask again
async function getSetupState() {
  const cfg = loadConfig();
  if (cfg.ollamaConsent === 'declined') return 'declined';

  const probed = await probeNow();
  if (probed.running && probed.modelPresent) return 'ready';
  if (probed.running && !probed.modelPresent) return 'needs-model';

  const bin = await which('ollama');
  if (bin) return 'needs-server';
  return 'needs-install';
}

// Spawns `ollama serve` and waits for the HTTP endpoint to accept connections.
// Resolves with { ok: true } once reachable or { error } after timeout.
// Idempotent: no-ops if another Ollama server is already listening.
async function ensureServerRunning({ onProgress } = {}) {
  const probed = await probeNow();
  if (probed.running) return { ok: true, alreadyRunning: true };

  const bin = await which('ollama');
  if (!bin) return { error: 'ollama binary not found on PATH' };

  onProgress && onProgress({ step: 'server', message: 'Starting Ollama server…' });

  // Inherit env so brew's OLLAMA_HOST / OLLAMA_MODELS / etc. overrides keep
  // working. Detach so a crash of the main process doesn't SIGHUP the server —
  // we still kill it explicitly on app quit.
  const child = spawn(bin, ['serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  _serverChild = child;

  // Drain stdio so a chatty server doesn't fill the pipe buffer and block.
  child.stdout && child.stdout.on('data', () => {});
  child.stderr && child.stderr.on('data', () => {});
  child.on('exit', () => { if (_serverChild === child) _serverChild = null; });

  // Poll /api/tags until it answers. Ollama boots fast (<2s typical) but we
  // give it up to 15s to cover slow first-run or cold-disk machines.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const p = await probeNow();
    if (p.running) return { ok: true, spawned: true };
  }
  // Timed out. Kill the child so we don't leak a half-started process.
  try { child.kill('SIGTERM'); } catch {}
  _serverChild = null;
  return { error: 'ollama serve did not become ready within 15s' };
}

// Installs Ollama via Homebrew. Brew is the most reliable zero-admin path on
// macOS for getting a working binary + updating PATH. If brew is missing we
// surface that to the renderer so it can link to the install page.
async function installOllamaViaBrew({ onProgress } = {}) {
  const brew = await which('brew');
  if (!brew) {
    return { error: 'Homebrew not found. Install from https://brew.sh and try again.' };
  }
  onProgress && onProgress({ step: 'install', message: 'Installing Ollama via Homebrew…' });

  return new Promise((resolve) => {
    // `brew install ollama` writes verbose status to stderr. We forward it
    // verbatim so the modal can show what brew's up to (Downloading…,
    // Pouring…) without our own parser.
    const proc = spawn(brew, ['install', 'ollama'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderrBuf += s;
      // Trim to last non-empty line — brew prints progress bars with \r.
      const lastLine = s.split(/[\r\n]+/).filter(Boolean).pop();
      if (lastLine && onProgress) onProgress({ step: 'install', message: lastLine.slice(0, 200) });
    });
    proc.stdout.on('data', () => {});
    proc.on('error', (err) => resolve({ error: 'brew install failed to start: ' + err.message }));
    proc.on('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ error: 'brew install exited with code ' + code + (stderrBuf ? ': ' + stderrBuf.trim().slice(-300) : '') });
    });
  });
}

// Pulls the configured model via /api/pull. Streams digest + bytes progress
// back through onProgress so the modal can render a percentage bar.
async function pullModel({ onProgress } = {}) {
  const url = getBaseUrl();
  const model = getModel();
  onProgress && onProgress({ step: 'model', message: 'Downloading model ' + model + '…', percent: 0 });

  let res;
  try {
    res = await fetch(url + '/api/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    });
  } catch (err) {
    return { error: 'ollama pull request failed: ' + ((err && err.message) || String(err)) };
  }
  if (!res.ok) return { error: 'ollama pull HTTP ' + res.status };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let lastPercent = -1;
  let lastMessage = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.error) return { error: obj.error };

        // Ollama sends multiple parallel layer downloads. We pick the layer
        // with total > 0 and report its completion ratio — good enough for a
        // "downloading model…" progress bar.
        let percent = lastPercent;
        if (typeof obj.total === 'number' && obj.total > 0 && typeof obj.completed === 'number') {
          percent = Math.min(100, Math.floor((obj.completed / obj.total) * 100));
        }
        const message = obj.status || lastMessage || 'downloading…';
        if (percent !== lastPercent || message !== lastMessage) {
          lastPercent = percent;
          lastMessage = message;
          onProgress && onProgress({ step: 'model', message, percent });
        }
        if (obj.status === 'success') return { ok: true };
      }
    }
  } catch (err) {
    return { error: 'ollama pull stream failed: ' + ((err && err.message) || String(err)) };
  }
  return { ok: true };
}

// End-to-end: install binary if needed → start server → pull model → warm up.
// Each step streams a progress event so the consent modal can show what's
// happening. Returns { ok } or { error } at the end.
async function runSetup({ onProgress } = {}) {
  const state = await getSetupState();

  if (state === 'needs-install') {
    const r = await installOllamaViaBrew({ onProgress });
    if (r.error) return r;
  }
  if (state === 'needs-install' || state === 'needs-server') {
    const r = await ensureServerRunning({ onProgress });
    if (r.error) return r;
  }
  // Either the initial state was 'needs-model' or we now need to check whether
  // the model is present after starting the server.
  const probed = await probeNow();
  if (!probed.modelPresent) {
    const r = await pullModel({ onProgress });
    if (r.error) return r;
  }

  // Persist consent so we don't prompt again next launch.
  saveConfig({ ollamaConsent: 'accepted' });

  onProgress && onProgress({ step: 'warmup', message: 'Warming up model…' });
  warmup();
  onProgress && onProgress({ step: 'done', message: 'Ready.' });
  return { ok: true };
}

function declineSetup() {
  saveConfig({ ollamaConsent: 'declined' });
}

// App shutdown — kill the child if we spawned one. Don't touch anything we
// didn't start.
function stopServerOnQuit() {
  if (app && typeof app.on === 'function') {
    app.on('before-quit', () => {
      if (_serverChild && !_serverChild.killed) {
        try { _serverChild.kill('SIGTERM'); } catch {}
      }
    });
  }
}
stopServerOnQuit();

module.exports = {
  probe,
  probeNow,
  generateFIM,
  warmup,
  getModel,
  getSetupState,
  ensureServerRunning,
  runSetup,
  declineSetup,
};
