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

test('strips overused AI emojis from prose', () => {
  assert.equal(humanizeComment('Add user authentication 🚀'), 'Add user authentication');
  assert.equal(humanizeComment('✨ Refactor database helpers ✨'), 'Refactor database helpers');
});

test('strips transition words at start of line/text', () => {
  assert.equal(humanizeComment('Furthermore, the handler has a bug.'), 'The handler has a bug.');
  assert.equal(humanizeComment('Moreover, we should clean up.'), 'We should clean up.');
});

test('strips filler praise leads and standalone praise lines', () => {
  assert.equal(humanizeComment('Great catch, this races on startup.'), 'This races on startup.');
  assert.equal(humanizeComment('Nice find. This leaks the handle.'), 'This leaks the handle.');
  assert.equal(humanizeComment('Good point, reverted in 1e9e938.'), 'Reverted in 1e9e938.');
  assert.equal(humanizeComment('Excellent point: the lock is wrong.'), 'The lock is wrong.');
  assert.equal(humanizeComment('Good call, dropped the field.'), 'Dropped the field.');
  assert.equal(humanizeComment('Well spotted, fixed now.'), 'Fixed now.');
  assert.equal(humanizeComment('Nice one. Pushed the fix.'), 'Pushed the fix.');
  assert.equal(humanizeComment('Great catch.'), '');
  assert.equal(humanizeComment('Great catch!\nThe retry is now bounded.'), 'The retry is now bounded.');
});

test('leaves non-lead praise and free-form ranking praise alone', () => {
  assert.equal(humanizeComment('Good point about the retry logic here.'), 'Good point about the retry logic here.');
  assert.equal(humanizeComment('Great work on the refactor.'), 'Great work on the refactor.');
  assert.equal(humanizeComment('You make a good point, but I disagree.'), 'You make a good point, but I disagree.');
  assert.equal(humanizeComment('This is the sharpest catch in the review.'), 'This is the sharpest catch in the review.');
});

test('strips bot thanking at start of line/text or when standalone', () => {
  assert.equal(humanizeComment('Thanks @dependabot! We should merge this.'), 'We should merge this.');
  assert.equal(humanizeComment('Thank you for the review, @codecov-bot!'), '');
  assert.equal(humanizeComment('Thanks, bot.'), '');
});

test('strips apologetic throat-clearing at start of line/text or when standalone', () => {
  assert.equal(humanizeComment('Sorry about that! The handler is correct.'), 'The handler is correct.');
  assert.equal(humanizeComment('Apologies for the confusion. We should use foo.'), 'We should use foo.');
  assert.equal(humanizeComment('My apologies.'), '');
});

test('replaces leverage and utilize with use', () => {
  assert.equal(humanizeComment('We should utilize the new function.'), 'We should use the new function.');
  assert.equal(humanizeComment('This will leverage caches.'), 'This will use caches.');
});

test('passes non-strings through unchanged', () => {
  assert.equal(humanizeComment(undefined), undefined);
  assert.equal(humanizeComment(null), null);
  assert.equal(humanizeComment(''), '');
});
