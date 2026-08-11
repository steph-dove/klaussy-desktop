const test = require('node:test');
const assert = require('node:assert/strict');
// Test the built-in JS port directly: it's deterministic and present
// everywhere, whereas humanizeComment() prefers the klaussy CLI (absent in CI,
// its rules owned by klaussy-agents).
const { humanizeCommentJs: humanizeComment } = require('../../main/util/humanize-comment');

test('normalizes em and en dashes in prose', () => {
  assert.equal(humanizeComment('Leaks a connection — wrap it.'), 'Leaks a connection, wrap it.');
  assert.equal(humanizeComment('the fix – finally – landed'), 'the fix - finally - landed');
});

test('keeps numeric ranges tight', () => {
  // A dash between digits is a range, not a clause break: "35 - 50 min" reads as
  // a subtraction or a dropped clause.
  assert.equal(humanizeComment('parses take 35–50 min'), 'parses take 35-50 min');
  assert.equal(humanizeComment('pages 3—4 are wrong'), 'pages 3-4 are wrong');
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

test('swaps stiff phrasings for their short equivalent, keeping the capital', () => {
  assert.equal(humanizeComment('Prior to the retry, flush the buffer.'), 'Before the retry, flush the buffer.');
  assert.equal(humanizeComment('The client has the ability to refresh it.'), 'The client can refresh it.');
  assert.equal(humanizeComment('Due to the fact that it expires, we refresh.'), 'Because it expires, we refresh.');
  assert.equal(humanizeComment('The worker was able to recover.'), 'The worker could recover.');
});

test('drops empty "actual" and "actually"', () => {
  assert.equal(humanizeComment('This actually works.'), 'This works.');
  assert.equal(humanizeComment('It fails, actually.'), 'It fails.');
  assert.equal(humanizeComment('The actual value is wrong.'), 'The value is wrong.');
  // "the actual" as a noun keeps its word.
  assert.equal(
    humanizeComment('Compare the actual to the expected.'),
    'Compare the actual to the expected.',
  );
});

test('strips editorializing verdict openers', () => {
  assert.equal(humanizeComment('Personally, I would rethrow here.'), 'I would rethrow here.');
  assert.equal(humanizeComment('Honestly, this leaks.'), 'This leaks.');
  assert.equal(humanizeComment('IMO, the lock is too broad.'), 'The lock is too broad.');
});

test('passes non-strings through unchanged', () => {
  assert.equal(humanizeComment(undefined), undefined);
  assert.equal(humanizeComment(null), null);
  assert.equal(humanizeComment(''), '');
});
