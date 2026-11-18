'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGhDeviceCode, ghWantsUserToOpenBrowser } = require('../../main/util/gh-device-code');

test('parses the legacy "one-time code: XXXX-XXXX" form', () => {
  assert.equal(parseGhDeviceCode('! First copy your one-time code: AB12-CD34\nPress Enter to open github.com'), 'AB12-CD34');
});

test('parses the gh 2.10x "One-time code (XXXX-XXXX) copied" form', () => {
  const out = '\n! One-time code (8105-E970) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n';
  assert.equal(parseGhDeviceCode(out), '8105-E970');
  assert.equal(ghWantsUserToOpenBrowser(out), true);
});

test('returns null until the code has arrived', () => {
  assert.equal(parseGhDeviceCode(''), null);
  assert.equal(parseGhDeviceCode('! One-time code (81'), null);
  assert.equal(parseGhDeviceCode(undefined), null);
});

test('legacy Press Enter output does not ask us to open the browser', () => {
  assert.equal(ghWantsUserToOpenBrowser('Press Enter to open github.com in your browser...'), false);
});
