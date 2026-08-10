require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { scan, stringsAt } = require('../../main/util/protobuf-scan');

// Hand-encoded so the expectations don't depend on any real file.
function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}
function field(num, payload) {
  return Buffer.concat([Buffer.from(varint((num << 3) | 2)), Buffer.from(varint(payload.length)), payload]);
}

test('a string is found at its dotted path', () => {
  const inner = field(1, Buffer.from('what the agent said', 'utf8'));
  const msg = field(20, inner);
  assert.deepEqual(stringsAt(msg, '20.1'), ['what the agent said']);
});

test('siblings at other paths are not returned', () => {
  const msg = field(20, Buffer.concat([
    field(1, Buffer.from('spoken aloud', 'utf8')),
    field(3, Buffer.from('private reasoning', 'utf8')),
  ]));
  assert.deepEqual(stringsAt(msg, '20.1'), ['spoken aloud']);
  assert.deepEqual(stringsAt(msg, '20.3'), ['private reasoning']);
});

// The schema is unpublished and can change; a wrong path must read as "cannot
// read this" rather than returning whatever bytes live at that offset.
test('an unknown path returns nothing rather than guessing', () => {
  const msg = field(20, field(1, Buffer.from('text', 'utf8')));
  assert.deepEqual(stringsAt(msg, '99.1'), []);
  assert.deepEqual(stringsAt(msg, '20.7'), []);
});

test('binary that is not text is skipped, not mangled', () => {
  const msg = field(20, field(1, Buffer.from([0xff, 0xfe, 0xfd, 0xfc])));
  assert.deepEqual(stringsAt(msg, '20.1'), []);
});

test('malformed input yields nothing instead of throwing', () => {
  assert.doesNotThrow(() => scan(Buffer.from([0xff, 0xff, 0xff, 0xff])));
  assert.doesNotThrow(() => scan(Buffer.alloc(0)));
  assert.deepEqual(stringsAt(Buffer.from([0x08]), '1'), []);
});

test('varint and fixed-width fields are stepped over correctly', () => {
  const msg = Buffer.concat([
    Buffer.from([(1 << 3) | 0, 0x96, 0x01]),           // varint field
    Buffer.from([(2 << 3) | 5, 1, 2, 3, 4]),           // fixed32
    field(20, field(1, Buffer.from('after the scalars', 'utf8'))),
  ]);
  assert.deepEqual(stringsAt(msg, '20.1'), ['after the scalars']);
});
