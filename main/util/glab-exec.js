// Process-execution helpers for glab (GitLab CLI) commands and tokens.

const { execFile, execFileSync } = require('child_process');
const execFileP = require('util').promisify(execFile);
const { detectForgeFromRemote } = require('./forge-url');

const GLAB_TOKEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const glabTokenCache = new Map(); // key -> { token: string|null, at: ms }

function clearGlabTokenCache() {
  glabTokenCache.clear();
}

function getGlabToken(host) {
  const h = host || 'gitlab.com';
  try {
    const token = execFileSync('glab', ['config', 'get', 'token', '--host', h], {
      stdio: 'pipe',
      timeout: 5000,
    }).toString().trim();
    if (token) return token;
  } catch (_) {}

  try {
    const token = execFileSync('glab', ['config', 'get', 'token'], {
      stdio: 'pipe',
      timeout: 5000,
    }).toString().trim();
    if (token) return token;
  } catch (_) {}

  return process.env.GITLAB_TOKEN || process.env.GL_TOKEN || '';
}

function glabEnvForRepo(repoDir) {
  if (!repoDir) return {};
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoDir,
      stdio: 'pipe',
    }).toString().trim();

    const info = detectForgeFromRemote(remoteUrl);
    if (!info || info.forge !== 'gitlab') return {};

    const host = info.host || 'gitlab.com';
    const key = `host:${host}`;
    const cached = glabTokenCache.get(key);
    if (cached && (Date.now() - cached.at) < GLAB_TOKEN_CACHE_TTL_MS) {
      return cached.token ? { GL_TOKEN: cached.token, GL_HOST: host } : {};
    }

    const token = getGlabToken(host);
    if (token) {
      glabTokenCache.set(key, { token, at: Date.now() });
      return { GL_TOKEN: token, GL_HOST: host };
    }

    glabTokenCache.set(key, { token: null, at: Date.now() });
    return {};
  } catch {
    return {};
  }
}

function glabEnvForAccount(username, hostname) {
  if (!username) return {};
  const host = hostname || 'gitlab.com';
  const key = `acct:${host}:${username}`;
  const cached = glabTokenCache.get(key);
  if (cached && (Date.now() - cached.at) < GLAB_TOKEN_CACHE_TTL_MS) {
    return cached.token ? { GL_TOKEN: cached.token, GL_HOST: host } : {};
  }

  const token = getGlabToken(host);
  if (token) {
    glabTokenCache.set(key, { token, at: Date.now() });
    return { GL_TOKEN: token, GL_HOST: host };
  }

  glabTokenCache.set(key, { token: null, at: Date.now() });
  return {};
}

function resolveGlabEnv({ account, host, cwd } = {}) {
  const env = {};
  if (account) {
    const acct = glabEnvForAccount(account, host);
    if (acct.GL_TOKEN) Object.assign(env, acct);
  }
  if (!env.GL_TOKEN) {
    const repoEnv = glabEnvForRepo(cwd);
    if (repoEnv && repoEnv.GL_TOKEN) Object.assign(env, repoEnv);
  }
  if (!env.GL_TOKEN) {
    const h = host || 'gitlab.com';
    const token = getGlabToken(h);
    if (token) Object.assign(env, { GL_TOKEN: token, GL_HOST: h });
  }
  return env;
}

function glabExec(args, opts = {}) {
  const { glabAccount, glabHost, ...rest } = opts;
  const env = resolveGlabEnv({ account: glabAccount, host: glabHost, cwd: rest.cwd });
  const merged = { ...process.env, ...env };
  delete merged.GITLAB_TOKEN;
  return execFileSync('glab', args, {
    ...rest,
    env: merged,
  });
}

async function glabExecP(args, opts = {}) {
  const { glabAccount, glabHost, ...rest } = opts;
  const env = resolveGlabEnv({ account: glabAccount, host: glabHost, cwd: rest.cwd });
  const merged = { ...process.env, ...env };
  delete merged.GITLAB_TOKEN;
  return execFileP('glab', args, {
    ...rest,
    env: merged,
  });
}

module.exports = {
  getGlabToken,
  glabEnvForRepo,
  glabEnvForAccount,
  resolveGlabEnv,
  glabExec,
  glabExecP,
  clearGlabTokenCache,
};
