// Tell "this token is dead" apart from "GitHub is having an outage".
//
// `gh auth status` verifies a token by calling the REST API. When GitHub has a
// REST degradation those endpoints 503, and gh reports "The token in keyring is
// invalid" — the same wording it uses for a genuinely revoked token. Taking gh
// at its word signs the user out mid-outage, and re-authenticating can't clear
// it: the freshly minted token 503s exactly the same way, so the login prompt
// returns on every check.
//
// /rate_limit is the tiebreaker. It stays served during REST degradation, and
// it still authenticates — verified against the live API:
//
//   bogus token  -> 401            (no silent fall back to anonymous)
//   no auth      -> 200, limit 60  (anonymous ceiling)
//   valid token  -> 200, limit 5000
//
// So a 200 with a limit above the anonymous ceiling means GitHub accepts the
// credential, and gh's "invalid" verdict is outage noise rather than a dead
// token. Anything else (401, network error, timeout) is treated as no evidence
// and we keep gh's verdict — this may only ever rescue an account, never
// condemn one.

const { execFileSync } = require('child_process');

const LIVE_PROBE_TTL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 5000;
const RATE_LIMIT_URL = 'https://api.github.com/rate_limit';
const ANON_CORE_LIMIT = 60;

const OUTAGE_REASON = 'GitHub API is degraded — your login is fine, but some requests may fail';

// username -> { alive: boolean, at: ms }. Probing costs a network round trip,
// and the callers that gate the UI (account list, PR account detect) can fire
// several times per user action.
const probeCache = new Map();

function readTokenFor(username) {
  try {
    return execFileSync('gh', ['auth', 'token', '--user', username], {
      stdio: 'pipe', timeout: PROBE_TIMEOUT_MS,
    }).toString().trim();
  } catch {
    return '';
  }
}

async function tokenAcceptedByGitHub(token, fetchImpl) {
  const res = await fetchImpl(RATE_LIMIT_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'klaussy-desktop',
    },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (res.status !== 200) return false;
  const body = await res.json();
  const limit = body?.resources?.core?.limit ?? 0;
  return limit > ANON_CORE_LIMIT;
}

async function isTokenLive(username, deps) {
  const { getToken, fetchImpl, now, cache } = deps;
  const cached = cache.get(username);
  if (cached && (now() - cached.at) < LIVE_PROBE_TTL_MS) return cached.alive;

  let alive = false;
  try {
    const token = getToken(username);
    if (token) alive = await tokenAcceptedByGitHub(token, fetchImpl);
  } catch {
    alive = false;
  }
  cache.set(username, { alive, at: now() });
  return alive;
}

// Mutates and returns `accounts`: any entry gh flagged invalid whose token
// GitHub still accepts is restored to valid and marked `outage: true`, so the
// UI can explain the degradation instead of demanding a pointless re-login.
async function reconcileOutage(accounts, deps = {}) {
  const {
    getToken = readTokenFor,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    cache = probeCache,
  } = deps;

  // The healthy path — every account valid — must cost zero network calls.
  const suspect = accounts.filter((a) => !a.valid);
  if (suspect.length === 0) return accounts;

  await Promise.all(suspect.map(async (acc) => {
    if (await isTokenLive(acc.username, { getToken, fetchImpl, now, cache })) {
      acc.valid = true;
      acc.outage = true;
      acc.reason = OUTAGE_REASON;
    }
  }));
  return accounts;
}

// Call alongside clearGhTokenCache() after a login or account switch: the
// credential changed, so a cached verdict about the old one is meaningless.
function clearOutageProbeCache() { probeCache.clear(); }

module.exports = {
  reconcileOutage,
  clearOutageProbeCache,
  OUTAGE_REASON,
  LIVE_PROBE_TTL_MS,
  ANON_CORE_LIMIT,
};
