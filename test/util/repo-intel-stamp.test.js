require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const { stampFor, listPkgVersion } = require('../../main/state/repo-intel');

// The stamp decides whether ensureRepoIntel regenerates a repo's intel, so a
// bump in either CLI has to change it — a conventions-only bump used to be
// invisible until the weekly staleness window expired.

test('a conventions bump alone changes the stamp', () => {
  const before = stampFor('0.27.0', '1.6.0');
  const after = stampFor('0.27.0', '1.7.0');
  assert.notEqual(after, before, 'new detectors reach the repo on the next session');
});

test('a klaussy bump alone still changes the stamp', () => {
  assert.notEqual(stampFor('0.28.0', '1.7.0'), stampFor('0.27.0', '1.7.0'));
});

test('an unchanged pair keeps the stamp stable', () => {
  assert.equal(stampFor('0.27.0', '1.7.0'), stampFor('0.27.0', '1.7.0'),
    'a stable stamp is what makes the cache hit');
});

test('no klaussy version stamps empty, which callers read as "no completed run"', () => {
  assert.equal(stampFor('', '1.7.0'), '');
  assert.equal(stampFor(null, '1.7.0'), '');
});

test('an unknown conventions version degrades to the klaussy-only stamp', () => {
  // Neither manager lists a pip --user install, and falling back to the old
  // stamp keeps those machines from regenerating forever.
  assert.equal(stampFor('0.27.0', ''), '0.27.0');
});

test('the stamp survives the cache-comment round trip', () => {
  // readDiskCache parses the stamp back with `cli:([^>]*)`, so one containing
  // '>' would not survive; real stamps carry a space ("klaussy 0.27.0").
  const stamp = stampFor('klaussy 0.27.0', '1.7.0');
  const line = '<!-- src-mtime:123 cli:' + stamp + ' -->\nblock';
  const m = line.match(/^<!-- src-mtime:([\d.]+)(?: cli:([^>]*))? -->\n/);
  assert.ok(m, 'the comment still parses');
  assert.equal((m[2] || '').trim(), stamp);
});

test('an old klaussy-only stamp no longer matches, so upgraded repos regenerate once', () => {
  // What every existing cache file on disk holds today.
  assert.notEqual(stampFor('klaussy 0.27.0', '1.7.0'), 'klaussy 0.27.0');
});

test('listPkgVersion reads the version out of both managers\' listings', () => {
  assert.equal(listPkgVersion('klaussy-repo-conventions 1.7.0', 'klaussy-repo-conventions'), '1.7.0');
  // uv prefixes a 'v'; the stamp must not treat "v1.7.0" and "1.7.0" as a bump.
  assert.equal(listPkgVersion('klaussy-repo-conventions v1.7.0', 'klaussy-repo-conventions'), '1.7.0');
});

test('listPkgVersion matches the whole package name, not a prefix', () => {
  const listing = 'klaussy-agents 0.27.0\nklaussy-repo-conventions 1.7.0';
  assert.equal(listPkgVersion(listing, 'klaussy-repo-conventions'), '1.7.0');
  assert.equal(listPkgVersion(listing, 'klaussy'), '', 'a prefix is not a match');
});

test('listPkgVersion yields nothing when the package is absent or unversioned', () => {
  assert.equal(listPkgVersion('klaussy-agents 0.27.0', 'klaussy-repo-conventions'), '');
  assert.equal(listPkgVersion('', 'klaussy-repo-conventions'), '');
  assert.equal(listPkgVersion(null, 'klaussy-repo-conventions'), '');
  assert.equal(listPkgVersion('klaussy-repo-conventions', 'klaussy-repo-conventions'), '');
});
