// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// One Maussian per settings folder. The desktop app and the browser-mode helper
// (web/helper.js) share userData — the same projects, sessions and settings —
// so only one of them may run against it at a time. Electron's single-instance
// lock covers desktop against desktop; this file covers desktop against browser
// and browser against browser.
//
// The lock is a small JSON file in userData naming the holder: its kind
// ('desktop' | 'web'), pid, and for the browser helper the port it serves on.
// A holder whose process is gone is stale and gets replaced.

const fs = require('fs');
const path = require('path');

const LOCK_FILE = 'maussian-instance.json';
const TOKEN_FILE = 'web-token';
const KINDS = new Set(['desktop', 'web']);

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else, so it's alive.
    return err.code === 'EPERM';
  }
}

function lockPath(dir) {
  return path.join(dir, LOCK_FILE);
}

function readLock(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'));
    if (v && Number.isInteger(v.pid) && KINDS.has(v.kind)) return v;
  } catch {}
  return null;
}

// The live process holding the folder, other than this one, or null.
function currentHolder(dir, { isAlive = isProcessAlive } = {}) {
  const v = readLock(dir);
  if (!v || v.pid === process.pid || !isAlive(v.pid)) return null;
  return v;
}

function writeLock(dir, info) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockPath(dir), JSON.stringify({ ...info, pid: process.pid }), { mode: 0o600 });
}

// Take the folder for this process. Returns { ok: true }, or { ok: false, holder }
// when another live process has it. The exclusive create means two processes
// starting at once can't both win.
function acquire(dir, info, opts) {
  fs.mkdirSync(dir, { recursive: true });
  const file = lockPath(dir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeSync(fd, JSON.stringify({ ...info, pid: process.pid })); } finally { fs.closeSync(fd); }
      return { ok: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = currentHolder(dir, opts);
      if (holder) return { ok: false, holder };
      fs.rmSync(file, { force: true }); // stale, unreadable, or our own: replace it
    }
  }
  const holder = currentHolder(dir, opts);
  return holder ? { ok: false, holder } : { ok: false, holder: readLock(dir) };
}

// Add fields (the helper's port, once it's listening) to a lock this process holds.
function update(dir, fields) {
  const v = readLock(dir);
  if (!v || v.pid !== process.pid) return false;
  writeLock(dir, { ...v, ...fields });
  return true;
}

function release(dir) {
  const v = readLock(dir);
  if (v && v.pid === process.pid) fs.rmSync(lockPath(dir), { force: true });
}

// Remove the lock whoever holds it. Only for a holder known to be leftover.
function discard(dir) {
  fs.rmSync(lockPath(dir), { force: true });
}

// The signed-in link to a running browser helper, or null if it isn't
// listening yet or has no token.
function browserUrl(dir, holder) {
  if (!holder || holder.kind !== 'web' || !Number.isInteger(holder.port)) return null;
  let token;
  try { token = fs.readFileSync(path.join(dir, TOKEN_FILE), 'utf8').trim(); } catch { return null; }
  if (!token) return null;
  return `http://127.0.0.1:${holder.port}/renderer/index.html#token=${token}`;
}

// Ask a holder to stop (it saves sessions on SIGTERM) and wait for it to exit.
async function stopHolder(holder, { timeoutMs = 10000, isAlive = isProcessAlive, kill = process.kill } = {}) {
  try { kill(holder.pid, 'SIGTERM'); } catch { return !isAlive(holder.pid); }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(holder.pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isAlive(holder.pid);
}

module.exports = {
  LOCK_FILE, TOKEN_FILE, acquire, update, release, discard, currentHolder, readLock, browserUrl, stopHolder, isProcessAlive,
};
