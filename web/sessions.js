// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Sign-in challenges and session tickets for the browser-mode helper, kept out
// of web/helper.js with an injectable clock so test/util/web-sessions.test.js
// can cover expiry and the limits without waiting.
//
// A paired browser asks for a challenge, signs it with its key, and gets a
// ticket. Tickets live only here, hashed, and end after SESSION_IDLE_MS unused,
// when the helper stops, or when their browser is unpaired. The limits are per
// browser, so one browser (or someone replaying its id) can't crowd out another.

const crypto = require('crypto');

const LIMITS = {
  challengeTtlMs: 60 * 1000,
  challengesPerBrowser: 5,              // a browser's oldest is dropped past this
  challengesTotal: 500,                 // past this, new ones are refused, never others' dropped
  failuresPerBrowser: 10,               // failed sign-ins per browser per window
  failureWindowMs: 60 * 1000,
  sessionIdleMs: 12 * 60 * 60 * 1000,
};

const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const newSecret = () => crypto.randomBytes(32).toString('base64url');
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

class SessionStore {
  // isPaired(browserId) says whether a browser is still paired.
  constructor({ isPaired, now = Date.now, limits = LIMITS } = {}) {
    this.isPaired = isPaired;
    this.now = now;
    this.limits = limits;
    this.challenges = new Map(); // challenge -> { browserId, expires }
    this.sessions = new Map();   // sha256(ticket) -> { browserId, lastUsed }
    this.failures = new Map();   // browserId -> [ms, ...]
  }

  // A challenge for a paired browser, or { error: 'limited' } when that browser
  // has failed too often lately or the helper holds too many.
  challengeFor(browserId) {
    const now = this.now();
    this.prune();
    if (this.tooManyFailures(browserId, now)) return { error: 'limited' };
    const mine = [...this.challenges].filter(([, v]) => v.browserId === browserId);
    if (mine.length >= this.limits.challengesPerBrowser) this.challenges.delete(mine[0][0]);
    if (this.challenges.size >= this.limits.challengesTotal) return { error: 'limited' };
    const challenge = newSecret();
    this.challenges.set(challenge, { browserId, expires: now + this.limits.challengeTtlMs });
    return { challenge };
  }

  // Spends a challenge (any attempt spends it) and, if it was this browser's,
  // unexpired, and `verify()` accepts the signature, starts a session.
  // Returns { ticket } or { error: 'refused' | 'limited' }.
  signIn(browserId, challenge, verify) {
    const now = this.now();
    if (this.tooManyFailures(browserId, now)) return { error: 'limited' };
    const c = typeof challenge === 'string' ? this.challenges.get(challenge) : null;
    if (c) this.challenges.delete(challenge);
    const ok = !!c && c.browserId === browserId && c.expires > now && verify();
    if (!ok) {
      if (typeof browserId === 'string') this.failures.set(browserId, [...(this.failures.get(browserId) || []), now]);
      return { error: 'refused' };
    }
    const ticket = newSecret();
    this.sessions.set(hash(ticket), { browserId, lastUsed: now });
    return { ticket };
  }

  // The browser a ticket belongs to, or null: unknown, idle too long, or its
  // browser has been unpaired since.
  browserFor(ticket) {
    if (typeof ticket !== 'string' || !SECRET_RE.test(ticket)) return null;
    const key = hash(ticket);
    const s = this.sessions.get(key);
    if (!s) return null;
    const now = this.now();
    if (now - s.lastUsed > this.limits.sessionIdleMs || !this.isPaired(s.browserId)) {
      this.sessions.delete(key);
      return null;
    }
    s.lastUsed = now;
    return s.browserId;
  }

  tooManyFailures(browserId, now) {
    const recent = (this.failures.get(browserId) || []).filter((t) => now - t < this.limits.failureWindowMs);
    if (recent.length) this.failures.set(browserId, recent); else this.failures.delete(browserId);
    return recent.length >= this.limits.failuresPerBrowser;
  }

  // Drops expired challenges, idle sessions, sessions of unpaired browsers and
  // old failures. Run on a timer, so nothing piles up for the helper's lifetime.
  prune() {
    const now = this.now();
    for (const [c, v] of this.challenges) if (v.expires <= now) this.challenges.delete(c);
    for (const [k, s] of this.sessions) {
      if (now - s.lastUsed > this.limits.sessionIdleMs || !this.isPaired(s.browserId)) this.sessions.delete(k);
    }
    for (const id of [...this.failures.keys()]) this.tooManyFailures(id, now);
  }
}

module.exports = { SessionStore, LIMITS };
