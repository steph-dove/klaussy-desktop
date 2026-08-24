// Classify glab CLI and GitLab REST API error strings into actionable categories.
const { execFileSync } = require('child_process');

let _glabAcctCache = { at: 0, value: null };

function activeGlabAccount() {
  const now = Date.now();
  if (now - _glabAcctCache.at < 30000) return _glabAcctCache.value;
  let account = null;
  try {
    const out = execFileSync('glab', ['auth', 'status'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    }).toString();
    account = parseGlabAccount(out);
  } catch (err) {
    const combined = ((err.stdout || '') + (err.stderr || '')).toString();
    account = parseGlabAccount(combined);
  }
  _glabAcctCache = { at: now, value: account };
  return account;
}

function parseGlabAccount(text) {
  if (!text) return null;
  // Format: "Logged in to gitlab.com as username (/path/to/config.yml)"
  // or "✓ Logged in to gitlab.com as username"
  const m = text.match(/Logged in to \S+ as ([A-Za-z0-9_.-]+)/i);
  return m ? m[1] : null;
}

function envGlabTokenVar() {
  if (process.env.GITLAB_TOKEN) return 'GITLAB_TOKEN';
  if (process.env.GL_TOKEN) return 'GL_TOKEN';
  if (process.env.CI_JOB_TOKEN) return 'CI_JOB_TOKEN';
  return null;
}

function classifyGlabError(raw, ctx = {}) {
  const msg = String(raw == null ? '' : raw).trim();
  const lower = msg.toLowerCase();
  const target = ctx.target ? ` for ${ctx.target}` : '';
  const host = ctx.host || 'gitlab.com';
  const acct = activeGlabAccount();
  const acctNote = acct ? ` You're signed in to glab as "${acct}".` : '';

  const has = (re) => re.test(msg) || re.test(lower);

  if (has(/enoent|command not found|not recognized as an internal or external command|glab: not found|spawn glab enoent/i)) {
    return {
      kind: 'missing-cli',
      summary: 'GitLab CLI (`glab`) is not installed or not in your PATH.',
      fix: 'Install glab (e.g. `brew install glab` on macOS, `winget install GitLab.glab` on Windows, or `sudo apt install glab` on Linux), then run `glab auth login`.',
      retryable: false,
    };
  }

  if (has(/http 5\d\d|service unavailable|bad gateway|502 bad gateway|503 service unavailable/i)) {
    return {
      kind: 'outage',
      summary: `GitLab's server returned an error${target} — this is likely an outage or server error.`,
      fix: host === 'gitlab.com'
        ? 'Check gitlabstatus.com. Retry once GitLab recovers.'
        : `Check ${host} server health. Retry once the server recovers.`,
      retryable: true,
    };
  }

  if (has(/401 unauthorized|unauthorized|bad credentials|invalid token|glab auth login|not logged in|authentication failed|no gitlab hosts/i)) {
    return {
      kind: 'auth',
      summary: `glab isn't authenticated with ${host} (or the token is invalid/expired).${acctNote}`,
      fix: `glab auth login --hostname ${host}`,
      retryable: false,
    };
  }

  if (has(/403 forbidden|insufficient.*scope|missing.*scope|access forbidden|permission denied|insufficient_scope/i)) {
    return {
      kind: 'scope',
      summary: `Your GitLab token lacks permission to perform this action${target} (needs 'api' or 'read_api' scope).`,
      fix: `glab auth login --hostname ${host}   # or generate a token with 'api' scope`,
      retryable: false,
    };
  }

  if (has(/404 not found|project not found|merge request not found|resource not accessible|cannot find/i)) {
    const what = ctx.target || 'this project';
    const envVar = envGlabTokenVar();
    if (envVar) {
      return {
        kind: 'not-found',
        summary: `GitLab can't find ${what} with the token in $${envVar}.`,
        fix: `unset ${envVar}   # glab falls back to the signed-in account\n# or grant access to ${what}`,
        retryable: false,
      };
    }
    return {
      kind: 'not-found',
      summary: `GitLab can't find ${what} for the signed-in account.${acctNote} The repo may be private or the account lacks access.`,
      fix: acct
        ? `glab auth status            # confirm account\nglab auth switch            # switch to account with access`
        : `glab auth login --hostname ${host}`,
      retryable: false,
    };
  }

  if (has(/rate limit|too many requests|429/i)) {
    return {
      kind: 'rate-limit',
      summary: 'Hit a GitLab API rate limit.',
      fix: 'Wait a minute and retry.',
      retryable: true,
    };
  }

  if (has(/timeout|etimedout|enotfound|eai_again|getaddrinfo|econnreset|socket hang up|network/i)) {
    return {
      kind: 'network',
      summary: `Network error connecting to ${host}.`,
      fix: 'Check your network connection; this retries automatically.',
      retryable: true,
    };
  }

  return {
    kind: 'unknown',
    summary: msg || 'Unknown error talking to GitLab.',
    fix: `glab auth status   # verify login and token permissions on ${host}`,
    retryable: false,
  };
}

module.exports = {
  classifyGlabError,
  activeGlabAccount,
  envGlabTokenVar,
};
