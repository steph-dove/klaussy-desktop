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
const path = require('path');
const { app } = require('electron');

let _loadConfig = () => ({});
let _getInstances = () => new Map();

function setDeps({ loadConfig, getInstances } = {}) {
  if (loadConfig) _loadConfig = loadConfig;
  if (getInstances) _getInstances = getInstances;
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
  } catch {}
  for (const inst of _getInstances().values()) {
    if (inst && inst.worktreePath) roots.add(inst.worktreePath);
  }
  // Klaussy-owned directories (pr-checkouts clones, userData for caches).
  try { roots.add(app.getPath('userData')); } catch {}
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
function pathUnder(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string') return null;
  try {
    const rootReal = fs.realpathSync(root);
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

module.exports = { pathUnder, pathUnderAnyRoot, getRendererAllowedRoots, setDeps };
