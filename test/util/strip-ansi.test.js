require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { stripAnsi } = require('../../main/state/instances');
const { parsePromptQuestion, parsePromptOptions } = require('../../main/util/chat-reply');

// A digits-only parameter class never matched private modes, so "[?25h"
// survived as literal text and broke every ^-anchored parse.
test('private mode sequences are stripped, not left as text', () => {
  assert.equal(stripAnsi('\x1b[?25lhidden\x1b[?25h'), 'hidden');
  assert.equal(stripAnsi('\x1b[?2004hpaste\x1b[?2004l'), 'paste');
  assert.doesNotMatch(stripAnsi('\x1b[?1006l\x1b[?1003l'), /\[\?/);
});

test('colour, erase and cursor positioning are stripped', () => {
  assert.equal(stripAnsi('\x1b[1m\x1b[38;5;39mbold\x1b[0m\x1b[K'), 'bold');
  assert.equal(stripAnsi('\x1b[2J\x1b[H\x1b[10;20Hplaced'), 'placed');
});

test('cursor-forward becomes the spaces it stood for', () => {
  assert.equal(stripAnsi('1.\x1b[1CYes'), '1. Yes');
  assert.equal(stripAnsi('a\x1b[3Cb'), 'a   b');
});

test('window-title sequences do not swallow the line', () => {
  assert.equal(stripAnsi('\x1b]0;my title\x07after'), 'after');
});

// End to end on a screen shaped like a real one: if any escape survives, the
// option lines stop matching and the alert falls back to dumping the screen.
test('a real menu survives stripping and parses completely', () => {
  const raw = [
    '\x1b[?25l\x1b[?2004h',
    '\x1b[1m\x1b[38;5;39m□\x1b[0m\x1b[1CCSS quiz\x1b[K',
    'In CSS, which `box-sizing` value includes padding and border?\x1b[K',
    '\x1b[38;5;39m❯\x1b[39m\x1b[1C1.\x1b[1Cborder-box\x1b[K',
    '\x1b[2C2.\x1b[1Ccontent-box\x1b[K',
    'Enter to select · ↑/↓ to navigate · Esc to cancel\x1b[?25h',
  ].join('\n');
  const clean = stripAnsi(raw);
  assert.doesNotMatch(clean, /\x1b|\[\?/, 'no escape residue');

  assert.equal(parsePromptQuestion(clean),
    'In CSS, which `box-sizing` value includes padding and border?');
  assert.deepEqual(parsePromptOptions(clean).options.map((o) => `${o.key}. ${o.label}`),
    ['1. border-box', '2. content-box']);
});
