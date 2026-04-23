// Process-execution primitives: promisified execFile, gh auth/env helpers,
// stderr tail cap, concurrency limiter, and PTY env sanitizer. Every git IPC
// handler should import `execFileP` here rather than promisifying locally,
// so there's exactly one entry point for subprocess calls.

const { execFile, execFileSync } = require('child_process');
const execFileP = require('util').promisify(execFile);

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
const ghTokenCache = new Map(); // remote owner -> { token: string|null, at: ms }

function ghEnvForRepo(repoDir) {
  try {
    // Get the remote URL
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoDir, stdio: 'pipe',
    }).toString().trim();

    // Extract owner from SSH or HTTPS remote
    // ssh: git@github.com:owner/repo.git  https: https://github.com/owner/repo.git
    // Accept arbitrary hostnames so GitHub Enterprise (github.corp.example)
    // works the same way as github.com.
    let owner;
    const m = remoteUrl.match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?$/);
    if (m) owner = m[1];
    if (!owner) return {};

    const cached = ghTokenCache.get(owner);
    if (cached && (Date.now() - cached.at) < GH_TOKEN_CACHE_TTL_MS) {
      if (cached.token) return { GH_TOKEN: cached.token };
      return {};
    }

    // Try to get a token for this owner from gh auth
    try {
      const token = execFileSync('gh', ['auth', 'token', '--user', owner], {
        stdio: 'pipe', timeout: 5000,
      }).toString().trim();
      if (token) {
        ghTokenCache.set(owner, { token, at: Date.now() });
        return { GH_TOKEN: token };
      }
    } catch {}

    ghTokenCache.set(owner, { token: null, at: Date.now() });
    return {};
  } catch {
    return {};
  }
}

function ghExec(args, opts) {
  const env = ghEnvForRepo(opts.cwd);
  return execFileSync('gh', args, {
    ...opts,
    env: { ...process.env, ...env },
  });
}

// Async variant for background work (timers, polling) — sync ghExec freezes
// the main thread for the full gh round-trip, which is unacceptable at
// 30-second cadence across N tasks.
async function ghExecP(args, opts) {
  const env = ghEnvForRepo(opts && opts.cwd);
  return execFileP('gh', args, {
    ...(opts || {}),
    env: { ...process.env, ...env },
  });
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

module.exports = {
  execFileP,
  STDERR_CAP_BYTES,
  appendStderr,
  ghEnvForRepo,
  ghExec,
  ghExecP,
  clearGhTokenCache,
  runWithConcurrency,
  sanitizeExtraEnv,
};
