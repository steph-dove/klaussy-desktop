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
