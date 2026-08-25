// Process-execution and REST API helpers for Bitbucket Cloud and Data Center.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { loadConfig, saveConfig } = require('./config');
const { detectForgeFromRemote } = require('./forge-url');

const BITBUCKET_AUTH_CACHE_TTL_MS = 5 * 60 * 1000;
const bitbucketAuthCache = new Map(); // key -> { auth, at: ms }

function clearBitbucketAuthCache() {
  bitbucketAuthCache.clear();
}

function parseNetrc(host) {
  try {
    const netrcPath = process.platform === 'win32'
      ? path.join(os.homedir(), '_netrc')
      : path.join(os.homedir(), '.netrc');
    if (!fs.existsSync(netrcPath)) return null;
    const content = fs.readFileSync(netrcPath, 'utf8');
    const tokens = content.split(/\s+/);
    let currentMachine = null;
    let login = null;
    let password = null;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === 'machine') {
        if (currentMachine && (currentMachine === host || currentMachine === `api.${host}`) && login && password) {
          return { username: login, password, source: 'netrc' };
        }
        currentMachine = tokens[++i];
        login = null;
        password = null;
      } else if (token === 'login') {
        login = tokens[++i];
      } else if (token === 'password') {
        password = tokens[++i];
      }
    }
    if (currentMachine && (currentMachine === host || currentMachine === `api.${host}`) && login && password) {
      return { username: login, password, source: 'netrc' };
    }
  } catch (_) {}
  return null;
}

function getGitCredential(host) {
  try {
    const input = `protocol=https\nhost=${host}\n\n`;
    const out = execFileSync('git', ['credential', 'fill'], {
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 1000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
    }).toString();

    let username = '';
    let password = '';
    for (const line of out.split('\n')) {
      if (line.startsWith('username=')) username = line.slice('username='.length).trim();
      else if (line.startsWith('password=')) password = line.slice('password='.length).trim();
    }
    if (username && password) {
      return { username, password, source: 'git-credential' };
    }
  } catch (_) {}
  return null;
}

function resolveEmailIfApiToken(username, secret) {
  if (secret && typeof secret === 'string' && secret.startsWith('ATATT') && (!username || !username.includes('@'))) {
    if (process.env.BITBUCKET_EMAIL && process.env.BITBUCKET_EMAIL.includes('@')) {
      return process.env.BITBUCKET_EMAIL.trim();
    }
    try {
      const gitEmail = execFileSync('git', ['config', '--get', 'user.email'], { timeout: 1000 }).toString().trim();
      if (gitEmail && gitEmail.includes('@')) return gitEmail;
    } catch (_) {}
    return 'doverstephaniem@gmail.com';
  }
  return username || 'x-token-auth';
}

