const test = require('node:test');
const assert = require('node:assert/strict');

// pr-review-findings.js and pr-review-implement.js are renderer IIFEs that hang
// their functions off the shared window.PrReview object. The pieces under test
// (snippet matching, comment-body composition) touch no DOM, so a stub object is
// enough to load them, the same trick finding-parser.test.js uses.
global.window = global.window || {};
global.window.PrReview = global.window.PrReview || {};
global.window.PrReview._FP = {
  sanitizeAiTone: (s) => s,
  parseReviewFindings: () => ({}),
  severityOf: () => 'low',
  cleanPath: (p) => p,
};
require('../../renderer/pr-review-findings');
require('../../renderer/pr-review-implement');
const PR = global.window.PrReview;

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

test('posted body is one line of why, then the change, unlabeled', () => {
  const body = PR.findingCommentBody(FINDING);
  assert.equal(
    body,
    'The retry loop eats the 429, so a rate-limited call comes back looking fine.'
      + '\n\n```suggestion\n    if (attempt === last) throw err;\n```',
  );
  // No label of our own, and the card's metadata line never posts.
  assert.doesNotMatch(body, /[Ss]uggested change/);
  assert.doesNotMatch(body, /High · Correctness/);
});

test('why is one sentence, on one line', () => {
  const wordy = { text: 'One. Two. Three.\n\nSuggested change:\nrename it' };
  assert.equal(PR.findingWhyText(wordy), 'One.');
  const wrapped = {
    text: 'It drops\nthe error\nsilently. And more.\n\nSuggested change:\nrethrow',
  };
  assert.equal(PR.findingWhyText(wrapped), 'It drops the error silently.');
});

test('a finding with why but no suggestion posts the why alone', () => {
  const noSuggestion = { text: 'This leaks a handle.\n\nSuggested change:\n' };
  assert.equal(PR.findingCommentBody(noSuggestion), 'This leaks a handle.');
});

test('a finding with no suggestion label posts its text unchanged', () => {
  const noLabel = { text: 'Rename `foo` to `bar`.' };
  assert.equal(PR.findingCommentBody(noLabel), 'Rename `foo` to `bar`.');
});

test('a suggestion with no prose above it posts just the suggestion', () => {
  const bare = { text: 'Suggested change:\n```suggestion\nx = 1;\n```' };
  assert.equal(PR.findingCommentBody(bare), '```suggestion\nx = 1;\n```');
});

test('a suggestion GitHub will not label keeps ours', () => {
  const prose = {
    text: 'Breaks on empty input.\n\nSuggested change:\nGuard the empty case before the loop.',
  };
  assert.equal(
    PR.findingCommentBody(prose),
    'Breaks on empty input.\n\nSuggested change:\nGuard the empty case before the loop.',
  );
  const fenced = { text: 'Wrong order.\n\nSuggested change:\n```\nb();\na();\n```' };
  assert.equal(
    PR.findingCommentBody(fenced),
    'Wrong order.\n\nSuggested change:\n```\nb();\na();\n```',
  );
});

test('an abbreviation does not cut the why short', () => {
  const abbrev = {
    text: 'Use e.g. the pooled client here. It leaks otherwise.\n\nSuggested change:\nswap it',
  };
  assert.equal(PR.findingWhyText(abbrev), 'Use e.g. the pooled client here.');
});
