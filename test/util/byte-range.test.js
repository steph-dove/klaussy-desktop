const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRange } = require('../../main/util/byte-range');

const SIZE = 1000;

test('a normal range is inclusive on both ends', () => {
  assert.deepEqual(parseRange('bytes=100-199', SIZE), { start: 100, end: 199 });
});

test('an open-ended range runs to the last byte', () => {
  assert.deepEqual(parseRange('bytes=900-', SIZE), { start: 900, end: 999 });
});

test('a suffix range asks for the last n bytes, not an offset', () => {
  assert.deepEqual(parseRange('bytes=-50', SIZE), { start: 950, end: 999 });
});

test('a suffix larger than the file clamps to the whole file', () => {
  assert.deepEqual(parseRange('bytes=-5000', SIZE), { start: 0, end: 999 });
});

test('an end past the last byte is clamped', () => {
  assert.deepEqual(parseRange('bytes=900-99999', SIZE), { start: 900, end: 999 });
});

test('a start past the end of the file is rejected', () => {
  assert.equal(parseRange('bytes=5000-6000', SIZE), null);
});

test('malformed and missing headers are rejected rather than guessed', () => {
  for (const header of ['bytes=-', 'bytes=abc-def', 'items=0-10', 'bytes=10', '', null, undefined]) {
    assert.equal(parseRange(header, SIZE), null, `should reject: ${header}`);
  }
});

test('a zero-length or unknown file size is rejected', () => {
  assert.equal(parseRange('bytes=0-10', 0), null);
  assert.equal(parseRange('bytes=0-10', NaN), null);
});
