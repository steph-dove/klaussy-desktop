const test = require('node:test');
const assert = require('node:assert/strict');

const { isEmptyReview, ghApiErrorMessage } = require('../../main/util/review-payload');

// The reported failure: every draft fell through to an issue comment and the
// summary was blank, so the 422 on the empty review dropped all three.
test('a COMMENT review with no comments and no body is empty', () => {
  assert.equal(isEmptyReview({ event: 'COMMENT', comments: [], body: '' }), true);
  assert.equal(isEmptyReview({ event: 'COMMENT', comments: [], body: '   \n' }), true);
  assert.equal(isEmptyReview({ event: 'COMMENT', comments: undefined, body: null }), true);
});

test('a COMMENT review with either half is not empty', () => {
  assert.equal(isEmptyReview({ event: 'COMMENT', comments: [{ path: 'a' }], body: '' }), false);
  assert.equal(isEmptyReview({ event: 'COMMENT', comments: [], body: 'looks good' }), false);
});

test('approve and request-changes are never treated as empty', () => {
  // An approval with an empty body is a perfectly good review; skipping it
  // would silently swallow the approval.
  assert.equal(isEmptyReview({ event: 'APPROVE', comments: [], body: '' }), false);
  assert.equal(isEmptyReview({ event: 'REQUEST_CHANGES', comments: [], body: '' }), false);
});

test('an all-empty errors array is not appended to the message', () => {
  const stdout = JSON.stringify({ message: 'Unprocessable Entity', errors: [''], status: '422' });
  assert.equal(ghApiErrorMessage(stdout, 'gh: Unprocessable Entity (HTTP 422)'), 'Unprocessable Entity');
});

test('errors with real content are still surfaced', () => {
  const stdout = JSON.stringify({
    message: 'Validation Failed',
    errors: [{ resource: 'PullRequestReviewComment', field: 'line' }],
  });
  const msg = ghApiErrorMessage(stdout, '');
  assert.match(msg, /^Validation Failed: /);
  assert.match(msg, /PullRequestReviewComment/);
});

test('falls back to stderr when stdout is absent or unparseable', () => {
  assert.equal(ghApiErrorMessage('', 'gh: HTTP 500'), 'gh: HTTP 500');
  assert.equal(ghApiErrorMessage('not json', 'gh: HTTP 500'), 'gh: HTTP 500');
  assert.equal(ghApiErrorMessage('{"no":"message"}', 'gh: HTTP 500'), 'gh: HTTP 500');
});
