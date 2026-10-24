// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findBestMatch, prefixMatches, SCAN_RADIUS } = require('../../renderer/word-complete.js');

function model(lines) {
  return {
    getLineCount: () => lines.length,
    getLineContent: (n) => lines[n - 1],
  };
}
const at = (lineNumber) => ({ lineNumber, column: 1 });

test('most frequent match wins', () => {
  const m = model(['foobar foobaz foobaz', 'fo']);
  assert.equal(findBestMatch(m, 'fo', at(2)), 'foobaz');
});

test('distance breaks a frequency tie: nearer word wins', () => {
  const m = model(['alpha', '', '', '', 'alpine', 'al']);
  assert.equal(findBestMatch(m, 'al', at(6)), 'alpine');
  const m2 = model(['alpine', '', '', '', 'alpha', 'al']);
  assert.equal(findBestMatch(m2, 'al', at(6)), 'alpha');
});

test('matching is case-sensitive', () => {
  const m = model(['MyClass', 'my']);
  assert.equal(findBestMatch(m, 'my', at(2)), null);
  assert.equal(prefixMatches('MyClass', 'my'), false);
  assert.equal(prefixMatches('myClass', 'my'), true);
});

test('a word equal to or no longer than the prefix is never offered', () => {
  const m = model(['foo fo f', 'foo']);
  assert.equal(findBestMatch(m, 'foo', at(2)), null);
  // A longer word sharing the prefix is still offered next to the exact match.
  const m2 = model(['foo foo foo foobar', 'foo']);
  assert.equal(findBestMatch(m2, 'foo', at(2)), 'foobar');
});

test('no match returns null', () => {
  const m = model(['hello world', 'zz']);
  assert.equal(findBestMatch(m, 'zz', at(2)), null);
});

test('only lines within SCAN_RADIUS of the cursor count', () => {
  // Repeat the word so its frequency outweighs the distance penalty and
  // only the radius decides whether it is seen.
  const heavy = (w) => new Array(300).fill(w).join(' ');
  const cursor = SCAN_RADIUS + 5;
  const build = (wordLine, prefix) => {
    const lines = new Array(SCAN_RADIUS * 2 + 10).fill('');
    lines[wordLine - 1] = heavy('inword');
    lines[cursor - 1] = prefix;
    return model(lines);
  };
  assert.equal(findBestMatch(build(cursor - SCAN_RADIUS - 1, 'in'), 'in', at(cursor)), null);
  assert.equal(findBestMatch(build(cursor - SCAN_RADIUS, 'in'), 'in', at(cursor)), 'inword');
  assert.equal(findBestMatch(build(cursor + SCAN_RADIUS, 'in'), 'in', at(cursor)), 'inword');
  assert.equal(findBestMatch(build(cursor + SCAN_RADIUS + 1, 'in'), 'in', at(cursor)), null);
});
