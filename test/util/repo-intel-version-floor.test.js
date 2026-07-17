require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const { versionBelow, KLAUSSY_AGENTS_MIN_VERSION } = require('../../main/state/repo-intel');

// versionBelow gates the "out of date" prompt: parse a triple from whatever
// `klaussy --version` prints, compare per-component (not lexically), and stay
// silent on unparseable input so a weird version string never nags forever

test('versionBelow: strictly-older version is below the floor', () => {
  assert.equal(versionBelow('0.14.9', '0.15.0'), true);
  assert.equal(versionBelow('0.14.0', '0.15.0'), true);
  assert.equal(versionBelow('0.0.1', '0.15.0'), true);
});

test('versionBelow: equal or newer version is NOT below the floor', () => {
  assert.equal(versionBelow('0.15.0', '0.15.0'), false);
  assert.equal(versionBelow('0.15.1', '0.15.0'), false);
  assert.equal(versionBelow('1.0.0', '0.15.0'), false);
});

test('versionBelow: numeric (not lexical) component comparison', () => {
  // Numerically 0.9.0 < 0.15.0 (minor 9 < 15), so it IS below the floor — a
  // naive lexical compare would wrongly say "0.9.0" > "0.15.0" ('9' > '1').
  assert.equal(versionBelow('0.9.0', '0.15.0'), true);
  // ...and 0.15.0 is not below 0.9.0 for the same reason.
  assert.equal(versionBelow('0.15.0', '0.9.0'), false);
});

test('versionBelow: parses a version out of a decorated --version string', () => {
  assert.equal(versionBelow('klaussy, version 0.14.0', '0.15.0'), true);
  assert.equal(versionBelow('klaussy-agents 0.15.0', '0.15.0'), false);
});

test('versionBelow: unparseable input is never "below" (no false nag)', () => {
  assert.equal(versionBelow('', '0.15.0'), false);
  assert.equal(versionBelow(null, '0.15.0'), false);
  assert.equal(versionBelow('dev', '0.15.0'), false);
  assert.equal(versionBelow('0.15.0', 'not-a-version'), false);
});

test('KLAUSSY_AGENTS_MIN_VERSION is a parseable semver triple', () => {
  assert.match(KLAUSSY_AGENTS_MIN_VERSION, /^\d+\.\d+\.\d+$/);
});
