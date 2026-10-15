require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOutputCoalescer } = require('../../main/util/output-coalescer');

// A clock pinned at 0 keeps every channel mid-burst, so pushes batch; the leading-edge test opts out.
function harness(opts = {}) {
  const sent = [];
  const c = createOutputCoalescer({ send: (ch, data) => sent.push([ch, data]), now: () => 0, ...opts });
  return { c, sent };
}

test('chunks inside one window go out as a single joined message', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, sent } = harness();
  c.push('terminal-data-1', 'a');
  c.push('terminal-data-1', 'b');
  c.push('terminal-data-1', 'c');
  assert.deepEqual(sent, []);
  t.mock.timers.tick(4);
  assert.deepEqual(sent, [['terminal-data-1', 'abc']]);
});

test('channels never mix', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, sent } = harness();
  c.push('terminal-data-1', 'one');
  c.push('terminal-data-2', 'two');
  c.push('terminal-data-1', '!');
  t.mock.timers.tick(4);
  assert.deepEqual(sent, [['terminal-data-1', 'one!'], ['terminal-data-2', 'two']]);
});

test('a channel that hits maxBytes flushes right away', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, sent } = harness({ maxBytes: 5 });
  c.push('terminal-data-1', 'abc');
  c.push('terminal-data-1', 'def');
  assert.deepEqual(sent, [['terminal-data-1', 'abcdef']]);
});

test('flush sends one channel now and leaves the rest on the timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, sent } = harness();
  c.push('terminal-data-1', 'x');
  c.push('terminal-data-2', 'y');
  c.flush('terminal-data-1');
  assert.deepEqual(sent, [['terminal-data-1', 'x']]);
  t.mock.timers.tick(4);
  assert.deepEqual(sent, [['terminal-data-1', 'x'], ['terminal-data-2', 'y']]);
});

test('flushing an empty channel and pushing an empty chunk are no-ops', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, sent } = harness();
  c.flush('terminal-data-9');
  c.push('terminal-data-9', '');
  t.mock.timers.tick(10);
  assert.deepEqual(sent, []);
});

test('a throwing send for one channel does not strand the others', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const c = createOutputCoalescer({
    send: (ch, data) => { if (ch === 'bad') throw new Error('destroyed'); sent.push([ch, data]); },
    now: () => 0,
  });
  const origError = console.error;
  console.error = () => {};
  try {
    c.push('bad', 'x');
    c.push('good', 'y');
    t.mock.timers.tick(4);
  } finally {
    console.error = origError;
  }
  assert.deepEqual(sent, [['good', 'y']]);
});

test('a lone chunk after a quiet spell goes out at once; only the burst behind it waits', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { c, sent } = harness({ now: () => Date.now() });
  c.push('terminal-data-7', 'k');
  assert.deepEqual(sent, [['terminal-data-7', 'k']], 'a keystroke echo is not held for the timer');
  c.push('terminal-data-7', 'a');
  c.push('terminal-data-7', 'b');
  assert.equal(sent.length, 1, 'chunks right behind it are batched');
  t.mock.timers.tick(4);
  assert.deepEqual(sent.at(-1), ['terminal-data-7', 'ab']);
  t.mock.timers.tick(50);
  c.push('terminal-data-7', 'z');
  assert.deepEqual(sent.at(-1), ['terminal-data-7', 'z'], 'quiet again, so straight through');
});
