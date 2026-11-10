// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// REST helpers and saved accounts for Azure DevOps Services and Server, authenticated with a PAT.

const { loadConfig, saveConfig, flushSaveConfig } = require('./config');
const { parseAzureCollection } = require('./forge-url');
const { ForgeHttpError, httpFetch, httpJson, httpText } = require('./forge-http');
const secretStore = require('./secret-store');

const SERVICES_HOST = 'dev.azure.com';
const ENV_PAT = 'AZURE_DEVOPS_EXT_PAT';

// Server 2020 speaks 6.0; Services takes the current version.
function apiVersion(host) {
  return host === SERVICES_HOST ? '7.1' : '6.0';
}

class AzureAuthError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'AzureAuthError';
    this.kind = kind;
  }
}

// Every part is encoded: a Server host can carry a port and a collection path has slashes.
function accountId(a) {
  return 'azure:' + [a.host, a.collectionPath, a.user].map(encodeURIComponent).join(':');
}

function parseAzureAccountId(id) {
  if (typeof id !== 'string' || !id.startsWith('azure:')) return null;
  const parts = id.split(':');
  if (parts.length !== 4) return null;
  try {
    const [host, collectionPath, user] = parts.slice(1).map((p) => decodeURIComponent(p));
    return { host, collectionPath, user };
  } catch (_) {
    return null; // a malformed escape, e.g. "azure:%:a:b" from the renderer
  }
}

function accountsFromConfig() {
  return loadConfig().azureAccounts || [];
}

function sameCollection(a, host, collectionPath) {
  return a.host === host && a.collectionPath === collectionPath;
}

// Picks the saved account for a collection: the named user, then the active
// one, then any. Falls back to $AZURE_DEVOPS_EXT_PAT.
function getAzureAuth({ host, collectionPath, account } = {}) {
  const accounts = accountsFromConfig().filter((a) => sameCollection(a, host, collectionPath));
  const match = (account && accounts.find((a) => a.user === account))
    || accounts.find((a) => a.active)
    || accounts[0];
  if (match) {
    let pat;
    try {
      pat = secretStore.decrypt(match.patEnc);
    } catch (_) {
      throw new AzureAuthError(
        `The saved Azure DevOps PAT for ${match.user} can't be read on this machine. Re-enter the PAT in Git Accounts.`,
        'reenter',
      );
    }
    return { pat, user: match.user, userId: match.userId || null, source: 'config' };
  }
  if (process.env[ENV_PAT]) {
    return { pat: process.env[ENV_PAT], user: null, userId: null, source: 'env' };
  }
  throw new AzureAuthError(
    `No Azure DevOps credentials for ${host}/${collectionPath}. Connect Azure DevOps in Git Accounts, or set $${ENV_PAT}.`,
    'missing',
  );
}

function basicHeader(pat) {
  return 'Basic ' + Buffer.from(':' + pat, 'utf8').toString('base64');
}

function buildUrl(collectionUrl, path, host) {
  const url = new URL(collectionUrl.replace(/\/+$/, '') + path);
  if (!url.searchParams.has('api-version')) url.searchParams.set('api-version', apiVersion(host));
  return url.toString();
}

