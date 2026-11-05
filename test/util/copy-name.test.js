const test = require('node:test');
const assert = require('node:assert/strict');
const { nextCopyName } = require('../../main/util/copy-name');

const taken = (...names) => (n) => names.includes(n);

test('first copy is "name copy.ext"', () => {
  assert.equal(nextCopyName('notes.md', taken()), 'notes copy.md');
});

test('collisions count up from 2', () => {
  assert.equal(nextCopyName('notes.md', taken('notes copy.md')), 'notes copy 2.md');
  assert.equal(nextCopyName('notes.md', taken('notes copy.md', 'notes copy 2.md')), 'notes copy 3.md');
});

test('dotfiles have no extension', () => {
  assert.equal(nextCopyName('.env', taken()), '.env copy');
});

test('extensionless files', () => {
  assert.equal(nextCopyName('Makefile', taken('Makefile copy')), 'Makefile copy 2');
});

test('only the last extension is split off', () => {
  assert.equal(nextCopyName('a.test.js', taken()), 'a.test copy.js');
});

test('dotfile with an extension and a taken dotfile copy', () => {
  assert.equal(nextCopyName('.config.json', taken()), '.config copy.json');
  assert.equal(nextCopyName('.env', taken('.env copy')), '.env copy 2');
});
