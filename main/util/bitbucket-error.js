// Classify Bitbucket REST API and HTTP error strings into actionable categories.

function classifyBitbucketError(raw, ctx = {}) {
  const msg = String(raw == null ? '' : raw).trim();
  const lower = msg.toLowerCase();
  const target = ctx.target ? ` for ${ctx.target}` : '';
  const host = ctx.host || 'bitbucket.org';
  const acct = ctx.account ? ` You're using Bitbucket account "${ctx.account}".` : '';

  const has = (re) => re.test(msg) || re.test(lower);

  if (has(/http 5\d\d|service unavailable|bad gateway|502 bad gateway|503 service unavailable|504 gateway timeout/i)) {
    return {
      kind: 'outage',
      summary: `Bitbucket's server returned an error${target} — this is likely an outage or server error.`,
      fix: host === 'bitbucket.org'
        ? 'Check bitbucket.status.atlassian.com. Retry once Bitbucket recovers.'
        : `Check ${host} server health. Retry once the server recovers.`,
      retryable: true,
    };
  }

  if (has(/401 unauthorized|unauthorized|bad credentials|invalid token|authentication failed|no bitbucket credentials|invalid app password/i)) {
    return {
      kind: 'auth',
      summary: `Bitbucket isn't authenticated with ${host} (or the token/app password is invalid).${acct}`,
      fix: `Add a Bitbucket App Password in Git Accounts, or set $BITBUCKET_TOKEN / $BITBUCKET_APP_PASSWORD in your environment.`,
      retryable: false,
    };
  }

  if (has(/403 forbidden|insufficient.*scope|missing.*scope|access forbidden|permission denied|insufficient_scope|not authorized/i)) {
    return {
      kind: 'scope',
      summary: `Your Bitbucket token lacks permission to perform this action${target} (needs 'pullrequests:read' or 'pullrequests:write' scope).`,
      fix: `Generate a Bitbucket App Password with repository and pull request read/write permissions.`,
      retryable: false,
    };
  }

  if (has(/404 not found|repository not found|pull request not found|resource not found|cannot find|could not find/i)) {
    const what = ctx.target || 'this repository or pull request';
    return {
      kind: 'not-found',
      summary: `Bitbucket can't find ${what}.${acct} The repo may be private or your account lacks access.`,
      fix: 'Verify the repository and pull request URL, and ensure your account has access to this repository.',
      retryable: false,
    };
  }

  if (has(/rate limit|too many requests|429/i)) {
    return {
      kind: 'rate-limit',
      summary: 'Hit a Bitbucket API rate limit.',
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
    summary: msg || 'Unknown error talking to Bitbucket.',
    fix: 'Verify Bitbucket credentials in Git Accounts or check your network connection.',
    retryable: false,
  };
}

module.exports = {
  classifyBitbucketError,
};
