require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const pathGate = require('../../main/util/path-gate');
const { pathUnder, pathUnderAnyRoot, setDeps } = pathGate;

// Build a small on-disk fixture: /tmpdir/root/subdir/file.txt with a
// symlink out-of-root so we can exercise the symlink-escape guard.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgate-root-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgate-outside-'));
fs.mkdirSync(path.join(root, 'subdir'));
fs.writeFileSync(path.join(root, 'subdir', 'file.txt'), 'content');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
// A symlink inside the root that points outside. pathUnder must refuse it.
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape-link'));

test('pathUnder accepts a file inside the root', () => {
  const safe = pathUnder(root, 'subdir/file.txt');
  assert.ok(safe);
  assert.equal(safe, fs.realpathSync(path.join(root, 'subdir', 'file.txt')));
});

test('pathUnder refuses `..` traversal', () => {
  // Even though /tmp/pathgate-outside-xyz exists, ../.. escapes the root.
  assert.equal(pathUnder(root, '../secret.txt'), null);
});

test('pathUnder refuses symlinks that point outside the root', () => {
  // escape-link IS inside root lexically but realpath() resolves through
  // the symlink to outside — refused. The whole point of pathUnder.
  assert.equal(pathUnder(root, 'escape-link'), null);
});

test('pathUnder accepts an absolute path if it resolves inside', () => {
  const abs = path.join(root, 'subdir', 'file.txt');
  assert.equal(pathUnder(root, abs), fs.realpathSync(abs));
});

test('pathUnder handles nonexistent targets via parent realpath', () => {
  // Write paths often don't exist yet. pathUnder falls back to realpath'ing
  // the parent dir then rejoining the basename — a write to a new file
  // inside root should be accepted.
  const newFile = path.join(root, 'subdir', 'new-file.txt');
  assert.notEqual(fs.existsSync(newFile), true);
  const safe = pathUnder(root, newFile);
  assert.ok(safe);
  assert.match(safe, /new-file\.txt$/);
});

test('pathUnder rejects non-string inputs', () => {
  assert.equal(pathUnder(root, null), null);
  assert.equal(pathUnder(null, 'foo'), null);
  assert.equal(pathUnder(root, undefined), null);
  assert.equal(pathUnder(root, 42), null);
});

test('pathUnder refuses when root itself does not exist', () => {
  // realpath throws on a missing root; pathUnder's outer try returns null.
  assert.equal(pathUnder('/tmp/definitely-does-not-exist-klaussy', 'x'), null);
});

test('pathUnderAnyRoot accepts under any injected root', () => {
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgate-other-'));
  fs.writeFileSync(path.join(otherRoot, 'f.txt'), 'x');
  setDeps({
    loadConfig: () => ({ projects: [{ path: root }, { path: otherRoot }] }),
    getInstances: () => new Map(),
  });
  assert.ok(pathUnderAnyRoot(path.join(otherRoot, 'f.txt')));
  assert.ok(pathUnderAnyRoot(path.join(root, 'subdir', 'file.txt')));
});

test('pathUnderAnyRoot refuses a path outside every root', () => {
  setDeps({
    loadConfig: () => ({ projects: [{ path: root }] }),
    getInstances: () => new Map(),
  });
  assert.equal(pathUnderAnyRoot(path.join(outside, 'secret.txt')), null);
});
