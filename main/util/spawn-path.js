// PATH management for spawned processes. In util/, not bootstrap/, so binary
// lookup can reach it without requiring the Electron main process.

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { execToolSync } = require('./exec');

// A GUI launch on every platform inherits a PATH that omits the dirs pipx,
// brew and pip --user install into, so spawns ENOENT until we prepend them.
// Listing a dir that doesn't exist is harmless, so nothing is stat'd here.
function spawnPathCandidates() {
  const homedir = require('os').homedir();
  if (process.platform === 'win32') {
    const out = [
      path.join(homedir, '.klaussy', 'bin'),
      // pipx's default bin dir is ~/.local/bin on EVERY OS, Windows included.
      path.join(homedir, '.local', 'bin'),
    ];
    // pip --user console scripts: %APPDATA%\Python\Python3X\Scripts. The minor
    // version varies, so enumerate what exists.
    if (process.env.APPDATA) {
      const pyRoot = path.join(process.env.APPDATA, 'Python');
      try {
        for (const e of fs.readdirSync(pyRoot, { withFileTypes: true })) {
          if (e.isDirectory()) out.push(path.join(pyRoot, e.name, 'Scripts'));
        }
      } catch { /* nothing pip-user installed */ }
    }
    return out;
  }
  // macOS + Linux intermixed — a path that doesn't exist on one is harmless.
  const out = [
    path.join(homedir, '.klaussy', 'bin'),
    '/opt/homebrew/bin',          // Apple Silicon brew (mac)
    '/opt/homebrew/sbin',
    '/usr/local/bin',             // Intel brew + manual installs (mac/linux)
    '/usr/local/sbin',
    '/snap/bin',                  // snap-installed CLIs (Ubuntu/snap distros)
    path.join(homedir, '.local/bin'),   // pipx + pip --user (linux, mac)
    path.join(homedir, 'bin'),
    path.join(homedir, '.cargo/bin'),
    '/Applications/Cursor.app/Contents/Resources/app/bin',
  ];
  // macOS `pip install --user` drops console scripts into
  // ~/Library/Python/<X.Y>/bin — NOT ~/.local/bin. Without this a pip-user
  // fallback install "succeeds" but the CLI is invisible (spawn ENOENT).
  if (process.platform === 'darwin') {
    try {
      const pyRoot = path.join(homedir, 'Library', 'Python');
      for (const e of fs.readdirSync(pyRoot, { withFileTypes: true })) {
        if (e.isDirectory()) out.push(path.join(pyRoot, e.name, 'bin'));
      }
    } catch { /* no ~/Library/Python — nothing pip-user installed */ }
  }
  return out;
}

// Prepend dirs to process.env.PATH (de-duped, OS-correct separator). Prepend
// — not append — so our known-good install dir wins over a stale shim earlier
// on PATH.
function prependToSpawnPath(dirs) {
  const sep = path.delimiter;
  const have = (process.env.PATH || '').split(sep).filter(Boolean);
  const want = dirs.filter((d) => d && !have.includes(d));
  if (want.length) process.env.PATH = want.concat(have).join(sep);
}

function fixSpawnPath() {
  prependToSpawnPath(spawnPathCandidates());
}

// Ask pipx where it actually exposes app shims — honors a custom PIPX_BIN_DIR
// the static candidate list can't know about. Best-effort; null if pipx is
// absent or the query fails.
function pipxBinDir() {
  try {
    // execToolSync so a Windows scoop-shim pipx (pipx.cmd) resolves + runs —
    // a bare execFileSync('pipx') would ENOENT on it and silently drop a
    // custom PIPX_BIN_DIR from the spawn PATH.
    const out = execToolSync('pipx', ['environment', '--value', 'PIPX_BIN_DIR'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).toString().trim();
    return out || null;
  } catch { return null; }
}

// Re-read PATH from the OS itself, picking up dirs the static candidate list
// can't know about (a fresh brew/winget/apt install, `pipx ensurepath`).
function refreshSpawnPath() {
  fixSpawnPath();
  // pipx may expose shims under a custom PIPX_BIN_DIR the static list misses.
  const px = pipxBinDir();
  if (px) prependToSpawnPath([px]);
  try {
    if (process.platform === 'win32') {
      const out1 = execSync('reg query "HKCU\\Environment" /v Path', { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 }).toString();
      const out2 = execSync('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path', { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 }).toString();
      const extract = (txt) => {
        const m = txt.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+?)\r?\n/);
        return m ? m[1].trim() : '';
      };
      const fresh = [extract(out2), extract(out1)].filter(Boolean).join(';').split(';').filter(Boolean);
      if (fresh.length) {
        const have = (process.env.PATH || '').split(';').filter(Boolean);
        const merged = [];
        for (const p of fresh) if (!merged.includes(p)) merged.push(p);
        for (const p of have)  if (!merged.includes(p)) merged.push(p);
        process.env.PATH = merged.join(';');
      }
      return;
    }
    // -l sources profile files, -i sources rc; both are needed to mimic a
    // fresh login shell. rc-file noise goes to stderr, which we discard.
    const shell = process.env.SHELL || '/bin/bash';
    const out = execSync(`${shell} -lic 'echo "$PATH"' 2>/dev/null`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
    if (out) {
      const fresh = out.split(':').filter(Boolean);
      const have = (process.env.PATH || '').split(':').filter(Boolean);
      const merged = [];
      for (const p of have)  if (!merged.includes(p)) merged.push(p);
      for (const p of fresh) if (!merged.includes(p)) merged.push(p);
      process.env.PATH = merged.join(':');
    }
  } catch { /* shell or registry read failed; keep current PATH */ }
}

module.exports = { fixSpawnPath, refreshSpawnPath, prependToSpawnPath, spawnPathCandidates };
