const { electronStub, testUserData } = require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareVoice, micHelp, openMicSettings, buildIntentPrompt, pickFromReply } = require('../../main/ipc/voice');
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
  assert.equal(res.code, 'off');
});

test('voice is on when the pref was never set', async () => {
  fs.writeFileSync(path.join(testUserData, 'config.json'), JSON.stringify({}));
  assert.deepEqual(await prepareVoice({ modelDir: modelDir({ complete: true }) }), { ok: true });
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
    assert.equal(res.code, 'mic-denied');
  });
  await withMic('not-determined', true, async () => {
    assert.deepEqual(await prepareVoice({ modelDir: modelDir({ complete: true }) }), { ok: true });
  });
});

test('mic help points each platform at its own settings', () => {
  assert.match(micHelp('darwin').message, /System Settings › Privacy & Security › Microphone/);
  assert.equal(micHelp('darwin').canOpenSettings, true);
  assert.match(micHelp('win32').message, /Settings › Privacy & security › Microphone/);
  assert.equal(micHelp('win32').canOpenSettings, true);
  assert.match(micHelp('linux').message, /Flatpak\/Snap/);
  assert.equal(micHelp('linux').canOpenSettings, false);
});

test('the settings button opens the OS microphone privacy page', async () => {
  const opened = [];
  const orig = electronStub.shell.openExternal;
  electronStub.shell.openExternal = (url) => { opened.push(url); return Promise.resolve(); };
  try {
    assert.deepEqual(await openMicSettings('darwin'), { ok: true });
    assert.deepEqual(await openMicSettings('win32'), { ok: true });
    assert.deepEqual(await openMicSettings('linux'), { ok: false });
  } finally {
    electronStub.shell.openExternal = orig;
  }
  assert.deepEqual(opened, [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    'ms-settings:privacy-microphone',
  ]);
});

test('the Ollama intent prompt numbers the actions and the reply must be one of them', () => {
  const actions = ['New Task', 'Show Active Agents', 'Press "Run review"'];
  const prompt = buildIntentPrompt('show me what my agents finished', actions);
  assert.match(prompt, /1\. New Task\n2\. Show Active Agents\n3\. Press "Run review"/);
  assert.match(prompt, /reply with only its number/);
  assert.match(prompt, /a question, a coding instruction.*reply 0/);
  assert.equal(pickFromReply('2', actions), 'Show Active Agents');
  assert.equal(pickFromReply(' 3. Press "Run review"', actions), 'Press "Run review"');
  assert.equal(pickFromReply('0', actions), null);
  assert.equal(pickFromReply('7', actions), null);
  assert.equal(pickFromReply('I think the second one', actions), null);
  assert.equal(pickFromReply('', actions), null);
});

test('over an agent tab the intent prompt says most speech is for the agent', () => {
  const prompt = buildIntentPrompt('open code revue', ['New Task'], { agentTab: true });
  assert.match(prompt, /instruction for the coding agent .* Those must get 0/);
  assert.match(prompt, /1\. New Task/);
  assert.doesNotMatch(buildIntentPrompt('open code revue', ['New Task']), /Those must get 0/);
});
