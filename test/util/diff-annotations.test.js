const test = require('node:test');
const assert = require('node:assert/strict');

// diff-annotations.js is a renderer IIFE assigning to window.DiffAnnotations and
// touches no Electron/DOM API, so we stub `window` and require it (same approach
// as finding-parser.test.js).
global.window = global.window || {};
require('../../renderer/diff-annotations');
const DA = global.window.DiffAnnotations;

test('upsert adds a new annotation and replaces one on the same line', () => {
  let list = [];
  list = DA.upsert(list, { filePath: 'a.js', side: 'RIGHT', line: 10, text: 'first' });
  assert.equal(list.length, 1);

  // Same file/side/line → edit in place, no duplicate.
  list = DA.upsert(list, { filePath: 'a.js', side: 'RIGHT', line: 10, text: 'edited' });
  assert.equal(list.length, 1);
  assert.equal(list[0].text, 'edited');

  // Different line → new entry.
  list = DA.upsert(list, { filePath: 'a.js', side: 'RIGHT', line: 11, text: 'second' });
  assert.equal(list.length, 2);
});

test('upsert distinguishes sides on the same line number', () => {
  let list = [];
  list = DA.upsert(list, { filePath: 'a.js', side: 'LEFT', line: 5, text: 'old side' });
  list = DA.upsert(list, { filePath: 'a.js', side: 'RIGHT', line: 5, text: 'new side' });
  assert.equal(list.length, 2);
});

test('upsert does not mutate the input array', () => {
  const original = [];
  const next = DA.upsert(original, { filePath: 'a.js', side: 'RIGHT', line: 1, text: 'x' });
  assert.equal(original.length, 0);
  assert.equal(next.length, 1);
});

test('removeById drops the matching annotation only', () => {
  let list = [];
  list = DA.upsert(list, { filePath: 'a.js', side: 'RIGHT', line: 1, text: 'x' });
  list = DA.upsert(list, { filePath: 'a.js', side: 'RIGHT', line: 2, text: 'y' });
  list = list.map((a) => ({ ...a, id: DA.keyFor(a) }));

  const target = DA.keyFor({ filePath: 'a.js', side: 'RIGHT', line: 1 });
  const after = DA.removeById(list, target);
  assert.equal(after.length, 1);
  assert.equal(after[0].text, 'y');
});

test('formatPrompt returns empty string for no annotations', () => {
  assert.equal(DA.formatPrompt([]), '');
  assert.equal(DA.formatPrompt(null), '');
});

test('formatPrompt groups comments by file in insertion order', () => {
  const list = [
    { filePath: 'a.js', side: 'RIGHT', line: 10, text: 'rename this' },
    { filePath: 'b.js', side: 'RIGHT', line: 3, text: 'extract a helper' },
    { filePath: 'a.js', side: 'LEFT', line: 4, text: 'why remove?' },
  ];
  const out = DA.formatPrompt(list);

  assert.match(out, /^Review feedback on the current diff:/);
  assert.match(out, /a\.js:/);
  assert.match(out, /- line 10: rename this/);
  assert.match(out, /- line 4: why remove\?/);
  assert.match(out, /b\.js:/);
  assert.match(out, /- line 3: extract a helper/);
  assert.match(out, /Please address this feedback\.$/);

  // Both a.js comments sit under a single a.js heading (grouped, not repeated).
  assert.equal(out.match(/a\.js:/g).length, 1);
  // a.js is emitted before b.js (insertion order).
  assert.ok(out.indexOf('a.js:') < out.indexOf('b.js:'));
});

test('formatPrompt labels a missing line number as general', () => {
  const out = DA.formatPrompt([{ filePath: 'a.js', side: 'RIGHT', line: null, text: 'overall note' }]);
  assert.match(out, /- general: overall note/);
});

test('formatPrompt trims whitespace around comment text', () => {
  const out = DA.formatPrompt([{ filePath: 'a.js', side: 'RIGHT', line: 1, text: '  spaced  ' }]);
  assert.match(out, /- line 1: spaced\n/);
});
