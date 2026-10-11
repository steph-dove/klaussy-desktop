require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const { decidePermission } = require('../../main/bootstrap/permissions');

const MAIN = 'file:///Applications/Klaussy.app/Contents/Resources/app.asar/renderer/index.html';
const audio = (requestingUrl) => ({ requestingUrl, mediaTypes: ['audio'] });

test('the main window gets the mic while voice input is on', () => {
  assert.equal(decidePermission('media', audio(MAIN), true), true);
  assert.equal(decidePermission('media', audio('file:///C:/Klaussy/resources/app.asar/renderer/index.html?secondary=1'), true), true);
});

test('no page gets the mic while voice input is off', () => {
  assert.equal(decidePermission('media', audio(MAIN), false), false);
  assert.equal(decidePermission('media', audio(MAIN)), false);
});

test('other app pages and remote origins never get the mic', () => {
  for (const url of [
    'file:///app/renderer/pr-review.html',
    'file:///app/renderer/preferences.html',
    'file:///app/renderer/popout.html',
    'https://example.com/renderer/index.html',
    'klaussy-voice://runtime/index.html',
    'not a url',
    '',
  ]) {
    assert.equal(decidePermission('media', audio(url), true), false, url);
  }
});

test('camera, or audio with video, is refused', () => {
  assert.equal(decidePermission('media', { requestingUrl: MAIN, mediaTypes: ['video'] }, true), false);
  assert.equal(decidePermission('media', { requestingUrl: MAIN, mediaTypes: ['audio', 'video'] }, true), false);
  assert.equal(decidePermission('media', { requestingUrl: MAIN, mediaTypes: [] }, true), false);
});

test('every other permission keeps the default grant', () => {
  for (const p of ['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen']) {
    assert.equal(decidePermission(p, { requestingUrl: MAIN }, false), true, p);
  }
});
