// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Path containment guard for every IPC that takes a filesystem path from the
// renderer. `pathUnder` canonicalizes both sides via realpath and refuses `..`
// or symlink escapes — this is what keeps a compromised renderer from asking
// main for ~/.ssh/id_rsa or /etc/passwd.
//
// `getRendererAllowedRoots` needs the live config and the live `instances`
// Map, neither of which exists as a module yet. Rather than hoist those moves
// forward, we accept them via setDeps so this module can land in Phase 1 and
// the owners (config.js, state/instances.js) wire up later without churn.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

let _loadConfig = () => ({});
let _getInstances = () => new Map();

function setDeps({ loadConfig, getInstances } = {}) {
  if (loadConfig) _loadConfig = loadConfig;
  if (getInstances) _getInstances = getInstances;
}

// True for '/', the home folder, and every folder that contains it.
function coversHome(p) {
  try {
    const dir = path.resolve(p);
    const home = path.resolve(os.homedir());
    const rel = path.relative(dir, home);
    return dir === path.parse(dir).root || rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return true;
  }
}

// Collect every filesystem root the renderer is allowed to read/write. Used
// by read-file/write-file/read-files-bulk — an XSS in the renderer must not
// be able to hand us ~/.ssh/id_rsa or ~/.config/gh/hosts.yml.
function getRendererAllowedRoots() {
  const roots = new Set();
  try {
    const config = _loadConfig();
    if (config.repoPath) roots.add(config.repoPath);
    if (Array.isArray(config.projects)) {
      for (const p of config.projects) if (p && p.path) roots.add(p.path);
    }
    // A non-git folder is never a project, so without this it is only
    // readable while its task is alive. Not the filesystem root, the home
    // folder or anything above it, though: opening one of those as a task is
    // visible, but it mustn't quietly make everything readable afterwards.
    const folders = (config.recentPaths && config.recentPaths.folders) || [];
    for (const p of folders) if (p && !coversHome(p)) roots.add(p);
  } catch {}
  for (const inst of _getInstances().values()) {
    if (inst && inst.worktreePath) roots.add(inst.worktreePath);
  }
  // PR review clones. Not userData itself: config.json there holds tokens and
  // settings that decide what runs (agent paths, MCP servers, webhooks).
  try { roots.add(path.join(app.getPath('userData'), 'pr-checkouts')); } catch {}
  return Array.from(roots);
}

// Check if `candidate` resolves under any known renderer-allowed root.
// Returns the canonical resolved path on success, null on reject.
function pathUnderAnyRoot(candidate) {
  for (const root of getRendererAllowedRoots()) {
    const safe = pathUnder(root, candidate);
    if (safe) return safe;
  }
  return null;
}

// Resolve `candidate` (absolute or relative to `root`) and confirm the final
// real path is contained within `root`'s real path. Refuses traversal (`..`)
// and symlink escapes. Returns the canonical absolute path, or null on reject.
// Use for every IPC that takes a filesystem path from the renderer.
// Roots are realpath'd on every guarded call (git-status polls), so their
// answers are kept briefly. Only answers: a root that doesn't exist yet (the
// PR checkouts folder before the first review) must work the moment it does.
// Candidates aren't cached at all: files come and go.
const REALPATH_TTL_MS = 2000;
const realpathCache = new Map(); // path -> { at, value }
function cachedRealpath(p) {
  const now = Date.now();
  const hit = realpathCache.get(p);
  if (hit && now - hit.at < REALPATH_TTL_MS) return hit.value;
  if (realpathCache.size > 1000) realpathCache.clear();
  const value = fs.realpathSync(p);
  realpathCache.set(p, { at: now, value });
  return value;
}

function pathUnder(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string') return null;
  try {
    const rootReal = cachedRealpath(root);
    const absCandidate = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(rootReal, candidate);
    // realpath only works if the path exists. For write targets the file may
    // not exist yet — realpath the parent dir instead and rejoin the basename.
    let resolved;
    try {
      resolved = fs.realpathSync(absCandidate);
    } catch {
      const parent = path.dirname(absCandidate);
      const parentReal = fs.realpathSync(parent);
      resolved = path.join(parentReal, path.basename(absCandidate));
    }
    const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
    if (resolved === rootReal || resolved.startsWith(rootWithSep)) return resolved;
    return null;
  } catch {
    return null;
  }
}

