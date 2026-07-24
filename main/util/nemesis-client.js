// HTTP client + node-pty-shaped terminal bridge for a remote Nemesis8 gateway
// (github.com/DeepBlueDynamics/nemesis8).
//
// Its remote API is request/response only — no PTY/stdio/attach — so each prompt
// runs one-shot via POST /completion, rendered in the normal terminal pane.
//
// Endpoints: GET /health; POST /completion {prompt,model?,session_id?} ->
// {session_id,status,output}. Bearer auth from config `nemesisToken`.

const { getNemesisConfig } = require('./config');

const DEFAULT_PORT = 9801;
// A completion runs a full agent turn server-side, so the ceiling is generous;
// Ctrl-C aborts the in-flight request sooner.
const COMPLETION_TIMEOUT_MS = 10 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 5000;

// ---- Pure helpers (unit-tested directly) ----

// Normalize a gateway address: add http:// and :9801 if absent, strip a trailing
// slash, keep an explicit scheme/port/path. Returns '' for empty input.
function normalizeBaseUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : 'http://' + trimmed;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return '';
  }
  if (!parsed.port && !/:\d+$/.test(parsed.host)) parsed.port = String(DEFAULT_PORT);
  return parsed.toString().replace(/\/+$/, '');
}

function authHeaders(token) {
  return token ? { authorization: 'Bearer ' + token } : {};
}

// True when a token would ride an unencrypted http:// connection to a
// non-loopback host — the Bearer header leaks in cleartext. http to localhost
// is fine (never leaves the box).
function isInsecureRemote(base, token) {
  if (!token || !base || !/^http:\/\//i.test(base)) return false;
  let host;
  try { host = new URL(base).hostname; } catch { return false; }
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
}

// Route a spawn to the remote gateway only when the integration is enabled AND
// the tab runs an agent (plain shells stay local). `isAgentMode` is injected so
// this stays pure and the routing choice can be pinned without a pty.
function shouldUseNemesis(cfg, mode, isAgentMode) {
  return !!(cfg && cfg.enabled) && isAgentMode(mode);
}

function errMsg(err) {
  return (err && err.message) || String(err);
}

// Line-edit a chunk of raw terminal input: returns the updated buffer, bytes to
// echo, and any completed lines (CR/LF). Pure, so the fiddly rules are testable.
function parseInputChunk(buffer, chunk) {
  let buf = buffer;
  let echo = '';
  const lines = [];
  const s = String(chunk);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\x1b') {
      // Drop an ANSI escape sequence (arrows, Home/End) whole — CSI/SS3 run until
      // a final byte in 0x40-0x7e. Stateless between chunks, so a bare ESC is
      // swallowed but a CSI split on a chunk boundary leaks its "[D" tail (rare).
      if (s[i + 1] === '[' || s[i + 1] === 'O') {
        i += 2;
        while (i < s.length && !(s[i] >= '@' && s[i] <= '~')) i++;
      }
    } else if (ch === '\r' || ch === '\n') {
      lines.push(buf);
      buf = '';
      echo += '\r\n';
    } else if (ch === '\x7f' || ch === '\b') {
      if (buf.length > 0) {
        buf = buf.slice(0, -1);
        echo += '\b \b'; // move back, erase, move back
      }
    } else if (ch >= ' ') {
      buf += ch;
      echo += ch;
    }
  }
  return { buf, echo, lines };
}

// ---- HTTP calls ----

function resolveBase() {
  const { remote, token } = getNemesisConfig();
  return { base: normalizeBaseUrl(remote), token };
}

async function health() {
  const { base, token } = resolveBase();
  if (!base) return { ok: false, error: 'no nemesis8 remote configured' };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(base + '/health', { headers: authHeaders(token), signal: ctrl.signal });
    if (res.status === 401) return { ok: false, error: 'unauthorized — check the nemesis token' };
    if (!res.ok) return { ok: false, error: 'health HTTP ' + res.status };
    const body = await res.json().catch(() => ({}));
    return { ok: true, version: body.version };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  } finally {
    clearTimeout(to);
  }
}

// Run one prompt, threading `sessionId` to keep a session across turns. Pass an
// AbortSignal for Ctrl-C cancellation; resolves (never rejects) with the result.
async function complete({ prompt, model, sessionId, signal } = {}) {
  const { remote, token, model: cfgModel } = getNemesisConfig();
  const base = normalizeBaseUrl(remote);
  if (!base) return { error: 'no nemesis8 remote configured' };
  const body = { prompt: String(prompt || '') };
  const useModel = model || cfgModel;
  if (useModel) body.model = useModel;
  if (sessionId) body.session_id = sessionId;

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), COMPLETION_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(base + '/completion', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (res.status === 401) return { error: 'unauthorized — check the nemesis token' };
    if (res.status === 429) return { error: 'gateway busy — max concurrent runs reached, retry shortly' };
    if (!res.ok) return { error: 'completion HTTP ' + res.status };
    const data = await res.json().catch(() => ({}));
    return { session_id: data.session_id || sessionId || null, status: data.status, output: data.output || '' };
  } catch (err) {
    if (signal && signal.aborted) return { cancelled: true };
    if (ctrl.signal.aborted) return { error: 'completion timed out' };
    return { error: errMsg(err) };
  } finally {
    clearTimeout(to);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ---- Terminal bridge ----

const C = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
};
const PROMPT = C.green + 'nemesis8> ' + C.reset;

