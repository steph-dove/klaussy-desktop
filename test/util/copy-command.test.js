const test = require('node:test');
const assert = require('node:assert/strict');
const { copyCommand } = require('../../renderer/copy-command');

test('returns true and writes the command when the write resolves', async () => {
  const written = [];
  const ok = await copyCommand('glab auth login', { writeText: async (t) => { written.push(t); } });
  assert.equal(ok, true);
  assert.deepEqual(written, ['glab auth login']);
});

test('returns false when writeText rejects', async () => {
  const ok = await copyCommand('glab auth login', { writeText: async () => { throw new Error('denied'); } });
  assert.equal(ok, false);
});

test('returns false when writeText throws synchronously', async () => {
  const ok = await copyCommand('x', { writeText: () => { throw new Error('nope'); } });
  assert.equal(ok, false);
});

test('returns false when there is no clipboard', async () => {
  assert.equal(await copyCommand('x', null), false);
  assert.equal(await copyCommand('x', {}), false);
});
