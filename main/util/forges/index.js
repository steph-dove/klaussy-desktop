// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Picks the forge adapter for a forge id, PR URL, git remote or picker account id.

const { parseForgeUrl, detectForgeFromRemote } = require('../forge-url');
const bitbucket = require('./bitbucket');

const FORGES = { bitbucket };

function getForge(id) {
  return FORGES[id] || null;
}

function forgeForUrl(url) {
  const parsed = parseForgeUrl(url);
  return parsed ? { adapter: getForge(parsed.forge), parsed } : null;
}

function forgeForRemote(remoteUrl) {
  const info = detectForgeFromRemote(remoteUrl);
  return info ? { adapter: getForge(info.forge), info } : null;
}

// Picker account ids: "gitlab:<host>:<user>", "bitbucket:<host>:<user>",
// "github:<user>", or a bare gh username. forge and host are null when the id
// doesn't name them, so the caller keeps what the URL or remote said.
function parseAccountId(account) {
  if (typeof account !== 'string') {
    return { forge: null, host: null, user: account && account.username };
  }
  for (const forge of ['gitlab', 'bitbucket']) {
    if (account.startsWith(forge + ':')) {
      const parts = account.split(':');
      return { forge, host: parts[1] || null, user: parts[2] || parts[1] };
    }
  }
  if (account.startsWith('github:')) {
    return { forge: 'github', host: null, user: account.slice('github:'.length) };
  }
  return { forge: null, host: null, user: account };
}

// CLI failures carry stderr; REST failures carry the response body.
function errorText(err) {
  return ((err && (err.stderr || err.responseBody || err.message)) || '').trim();
}

function toIpcError(adapter, err, ctx) {
  const raw = errorText(err);
  const cls = adapter.classifyError(raw, ctx);
  return { error: raw, errorKind: cls.kind, errorSummary: cls.summary, errorFix: cls.fix };
}

module.exports = {
  FORGES, getForge, forgeForUrl, forgeForRemote, parseAccountId, errorText, toIpcError,
};
