// Nemesis8 helpers: the routing check plus a /health probe for the prefs "Test
// connection" button. Tabs run `nemesis8 interactive` in a real pty (see
// ai-providers.js / instances.js), not the gateway's HTTP /completion, which
// hangs upstream (drops the prompt behind a synthetic session id).

const { getNemesisConfig } = require('./config');

const DEFAULT_PORT = 9801;
const HEALTH_TIMEOUT_MS = 5000;

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

// Picker ids whose tabs run in a Nemesis8 sandbox: `nemesis8` or, per named
// gateway profile, `nemesis8:<profileId>`. A per-tab choice, not a global flag.
const NEMESIS_MODE = 'nemesis8';

function shouldUseNemesis(mode) {
  return mode === NEMESIS_MODE || (typeof mode === 'string' && mode.startsWith(NEMESIS_MODE + ':'));
}

function errMsg(err) {
  if (!err) return 'unknown error';
  // Node's fetch wraps the real network failure ("fetch failed") in err.cause;
  // surface its code (ECONNREFUSED / ENOTFOUND / …) so the UI is diagnostic.
  const cause = err.cause && (err.cause.code || err.cause.message);
  return cause ? `${err.message} (${cause})` : (err.message || String(err));
}

// Resolve the {base, token} to probe. `conn` ({ remote, token }) targets a
// specific gateway profile (or the prefs form's on-screen values).
function resolveBase(conn) {
  if (conn && (conn.remote || conn.token)) {
    return { base: normalizeBaseUrl(conn.remote), token: conn.token || '' };
  }
  const { remote, token } = getNemesisConfig();
  return { base: normalizeBaseUrl(remote), token };
}

// Liveness probe for a remote gateway's `serve`. { ok, version } / { ok:false, error }.
async function health(conn) {
  const { base, token } = resolveBase(conn);
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

module.exports = {
  NEMESIS_MODE,
  normalizeBaseUrl,
  authHeaders,
  isInsecureRemote,
  shouldUseNemesis,
  health,
};