function getBitbucketAuth(opts = {}) {
  const host = opts.host || 'bitbucket.org';
  const targetAccount = opts.account || null;
  const cacheKey = `${host}:${targetAccount || 'default'}`;

  const cached = bitbucketAuthCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < BITBUCKET_AUTH_CACHE_TTL_MS) {
    return cached.auth;
  }

  // 1. Configured accounts in app config
  const config = loadConfig();
  const accounts = config.bitbucketAccounts || [];
  if (targetAccount) {
    const matched = accounts.find((a) => (a.username === targetAccount || a.id === targetAccount) && (!a.hostname || a.hostname === host));
    if (matched) {
      const rawSecret = matched.appPassword || matched.password || matched.token || '';
      const auth = {
        username: resolveEmailIfApiToken(matched.username, rawSecret),
        password: rawSecret,
        token: rawSecret.startsWith('ATATT') ? null : (matched.token || null),
        host,
        source: 'config',
      };
      bitbucketAuthCache.set(cacheKey, { auth, at: Date.now() });
      return auth;
    }
  }

  const activeConfigAccount = accounts.find((a) => a.active && (!a.hostname || a.hostname === host)) || accounts[0];
  if (activeConfigAccount) {
    const rawSecret = activeConfigAccount.appPassword || activeConfigAccount.password || activeConfigAccount.token || '';
    const auth = {
      username: resolveEmailIfApiToken(activeConfigAccount.username, rawSecret),
      password: rawSecret,
      token: rawSecret.startsWith('ATATT') ? null : (activeConfigAccount.token || null),
      host,
      source: 'config',
    };
    bitbucketAuthCache.set(cacheKey, { auth, at: Date.now() });
    return auth;
  }

  // 2. Direct token/password from config
  if (config.bitbucketToken) {
    const auth = {
      username: resolveEmailIfApiToken(config.bitbucketUsername, config.bitbucketToken),
      password: config.bitbucketToken,
      token: config.bitbucketToken.startsWith('ATATT') ? null : config.bitbucketToken,
      host,
      source: 'config-direct',
    };
    bitbucketAuthCache.set(cacheKey, { auth, at: Date.now() });
    return auth;
  }

  // 3. Environment variables
  if (process.env.BITBUCKET_TOKEN || process.env.BITBUCKET_BEARER_TOKEN) {
    const token = process.env.BITBUCKET_TOKEN || process.env.BITBUCKET_BEARER_TOKEN;
    const rawUser = process.env.BITBUCKET_EMAIL || process.env.BITBUCKET_USERNAME || process.env.BITBUCKET_USER || null;
    const auth = {
      username: resolveEmailIfApiToken(rawUser, token),
      token: token.startsWith('ATATT') ? null : token,
      password: token,
      host,
      source: 'env-token',
    };
    bitbucketAuthCache.set(cacheKey, { auth, at: Date.now() });
    return auth;
  }

  if ((process.env.BITBUCKET_APP_PASSWORD || process.env.BITBUCKET_PASSWORD) && (process.env.BITBUCKET_USERNAME || process.env.BITBUCKET_USER)) {
    const username = process.env.BITBUCKET_USERNAME || process.env.BITBUCKET_USER;
    const password = process.env.BITBUCKET_APP_PASSWORD || process.env.BITBUCKET_PASSWORD;
    const auth = {
      username,
      password,
      token: null,
      host,
      source: 'env-basic',
    };
    bitbucketAuthCache.set(cacheKey, { auth, at: Date.now() });
    return auth;
  }

  // 4. Netrc file
  const netrcAuth = parseNetrc(host);
  if (netrcAuth) {
    const auth = {
      username: netrcAuth.username,
      password: netrcAuth.password,
      token: null,
      host,
      source: 'netrc',
    };
    bitbucketAuthCache.set(cacheKey, { auth, at: Date.now() });
    return auth;
  }

  // 5. Git credential helper
  const gitCred = getGitCredential(host);
  if (gitCred) {
    const auth = {
      username: gitCred.username,
      password: gitCred.password,
      token: null,
      host,
      source: 'git-credential',
    };
    bitbucketAuthCache.set(cacheKey, { auth, at: Date.now() });
    return auth;
  }

  bitbucketAuthCache.set(cacheKey, { auth: null, at: Date.now() });
  return null;
}

function resolveBitbucketEnv(opts = {}) {
  const auth = getBitbucketAuth(opts);
  if (!auth) return {};
  if (auth.token) {
    return { BITBUCKET_TOKEN: auth.token };
  }
  if (auth.username && auth.password) {
    return {
      BITBUCKET_USERNAME: auth.username,
      BITBUCKET_APP_PASSWORD: auth.password,
    };
  }
  return {};
}

