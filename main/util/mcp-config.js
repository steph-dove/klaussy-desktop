// Read/add/remove MCP servers in each agent's own config. Format-aware: JSON
// `mcpServers` map for most agents, TOML `[mcp_servers.*]` for Codex. Per-agent
// locations live in main/state/mcp-configs.js.
//
// Two safety rules from the original read-only inventory: listing returns env
// KEYS only (never secret values), and writes are atomic (tmp+rename) merges
// that preserve unrelated keys — a malformed existing file errors, never clobbers.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { PROVIDER_IDS, displayNameFor } = require('../state/ai-providers');
const { mcpConfigFor } = require('../state/mcp-configs');

function defaultHome() {
  return process.env.HOME || os.homedir();
}

// Resolve the absolute config file for an agent at a given scope, or null when
// the agent has no config for that scope (e.g. project scope without a repo, or
// an agent with no documented project-scope MCP file).
function configFile(agentId, scope, repoPath, homedir = defaultHome()) {
  const cfg = mcpConfigFor(agentId);
  if (!cfg) return null;
  if (scope === 'project') {
    if (!cfg.projectFile || !repoPath) return null;
    return path.join(repoPath, ...cfg.projectFile);
  }
  return path.join(homedir, ...cfg.userFile);
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// Normalize the transport type from a stored def or an add request.
function typeOf(def) {
  if (def && def.type) return def.type;
  return def && def.url ? 'http' : 'stdio';
}

// Build the on-disk def. `server.env` = literal values; `server.secretRefs` =
// env var NAMES pulled from the environment, never stored. `envRef` picks the
// syntax: 'brace' ${VAR}, 'envcolon' ${env:VAR}; 'envvars' (codex) in codexBlock.
function serverToDef(server, envRef) {
  const type = server.type || (server.url ? 'http' : 'stdio');
  if (type === 'http' || type === 'sse') {
    const def = { type, url: server.url || '' };
    if (server.headers && Object.keys(server.headers).length) def.headers = { ...server.headers };
    return def;
  }
  const def = { command: server.command || '' };
  if (Array.isArray(server.args) && server.args.length) def.args = server.args.slice();
  const env = { ...(server.env || {}) };
  for (const k of (Array.isArray(server.secretRefs) ? server.secretRefs : [])) {
    if (envRef === 'brace') env[k] = '${' + k + '}';
    else if (envRef === 'envcolon') env[k] = '${env:' + k + '}';
  }
  if (Object.keys(env).length) def.env = env;
  return def;
}

// Public entry shape (env VALUES intentionally omitted — keys only).
function defToEntry(name, def, agentId, scope, file, projectName) {
  return {
    name,
    agentId,
    agentName: displayNameFor(agentId),
    scope,
    projectName: projectName || null,
    sourceFile: file,
    type: typeOf(def),
    command: def.command || '',
    args: Array.isArray(def.args) ? def.args : [],
    url: def.url || '',
    envKeys: def.env && typeof def.env === 'object' ? Object.keys(def.env) : [],
  };
}

// ---- JSON-format helpers (the common case) ----

// Read the raw config object, returning { obj } or { error }. A missing file is
// not an error — it yields an empty object so add can create it.
function readJson(file) {
  if (!fs.existsSync(file)) return { obj: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { obj: raw && typeof raw === 'object' ? raw : {} };
  } catch (err) {
    return { error: `Could not parse ${file}: ${err.message}` };
  }
}

function jsonList(file, mapKey, agentId, scope, projectName) {
  const r = readJson(file);
  if (r.error) return r;
  const map = (r.obj && r.obj[mapKey]) || {};
  const out = [];
  for (const [name, def] of Object.entries(map)) {
    if (!def || typeof def !== 'object') continue;
    out.push(defToEntry(name, def, agentId, scope, file, projectName));
  }
  return { servers: out };
}

function jsonAdd(file, mapKey, server, envRef) {
  const r = readJson(file);
  if (r.error) return r;
  const obj = r.obj;
  if (!obj[mapKey] || typeof obj[mapKey] !== 'object') obj[mapKey] = {};
  obj[mapKey][server.name] = serverToDef(server, envRef);
  try {
    atomicWrite(file, JSON.stringify(obj, null, 2) + '\n');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

function jsonRemove(file, mapKey, name) {
  const r = readJson(file);
  if (r.error) return r;
  const obj = r.obj;
  if (!obj[mapKey] || typeof obj[mapKey] !== 'object' || !(name in obj[mapKey])) {
    return { ok: true, removed: false };
  }
  delete obj[mapKey][name];
  try {
    atomicWrite(file, JSON.stringify(obj, null, 2) + '\n');
    return { ok: true, removed: true };
  } catch (err) {
    return { error: err.message };
  }
}

// ---- TOML-format helpers (Codex only) ----
//
// Never reformat the whole file (would lose comments/config). We splice only the
// named `[mcp_servers.<name>]` table + its sub-tables, parsing just enough TOML
// to surface command/args/url/env.

// Split a dotted (possibly quoted) key path like `mcp_servers."my.srv".env`
// into segments ['mcp_servers', 'my.srv', 'env'].
function splitDottedKey(str) {
  const parts = [];
  let i = 0;
  while (i < str.length) {
    while (i < str.length && (str[i] === '.' || str[i] === ' ' || str[i] === '\t')) i++;
    if (i >= str.length) break;
    if (str[i] === '"' || str[i] === "'") {
      const q = str[i++];
      let s = '';
      while (i < str.length && str[i] !== q) s += str[i++];
      i++;
      parts.push(s);
    } else {
      let s = '';
      while (i < str.length && str[i] !== '.' && str[i] !== ' ' && str[i] !== '\t') s += str[i++];
      parts.push(s);
    }
  }
  return parts;
}

// Parse a table-header line `[ a.b.c ]` → its segment array, or null.
function headerSegments(line) {
  const m = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*$/);
  if (!m) return null;
  return splitDottedKey(m[1]);
}

function tomlEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function tomlString(s) {
  return '"' + tomlEscape(s) + '"';
}

// Minimal value parser for the fields we read back: bare strings and string
// arrays. Anything else returns undefined (we only need command/args/url/type).
function parseTomlString(v) {
  const t = v.trim();
  const m = t.match(/^"((?:[^"\\]|\\.)*)"$/) || t.match(/^'([^']*)'$/);
  return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : undefined;
}

