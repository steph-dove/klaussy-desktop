// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Classify Azure DevOps REST API and HTTP error strings into actionable categories.

const SCOPES = 'Code (Read & write) and Build (Read)';

function classifyAzureError(raw, ctx = {}) {
  const msg = String(raw == null ? '' : raw).trim();
  const target = ctx.target ? ` for ${ctx.target}` : '';
  const host = ctx.host || 'dev.azure.com';
  const acct = ctx.account ? ` You're using Azure DevOps account "${ctx.account}".` : '';
  const has = (re) => re.test(msg);

  // Matched before auth: the saved PAT exists but this machine can't decrypt it.
  if (has(/can't be read on this machine|re-enter the pat/i)) {
    return {
      kind: 'auth',
      summary: `The saved Azure DevOps PAT can't be read on this machine.${acct}`,
      fix: 'Re-enter the PAT in Git Accounts.',
      retryable: false,
    };
  }

  if (has(/VssVersionOutOfRangeException|api-version.*(?:out of range|not supported)|version .* of the api is not supported/i)) {
    return {
      kind: 'server-version',
      summary: `This Azure DevOps Server (${host}) is older than Klaussy supports.`,
      fix: 'Klaussy needs Azure DevOps Server 2020 or later, or Azure DevOps Services.',
      retryable: false,
    };
  }

  if (has(/http 5\d\d|service unavailable|bad gateway|gateway timeout/i)) {
    return {
      kind: 'outage',
      summary: `Azure DevOps returned a server error${target}, so this is likely an outage.`,
      fix: host === 'dev.azure.com'
        ? 'Check status.dev.azure.com and retry once Azure DevOps recovers.'
        : `Check ${host} server health and retry once it recovers.`,
      retryable: true,
    };
  }

  if (has(/http 401|http 203|unauthorized|no azure devops credentials|did not accept the pat|TF400813/i)) {
    return {
      kind: 'auth',
      summary: `Azure DevOps didn't accept the credentials for ${host}. The PAT may be missing, expired or revoked.${acct}`,
      fix: `Connect Azure DevOps in Git Accounts with a PAT that has ${SCOPES}, or set $AZURE_DEVOPS_EXT_PAT.`,
      retryable: false,
    };
  }

  if (has(/http 403|TF401027|TF400409|forbidden|does not have permissions|insufficient permissions/i)) {
    return {
      kind: 'scope',
      summary: `Your Azure DevOps PAT isn't allowed to do this${target}.`,
      fix: `Create a PAT with ${SCOPES} for this organization, and check that your account can contribute to the repository.`,
      retryable: false,
    };
  }

  if (has(/http 404|TF401019|TF401180|TF200016|does not exist|could not be found|not found/i)) {
    const what = ctx.target || 'this repository or pull request';
    return {
      kind: 'not-found',
      summary: `Azure DevOps can't find ${what}.${acct} It may not exist, or your account can't see it.`,
      fix: 'Check the pull request URL, and that the PAT was created in the organization that owns the repository.',
      retryable: false,
    };
  }

  if (has(/http 429|too many requests|rate limit|TF400733/i)) {
    return {
      kind: 'rate-limit',
      summary: 'Azure DevOps is throttling requests.',
      fix: 'Wait a minute and retry.',
      retryable: true,
    };
  }

  if (has(/timeout|etimedout|enotfound|eai_again|getaddrinfo|econnreset|socket hang up|fetch failed|network/i)) {
    return {
      kind: 'network',
      summary: `Network error connecting to ${host}.`,
      fix: 'Check your network connection and retry.',
      retryable: true,
    };
  }

  return {
    kind: 'unknown',
    summary: msg || 'Unknown error talking to Azure DevOps.',
    fix: 'Check your Azure DevOps account in Git Accounts and your network connection.',
    retryable: false,
  };
}

module.exports = { classifyAzureError };
