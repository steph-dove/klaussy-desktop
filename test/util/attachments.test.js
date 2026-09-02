require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { safeAttachmentName, saveAttachment, MAX_ATTACHMENT_BYTES } = require('../../main/util/attachments');

test('a name with separators is reduced to its basename', () => {
  assert.equal(safeAttachmentName('shot.png'), 'shot.png');
  assert.equal(safeAttachmentName('folder/shot.png'), 'shot.png');
  assert.equal(safeAttachmentName('C:\\Users\\me\\shot.png'), 'shot.png');
});

test('traversal in the name cannot walk out of the drop directory', () => {
  // The name is joined onto a temp dir, so a surviving `..` would escape it.
  for (const hostile of ['../../etc/passwd', '../../../.ssh/id_rsa', '..']) {
    const safe = safeAttachmentName(hostile);
    assert.ok(!safe.includes('..'), `"${hostile}" -> "${safe}" still has ..`);
    assert.ok(!safe.includes('/') && !safe.includes('\\'), `"${safe}" still has a separator`);
  }
});

test('an unusable name falls back rather than producing an empty path', () => {
  assert.equal(safeAttachmentName(''), 'pasted-image.png');
  assert.equal(safeAttachmentName(null), 'pasted-image.png');
  assert.equal(safeAttachmentName('   '), 'pasted-image.png');
  assert.equal(safeAttachmentName('...'), 'pasted-image.png');
});

test('control characters are stripped so the path stays quotable', () => {
  assert.equal(safeAttachmentName('sh\u0000ot\u001b.png'), 'shot.png');
});

test('an absurd name is truncated but keeps its extension', () => {
  const long = 'a'.repeat(400) + '.png';
  const safe = safeAttachmentName(long);
  assert.ok(safe.length <= 120);
  assert.ok(safe.endsWith('.png'));
});

test('bytes are written and the returned path reads back identical', () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const res = saveAttachment(bytes, 'screenshot.png');
  assert.equal(res.ok, true);
  assert.equal(path.basename(res.path), 'screenshot.png');
  assert.deepEqual(fs.readFileSync(res.path), bytes);
});

test('two attachments sharing a name both survive', () => {
  const a = saveAttachment(Buffer.from('first'), 'Screenshot.png');
  const b = saveAttachment(Buffer.from('second'), 'Screenshot.png');
  assert.notEqual(a.path, b.path);
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'first');
  assert.equal(fs.readFileSync(b.path, 'utf8'), 'second');
});

test('an empty drop is refused instead of writing a zero-byte file', () => {
  assert.ok(saveAttachment(Buffer.alloc(0), 'shot.png').error);
  assert.ok(saveAttachment(null, 'shot.png').error);
});

test('an oversized attachment is refused', () => {
  const res = saveAttachment(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), 'huge.png');
  assert.ok(res.error);
  assert.match(res.error, /larger than/);
});

test('a plain array of bytes is accepted, not just a Buffer', () => {
  // IPC hands main a Uint8Array, which is what the renderer serializes to.
  const res = saveAttachment(new Uint8Array([1, 2, 3]), 'shot.png');
  assert.equal(res.ok, true);
  assert.deepEqual(fs.readFileSync(res.path), Buffer.from([1, 2, 3]));
});