function parseTomlStringArray(v) {
  const t = v.trim();
  if (!t.startsWith('[')) return undefined;
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m;
  while ((m = re.exec(t))) out.push((m[1] !== undefined ? m[1] : m[2]).replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  return out;
}

// Pull env keys out of an inline table `{ A = "x", B = "y" }` (keys only).
function parseInlineTableKeys(v) {
  const t = v.trim();
  if (!t.startsWith('{')) return [];
  const keys = [];
  const re = /(?:^|[{,])\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=/g;
  let m;
  while ((m = re.exec(t))) keys.push(m[1] || m[2] || m[3]);
  return keys;
}

// Parse all `[mcp_servers.*]` tables from a TOML file into a name→def map where
// def = { command, args, url, type, env: {keysOnly} }. Returns { map } or
// { error } (we only fail on unreadable files; unknown lines are ignored).
function parseCodexServers(text) {
  const lines = text.split(/\r?\n/);
  const map = {};
  let curName = null; // current mcp_servers.<name> top table
  let inEnvSub = false; // inside [mcp_servers.<name>.env]
  for (const line of lines) {
    const segs = headerSegments(line);
    if (segs) {
      if (segs[0] === 'mcp_servers' && segs.length >= 2) {
        curName = segs[1];
        inEnvSub = segs.length === 3 && segs[2] === 'env';
        if (!map[curName]) map[curName] = { args: [], env: {} };
      } else {
        curName = null;
        inEnvSub = false;
      }
      continue;
    }
    if (!curName) continue;
    const kv = line.match(/^\s*([A-Za-z0-9_."'-]+)\s*=\s*(.+?)\s*$/);
    if (!kv) continue;
    const key = kv[1].replace(/^["']|["']$/g, '');
    const val = kv[2];
    if (inEnvSub) {
      map[curName].env[key] = true; // keys only
      continue;
    }
    if (key === 'command') map[curName].command = parseTomlString(val);
    else if (key === 'url') map[curName].url = parseTomlString(val);
    else if (key === 'type') map[curName].type = parseTomlString(val);
    else if (key === 'args') map[curName].args = parseTomlStringArray(val) || [];
    else if (key === 'env') for (const k of parseInlineTableKeys(val)) map[curName].env[k] = true;
  }
  return { map };
}

function readCodex(file) {
  if (!fs.existsSync(file)) return { text: '', map: {} };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { error: `Could not read ${file}: ${err.message}` };
  }
  const parsed = parseCodexServers(text);
  if (parsed.error) return parsed;
  return { text, map: parsed.map };
}

function tomlList(file, agentId, scope, projectName) {
  const r = readCodex(file);
  if (r.error) return r;
  const out = [];
  for (const [name, def] of Object.entries(r.map)) {
    const entry = defToEntry(
      name,
      { command: def.command, args: def.args, url: def.url, type: def.type, env: def.env },
      agentId, scope, file, projectName,
    );
    out.push(entry);
  }
  return { servers: out };
}

// Generate the TOML block for one server (trailing blank line included).
function codexBlock(server) {
  const name = /^[A-Za-z0-9_-]+$/.test(server.name) ? server.name : tomlString(server.name);
  const lines = [`[mcp_servers.${name}]`];
  const type = server.type || (server.url ? 'http' : 'stdio');
  if (type === 'http' || type === 'sse') {
    lines.push(`url = ${tomlString(server.url || '')}`);
    if (type !== 'stdio') lines.push(`type = ${tomlString(type)}`);
  } else {
    lines.push(`command = ${tomlString(server.command || '')}`);
    if (Array.isArray(server.args) && server.args.length) {
      lines.push(`args = [${server.args.map(tomlString).join(', ')}]`);
    }
    // Codex pulls secrets from its environment by name via an allowlist — the
    // value is never written into config.
    if (Array.isArray(server.secretRefs) && server.secretRefs.length) {
      lines.push(`env_vars = [${server.secretRefs.map(tomlString).join(', ')}]`);
    }
  }
  let block = lines.join('\n') + '\n';
  if (server.env && Object.keys(server.env).length) {
    block += `\n[mcp_servers.${name}.env]\n`;
    for (const [k, v] of Object.entries(server.env)) block += `${k} = ${tomlString(v)}\n`;
  }
  return block;
}

// Find the [start, end) line range covering `[mcp_servers.<name>]` and all its
// child sub-tables, or null when absent. `end` is exclusive.
function codexBlockRange(lines, name) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const segs = headerSegments(lines[i]);
    if (!segs) continue;
    if (segs[0] === 'mcp_servers' && segs[1] === name) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      // First header that is NOT this server (top-level or another server) ends it.
      return { start, end: i };
    }
  }
  if (start === -1) return null;
  return { start, end: lines.length };
}

function tomlAdd(file, server) {
  const r = readCodex(file);
  if (r.error) return r;
  const block = codexBlock(server);
  let text = r.text;
  const lines = text.split('\n');
  const range = codexBlockRange(lines, server.name);
  let out;
  if (range) {
    const before = lines.slice(0, range.start);
    const after = lines.slice(range.end);
    out = before.concat(block.replace(/\n$/, '').split('\n'), after).join('\n');
  } else {
    const sep = text === '' ? '' : (text.endsWith('\n\n') ? '' : (text.endsWith('\n') ? '\n' : '\n\n'));
    out = text + sep + block;
  }
  try {
    atomicWrite(file, out);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

function tomlRemove(file, name) {
  const r = readCodex(file);
  if (r.error) return r;
  const lines = r.text.split('\n');
  const range = codexBlockRange(lines, name);
  if (!range) return { ok: true, removed: false };
  let out = lines.slice(0, range.start).concat(lines.slice(range.end));
  // Collapse a doubled blank line left where the block was spliced out.
  while (out.length > 1 && out[range.start - 1] === '' && out[range.start] === '') out.splice(range.start, 1);
  try {
    atomicWrite(file, out.join('\n'));
    return { ok: true, removed: true };
  } catch (err) {
    return { error: err.message };
  }
}

// ---- Public API ----

// List every configured MCP server across all agents + scopes. Deduped by
// absolute file path, so antigravity (which shares Gemini's settings.json)
// doesn't double-list. `activeRepo` is folded in if not already a project.
function listServers({ projects = [], activeRepo = null, homedir = defaultHome() } = {}) {
  const locations = [{ scope: 'user', repoPath: null, projectName: null }];
  const seenRepos = new Set();
  for (const p of projects) {
    if (!p || !p.path) continue;
    seenRepos.add(p.path);
    locations.push({ scope: 'project', repoPath: p.path, projectName: p.name || path.basename(p.path) });
  }
  if (activeRepo && !seenRepos.has(activeRepo)) {
    locations.push({ scope: 'project', repoPath: activeRepo, projectName: path.basename(activeRepo) });
  }

  const servers = [];
  const seenFiles = new Set();
  for (const loc of locations) {
    for (const agentId of PROVIDER_IDS) {
      const cfg = mcpConfigFor(agentId);
      if (!cfg) continue;
      const file = configFile(agentId, loc.scope, loc.repoPath, homedir);
      if (!file || seenFiles.has(file)) continue;
      seenFiles.add(file);
      const r = cfg.format === 'toml'
        ? tomlList(file, agentId, loc.scope, loc.projectName)
        : jsonList(file, cfg.mapKey, agentId, loc.scope, loc.projectName);
      if (r.servers) servers.push(...r.servers);
      // Parse errors on one file shouldn't sink the whole listing; skip silently
      // (mirrors the original reader, which skipped malformed configs).
    }
  }

  servers.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'user' ? -1 : 1;
    if (a.agentId !== b.agentId) return a.agentId.localeCompare(b.agentId);
    return a.name.localeCompare(b.name);
  });
  return { servers };
}

function validateServer(server) {
  if (!server || typeof server !== 'object') return 'No server provided';
  if (!server.name || !/^[\w.-]+$/.test(server.name)) {
    return 'Server name is required and may contain only letters, numbers, dot, dash, and underscore';
  }
  const type = server.type || (server.url ? 'http' : 'stdio');
  if (type === 'http' || type === 'sse') {
    if (!server.url) return 'A URL is required for http/sse servers';
  } else if (!server.command) {
    return 'A command is required for stdio servers';
  }
  return null;
}

// Add (or overwrite) a server in one agent's config at the given scope.
function addServer({ agentId, scope = 'user', repoPath = null, server, homedir = defaultHome() }) {
  const cfg = mcpConfigFor(agentId);
  if (!cfg) return { error: `${agentId} does not support MCP servers` };
  const invalid = validateServer(server);
  if (invalid) return { error: invalid };
  const file = configFile(agentId, scope, repoPath, homedir);
  if (!file) return { error: `${displayNameFor(agentId)} has no ${scope}-scope MCP config` };
  // An agent that can't reference env vars must never receive a secret.
  if (Array.isArray(server.secretRefs) && server.secretRefs.length && !cfg.envRef) {
    return { error: `${displayNameFor(agentId)} can't read secrets from the environment` };
  }
  return cfg.format === 'toml' ? tomlAdd(file, server) : jsonAdd(file, cfg.mapKey, server, cfg.envRef);
}

function removeServer({ agentId, scope = 'user', repoPath = null, name, homedir = defaultHome() }) {
  const cfg = mcpConfigFor(agentId);
  if (!cfg) return { error: `${agentId} does not support MCP servers` };
  if (!name) return { error: 'No server name provided' };
  const file = configFile(agentId, scope, repoPath, homedir);
  if (!file) return { error: `${displayNameFor(agentId)} has no ${scope}-scope MCP config` };
  return cfg.format === 'toml' ? tomlRemove(file, name) : jsonRemove(file, cfg.mapKey, name);
}

module.exports = {
  configFile,
  listServers,
  addServer,
  removeServer,
  validateServer,
  // exported for tests
  serverToDef,
  parseCodexServers,
  codexBlock,
};
