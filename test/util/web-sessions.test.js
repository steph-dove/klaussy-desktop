require('../setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionStore, LIMITS } = require('../../web/sessions');

// A store with a hand-moved clock and a set of paired browsers.
function store() {
  const paired = new Set(['a', 'b']);
  const clock = { t: 1_000_000 };
  const s = new SessionStore({ isPaired: (id) => paired.has(id), now: () => clock.t });
  return { s, paired, clock };
}
const yes = () => true;
const no = () => false;

test('a challenge works once, for its own browser, within its minute', () => {
  const { s, clock } = store();
  const c1 = s.challengeFor('a').challenge;
  assert.ok(s.signIn('a', c1, yes).ticket);
  assert.deepEqual(s.signIn('a', c1, yes), { error: 'refused' }); // spent

  const c2 = s.challengeFor('a').challenge;
  assert.deepEqual(s.signIn('b', c2, yes), { error: 'refused' }); // a's challenge, b's sign-in
  assert.deepEqual(s.signIn('a', c2, yes), { error: 'refused' }); // and any attempt spends it

  const c3 = s.challengeFor('a').challenge;
  clock.t += LIMITS.challengeTtlMs + 1;
  assert.deepEqual(s.signIn('a', c3, yes), { error: 'refused' }); // expired
});

test('a bad signature spends the challenge and counts as a failure', () => {
  const { s } = store();
  const c = s.challengeFor('a').challenge;
  assert.deepEqual(s.signIn('a', c, no), { error: 'refused' });
  assert.deepEqual(s.signIn('a', c, yes), { error: 'refused' });
});

test('too many failed sign-ins limit that browser only, for a minute', () => {
  const { s, clock } = store();
  for (let i = 0; i < LIMITS.failuresPerBrowser; i++) s.signIn('a', s.challengeFor('a').challenge, no);
  assert.deepEqual(s.challengeFor('a'), { error: 'limited' });
  assert.ok(s.signIn('b', s.challengeFor('b').challenge, yes).ticket); // b is unaffected
  clock.t += LIMITS.failureWindowMs + 1;
  assert.ok(s.signIn('a', s.challengeFor('a').challenge, yes).ticket);
});

test('flooding challenges for one browser never drops another browser’s', () => {
  const { s } = store();
  const bs = s.challengeFor('b').challenge;
  for (let i = 0; i < 50; i++) s.challengeFor('a');
  assert.ok(s.signIn('b', bs, yes).ticket);
});

test('a ticket ends when idle too long or when its browser is unpaired', () => {
  const { s, paired, clock } = store();
  const t1 = s.signIn('a', s.challengeFor('a').challenge, yes).ticket;
  assert.equal(s.browserFor(t1), 'a');
  clock.t += LIMITS.sessionIdleMs - 1000;
  assert.equal(s.browserFor(t1), 'a'); // use keeps it alive
  clock.t += LIMITS.sessionIdleMs + 1;
  assert.equal(s.browserFor(t1), null);

  const t2 = s.signIn('b', s.challengeFor('b').challenge, yes).ticket;
  paired.delete('b');
  assert.equal(s.browserFor(t2), null);
  assert.equal(s.browserFor('x'.repeat(43)), null);
  assert.equal(s.browserFor(undefined), null);
});

test('prune drops expired challenges, dead sessions and old failures', () => {
  const { s, paired, clock } = store();
  s.challengeFor('a');
  s.signIn('b', s.challengeFor('b').challenge, yes);
  s.signIn('a', 'not-a-challenge', yes);
  paired.delete('b');
  clock.t += LIMITS.failureWindowMs + LIMITS.challengeTtlMs + 1;
  s.prune();
  assert.equal(s.challenges.size, 0);
  assert.equal(s.sessions.size, 0);
  assert.equal(s.failures.size, 0);
});
