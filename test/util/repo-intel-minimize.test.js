require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ruleMatchesTouchedPaths,
  filterGraphSummary,
  assembleBlock,
} = require('../../main/state/repo-intel');
const { parseChangedFilesFromDiff } = require('../../main/state/agent-select');

// These cover Item 4 (Smart Context & Token Minimization): the prompt block
// must be scoped to the files actually being touched so we don't dump the
// whole repo's rules/graph into every agent prompt.

// ---- ruleMatchesTouchedPaths ----

test('ruleMatchesTouchedPaths: no touched paths means no filtering (include all)', () => {
  // Empty/undefined touchedPaths is the "I don't know what's touched" signal —
  // fall back to including every rule rather than silently dropping them.
  assert.equal(ruleMatchesTouchedPaths('backend.md', []), true);
  assert.equal(ruleMatchesTouchedPaths('backend.md', undefined), true);
});

test('ruleMatchesTouchedPaths: matches a directory segment', () => {
  assert.equal(ruleMatchesTouchedPaths('backend.md', ['backend/server.js']), true);
});

test('ruleMatchesTouchedPaths: matches a filename stem (path contains /<rule>)', () => {
  // rule "files" should match main/ipc/files.js via the "/files" substring.
  assert.equal(ruleMatchesTouchedPaths('files.md', ['main/ipc/files.js']), true);
});

test('ruleMatchesTouchedPaths: matches a root-level file by prefix', () => {
  assert.equal(ruleMatchesTouchedPaths('preload.md', ['preload.js']), true);
});

test('ruleMatchesTouchedPaths: returns false when nothing relates', () => {
  assert.equal(ruleMatchesTouchedPaths('backend.md', ['renderer/app.js']), false);
});

test('ruleMatchesTouchedPaths: is case-insensitive and normalizes backslashes', () => {
  assert.equal(ruleMatchesTouchedPaths('Backend.md', ['BACKEND\\Server.js']), true);
});

// ---- filterGraphSummary ----

const importGraphRule = (fanIn, fanOut, cycles) => ({
  id: 'repo.import_graph',
  description: 'Import graph overview',
  stats: {
    top_fan_in: fanIn,
    top_fan_out: fanOut,
    ...(cycles ? { cycle_count: cycles } : {}),
  },
});

test('filterGraphSummary: returns null for empty input', () => {
  assert.equal(filterGraphSummary([], ['a.js']), null);
  assert.equal(filterGraphSummary(null, ['a.js']), null);
});

test('filterGraphSummary: with no touched paths, includes all fan-in/out entries', () => {
  const rule = importGraphRule([['core/db.js', 12]], [['core/app.js', 9]], 0);
  const out = filterGraphSummary([rule], []);
  assert.match(out, /core\/db\.js \(12\)/);
  assert.match(out, /core\/app\.js \(9\)/);
});

test('filterGraphSummary: scopes fan-in to files related to touched paths', () => {
  const rule = importGraphRule(
    [['core/db.js', 12], ['core/cache.js', 7]],
    [],
    0,
  );
  // Only db.js is touched, so cache.js must be filtered out of the summary.
  const out = filterGraphSummary([rule], ['core/db.js']);
  assert.match(out, /core\/db\.js \(12\)/);
  assert.doesNotMatch(out, /cache\.js/);
});

test('filterGraphSummary: returns null when touched paths match nothing and no cycles', () => {
  const rule = importGraphRule([['core/db.js', 12]], [['core/app.js', 9]], 0);
  assert.equal(filterGraphSummary([rule], ['totally/unrelated.ts']), null);
});

test('filterGraphSummary: cycle warning is always surfaced even when fan lists are scoped out', () => {
  const rule = importGraphRule([['core/db.js', 12]], [], 3);
  const out = filterGraphSummary([rule], ['unrelated/file.js']);
  assert.match(out, /3 circular dependency chain\(s\)/);
});

test('filterGraphSummary: matches fan-in entries by path suffix in either direction', () => {
  // touchedPaths from `git diff` are repo-relative; graph files may be stored
  // with or without a leading segment — the matcher accepts suffix overlap.
  const rule = importGraphRule([['src/core/db.js', 5]], [], 0);
  const out = filterGraphSummary([rule], ['core/db.js']);
  assert.match(out, /src\/core\/db\.js \(5\)/);
});

// ---- assembleBlock ----

test('assembleBlock: empty intel produces an empty string (no block)', () => {
  assert.equal(assembleBlock({ claudeMd: '', rules: [], graphRules: [] }, []), '');
});

test('assembleBlock: includes CLAUDE.md conventions when present', () => {
  const out = assembleBlock({ claudeMd: 'Use tabs.', rules: [], graphRules: [] }, []);
  assert.match(out, /## Repository intelligence/);
  assert.match(out, /Repository conventions \(CLAUDE\.md\)/);
  assert.match(out, /Use tabs\./);
});

test('assembleBlock: drops rules that do not match touched paths', () => {
  const intel = {
    claudeMd: '',
    rules: [
      { file: 'backend.md', content: 'Backend rule body.' },
      { file: 'frontend.md', content: 'Frontend rule body.' },
    ],
    graphRules: [],
  };
  const out = assembleBlock(intel, ['renderer/frontend/widget.js']);
  assert.match(out, /Frontend rule body\./);
  assert.doesNotMatch(out, /Backend rule body\./);
});

test('assembleBlock: includes all rules when touched paths are unknown', () => {
  const intel = {
    claudeMd: '',
    rules: [
      { file: 'backend.md', content: 'Backend rule body.' },
      { file: 'frontend.md', content: 'Frontend rule body.' },
    ],
    graphRules: [],
  };
  const out = assembleBlock(intel, []);
  assert.match(out, /Backend rule body\./);
  assert.match(out, /Frontend rule body\./);
});

// ---- parseChangedFilesFromDiff (agent-select) ----

test('parseChangedFilesFromDiff: extracts file paths from a unified diff', () => {
  const diff = [
    'diff --git a/main/ipc/files.js b/main/ipc/files.js',
    'index 1e675d6..571dd34 100644',
    '--- a/main/ipc/files.js',
    '+++ b/main/ipc/files.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/renderer/app.js b/renderer/app.js',
    '--- a/renderer/app.js',
    '+++ b/renderer/app.js',
  ].join('\n');
  assert.deepEqual(parseChangedFilesFromDiff(diff), ['main/ipc/files.js', 'renderer/app.js']);
});

test('parseChangedFilesFromDiff: returns an empty array for empty/falsy input', () => {
  assert.deepEqual(parseChangedFilesFromDiff(''), []);
  assert.deepEqual(parseChangedFilesFromDiff(null), []);
});

test('parseChangedFilesFromDiff: de-duplicates repeated file headers', () => {
  const diff = [
    'diff --git a/x.js b/x.js',
    'diff --git a/x.js b/x.js',
  ].join('\n');
  assert.deepEqual(parseChangedFilesFromDiff(diff), ['x.js']);
});