// A directory under `root` to start a shell in, or null when `rel` escapes the
// root, doesn't exist, or isn't a directory.
function dirUnder(root, rel) {
  const resolved = pathUnder(root, rel);
  if (!resolved) return null;
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

// ---- workspaces ------------------------------------------------------------

const samePath = (a, b) => (process.platform === 'win32' || process.platform === 'darwin'
  ? a.toLowerCase() === b.toLowerCase() : a === b);

function realOrResolved(p) {
  try { return cachedRealpath(p); } catch { return path.resolve(p); }
}

// The repo a git worktree belongs to, read from its `.git` file
// ("gitdir: <repo>/.git/worktrees/<name>"). Reads the file rather than running
// git there: git honours a repo's own config (core.fsmonitor and friends), so
// running it in an untrusted folder can run that folder's commands.
function worktreeOwner(dir) {
  try {
    const dotGit = path.join(dir, '.git');
    if (!fs.statSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const gitdir = path.resolve(dir, m[1].trim());
    if (path.basename(path.dirname(gitdir)) !== 'worktrees') return null;
    const repoGit = path.dirname(path.dirname(gitdir));
    if (path.basename(repoGit) !== '.git') return null;
    // The repo's record of the worktree must point back here: a `.git` file
    // alone could claim any repo.
    const back = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim());
    if (realOrResolved(back) !== realOrResolved(dotGit)) return null;
    return path.dirname(repoGit);
  } catch {
    return null;
  }
}

// Whether `repo` has a worktree registered at `dir` (its .git/worktrees/<name>/gitdir
// names <dir>/.git).
function registersWorktree(repo, dir) {
  try {
    const base = path.join(repo, '.git', 'worktrees');
    for (const name of fs.readdirSync(base)) {
      let target;
      try { target = fs.readFileSync(path.join(base, name, 'gitdir'), 'utf8').trim(); } catch { continue; }
      if (samePath(path.resolve(base, name, target), path.join(dir, '.git'))) return true;
    }
  } catch {}
  return false;
}

// The canonical path of a workspace the app already knows, or null. A
// workspace is a project, the active repo, a recent folder, a live task's
// worktree (anything under those), a saved session's worktree (it may be gone
// from disk; resume recreates it), or a git worktree of a known project
// wherever it lives. Every IPC that takes a worktree or repo path from the
// renderer goes through this (main/util/ipc-guard.js), so a page can't point
// one at ~/.ssh or $HOME: it has to name somewhere the person already opened.
function knownWorkspace(candidate) {
  if (typeof candidate !== 'string' || !candidate || !path.isAbsolute(candidate)) return null;
  const inRoot = pathUnderAnyRoot(candidate);
  if (inRoot) return inRoot;
  const real = realOrResolved(candidate);
  let config = {};
  try { config = _loadConfig() || {}; } catch {}
  const named = [config.repoPath, ...(config.projects || []).map((p) => p && p.path)];
  for (const s of config.savedSessions || []) if (s && s.worktreePath) named.push(s.worktreePath);
  for (const n of named) {
    if (typeof n === 'string' && n && samePath(realOrResolved(n), real)) return real;
  }
  // A worktree whose folder is already gone (delete-session cleans those up)
  // is still named by its project's own record, .git/worktrees/*/gitdir.
  const projectsForStale = [config.repoPath, ...(config.projects || []).map((p) => p && p.path)];
  if (!fs.existsSync(real) && projectsForStale.some((p) => typeof p === 'string' && p && registersWorktree(p, real))) {
    return real;
  }
  const owner = worktreeOwner(real);
  if (owner) {
    const ownerReal = realOrResolved(owner);
    const projects = [config.repoPath, ...(config.projects || []).map((p) => p && p.path)];
    if (projects.some((p) => typeof p === 'string' && p && samePath(realOrResolved(p), ownerReal))) return real;
  }
  return null;
}

module.exports = { dirUnder, pathUnder, pathUnderAnyRoot, getRendererAllowedRoots, setDeps, knownWorkspace, worktreeOwner };
