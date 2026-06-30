// Ollama HTTP client for inline AI completion. Probes the local server,
// streams fill-in-middle completions, and surfaces model-presence state so
// the renderer can decide whether to activate passive ghost-text or fall
// back to word-complete.
//
// No HTTP dependency — Node 18+ has global `fetch` and `AbortController`.
// Streaming reads ReadableStream line by line, since Ollama emits one JSON
// object per line.
//
// Config overrides (persisted in userData/config.json):
//   ollamaUrl   — default 'http://127.0.0.1:11434'
//   ollamaModel — default 'qwen2.5-coder:1.5b-base' (base = FIM-tuned)

const { execFile, spawn } = require('child_process');
const { app } = require('electron');
const { loadConfig, saveConfig } = require('../util/config');
const { whichBinSync } = require('../util/platform');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

const DEFAULT_URL = 'http://127.0.0.1:11434';
// Base (not instruct) variant: trained for fill-in-the-middle, so it continues
// code cleanly instead of narrating. Override via config `ollamaModel`.
const DEFAULT_MODEL = 'qwen2.5-coder:1.5b-base';
// Ollama's runtime default context window is 4096 when num_ctx is unset, which
// silently truncates once we add cross-file snippets. 8192 fits the current
// window plus repo context with room for the completion.
const DEFAULT_NUM_CTX = 8192;

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
    // Tags are "<name>:<tag>". A configured tag must match exactly (a sibling
    // tag is a different download and FIM would 404); a bare name with no ':'
    // matches any tag of that family.
    const hasTag = model.includes(':');
    result.modelPresent = names.some((n) =>
      n === model || n.startsWith(model + ':') || (!hasTag && n.split(':')[0] === model));
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

// Builds Qwen2.5-Coder's repo-level FIM prompt: optional repo name, cross-file
// snippets, then the current file with the cursor hole. Sent raw:true so Ollama
// passes it verbatim instead of applying a chat template.
function buildRepoFimPrompt({ repoName, filePath, prefix, suffix, snippets }) {
  const parts = [];
  if (repoName) parts.push('<|repo_name|>' + repoName);
  (snippets || []).forEach((s) => {
    if (s && s.path && s.content) parts.push('<|file_sep|>' + s.path + '\n' + s.content);
  });
  const head = filePath ? '<|file_sep|>' + filePath + '\n' : '';
  parts.push(head + '<|fim_prefix|>' + (prefix || '') + '<|fim_suffix|>' + (suffix || '') + '<|fim_middle|>');
  return parts.join('\n');
}

// Streams a fill-in-middle completion.
//
// Two transports: with filePath/snippets we send the repo-level FIM prompt
// raw (model sees filename + neighbours); without, legacy file-level FIM via
// Ollama's native prompt+suffix wrapping.
//
// Callbacks:
//   onChunk(text)      — each response delta from the stream
//   onDone({ ok, error, cancelled })
//
// Returns a cancel function.
function generateFIM({ prefix, suffix, filePath, snippets, repoName, options, onChunk, onDone }) {
  const url = getBaseUrl();
  const model = getModel();
  const ctrl = new AbortController();
  let settled = false;

  const useRepoFim = !!(filePath || (snippets && snippets.length));

  function finish(payload) {
    if (settled) return;
    settled = true;
    try { onDone && onDone(payload); } catch {}
  }

  (async () => {
    let res;
    try {
      // Keep completions short and deterministic-ish — this is inline
      // autocomplete, not free-form generation. num_ctx must be explicit or
      // Ollama caps at 4096 and truncates the repo context.
      const reqOptions = Object.assign({
        num_ctx: DEFAULT_NUM_CTX,
        num_predict: 128,
        temperature: 0.2,
        top_p: 0.95,
        stop: ['\n\n\n', '<|endoftext|>', '<|file_sep|>', '<|fim_pad|>'],
      }, options || {});
      const body = useRepoFim
        ? { model, prompt: buildRepoFimPrompt({ repoName, filePath, prefix, suffix, snippets }), raw: true, stream: true, options: reqOptions }
        : { model, prompt: prefix || '', suffix: suffix || '', stream: true, options: reqOptions };
      res = await fetch(url + '/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify(body),
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
  // Thin wrapper around whichBinSync (which / where.exe). The wrapper used
  // to shell out to /usr/bin/which directly, which broke on Windows; routing
  // through platform.js fixes that and keeps the call-site async-shaped.
  return Promise.resolve(whichBinSync(bin));
}

// Detection cascade for the consent/install flow. Returns 'ready',
// 'needs-model', 'needs-server', 'needs-install', or 'declined' (the last
// when the user previously opted out).
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

// Spawns a package-manager install command, streaming progress via onProgress.
// Shared by the brew/winget/snap paths (only binary + args differ). Returns
// { ok } on exit 0, { error } otherwise.
function spawnInstall({ cmd, args, label, onProgress }) {
  onProgress && onProgress({ step: 'install', message: `Installing Ollama via ${label}…` });
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      resolve({ error: `${label} install failed to start: ${err.message}` });
      return;
    }
    let stderrBuf = '';
    const stream = (chunk) => {
      const s = chunk.toString();
      stderrBuf += s;
      // Trim to last non-empty line — brew/winget print progress with \r.
      const lastLine = s.split(/[\r\n]+/).filter(Boolean).pop();
      if (lastLine && onProgress) onProgress({ step: 'install', message: lastLine.slice(0, 200) });
    };
    proc.stderr.on('data', stream);
    // winget writes its progress to stdout; brew writes to stderr. Tail both.
    proc.stdout.on('data', stream);
    proc.on('error', (err) => resolve({ error: `${label} install failed to start: ${err.message}` }));
    proc.on('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({
        error: `${label} install exited with code ${code}` + (stderrBuf ? ': ' + stderrBuf.trim().slice(-300) : ''),
      });
    });
  });
}

