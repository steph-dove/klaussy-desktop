// Process-execution primitives: promisified execFile, gh auth/env helpers,
// stderr tail cap, concurrency limiter, and PTY env sanitizer. Every git IPC
// handler should import `execFileP` here rather than promisifying locally,
// so there's exactly one entry point for subprocess calls.

const { execFile, execFileSync } = require('child_process');
const execFileP = require('util').promisify(execFile);
const { whichBinSync } = require('./platform');

const IS_WIN = process.platform === 'win32';

// cmd.exe-safe quoting for execToolP's batch-shim branch: bare tokens pass
// through; anything with whitespace/metacharacters is double-quoted (no `%`).
function winShellQuote(s) {
  s = String(s);
  if (/^[A-Za-z0-9_.:=+\-\\/]+$/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

// Windows-hardened execFile for PATH tools, a plain passthrough on macOS/Linux
// (on Windows: where+PATHEXT resolution, cmd/bat shims via shell, windowsHide,
// and batch files that execFile blocks per CVE-2024-27980 run through cmd)
function execToolP(file, args = [], opts = {}) {
  if (!IS_WIN) return execFileP(file, args, opts);
  const resolved = /[\\/]/.test(file) ? file : (whichBinSync(file) || file);
  if (/\.(cmd|bat)$/i.test(resolved)) {
    return execFileP(winShellQuote(resolved), args.map(winShellQuote), {
      ...opts, shell: true, windowsHide: true,
    });
  }
  return execFileP(resolved, args, { ...opts, windowsHide: true });
}

// Synchronous twin of execToolP for startup PATH-discovery, same Windows
// hardening, passthrough to execFileSync on macOS/Linux
function execToolSync(file, args = [], opts = {}) {
  if (!IS_WIN) return execFileSync(file, args, opts);
  const resolved = /[\\/]/.test(file) ? file : (whichBinSync(file) || file);
  if (/\.(cmd|bat)$/i.test(resolved)) {
    return execFileSync(winShellQuote(resolved), args.map(winShellQuote), {
      ...opts, shell: true, windowsHide: true,
    });
  }
  return execFileSync(resolved, args, { ...opts, windowsHide: true });
}

// Cap accumulation of a child process's stderr. Every streaming claude handler
// buffers stderr unboundedly — a `--verbose` run or a lot of warnings could
// balloon memory per request. We keep the last N bytes so the tail is
// preserved for error reporting.
const STDERR_CAP_BYTES = 64 * 1024;
function appendStderr(buf, chunk) {
  const s = buf + chunk.toString();
  if (s.length <= STDERR_CAP_BYTES) return s;
  return s.slice(s.length - STDERR_CAP_BYTES);
}

// Resolve the correct gh auth token for a given repo directory.
// Matches the remote owner (e.g. "steph-dove") to a logged-in gh account.
//
// Entries have a TTL — previously they lived forever, so after `gh auth switch`
// or `gh auth refresh` (external or internal), we'd keep sending a stale/revoked
// token on every outbound gh call. The `gh-switch-account` handler also clears
// the cache explicitly via clearGhTokenCache().
const GH_TOKEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const ghTokenCache = new Map(); // remote owner | 'acct:<user>' -> { token: string|null, at: ms }
// A remote's owner barely ever changes, so skip `git remote get-url` on every gh call.
const repoOwnerCache = new Map(); // cwd -> { owner: string|null, at: ms }
const ghEnvInFlight = new Map(); // key -> Promise, so concurrent pollers share one spawn

function freshEntry(map, key) {
  const entry = map.get(key);
  return entry && (Date.now() - entry.at) < GH_TOKEN_CACHE_TTL_MS ? entry : null;
}

function shareInFlight(key, fn) {
  if (ghEnvInFlight.has(key)) return ghEnvInFlight.get(key);
  const p = fn().finally(() => ghEnvInFlight.delete(key));
  ghEnvInFlight.set(key, p);
  return p;
}

// ssh: git@github.com:owner/repo.git  https: https://github.com/owner/repo.git
// Any hostname is accepted so GitHub Enterprise works the same as github.com.
function ownerFromRemoteUrl(remoteUrl) {
  const m = String(remoteUrl || '').trim().match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?$/);
  return m ? m[1] : null;
}

function repoOwnerSync(cwd) {
  const cached = freshEntry(repoOwnerCache, cwd);
  if (cached) return cached.owner;
  let owner = null;
  try {
    owner = ownerFromRemoteUrl(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, stdio: 'pipe' }).toString());
  } catch {}
  // A failed lookup isn't cached: origin may be added moments later.
  if (owner) repoOwnerCache.set(cwd, { owner, at: Date.now() });
  return owner;
}

async function repoOwnerP(cwd) {
  const cached = freshEntry(repoOwnerCache, cwd);
  if (cached) return cached.owner;
  return shareInFlight('owner:' + cwd, async () => {
    let owner = null;
    try {
      const { stdout } = await execFileP('git', ['remote', 'get-url', 'origin'], { cwd });
      owner = ownerFromRemoteUrl(stdout);
    } catch {}
    if (owner) repoOwnerCache.set(cwd, { owner, at: Date.now() });
    return owner;
  });
}

function tokenEnv(token) { return token ? { GH_TOKEN: token } : {}; }

function tokenEnvSync(key, user) {
  const cached = freshEntry(ghTokenCache, key);
  if (cached) return tokenEnv(cached.token);
  let token = null;
  try {
    token = execFileSync('gh', ['auth', 'token', '--user', user], { stdio: 'pipe', timeout: 5000 }).toString().trim() || null;
  } catch {}
  ghTokenCache.set(key, { token, at: Date.now() });
  return tokenEnv(token);
}