// Build a node-pty-shaped object that runs prompts against the remote gateway.
// `client` is injectable for tests; defaults to this module's real HTTP calls.
function createNemesisTerminal(opts = {}) {
  const { worktreePath, model, initialPrompt, resumeSessionId } = opts;
  const client = opts.client || { health, complete };

  const dataCbs = [];
  const exitCbs = [];
  let preBuffer = [];
  let sessionId = resumeSessionId || null;
  let alive = true;
  let busy = false;
  let booting = true; // ignore typed input until the health check settles
  let inflight = null; // AbortController for the running completion
  let lineBuf = '';

  function emit(s) {
    if (dataCbs.length === 0) { preBuffer.push(s); return; }
    for (const cb of dataCbs) { try { cb(s); } catch { /* subscriber threw */ } }
  }

  function fireExit(code, extra) {
    if (!alive) return;
    alive = false;
    const payload = { exitCode: code, ...extra };
    for (const cb of exitCbs) { try { cb(payload); } catch { /* subscriber threw */ } }
  }

  function writePrompt() {
    emit('\r\n' + PROMPT);
  }

  async function submit(text) {
    if (busy) return; // one completion at a time — the shared re-entrancy guard
    const prompt = text.trim();
    if (!prompt) { writePrompt(); return; }
    busy = true;
    emit('\r\n' + C.dim + '· running on nemesis8…' + C.reset + '\r\n');
    const ctrl = new AbortController();
    inflight = ctrl;
    let res;
    try {
      res = await client.complete({ prompt, model, sessionId, signal: ctrl.signal });
    } finally {
      inflight = null;
      busy = false;
    }
    if (!alive) return;
    if (res && res.cancelled) {
      emit(C.dim + '· cancelled' + C.reset + '\r\n');
    } else if (!res || res.error) {
      emit(C.red + 'error: ' + ((res && res.error) || 'unknown') + C.reset + '\r\n');
    } else {
      if (res.session_id) sessionId = res.session_id;
      const out = String(res.output || '').replace(/\r?\n/g, '\r\n');
      emit(out + (out.endsWith('\r\n') || out === '' ? '' : '\r\n'));
    }
    writePrompt();
  }

  // Boot on a fresh tick so state/instances.js registers its onData handler
  // before we emit the banner (otherwise the first bytes race the subscriber).
  setTimeout(async () => {
    emit(C.cyan + 'Nemesis8 remote session' + C.reset +
         C.dim + (worktreePath ? '  (' + worktreePath + ')' : '') + C.reset + '\r\n');
    const { remote, token } = getNemesisConfig();
    if (isInsecureRemote(normalizeBaseUrl(remote), token)) {
      emit(C.red + 'warning: the nemesis token is sent unencrypted over http:// — ' +
           'use an https gateway or a trusted tunnel' + C.reset + '\r\n');
    }
    const h = await client.health();
    if (!alive) return;
    if (!h || !h.ok) {
      emit(C.red + 'Cannot reach nemesis8 gateway: ' + ((h && h.error) || 'unknown') + C.reset + '\r\n');
      // Distinct signal so instances.js keeps the tab in an exited/error state
      // rather than silently dropping to a local shell in a worktree the user
      // meant to drive remotely (a misleading "<agent> has exited").
      fireExit(1, { nemesisUnreachable: true });
      return;
    }
    emit(C.dim + 'connected' + (h.version ? ' · v' + h.version : '') +
         ' · type a prompt, Enter to run, Ctrl-C to cancel' + C.reset + '\r\n');
    booting = false;
    if (initialPrompt) await submit(initialPrompt);
    else writePrompt();
  }, 0);

  return {
    cols: 120,
    rows: 30,
    onData(cb) {
      dataCbs.push(cb);
      if (preBuffer.length) {
        const flush = preBuffer;
        preBuffer = [];
        for (const s of flush) { try { cb(s); } catch { /* subscriber threw */ } }
      }
      return { dispose() { const i = dataCbs.indexOf(cb); if (i !== -1) dataCbs.splice(i, 1); } };
    },
    onExit(cb) {
      exitCbs.push(cb);
      return { dispose() { const i = exitCbs.indexOf(cb); if (i !== -1) exitCbs.splice(i, 1); } };
    },
    write(data) {
      if (!alive) return;
      // Ctrl-C aborts an in-flight completion (or clears a half-typed line).
      if (String(data).includes('\x03')) {
        if (inflight) { try { inflight.abort(); } catch { /* already done */ } }
        else if (lineBuf) { lineBuf = ''; emit('^C'); writePrompt(); }
        return;
      }
      if (booting || busy) return;
      const { buf, echo, lines } = parseInputChunk(lineBuf, data);
      lineBuf = buf;
      if (echo) emit(echo);
      if (lines.length) submit(lines[0]); // one prompt at a time; extras dropped
    },
    resize() { /* remote gateway has no TTY to resize */ },
    kill() {
      if (inflight) { try { inflight.abort(); } catch { /* already done */ } }
      fireExit(0);
    },
    get sessionId() { return sessionId; },
  };
}

module.exports = {
  normalizeBaseUrl,
  authHeaders,
  isInsecureRemote,
  shouldUseNemesis,
  parseInputChunk,
  health,
  complete,
  createNemesisTerminal,
};
