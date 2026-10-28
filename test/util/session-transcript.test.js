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

async function screenSays(id, data, cols = 40, rows = 10) {
  transcript.feedScreen(id, data, cols, rows);
  await transcript._flush(id);
  return transcript.takeNewOutput(id, '');
}

test('a boxed panel drawn with cursor moves reads as its text', async () => {
  transcript._reset();
  const out = await screenSays(1,
    '\x1b[2J\x1b[1;1H╭──────────────╮'
    + '\x1b[2;1H│ Permission   \x1b[2;16H│'
    + '\x1b[3;1H│ granted.     \x1b[3;16H│'
    + '\x1b[4;1H╰──────────────╯');
  assert.equal(out, 'Permission\ngranted.');
});

test('an alt-screen repaint of the same frame sends nothing', async () => {
  transcript._reset();
  const frame = '\x1b[?1049h\x1b[2J\x1b[HAll permissions are now enabled.\r\nExecution mode: Interactive.';
  assert.match(await screenSays(1, frame), /All permissions are now enabled\.\nExecution mode: Interactive\./);
  assert.equal(await screenSays(1, frame), '');
});

test('a line painted into place is sent on its own', async () => {
  transcript._reset();
  await screenSays(1, '\x1b[2J\x1b[HFirst answer.');
  assert.equal(await screenSays(1, '\x1b[3;1HSecond answer.'), 'Second answer.');
});

test('a resize reflows the screen without reposting it', async () => {
  transcript._reset();
  const long = 'This sentence is long enough to wrap at forty columns wide.';
  assert.equal(await screenSays(1, long, 40), long);
  assert.equal(await screenSays(1, '', 80), '');
});

test('a long scrollback is not reposted on the next turn', async () => {
  transcript._reset();
  const lines = Array.from({ length: 300 }, (_, i) => `output line ${i}`).join('\r\n');
  await screenSays(1, lines);
  assert.equal(await screenSays(1, '\r\nThe tests pass.'), 'The tests pass.');
});

test('forgetting a task drops its screen too', async () => {
  transcript._reset();
  await screenSays(3, 'On the screen.');
  transcript.forgetTask(3);
  assert.equal(transcript.takeNewOutput(3, 'From the stream.'), 'From the stream.');
});

test('the current screen is available for a notification tail', async () => {
  transcript._reset();
  assert.equal(transcript.screenText(4), '', 'no screen yet');
  transcript.feedScreen(4, '\x1b[2J\x1b[1;1Hcrashed: out of memory', 40, 5);
  await transcript._flush(4);
  assert.match(transcript.screenText(4), /^crashed: out of memory/);
});