function buildBitbucketUrl(endpoint, host = 'bitbucket.org') {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  const cleanPath = endpoint.replace(/^\//, '');
  if (host === 'bitbucket.org' || host === 'api.bitbucket.org') {
    return `https://api.bitbucket.org/2.0/${cleanPath}`;
  }
  return `https://${host}/2.0/${cleanPath}`;
}

async function bitbucketFetch(endpoint, opts = {}) {
  const host = opts.host || 'bitbucket.org';
  const url = buildBitbucketUrl(endpoint, host);
  const auth = getBitbucketAuth({ account: opts.account, host, cwd: opts.cwd });

  const headers = Object.assign({
    Accept: 'application/json',
    'User-Agent': 'Klaussy-Desktop',
  }, opts.headers || {});

  if (auth) {
    if (auth.username && auth.password && (auth.username !== 'x-token-auth' || !auth.token)) {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      headers.Authorization = `Basic ${encoded}`;
    } else if (auth.token) {
      headers.Authorization = `Bearer ${auth.token}`;
    }
  }

  const fetchOpts = {
    method: opts.method || 'GET',
    headers,
    redirect: 'follow',
  };

  if (opts.body) {
    if (typeof opts.body === 'object') {
      fetchOpts.body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    } else {
      fetchOpts.body = String(opts.body);
    }
  }

  const res = await fetch(url, fetchOpts);
  return res;
}

async function bitbucketJson(endpoint, opts = {}) {
  const res = await bitbucketFetch(endpoint, opts);
  if (!res.ok) {
    let errBody = '';
    try {
      const json = await res.json();
      errBody = (json && (json.error && json.error.message)) || json.message || JSON.stringify(json);
    } catch (_) {
      try {
        errBody = await res.text();
      } catch (_) {}
    }
    const err = new Error(`Bitbucket API error (HTTP ${res.status}): ${errBody || res.statusText}`);
    err.status = res.status;
    err.statusCode = res.status;
    err.responseBody = errBody;
    throw err;
  }
  return res.json();
}

async function bitbucketText(endpoint, opts = {}) {
  const mergedOpts = Object.assign({}, opts);
  mergedOpts.headers = Object.assign({
    Accept: 'text/plain, text/x-diff, application/x-diff, */*',
  }, opts.headers || {});
  const res = await bitbucketFetch(endpoint, mergedOpts);
  if (!res.ok) {
    let errBody = '';
    try { errBody = await res.text(); } catch (_) {}
    const err = new Error(`Bitbucket API error (HTTP ${res.status}): ${errBody || res.statusText}`);
    err.status = res.status;
    err.statusCode = res.status;
    err.responseBody = errBody;
    throw err;
  }
  return res.text();
}

function listBitbucketAccounts() {
  const config = loadConfig();
  const saved = config.bitbucketAccounts || [];
  const accounts = [];
  const seen = new Set();

  for (const a of saved) {
    if (!a || !a.username) continue;
    const key = `${a.hostname || 'bitbucket.org'}:${a.username}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({
      id: `bitbucket:${a.hostname || 'bitbucket.org'}:${a.username}`,
      username: a.username,
      hostname: a.hostname || 'bitbucket.org',
      active: !!a.active,
      valid: true,
      source: 'config',
    });
  }

  // Also include ambient credentials if not already covered
  const ambient = getBitbucketAuth();
  if (ambient && ambient.username) {
    const key = `${ambient.host || 'bitbucket.org'}:${ambient.username}`;
    if (!seen.has(key)) {
      seen.add(key);
      accounts.push({
        id: `bitbucket:${ambient.host || 'bitbucket.org'}:${ambient.username}`,
        username: ambient.username,
        hostname: ambient.host || 'bitbucket.org',
        active: accounts.length === 0,
        valid: true,
        source: ambient.source,
      });
    }
  }

  if (accounts.length > 0 && !accounts.some((a) => a.active)) {
    accounts[0].active = true;
  }

  return accounts;
}

function switchBitbucketAccount(username, hostname = 'bitbucket.org') {
  if (!username) return { error: 'Missing username' };
  const config = loadConfig();
  const accounts = config.bitbucketAccounts || [];
  let found = false;

  for (const a of accounts) {
    if (a.username === username && (a.hostname || 'bitbucket.org') === hostname) {
      a.active = true;
      found = true;
    } else {
      a.active = false;
    }
  }

  if (!found) {
    accounts.push({
      username,
      hostname,
      active: true,
    });
  }

  config.bitbucketAccounts = accounts;
  saveConfig(config);
  clearBitbucketAuthCache();
  return { ok: true };
}

function saveBitbucketAccount(account) {
  if (!account || !account.username) return { error: 'Missing username' };
  const hostname = account.hostname || 'bitbucket.org';
  const config = loadConfig();
  const accounts = config.bitbucketAccounts || [];

  const existingIdx = accounts.findIndex(
    (a) => a.username === account.username && (a.hostname || 'bitbucket.org') === hostname,
  );

  const newEntry = {
    username: account.username,
    hostname,
    appPassword: account.appPassword || account.password || '',
    token: account.token || '',
    active: account.active !== false,
  };

  if (newEntry.active) {
    for (const a of accounts) a.active = false;
  }

  if (existingIdx >= 0) {
    accounts[existingIdx] = Object.assign(accounts[existingIdx], newEntry);
  } else {
    accounts.push(newEntry);
  }

  config.bitbucketAccounts = accounts;
  saveConfig(config);
  clearBitbucketAuthCache();
  return { ok: true };
}

function removeBitbucketAccount(username, hostname = 'bitbucket.org') {
  if (!username) return { error: 'Missing username' };
  const config = loadConfig();
  const accounts = (config.bitbucketAccounts || []).filter(
    (a) => !(a.username === username && (a.hostname || 'bitbucket.org') === hostname),
  );
  if (accounts.length > 0 && !accounts.some((a) => a.active)) {
    accounts[0].active = true;
  }
  config.bitbucketAccounts = accounts;
  saveConfig(config);
  clearBitbucketAuthCache();
  return { ok: true };
}

module.exports = {
  getBitbucketAuth,
  resolveBitbucketEnv,
  bitbucketFetch,
  bitbucketJson,
  bitbucketText,
  listBitbucketAccounts,
  switchBitbucketAccount,
  saveBitbucketAccount,
  removeBitbucketAccount,
  clearBitbucketAuthCache,
};
