// Turn a raw `gh` / GraphQL error string into something actionable. These
// failures are almost always environmental (wrong gh account, un-authorized
// SSO org, missing token scope, expired login, transient network) rather than
// bugs, and they only surface on certain repos/machines — so a clear summary
// plus the exact `gh` command to fix it saves a lot of guessing.
const { execFileSync } = require('child_process');

// Best-effort active GitHub CLI account (the common "two accounts, wrong one
// active on this machine" case). Cached briefly so repeated classifications
// don't shell out each time. Never throws.
let _acctCache = { at: 0, value: null };
function activeGhAccount() {
  const now = Date.now();
  if (now - _acctCache.at < 30000) return _acctCache.value;
  let account = null;
  try {
    // `gh auth status` prints to stderr on older versions, stdout on newer.
    const out = execFileSync('gh', ['auth', 'status'], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    }).toString();
    account = parseGhAccount(out);
  } catch (err) {
    const combined = ((err.stdout || '') + (err.stderr || '')).toString();
    account = parseGhAccount(combined);
  }
  _acctCache = { at: now, value: account };
  return account;
}

function parseGhAccount(text) {
  if (!text) return null;
  // Newer gh: "Logged in to github.com account steph-dove (keyring)"
  // Older gh: "Logged in to github.com as steph-dove (...)"
  const m = text.match(/Logged in to \S+ (?:account|as) ([A-Za-z0-9-]+)/);
  return m ? m[1] : null;
}

// Classify a raw error message. `ctx` may carry { target: 'owner/repo' } for a
// more specific summary. Returns { kind, summary, fix, retryable }.
function classifyGhError(raw, ctx = {}) {
  const msg = String(raw == null ? '' : raw).trim();
  const lower = msg.toLowerCase();
  const target = ctx.target ? ` for ${ctx.target}` : '';
  const acct = activeGhAccount();
  const acctNote = acct ? ` You're signed in to gh as "${acct}".` : '';

  const has = (re) => re.test(msg) || re.test(lower);

  if (has(/saml enforcement|protected by organization|single sign-on|\bsso\b/i)) {
    return {
      kind: 'sso',
      summary: `This organization requires SSO authorization for your gh token${target}.`,
      fix: 'gh auth refresh -h github.com   # then authorize the org in the browser',
      retryable: false,
    };
  }
  if (has(/required scopes|missing.*scope|requires.*\bscope\b|read:org/i)) {
    return {
      kind: 'scope',
      summary: `Your gh token is missing a scope GitHub needs to read this PR's threads/checks.`,
      fix: 'gh auth refresh -h github.com -s read:org,repo',
      retryable: false,
    };
  }
  if (has(/bad credentials|http 401|not logged in|no github hosts|gh auth login|authentication failed/i)) {
    return {
      kind: 'auth',
      summary: `gh isn't authenticated (or the token expired).${acctNote}`,
      fix: 'gh auth login',
      retryable: false,
    };
  }
  if (has(/could not resolve to a|http 404|not found|resource not accessible|http 403/i)) {
    return {
      kind: 'not-found',
      summary: `GitHub can't see ${ctx.target || 'this repo'} for the signed-in account.${acctNote} Likely the wrong gh account is active, or it lacks access.`,
      fix: acct
        ? `gh auth status            # confirm the account\ngh auth switch            # switch to the account with access`
        : 'gh auth login            # sign in with the account that has access',
      retryable: false,
    };
  }
  if (has(/rate limit|secondary rate|abuse detection/i)) {
    return {
      kind: 'rate-limit',
      summary: 'Hit a GitHub API rate limit.',
      fix: 'Wait a minute and refresh.',
      retryable: true,
    };
  }
  if (has(/timeout|etimedout|enotfound|eai_again|getaddrinfo|econnreset|socket hang up|network|http 50\d|\b50[234]\b/i)) {
    return {
      kind: 'network',
      summary: 'Network hiccup talking to the GitHub API.',
      fix: 'Check your connection; this retries automatically.',
      retryable: true,
    };
  }
  return {
    kind: 'unknown',
    summary: msg || 'Unknown error talking to GitHub.',
    fix: 'gh auth status   # check your login, account, and token scopes',
    retryable: false,
  };
}

module.exports = { classifyGhError, activeGhAccount };
