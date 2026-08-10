require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanExcerpt } = require('../../main/util/terminal-excerpt');

// Captured from a live session: the agent's answer buried under spinner frames,
// the input box, and the user's next message echoed one character per line.
const RAW = [
  '⏺Pop Quiz — 5 questions, mixed bag. No googling.',
  '',
  '1. What\'s the only mammal that can\'t jump?',
  '2. In JavaScript, what does typeof NaN return?',
  'Give me your answers and I\'ll grade them.',
  '✶Perambulating… (8s · ↓425 tokens)',
  'running stop hook · 8s · ↓425 tokens)',
  '✻Brewed for 8s',
  '',
  '❯ ',
  '? for shortcuts',
  'n', 'o', 'I', 'm', 'e', 'a', 'n',
].join('\n');

test('spinner frames, token counters and the input box are dropped', () => {
  const out = cleanExcerpt(RAW);
  assert.doesNotMatch(out, /Perambulating/);
  assert.doesNotMatch(out, /tokens/);
  assert.doesNotMatch(out, /Brewed for/);
  assert.doesNotMatch(out, /for shortcuts/);
  assert.doesNotMatch(out, /running stop hook/);
});

test('the agent\'s own message survives the cleaning', () => {
  const out = cleanExcerpt(RAW);
  assert.match(out, /Pop Quiz/);
  assert.match(out, /only mammal/);
  assert.match(out, /grade them/);
});

test('a column of echoed keystrokes becomes the word that was typed', () => {
  assert.match(cleanExcerpt(RAW), /noImean/);
});

test('short runs are left alone, since one character can be real content', () => {
  // A menu key on its own line is content, not an echoed word.
  assert.equal(cleanExcerpt('a\nb'), 'a\nb');
});

test('repeated repaints of the same line collapse to one', () => {
  assert.equal(cleanExcerpt('Building…\nBuilding…\nBuilding…\nDone'), 'Building…\nDone');
});

test('a bare carriage return does not glue two repaints together', () => {
  assert.equal(cleanExcerpt('50%\r100%'), '50%\n100%');
});

test('blank runs collapse and nothing is left dangling', () => {
  assert.equal(cleanExcerpt('\n\n\nreal\n\n\n\nlines\n\n'), 'real\n\nlines');
});

test('empty input is handled', () => {
  assert.equal(cleanExcerpt(''), '');
  assert.equal(cleanExcerpt(null), '');
});

// Repeated stale alerts came from treating a repaint as the agent doing
// something: each one re-armed the timer, which expired again, forever.
test('a repaint alone is not the agent doing something', () => {
  const { isChromeOnly } = require('../../main/util/terminal-excerpt');
  assert.equal(isChromeOnly('✶ Perambulating… (8s · ↓425 tokens)'), true);
  assert.equal(isChromeOnly('❯ \n? for shortcuts'), true);
  assert.equal(isChromeOnly(''), true, 'an empty chunk is not activity');
});

test('real output is activity and starts a new quiet episode', () => {
  const { isChromeOnly } = require('../../main/util/terminal-excerpt');
  assert.equal(isChromeOnly('Here is the answer you asked for.'), false);
  assert.equal(isChromeOnly('Done.\n✶ Perambulating… (1s · ↓5 tokens)'), false);
});

// Verbatim from a live Antigravity session, whose spinner label is retyped a
// character at a time.
test('a label typed out one character at a time collapses to nothing', () => {
  const raw = [
    'The :root default in renderer/styles/01-base.css,',
    '⋮ Working...',
    '└ Tip: Use /cs to search in your codebase.',
    '⋮', '⋮', '⋮',
    '⋮ Wo', '⋮ Wor', '⋮ Work', '⋮ Worki', '⋮ Working...',
  ].join('\n');
  const out = cleanExcerpt(raw);
  assert.match(out, /:root default/, 'the real line survives');
  assert.doesNotMatch(out, /Wo\b|Wor\b|Worki\b/, 'no growth stubs');
  assert.doesNotMatch(out, /Tip:/, 'the hint line is chrome');
  assert.doesNotMatch(out, /⋮/, 'bare gutter marks are chrome');
});

test('the final form of a grown label is what gets recognised as chrome', () => {
  // Collapses to "Working...", which the chrome rules then remove entirely.
  assert.equal(cleanExcerpt('Wo\nWor\nWork\nWorking...'), '');
  assert.equal(cleanExcerpt('Fi\nFini\nFinished the refactor'), 'Finished the refactor');
});

test('gutter marks are never stitched into words', () => {
  assert.doesNotMatch(cleanExcerpt('>\n⋮\n⋮\n⋮'), />⋮/);
  assert.equal(cleanExcerpt('y\ne\ns'), 'yes');
});
