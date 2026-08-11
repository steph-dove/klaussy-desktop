const test = require('node:test');
const assert = require('node:assert/strict');

// pr-review-findings.js and pr-review-implement.js are renderer IIFEs that hang
// their functions off the shared window.PrReview object. The pieces under test
// (snippet matching, comment-body composition) touch no DOM, so a stub object is
// enough to load them, the same trick finding-parser.test.js uses.
global.window = global.window || {};
window.PrReview = window.PrReview || {};
window.PrReview._FP = {
  sanitizeAiTone: (s) => s,
  parseReviewFindings: () => ({}),
  severityOf: () => 'low',
  cleanPath: (p) => p,
};
require('../../renderer/pr-review-findings');
require('../../renderer/pr-review-implement');
const PR = window.PrReview;

const FILE = [
  'function retry(attempts) {',        // 1
  '  for (let i = 0; i < attempts; i++) {', // 2
  '    try {',                         // 3
  '      return send();',              // 4
  '    } catch (err) {',               // 5
  '      log(err);',                   // 6
  '    }',                             // 7
  '  }',                               // 8
  '}',                                 // 9
].join('\n');

test('snippet match prefers a line the caller accepts as an anchor', () => {
  // Both line 3 ("try {") and line 7 ("}") are plausible matches for a code
  // block; only line 6 is in the diff. Without a preference the matcher takes
  // the closest, which here is the wrong, unanchorable one.
  const inDiff = (ln) => ln === 6;
  const m = PR.findSnippetLineAcrossCandidates(FILE, 5, ['log(err);', '} catch (err) {'], inDiff);
  assert.equal(m.line, 6);
  assert.equal(m.preferred, true);
});

test('falls back to the closest match when nothing is acceptable', () => {
  const m = PR.findSnippetLineAcrossCandidates(FILE, 5, ['log(err);'], () => false);
  assert.equal(m.line, 6);
  assert.equal(m.preferred, false);
});

test('no preference function keeps the closest-match behaviour', () => {
  const m = PR.findSnippetLineAcrossCandidates(FILE, 4, ['return send();']);
  assert.equal(m.line, 4);
});

// --- posted comment body -----------------------------------------------------

const FINDING = {
  text: [
    '**High · Correctness · `src/api.js:88`**',
    '',
    'The retry loop eats the 429, so a rate-limited call comes back looking fine.',
    'It only shows up under load.',
    '',
    'Suggested change:',
    '```suggestion',
    '    if (attempt === last) throw err;',
    '```',
  ].join('\n'),
};

test('posted body leads with the why, then the suggested change', () => {
  const body = PR.findingCommentBody(FINDING);
  assert.match(body, /^The retry loop eats the 429/);
  assert.ok(body.indexOf('Suggested change:') > 0, 'suggestion follows the why');
  assert.ok(body.indexOf('```suggestion') > body.indexOf('Suggested change:'));
  // The metadata line renders from its own fields; it must not be repeated.
  assert.doesNotMatch(body, /High · Correctness/);
});

test('why is capped at two sentences', () => {
  const wordy = {
    text: 'One. Two. Three. Four.\n\nSuggested change:\nrename it',
  };
  assert.equal(PR.findingWhyText(wordy), 'One. Two.');
});

test('a finding with no suggestion label posts its text unchanged', () => {
  const noLabel = { text: 'Rename `foo` to `bar`.' };
  assert.equal(PR.findingCommentBody(noLabel), 'Rename `foo` to `bar`.');
});

test('a suggestion with no prose above it posts just the suggestion', () => {
  const bare = { text: 'Suggested change:\n```suggestion\nx = 1;\n```' };
  assert.equal(PR.findingCommentBody(bare), '```suggestion\nx = 1;\n```');
});
