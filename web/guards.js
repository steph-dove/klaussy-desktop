// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// The checks web/helper.js runs on every request, kept free of server state so
// test/util/web-guards.test.js can cover them directly.

const fs = require('fs');
const path = require('path');

// Host: blocks DNS rebinding (an attacker's hostname resolving to 127.0.0.1).
function hostOk(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

// Origin: only the helper's own page may open the socket or POST.
function originOk(origin, port) {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

// The one ipcMain.on channel the renderer reaches synchronously (preload.js).
const SYNC_CHANNELS = new Set(['get-providers-sync']);

// Decode a request path. null for anything malformed: a bad %-escape, a NUL
// byte, or a backslash (a path separator on Windows).
function decodePath(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel.includes('\0') || rel.includes('\\')) return null;
  return rel.replace(/^\/+/, '');
}

// The real file a static request may read, or null. A file qualifies only if,
// after resolving every symlink, it is still inside one of `roots` (each a file
// or a folder ending in '/', relative to `root`).
function resolveStatic(root, rel, roots, realpath = fs.realpathSync.native) {
  let realRoot;
  let real;
  try {
    realRoot = realpath(root);
    real = realpath(path.resolve(root, rel));
  } catch {
    return null;
  }
  const inside = path.relative(realRoot, real);
  if (!inside || inside.startsWith('..' + path.sep) || inside === '..' || path.isAbsolute(inside)) return null;
  const posix = inside.split(path.sep).join('/');
  const allowed = roots.some((r) => (r.endsWith('/') ? posix.startsWith(r) : posix === r));
  return allowed ? real : null;
}

module.exports = { hostOk, originOk, SYNC_CHANNELS, decodePath, resolveStatic };