async function tokenEnvP(key, user) {
  const cached = freshEntry(ghTokenCache, key);
  if (cached) return tokenEnv(cached.token);
  const token = await shareInFlight('token:' + key, async () => {
    let t = null;
    try {
      const { stdout } = await execFileP('gh', ['auth', 'token', '--user', user], { timeout: 5000 });
      t = String(stdout).trim() || null;
    } catch {}
    ghTokenCache.set(key, { token: t, at: Date.now() });
    return t;
  });
  return tokenEnv(token);
}

function ghEnvForRepo(repoDir) {
  const owner = repoOwnerSync(repoDir);
  return owner ? tokenEnvSync(owner, owner) : {};
}

async function ghEnvForRepoP(repoDir) {
  const owner = await repoOwnerP(repoDir);
  return owner ? tokenEnvP(owner, owner) : {};
}

// Resolve the GH_TOKEN env for a gh call, most specific first: an explicit
// review account (survives global-account drift; the only thing that works for
// org repos), then the repo owner, then {} (gh's ambient active account).
function resolveGhEnv({ account, cwd } = {}) {
  if (account) {
    const acct = ghEnvForAccount(account);
    if (acct.GH_TOKEN) return acct;
  }
  return ghEnvForRepo(cwd);
}

async function resolveGhEnvP({ account, cwd } = {}) {
  if (account) {
    const acct = await ghEnvForAccountP(account);
    if (acct.GH_TOKEN) return acct;
  }
  return ghEnvForRepoP(cwd);
}

function ghExec(args, opts = {}) {
  const { ghAccount, ...rest } = opts;
  const env = resolveGhEnv({ account: ghAccount, cwd: rest.cwd });
  return execFileSync('gh', args, {
    ...rest,
    env: { ...process.env, ...env },
  });
}

// Async variant for background work (timers, polling) — sync ghExec freezes
// the main thread for the full gh round-trip, which is unacceptable at
// 30-second cadence across N tasks.
async function ghExecP(args, opts = {}) {
  const { ghAccount, ...rest } = opts;
  const env = await resolveGhEnvP({ account: ghAccount, cwd: rest.cwd });
  return execFileP('gh', args, {
    ...rest,
    env: { ...process.env, ...env },
  });
}

function ghAccountUser(username) {
  // The PR picker passes its account ids ('github:<user>', 'gitlab:...').
  if (typeof username === 'string' && username.startsWith('github:')) username = username.slice('github:'.length);
  if (!username || /^(gitlab|bitbucket):/.test(username)) return null;
  return username;
}

// Resolve a gh token for a specific logged-in account (by username), so a
// caller can run a gh command AS that account without `gh auth switch` flipping
// the global active account. Returns { GH_TOKEN } or {} if no token. Cached
// (keyed distinctly from the repo-owner cache).
function ghEnvForAccount(username) {
  const user = ghAccountUser(username);
  return user ? tokenEnvSync('acct:' + user, user) : {};
}

async function ghEnvForAccountP(username) {
  const user = ghAccountUser(username);
  return user ? tokenEnvP('acct:' + user, user) : {};
}

function clearGhTokenCache() { ghTokenCache.clear(); }

// Process `items` in parallel with at most `cap` in flight at once. Used by
// background timers so a 20-task setup doesn't spawn 20 simultaneous `git
// fetch` subprocesses — we keep to `cap` workers and let them drain the queue.
async function runWithConcurrency(items, cap, worker) {
  const queue = items.slice();
  const active = [];
  for (let i = 0; i < Math.min(cap, queue.length); i++) {
    active.push((async () => {
      while (queue.length) {
        const next = queue.shift();
        try { await worker(next); } catch (_) { /* silent — background */ }
      }
    })());
  }
  await Promise.all(active);
}

// Drop any env key we'd rather not see forwarded into a PTY child: anything
// that looks like a dynamic-linker knob (LD_PRELOAD / DYLD_*), Node/Ruby/Perl/
// Python startup hijackers, or whose name isn't a plausible env-var identifier.
// Called for every PTY spawn + restart — a compromised renderer (via XSS) or
// a malicious pasted .env must not be able to inject dylib loads into the
// shell / claude / gh subprocesses.
const ENV_NAME_DENYLIST = /^(LD_|DYLD_|NODE_OPTIONS$|PATH$|PYTHONPATH$|RUBYOPT$|PERL5LIB$|RUBYLIB$|PYTHONSTARTUP$)/;
function sanitizeExtraEnv(extraEnv) {
  if (!extraEnv || typeof extraEnv !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(extraEnv)) {
    if (typeof k !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(k)) continue;
    if (ENV_NAME_DENYLIST.test(k)) continue;
    if (typeof v !== 'string') continue;
    out[k] = v;
  }
  return out;
}

// Not osascript: macOS silently refuses AppleEvents from apps without the automation entitlement.
function openInMacTerminal(scriptPath) {
  return execFileP('open', ['-a', 'Terminal', scriptPath], { timeout: 15000 });
}

module.exports = {
  execFileP,
  openInMacTerminal,
  execToolP,
  execToolSync,
  winShellQuote,
  STDERR_CAP_BYTES,
  appendStderr,
  ownerFromRemoteUrl,
  ghEnvForRepo,
  ghEnvForRepoP,
  ghEnvForAccount,
  ghEnvForAccountP,
  resolveGhEnv,
  resolveGhEnvP,
  ghExec,
  ghExecP,
  clearGhTokenCache,
  runWithConcurrency,
  sanitizeExtraEnv,
};