// Installs Ollama via the platform package manager (brew/winget/snap). We
// don't curl-pipe-sh on Linux without consent. If the manager is missing,
// returns a message pointing at the official download page.
async function installOllama({ onProgress } = {}) {
  if (IS_WIN) {
    const winget = await which('winget');
    if (!winget) {
      return {
        error:
          'winget not found. Install Ollama from https://ollama.com/download/windows and re-run setup.',
      };
    }
    return spawnInstall({
      cmd: winget,
      // --accept-* flags suppress the interactive Y/N prompts that would
      // otherwise hang a non-TTY child. -e + --id picks the canonical
      // package and rejects partial-name fuzzy matches.
      args: ['install', '-e', '--id', 'Ollama.Ollama', '--accept-source-agreements', '--accept-package-agreements'],
      label: 'winget',
      onProgress,
    });
  }
  if (IS_LINUX) {
    const snap = await which('snap');
    if (snap) {
      // The classic snap is the upstream-recommended way on Ubuntu and
      // most snap-enabled distros. --classic is required because Ollama
      // needs broader filesystem access than strict confinement allows.
      return spawnInstall({
        cmd: snap,
        args: ['install', 'ollama', '--classic'],
        label: 'snap',
        onProgress,
      });
    }
    return {
      error:
        'snap not found. Install Ollama with the official script:\n\n' +
        '  curl -fsSL https://ollama.com/install.sh | sh\n\n' +
        'Then re-run setup.',
    };
  }
  // macOS
  const brew = await which('brew');
  if (!brew) {
    return { error: 'Homebrew not found. Install from https://brew.sh and try again.' };
  }
  return spawnInstall({ cmd: brew, args: ['install', 'ollama'], label: 'brew', onProgress });
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

// Ensures the configured model is installed: starts the server if needed, then
// pulls only when absent. Assumes the Ollama binary exists. Returns
// { ok } / { ok, alreadyPresent } / { error }.
async function ensureModel({ onProgress } = {}) {
  let probed = await probeNow();
  if (!probed.running) {
    const r = await ensureServerRunning({ onProgress });
    if (r.error) return r;
    probed = await probeNow();
  }
  if (probed.modelPresent) return { ok: true, alreadyPresent: true };
  const r = await pullModel({ onProgress });
  if (r.error) return r;
  await probeNow();
  return { ok: true };
}

// End-to-end: install binary if needed → start server → pull model → warm up.
// Each step streams a progress event so the consent modal can show what's
// happening. Returns { ok } or { error } at the end.
async function runSetup({ onProgress } = {}) {
  const state = await getSetupState();

  if (state === 'needs-install') {
    const r = await installOllama({ onProgress });
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
  ensureModel,
  runSetup,
  declineSetup,
};