function requestOpts(ctx, opts = {}) {
  const auth = ctx.auth || getAzureAuth(ctx);
  const headers = Object.assign({ Authorization: basicHeader(auth.pat) }, opts.headers || {});
  const out = { method: opts.method || 'GET', headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = opts.contentType || 'application/json';
    out.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  return out;
}

// Error text leads with the HTTP status, which is what the classifier reads,
// then Azure's own message. An expired PAT gets a sign-in or "Access Denied"
// HTML page, which would only be noise in the UI, so HTML bodies are dropped.
function withStatus(err) {
  if (!(err instanceof ForgeHttpError)) return err;
  let detail = err.responseBody || '';
  try {
    const j = JSON.parse(detail);
    if (j && j.message) detail = j.message;
  } catch (_) { /* not JSON: keep the raw text */ }
  if (/^\s*</.test(detail)) detail = '';
  const text = `HTTP ${err.status}: ${detail || err.statusText || ''}`.trim();
  err.message = text;
  err.responseBody = text;
  return err;
}

async function rethrowWithStatus(promise) {
  try {
    return await promise;
  } catch (err) {
    throw withStatus(err);
  }
}

// ctx: { collectionUrl, host, collectionPath, account } — or { auth } to skip the lookup.
async function azureFetch(ctx, path, opts = {}) {
  return rethrowWithStatus(httpFetch(buildUrl(ctx.collectionUrl, path, ctx.host), requestOpts(ctx, opts)));
}

async function azureJson(ctx, path, opts = {}) {
  return rethrowWithStatus(httpJson(buildUrl(ctx.collectionUrl, path, ctx.host), requestOpts(ctx, opts)));
}

async function azureText(ctx, path, opts = {}) {
  const o = requestOpts(ctx, opts);
  o.headers.Accept = 'text/plain';
  return rethrowWithStatus(httpText(buildUrl(ctx.collectionUrl, path, ctx.host), o));
}

const ANONYMOUS_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// connectionData has no api-version, and a caller it treats as anonymous gets
// a 200 with the anonymous id instead of a 401.
async function fetchConnectionData(collectionUrl, pat) {
  const url = collectionUrl.replace(/\/+$/, '') + '/_apis/connectionData';
  const data = await rethrowWithStatus(httpJson(url, { headers: { Authorization: basicHeader(pat) } }));
  const u = data && data.authenticatedUser;
  if (!u || !u.id || u.id === ANONYMOUS_ID) {
    throw new ForgeHttpError('HTTP 401: Azure DevOps did not accept the PAT', { status: 401 });
  }
  const props = u.properties || {};
  const email = props.Account && (props.Account.$value || props.Account);
  return { userId: u.id, user: (typeof email === 'string' && email) || u.providerDisplayName || u.id };
}

// A Server remote over SSH gives the host without the web port or scheme. If
// no saved account matches it exactly but one for the same collection on the
// same hostname does, that account's host and collection URL are the real ones.
function resolveSavedCollection({ host, collectionPath, collectionUrl }) {
  const accounts = accountsFromConfig();
  if (accounts.some((a) => sameCollection(a, host, collectionPath))) return { host, collectionUrl };
  const bare = (h) => String(h || '').replace(/:\d+$/, '');
  const hits = accounts.filter((a) => a.collectionPath === collectionPath && bare(a.host) === bare(host));
  const hosts = new Set(hits.map((a) => a.host));
  if (hosts.size !== 1) return { host, collectionUrl };
  return { host: hits[0].host, collectionUrl: hits[0].collectionUrl };
}

function publicAccount(a) {
  let needsReentry = false;
  try { secretStore.decrypt(a.patEnc); } catch (_) { needsReentry = true; }
  return {
    id: accountId(a),
    host: a.host,
    collectionPath: a.collectionPath,
    collectionUrl: a.collectionUrl,
    user: a.user,
    active: !!a.active,
    needsReentry,
  };
}

function listAzureAccounts() {
  return accountsFromConfig().map(publicAccount);
}

// Checks the PAT against the collection before anything is written, and only
// ever stores it encrypted.
async function saveAzureAccount({ collection, pat }) {
  const coll = parseAzureCollection(collection);
  if (!coll) {
    throw new AzureAuthError('Enter an Azure DevOps organization (dev.azure.com/your-org) or a Server collection URL.', 'input');
  }
  const token = String(pat || '').trim();
  if (!token) throw new AzureAuthError('Enter a personal access token.', 'input');
  if (!secretStore.available()) {
    throw new AzureAuthError(
      `This system has no secure storage for the PAT, so Klaussy won't save it. Set $${ENV_PAT} in your environment instead.`,
      'unavailable',
    );
  }
  const { userId, user } = await fetchConnectionData(coll.collectionUrl, token);
  const patEnc = secretStore.encrypt(token);

  const config = loadConfig();
  const accounts = (config.azureAccounts || []).map((a) => (
    sameCollection(a, coll.host, coll.collectionPath) ? { ...a, active: false } : a
  ));
  const entry = { ...coll, user, userId, patEnc, active: true };
  // Saving the same user again replaces the entry; emails differ only by case at times.
  const i = accounts.findIndex((a) => sameCollection(a, coll.host, coll.collectionPath)
    && String(a.user).toLowerCase() === String(user).toLowerCase());
  if (i >= 0) accounts[i] = entry; else accounts.push(entry);
  config.azureAccounts = accounts;
  saveConfig(config);
  await flushSaveConfig();
  return publicAccount(entry);
}

// saveConfig writes through a queue; each change waits for its write so the
// next list or lookup reads it back.
async function switchAzureAccount(id) {
  const target = parseAzureAccountId(id);
  if (!target) return false;
  const config = loadConfig();
  const accounts = config.azureAccounts || [];
  if (!accounts.some((a) => accountId(a) === id)) return false;
  config.azureAccounts = accounts.map((a) => (
    sameCollection(a, target.host, target.collectionPath) ? { ...a, active: accountId(a) === id } : a
  ));
  saveConfig(config);
  await flushSaveConfig();
  return true;
}

async function removeAzureAccount(id) {
  const target = parseAzureAccountId(id);
  if (!target) return false;
  const config = loadConfig();
  const before = config.azureAccounts || [];
  const accounts = before.filter((a) => accountId(a) !== id);
  if (accounts.length === before.length) return false;
  const rest = accounts.filter((a) => sameCollection(a, target.host, target.collectionPath));
  if (rest.length && !rest.some((a) => a.active)) rest[0].active = true;
  config.azureAccounts = accounts;
  saveConfig(config);
  await flushSaveConfig();
  return true;
}

module.exports = {
  ENV_PAT,
  SERVICES_HOST,
  AzureAuthError,
  apiVersion,
  accountId,
  parseAzureAccountId,
  getAzureAuth,
  resolveSavedCollection,
  basicHeader,
  azureFetch,
  azureJson,
  azureText,
  fetchConnectionData,
  listAzureAccounts,
  saveAzureAccount,
  switchAzureAccount,
  removeAzureAccount,
};
