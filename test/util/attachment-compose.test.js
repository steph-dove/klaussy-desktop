require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

// A browser IIFE; the composer is pure, so it needs no DOM.
global.window = {};

require('../../renderer/attachment-input');
const { composeSubmission } = global.window.AttachmentInput;

const SHOT = '/Users/me/Desktop/shot.png';

// Regression: text and attachments must both survive, never either/or.
test('a typed task and a dropped image both reach the agent', () => {
  const out = composeSubmission('Fix the header alignment', [SHOT]);
  assert.match(out, /Fix the header alignment/);
  assert.match(out, /shot\.png/);
});

test('the task text comes first so the agent reads the ask before the files', () => {
  const out = composeSubmission('Fix the header alignment', [SHOT]);
  assert.ok(out.indexOf('Fix the header') < out.indexOf('shot.png'));
});

test('text with no attachments is passed through untouched', () => {
  assert.equal(composeSubmission('Fix the header alignment', []), 'Fix the header alignment');
  assert.equal(composeSubmission('Fix the header alignment', null), 'Fix the header alignment');
});

test('attachments with no text still carry a lead-in telling the agent to read them', () => {
  const out = composeSubmission('', [SHOT]);
  assert.match(out, /read them/);
  assert.match(out, /shot\.png/);
});

test('an empty modal produces nothing, so submit can refuse it', () => {
  assert.equal(composeSubmission('', []), '');
  assert.equal(composeSubmission('   \n  ', []), '');
});

test('every attachment is listed, not just the first', () => {
  const out = composeSubmission('see these', ['/a/one.png', '/a/two.png', '/a/three.png']);
  for (const name of ['one.png', 'two.png', 'three.png']) assert.match(out, new RegExp(name));
});

test('a path with spaces is quoted so it survives reaching a shell', () => {
  const out = composeSubmission('look', ['/Users/me/Desktop/Screen Shot.png']);
  assert.match(out, /"\/Users\/me\/Desktop\/Screen Shot\.png"/);
});

test('a path without spaces is left unquoted', () => {
  assert.match(composeSubmission('look', [SHOT]), /(^|\n)\/Users\/me\/Desktop\/shot\.png$/m);
});

test('each attachment goes on its own line', () => {
  const out = composeSubmission('', ['/a/one.png', '/a/two.png']);
  assert.match(out, /one\.png\n\/a\/two\.png/);
});

// Dropping at the cursor is the whole point: "this is the bug, this is the
// goal". A path the user placed inline must not be repeated at the end.
test('a path already sitting in the text is not listed again', () => {
  const text = 'Current state:\n' + SHOT + '\n\nGoal:\n/Users/me/Desktop/goal.png';
  const out = composeSubmission(text, [SHOT, '/Users/me/Desktop/goal.png']);
  assert.equal(out, text);
  assert.equal(out.match(/shot\.png/g).length, 1, 'shot.png appears twice');
});

test('an attachment the text does not mention is still appended', () => {
  const text = 'Current state:\n' + SHOT;
  const out = composeSubmission(text, [SHOT, '/Users/me/Desktop/orphan.png']);
  assert.equal(out.match(/shot\.png/g).length, 1);
  assert.match(out, /orphan\.png/);
  assert.match(out, /read them/);
});

test('the inline ordering the user chose is preserved', () => {
  const text = 'Broken:\n/a/bug.png\n\nShould look like:\n/a/goal.png';
  const out = composeSubmission(text, ['/a/bug.png', '/a/goal.png']);
  assert.ok(out.indexOf('bug.png') < out.indexOf('goal.png'));
  assert.ok(out.indexOf('Broken') < out.indexOf('bug.png'));
  assert.ok(out.indexOf('Should look like') < out.indexOf('goal.png'));
});

// An item may arrive as a bare path or as { path }, since the live handle
// carries objects.
test('an item object composes the same as a bare path', () => {
  const out = composeSubmission('look', [{ path: SHOT }]);
  assert.match(out, /shot\.png/);
  assert.match(out, /read them/);
});

test('a path the writer placed inline is not repeated', () => {
  const text = 'Current:\n' + SHOT;
  assert.equal(composeSubmission(text, [{ path: SHOT }]), text);
});
