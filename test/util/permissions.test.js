const { electronStub, testUserData } = require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { decidePermission, install } = require('../../main/bootstrap/permissions');

const MAIN = 'file:///Applications/Klaussy.app/Contents/Resources/app.asar/renderer/index.html';
const audio = (requestingUrl) => ({ requestingUrl, mediaTypes: ['audio'] });
const decide = (permission, details, voiceEnabled) => decidePermission(permission, details, voiceEnabled, MAIN);

test('the main page gets the mic while voice input is on', () => {
  assert.equal(decide('media', audio(MAIN), true), true);
  assert.equal(decide('media', audio(MAIN + '#x'), true), true);
});

test('no page gets the mic while voice input is off', () => {
  assert.equal(decide('media', audio(MAIN), false), false);
  assert.equal(decide('media', audio(MAIN)), false);
});

test('secondary windows, other pages and look-alike paths never get the mic', () => {
  for (const url of [
    MAIN + '?secondary=1',
    'file:///Applications/Klaussy.app/Contents/Resources/app.asar/renderer/pr-review.html',
    'file:///Users/me/src/klaussy-desktop/renderer/index.html',
    'https://example.com/renderer/index.html',
    'klaussy-voice://runtime/index.html',
    'not a url',
    '',
  ]) {
    assert.equal(decide('media', audio(url), true), false, url);
  }
});

test('camera, or audio with video, is refused', () => {
  assert.equal(decide('media', { requestingUrl: MAIN, mediaTypes: ['video'] }, true), false);
  assert.equal(decide('media', { requestingUrl: MAIN, mediaTypes: ['audio', 'video'] }, true), false);
  assert.equal(decide('media', { requestingUrl: MAIN, mediaTypes: [] }, true), false);
});

test('every other permission keeps the default grant', () => {
  for (const p of ['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen']) {
    assert.equal(decide(p, { requestingUrl: MAIN }, false), true, p);
  }
});

test('the installed handler reads the voice pref on every request', () => {
  let handler;
  const ds = electronStub.session.defaultSession;
  const orig = ds.setPermissionRequestHandler;
  ds.setPermissionRequestHandler = (h) => { handler = h; };
  try {
    install();
  } finally {
    ds.setPermissionRequestHandler = orig;
  }
  const page = pathToFileURL(path.join(electronStub.app.getAppPath(), 'renderer', 'index.html')).href;
  const ask = (permission) => new Promise((resolve) => handler(null, permission, resolve, audio(page)));
  const setPref = (on) => fs.writeFileSync(path.join(testUserData, 'config.json'), JSON.stringify({ voiceInput: on }));

  return (async () => {
    setPref(true);
    assert.equal(await ask('media'), true);
    setPref(false);
    assert.equal(await ask('media'), false);
    assert.equal(await ask('notifications'), true);
  })();
});

test('the PR review pop-out gets the mic too, look-alikes do not', () => {
  const pages = [MAIN, MAIN.replace('index.html', 'pr-review.html')];
  assert.equal(decidePermission('media', audio(pages[1]), true, pages), true);
  assert.equal(decidePermission('media', audio(MAIN), true, pages), true);
  assert.equal(decidePermission('media', audio('file:///tmp/clone/renderer/pr-review.html'), true, pages), false);
  assert.equal(decidePermission('media', audio(MAIN.replace('index.html', 'preferences.html')), true, pages), false);
});
