const { electronStub, testUserData } = require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareVoice } = require('../../main/ipc/voice');
const manifest = require('../../main/util/voice-model.json');

function setVoicePref(on) {
  fs.writeFileSync(path.join(testUserData, 'config.json'), JSON.stringify({ voiceInput: on }));
}

test.beforeEach(() => setVoicePref(true));

function modelDir({ complete }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-ipc-'));
  const files = Object.keys(manifest.files).concat(Object.keys(manifest.runtime).map((n) => 'runtime/' + n));
  for (const rel of complete ? files : files.slice(1)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '');
  }
  return dir;
}

function withMic(status, askResult, fn) {
  const sp = electronStub.systemPreferences;
  const orig = { ...sp };
  sp.getMediaAccessStatus = () => status;
  sp.askForMediaAccess = () => Promise.resolve(askResult);
  return fn().finally(() => Object.assign(sp, orig));
}

test('refuses while voice input is off, so no page can raise the mic prompt', async () => {
  setVoicePref(false);
  const res = await prepareVoice({ modelDir: modelDir({ complete: true }) });
  assert.equal(res.ok, false);
  assert.match(res.error, /Voice input is off/);
});

test('a missing model reports how to get it in dev', async () => {
  const res = await prepareVoice({ modelDir: modelDir({ complete: false }) });
  assert.equal(res.ok, false);
  assert.match(res.error, /npm run voice:fetch/);
});

test('ready when the model is complete and the mic is granted', async () => {
  assert.deepEqual(await prepareVoice({ modelDir: modelDir({ complete: true }) }), { ok: true });
});

test('macOS asks for the mic and reports a denial with where to fix it', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  await withMic('not-determined', false, async () => {
    const res = await prepareVoice({ modelDir: modelDir({ complete: true }) });
    assert.equal(res.ok, false);
    assert.match(res.error, /Privacy & Security › Microphone/);
  });
  await withMic('not-determined', true, async () => {
    assert.deepEqual(await prepareVoice({ modelDir: modelDir({ complete: true }) }), { ok: true });
  });
});
