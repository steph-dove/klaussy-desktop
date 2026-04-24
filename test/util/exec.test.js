require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const { appendStderr, sanitizeExtraEnv, runWithConcurrency, STDERR_CAP_BYTES } = require('../../main/util/exec');

// --- appendStderr ---

test('appendStderr accumulates chunks below the cap', () => {
  let buf = '';
  buf = appendStderr(buf, Buffer.from('hello '));
  buf = appendStderr(buf, Buffer.from('world'));
  assert.equal(buf, 'hello world');
});

test('appendStderr caps at STDERR_CAP_BYTES (tail-preserving)', () => {
  // Fill past the cap. The tail must be preserved so error messages near
  // the moment of failure are what we show the user.
  let buf = '';
  const chunk = Buffer.from('a'.repeat(1024));
  for (let i = 0; i < 100; i++) buf = appendStderr(buf, chunk);
  assert.equal(buf.length, STDERR_CAP_BYTES);
  // The last byte should still be 'a' — we took the tail.
  assert.equal(buf[buf.length - 1], 'a');
});

test('appendStderr preserves the most-recent content when overflowing', () => {
  let buf = 'a'.repeat(STDERR_CAP_BYTES);
  buf = appendStderr(buf, Buffer.from('DISTINCTIVE_TAIL'));
  assert.equal(buf.length, STDERR_CAP_BYTES);
  assert.ok(buf.endsWith('DISTINCTIVE_TAIL'));
});

// --- sanitizeExtraEnv ---

test('sanitizeExtraEnv drops LD_PRELOAD and DYLD_* keys', () => {
  const out = sanitizeExtraEnv({
    LD_PRELOAD: '/tmp/evil.so',
    DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
    DYLD_FALLBACK_LIBRARY_PATH: '/tmp/evil',
    HARMLESS: 'ok',
  });
  assert.deepEqual(out, { HARMLESS: 'ok' });
});

test('sanitizeExtraEnv drops NODE_OPTIONS / PATH / PYTHONPATH / RUBYOPT / PERL5LIB', () => {
  const out = sanitizeExtraEnv({
    NODE_OPTIONS: '--require /tmp/evil.js',
    PATH: '/tmp/evil',
    PYTHONPATH: '/tmp/evil',
    RUBYOPT: '-r/tmp/evil',
    PERL5LIB: '/tmp/evil',
    RUBYLIB: '/tmp/evil',
    PYTHONSTARTUP: '/tmp/evil',
    MY_VAR: 'fine',
  });
  assert.deepEqual(out, { MY_VAR: 'fine' });
});

test('sanitizeExtraEnv requires ALL-CAPS identifier names', () => {
  // The filter is intentionally strict: /^[A-Z_][A-Z0-9_]*$/ — matches the
  // POSIX env-var convention + blocks any lowercase-laden name a sloppy
  // .env might try to pass through. Keeps the allowed shape narrow.
  const out = sanitizeExtraEnv({
    bad_space: 'nope',                // (wouldn't even be a valid key literal)
    'bad space': 'nope',
    '1STARTSDIGIT': 'nope',
    '-dash': 'nope',
    'lowercase': 'nope',
    'valid_VAR': 'nope',              // lowercase 'v' disqualifies
    'MIXED_Case_123': 'nope',
    'UPPER_ONLY_123': 'ok',
    'A': 'ok',
    '_LEADING_UNDERSCORE': 'ok',
  });
  assert.deepEqual(out, {
    UPPER_ONLY_123: 'ok',
    A: 'ok',
    _LEADING_UNDERSCORE: 'ok',
  });
});

test('sanitizeExtraEnv rejects non-string values', () => {
  const out = sanitizeExtraEnv({ A: 'str', B: 42, C: null, D: undefined, E: {}, F: true });
  assert.deepEqual(out, { A: 'str' });
});

test('sanitizeExtraEnv accepts empty / non-object inputs gracefully', () => {
  assert.deepEqual(sanitizeExtraEnv(null), {});
  assert.deepEqual(sanitizeExtraEnv(undefined), {});
  assert.deepEqual(sanitizeExtraEnv('nope'), {});
  assert.deepEqual(sanitizeExtraEnv({}), {});
});

// --- runWithConcurrency ---

test('runWithConcurrency processes every item', async () => {
  const items = [1, 2, 3, 4, 5];
  const done = [];
  await runWithConcurrency(items, 2, async (n) => { done.push(n); });
  assert.deepEqual(done.slice().sort(), items);
});

test('runWithConcurrency never runs more than `cap` workers at once', async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await runWithConcurrency(items, 4, async () => {
    active++;
    peak = Math.max(peak, active);
    // Yield so other workers get a chance to start — without this the
    // first Promise resolves before the second one picks up, and peak
    // concurrency looks artificially low.
    await new Promise(r => setTimeout(r, 1));
    active--;
  });
  assert.ok(peak <= 4, 'peak concurrency exceeded cap: ' + peak);
  assert.ok(peak >= 2, 'peak concurrency suspiciously low: ' + peak);
});

test('runWithConcurrency swallows per-worker errors (background-safe)', async () => {
  // The auto-fetch + ci-poll callers don't want a single failing worker
  // to reject the whole batch. runWithConcurrency intentionally catches.
  const done = [];
  await runWithConcurrency([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('boom');
    done.push(n);
  });
  assert.deepEqual(done.slice().sort(), [1, 3]);
});

test('runWithConcurrency with cap > items runs up to items.length workers', async () => {
  let active = 0;
  let peak = 0;
  await runWithConcurrency([1, 2], 10, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 1));
    active--;
  });
  assert.ok(peak <= 2, 'spawned more workers than items: ' + peak);
});
