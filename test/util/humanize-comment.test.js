const test = require('node:test');
const assert = require('node:assert/strict');
// Test the built-in JS port directly: it's deterministic and present
// everywhere, whereas humanizeComment() prefers the klaussy CLI (absent in CI,
// its rules owned by klaussy-agents).
const { humanizeCommentJs: humanizeComment } = require('../../main/util/humanize-comment');

test('normalizes em and en dashes in prose', () => {
  assert.equal(humanizeComment('Leaks a connection — wrap it.'), 'Leaks a connection, wrap it.');
  assert.equal(humanizeComment('range 1–5 here'), 'range 1 - 5 here');
});

test('strips a leading filler opener and recapitalizes', () => {
  assert.equal(
    humanizeComment("It's worth noting that the handler swallows the error."),
    'The handler swallows the error.',
  );
});

test('drops trailing chatbot scaffolding', () => {
  assert.equal(
    humanizeComment('This races on startup.\nLet me know if you have questions!'),
    'This races on startup.',
  );
});

test('tightens verbose phrasings', () => {
  assert.equal(humanizeComment('Refactor in order to avoid the N+1.'), 'Refactor to avoid the N+1.');
  assert.equal(humanizeComment('This could potentially deadlock.'), 'This could deadlock.');
});

test('never touches code (fenced or inline)', () => {
  const input = 'Use `a — b` then:\n```\nx — y\n```\nbut this — changes.';
  const out = humanizeComment(input);
  assert.match(out, /`a — b`/);      // inline code dash preserved
  assert.match(out, /x — y/);         // fenced code dash preserved
  assert.match(out, /but this, changes\./); // prose dash normalized
});

test('leaves an already-clean human comment unchanged', () => {
  assert.equal(humanizeComment('Nit: rename foo to bar.'), 'Nit: rename foo to bar.');
});

test('passes non-strings through unchanged', () => {
  assert.equal(humanizeComment(undefined), undefined);
  assert.equal(humanizeComment(null), null);
  assert.equal(humanizeComment(''), '');
});
