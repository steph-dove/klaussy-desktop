require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOutputCoalescer } = require('../../main/util/output-coalescer');

// A hand-run scheduler: nextTurn() is the end of the current event-loop turn.
function harness(opts = {}) {
  const sent = [];
  let queued = null;
  const c = createOutputCoalescer({
    send: (ch, data) => sent.push([ch, data]),
    schedule: (fn) => { queued = fn; return 1; },
    cancel: () => { queued = null; },
    ...opts,
  });
  const nextTurn = () => { const fn = queued; queued = null; if (fn) fn(); };
  return { c, sent, nextTurn, isScheduled: () => queued !== null };
}

test('chunks read in one turn go out as a single joined message', () => {
  const { c, sent, nextTurn } = harness();
  c.push('terminal-data-1', 'a');
  c.push('terminal-data-1', 'b');
  c.push('terminal-data-1', 'c');
  assert.deepEqual(sent, []);
  nextTurn();
  assert.deepEqual(sent, [['terminal-data-1', 'abc']]);
});

test('a lone keystroke echo is delivered at the end of the same turn, with no timer', () => {
  const { c, sent, nextTurn, isScheduled } = harness();
  c.push('terminal-data-7', 'k');
  assert.equal(isScheduled(), true);
  nextTurn();
  assert.deepEqual(sent, [['terminal-data-7', 'k']]);
});

test('the real scheduler flushes before any timer could fire', async () => {
  const sent = [];
  const c = createOutputCoalescer({ send: (ch, data) => sent.push([ch, data]) });
  c.push('terminal-data-8', 'x');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [['terminal-data-8', 'x']]);
});

test('channels never mix', () => {
  const { c, sent, nextTurn } = harness();
  c.push('terminal-data-1', 'one');
  c.push('terminal-data-2', 'two');
  c.push('terminal-data-1', '!');
  nextTurn();
  assert.deepEqual(sent, [['terminal-data-1', 'one!'], ['terminal-data-2', 'two']]);
});

test('a channel that hits maxBytes flushes right away', () => {
  const { c, sent } = harness({ maxBytes: 5 });
  c.push('terminal-data-1', 'abc');
  c.push('terminal-data-1', 'def');
  assert.deepEqual(sent, [['terminal-data-1', 'abcdef']]);
});

test('flush sends one channel now and leaves the rest for the end of the turn', () => {
  const { c, sent, nextTurn } = harness();
  c.push('terminal-data-1', 'x');
  c.push('terminal-data-2', 'y');
  c.flush('terminal-data-1');
  assert.deepEqual(sent, [['terminal-data-1', 'x']]);
  nextTurn();
  assert.deepEqual(sent, [['terminal-data-1', 'x'], ['terminal-data-2', 'y']]);
});

test('flushing an empty channel and pushing an empty chunk are no-ops', () => {
  const { c, sent, nextTurn, isScheduled } = harness();
  c.flush('terminal-data-9');
  c.push('terminal-data-9', '');
  assert.equal(isScheduled(), false);
  nextTurn();
  assert.deepEqual(sent, []);
});

test('a throwing send for one channel does not strand the others', () => {
  let queued = null;
  const sent = [];
  const c = createOutputCoalescer({
    send: (ch, data) => { if (ch === 'bad') throw new Error('destroyed'); sent.push([ch, data]); },
    schedule: (fn) => { queued = fn; return 1; },
    cancel: () => { queued = null; },
  });
  const origError = console.error;
  console.error = () => {};
  try {
    c.push('bad', 'x');
    c.push('good', 'y');
    queued();
  } finally {
    console.error = origError;
  }
  assert.deepEqual(sent, [['good', 'y']]);
});
