require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const transcript = require('../../main/util/session-transcript');

test('the first turn is delivered whole', () => {
  transcript._reset();
  const out = transcript.takeNewOutput(1, 'Here is the plan.\nStep one.');
  assert.match(out, /Here is the plan/);
  assert.match(out, /Step one/);
});

// The screen is repainted constantly; without this every redraw would repost
// the entire conversation so far.
test('a repaint of the same screen sends nothing', () => {
  transcript._reset();
  const screen = 'Here is the plan.\nStep one.';
  transcript.takeNewOutput(1, screen);
  assert.equal(transcript.takeNewOutput(1, screen), '');
});

test('only the new lines of a grown screen are sent', () => {
  transcript._reset();
  transcript.takeNewOutput(1, 'Here is the plan.\nStep one.');
  const out = transcript.takeNewOutput(1, 'Here is the plan.\nStep one.\nStep two.');
  assert.equal(out, 'Step two.');
});

test('sessions do not bleed into each other', () => {
  transcript._reset();
  transcript.takeNewOutput(1, 'Session one says this.');
  const other = transcript.takeNewOutput(2, 'Session one says this.');
  assert.match(other, /Session one says this/, 'a second session starts fresh');
});

test('chrome alone is never worth sending', () => {
  transcript._reset();
  assert.equal(transcript.takeNewOutput(1, '✶ Perambulating… (8s · ↓425 tokens)\n❯ '), '');
});

test('an oversized turn is trimmed to its ending', () => {
  transcript._reset();
  const long = Array.from({ length: 400 }, (_, i) => `line number ${i}`).join('\n');
  const out = transcript.takeNewOutput(1, long);
  assert.ok(out.length <= transcript.MAX_POST_CHARS + 40, 'bounded for the platform limit');
  assert.match(out, /line number 399/, 'keeps the end, where the question is');
  assert.match(out, /trimmed/);
});

test('forgetting a task lets its lines be sent again', () => {
  transcript._reset();
  transcript.takeNewOutput(9, 'Something it said.');
  assert.equal(transcript.takeNewOutput(9, 'Something it said.'), '');
  transcript.forgetTask(9);
  assert.match(transcript.takeNewOutput(9, 'Something it said.'), /Something it said/);
});

test('empty and blank screens produce nothing', () => {
  transcript._reset();
  assert.equal(transcript.takeNewOutput(1, ''), '');
  assert.equal(transcript.takeNewOutput(1, '\n\n   \n'), '');
});
