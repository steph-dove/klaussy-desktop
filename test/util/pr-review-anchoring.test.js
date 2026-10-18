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

const details = (text) => '<details>\n<summary></summary>\n\n' + text + '\n\n</details>';

// Same shape the klaussy-review bot posts (klaussy/review_post.py Finding.comment).
test('a code suggestion posts under the why, the explanation collapsed', () => {
  const body = PR.findingCommentBody(FINDING);
  assert.equal(
    body,
    'The retry loop eats the 429, so a rate-limited call comes back looking fine.'
      + '\n\n```suggestion\n    if (attempt === last) throw err;\n```'
      + '\n\n' + details('The retry loop eats the 429, so a rate-limited call comes back looking fine.\nIt only shows up under load.'),
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

test('a finding with why but no suggestion posts the why and its explanation', () => {
  const noSuggestion = { text: 'This leaks a handle.\n\nSuggested change:\n' };
  assert.equal(PR.findingCommentBody(noSuggestion), 'This leaks a handle.\n\n' + details('This leaks a handle.'));
});

test('a finding with no suggestion label leads with its first sentence', () => {
  const noLabel = { text: 'Rename `foo` to `bar`. It reads better.' };
  assert.equal(PR.findingCommentBody(noLabel), 'Rename `foo` to `bar`.\n\n' + details('Rename `foo` to `bar`. It reads better.'));
});

test('the collapsed explanation keeps quoted code, as the bot does', () => {
  const quoted = {
    verifiedSnippet: { path: 'a.js', startLine: 1, endLine: 1, text: 'x()' },
    text: 'It throws.\n\n```js\nx()\n```\n\nSuggested change:\nGuard it.',
  };
  assert.equal(PR.findingCommentBody(quoted), 'Guard it.\n\n' + details('Guard it.\n\nIt throws.\n\n```js\nx()\n```'));
});

test('a suggestion with no prose above it posts just the suggestion', () => {
  const bare = { text: 'Suggested change:\n```suggestion\nx = 1;\n```' };
  assert.equal(PR.findingCommentBody(bare), '```suggestion\nx = 1;\n```');
});

test('a prose suggestion is the one visible sentence; the why moves into the dropdown', () => {
  const prose = {
    text: 'Breaks on empty input.\n\nSuggested change:\nGuard the empty case before the loop.',
  };
  assert.equal(
    PR.findingCommentBody(prose),
    'Guard the empty case before the loop.\n\n' + details('Guard the empty case before the loop.\n\nBreaks on empty input.'),
  );
});

test('prose and code in one suggestion: the prose leads, the code stays applyable', () => {
  const both = { text: 'It races.\n\nSuggested change:\nTake the lock first. Then write.\n\n```suggestion\nlock();\n```' };
  assert.equal(
    PR.findingCommentBody(both),
    'Take the lock first.\n\n```suggestion\nlock();\n```\n\n' + details('Take the lock first. Then write.\n\nIt races.'),
  );
});

test('legacy headers stay out of the lead and the dropdown', () => {
  const legacy = {
    text: '**[Severity: High]**\n**[Location: a.js:3]**\n**Comment:** It drops the error. Only on retry.\n\nSuggested change:\nRethrow it.',
  };
  assert.equal(PR.findingCommentBody(legacy), 'Rethrow it.\n\n' + details('Rethrow it.\n\nIt drops the error. Only on retry.'));
  assert.equal(PR.findingReportText(legacy), 'Rethrow it.\n\nIt drops the error. Only on retry.');
});

test('an abbreviation does not cut the why short', () => {
  const abbrev = {
    text: 'Use e.g. the pooled client here. It leaks otherwise.\n\nSuggested change:\nswap it',
  };
  assert.equal(PR.findingWhyText(abbrev), 'Use e.g. the pooled client here.');
});

// --- finding explanation (longer output) --------------------------------------

test('explanation preserves the full prose above the suggestion', () => {
  const explanation = PR.findingExplanationText(FINDING);
  assert.equal(
    explanation,
    'The retry loop eats the 429, so a rate-limited call comes back looking fine.\nIt only shows up under load.',
  );
  assert.doesNotMatch(explanation, /High · Correctness/);
  assert.doesNotMatch(explanation, /[Ss]uggested change/);
});

test('explanation preserves multi-line and markdown details', () => {
  const multi = {
    text: [
      '**Medium · Performance · `src/cache.js:15`**',
      '',
      'Cache keys are computed synchronously.',
      '- Blocks event loop for 15ms.',
      '- Degrades throughput under load.',
      '',
      'Suggested change:',
      '```js',
      'const key = fastHash(id);',
      '```',
    ].join('\n'),
  };
  assert.equal(
    PR.findingExplanationText(multi),
    'Cache keys are computed synchronously.\n- Blocks event loop for 15ms.\n- Degrades throughput under load.',
  );
});

test('explanation strips bracketed metadata and Comment: headers', () => {
  const bracketed = {
    text: [
      '[Severity: High]',
      '[Location: api.js:88]',
      '[Category: Security]',
      'Comment: Token expiration check is insecure.',
      'An attacker can forge tokens.',
      '',
      'Suggested change:',
      'fix',
    ].join('\n'),
  };
  assert.equal(
    PR.findingExplanationText(bracketed),
    'Token expiration check is insecure.\nAn attacker can forge tokens.',
  );
});

test('explanation returns full body when no suggestion label is present', () => {
  const noSuggestion = {
    text: [
      '**High · Correctness · `src/db.js:10`**',
      '',
      'The connection pool is never closed on shutdown.',
      'This causes socket leaks.',
    ].join('\n'),
  };
  assert.equal(
    PR.findingExplanationText(noSuggestion),
    'The connection pool is never closed on shutdown.\nThis causes socket leaks.',
  );
});

