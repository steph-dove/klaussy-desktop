// Whether an agent CLI is installed is decided by resolving its binary, never
// by the exit status of `agent --version`: a probe that times out or exits
// non-zero says nothing about whether the CLI is there.

const fs = require('fs');
const { whichBinSync } = require('./platform');

// The refresh spawns a login shell, and probing every provider misses once per
// absent agent. Short enough that "Re-check" after an install still re-reads.
const REFRESH_COOLDOWN_MS = 5000;
let lastRefresh = 0;

// whichBinSync, not `which`, so Windows resolves via where.exe + PATHEXT.
function lookup(bin) {
  if (!bin) return null;
  if (/[/\\]/.test(bin)) return fs.existsSync(bin) ? bin : null;
  return whichBinSync(bin);
}

function refreshPath() {
  if (Date.now() - lastRefresh < REFRESH_COOLDOWN_MS) return false;
  lastRefresh = Date.now();
  try {
    require('./spawn-path').refreshSpawnPath();
    return true;
  } catch {
    return false;
  }
}

// A GUI launch starts with a minimal PATH, so a miss re-reads the user's
// login-shell PATH before giving up.
function resolveAgentBin(bin) {
  const hit = lookup(bin);
  if (hit) return hit;
  if (!refreshPath()) return null;
  return lookup(bin);
}

module.exports = { resolveAgentBin };
