// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Which browsers may drive the browser-mode helper (web/helper.js).
//
// A browser pairs once: the helper's link carries a one-time pairing code, and
// the page registers the public half of a key pair it made with WebCrypto as
// non-extractable, so the private half can be used by the page but never read
// out of it. After that the page signs in by signing a fresh challenge with
// that key. Nothing long-lived that grants access sits anywhere a script could
// copy it: the pairing code expires in minutes and works once, and the
// session ticket the helper hands out lives only in the helper's memory.
//
// Two files in userData, both mode 600:
//   web-pair-codes.json  pending pairing codes, stored as SHA-256 hashes
//   web-browsers.json    paired browsers: id, public key (JWK), label, when
// Plain Node, so main/util/instance-lock.js (the desktop app's "Open in
// Browser") can mint a code too, and the tests can drive it directly.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CODES_FILE = 'web-pair-codes.json';
const BROWSERS_FILE = 'web-browsers.json';
const LOCK_FILE = 'web-pairing.lock';
const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_CODES = 5;   // each link mints one; older ones drop off
const MAX_BROWSERS = 50;       // full means refuse, never evict someone's browser
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 10000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Atomic, so a reader never sees half a file.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The helper and a second `npm run web` (or the desktop app's "Open in
// Browser") both read-modify-write these files. Without this, a mint that reads
// just before a consume writes could put the spent code back, or drop the code
// it just minted. A lock older than LOCK_STALE_MS was left by a crash.
function withLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let stale = false;
      try { stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { continue; }
      if (stale) { fs.rmSync(lock, { force: true }); continue; }
      if (Date.now() > deadline) throw new Error('Maussian\'s pairing files are busy; try again');
      sleepSync(20);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

function pendingCodes(dir, now) {
  const list = readJson(path.join(dir, CODES_FILE), []);
  return Array.isArray(list) ? list.filter((c) => c && typeof c.hash === 'string' && c.expires > now) : [];
}

// A new one-time pairing code for a link. Any process running as the user can
// mint one, which is the point: only someone who can already run commands as
// this user can get a code. At most MAX_PENDING_CODES are live at once.
function mintPairCode(dir, now = Date.now()) {
  const code = crypto.randomBytes(32).toString('base64url');
  withLock(dir, () => {
    const codes = pendingCodes(dir, now).slice(-(MAX_PENDING_CODES - 1));
    codes.push({ hash: sha256(code), expires: now + PAIR_CODE_TTL_MS });
    writeJson(path.join(dir, CODES_FILE), codes);
  });
  return code;
}

// Call with the lock held.
function spendCode(dir, code, now) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return false;
  const hash = sha256(code);
  const codes = pendingCodes(dir, now);
  const keep = codes.filter((c) => c.hash !== hash);
  if (keep.length === codes.length) return false;
  writeJson(path.join(dir, CODES_FILE), keep);
  return true;
}

// True once for a valid, unexpired code; the code is gone after that.
function consumePairCode(dir, code, now = Date.now()) {
  return withLock(dir, () => spendCode(dir, code, now));
}

// Only the public parts of a P-256 key, nothing else carried along.
function publicJwk(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || jwk.d !== undefined) return null;
  const clean = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  try { crypto.createPublicKey({ key: clean, format: 'jwk' }); } catch { return null; }
  return clean;
}

function listBrowsers(dir) {
  const list = readJson(path.join(dir, BROWSERS_FILE), []);
  return Array.isArray(list) ? list.filter((b) => b && typeof b.id === 'string' && b.jwk) : [];
}

function findBrowser(dir, id) {
  return (typeof id === 'string' && listBrowsers(dir).find((b) => b.id === id)) || null;
}

// Pairs a browser: { browserId } or { error: 'bad-key' | 'full' | 'bad-code' }.
// The key and the room are checked before the code is spent, so a bad request
// never burns the one-time code its link carried.
function pairBrowser(dir, code, jwk, label, now = Date.now()) {
  const key = publicJwk(jwk);
  if (!key) return { error: 'bad-key' };
  return withLock(dir, () => {
    const browsers = listBrowsers(dir);
    if (browsers.length >= MAX_BROWSERS) return { error: 'full' };
    if (!spendCode(dir, code, now)) return { error: 'bad-code' };
    const id = crypto.randomBytes(16).toString('hex');
    browsers.push({ id, jwk: key, label: String(label || '').slice(0, 120), pairedAt: new Date(now).toISOString() });
    writeJson(path.join(dir, BROWSERS_FILE), browsers);
    return { browserId: id };
  });
}

// Forgets every paired browser and pending code; returns how many browsers.
function removeAllBrowsers(dir) {
  return withLock(dir, () => {
    const count = listBrowsers(dir).length;
    writeJson(path.join(dir, BROWSERS_FILE), []);
    writeJson(path.join(dir, CODES_FILE), []);
    return count;
  });
}

// WebCrypto's ECDSA signatures are r || s (IEEE P1363), not DER.
function verifyChallenge(jwk, challenge, signatureB64url) {
  try {
    const key = crypto.createPublicKey({ key: publicJwk(jwk), format: 'jwk' });
    return crypto.verify('sha256', Buffer.from(String(challenge)), { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(String(signatureB64url), 'base64url'));
  } catch {
    return false;
  }
}

module.exports = {
  CODES_FILE, BROWSERS_FILE, LOCK_FILE, PAIR_CODE_TTL_MS, MAX_PENDING_CODES, MAX_BROWSERS,
  mintPairCode, consumePairCode, publicJwk, listBrowsers, findBrowser, pairBrowser, removeAllBrowsers, verifyChallenge,
};
