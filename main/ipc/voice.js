// Never throws; the renderer shows `error`, and offers the OS mic settings when `code` is 'mic-denied'.

const { ipcMain, app, shell, systemPreferences } = require('electron');
const { modelMissing } = require('../bootstrap/voice-protocol');
const { loadConfig } = require('../util/config');
const ollama = require('../state/ollama');

const MIC_SETTINGS_URLS = {
  darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  win32: 'ms-settings:privacy-microphone',
};

function micHelp(platform = process.platform) {
  if (platform === 'darwin') {
    return { message: 'Klaussy can’t use the microphone. Allow it in System Settings › Privacy & Security › Microphone.', canOpenSettings: true };
  }
  if (platform === 'win32') {
    return { message: 'Klaussy can’t use the microphone. Turn on microphone access for desktop apps in Settings › Privacy & security › Microphone.', canOpenSettings: true };
  }
  return { message: 'Klaussy can’t use the microphone. Check that one is connected and not muted, and that your desktop’s privacy settings (or Flatpak/Snap permissions) let Klaussy use it.', canOpenSettings: false };
}

function micDenied() {
  return { ok: false, code: 'mic-denied', error: micHelp().message };
}

async function prepareVoice({ modelDir } = {}) {
  if (loadConfig().voiceInput === false) {
    return { ok: false, code: 'off', error: 'Voice input is off. Turn it on in Preferences › Voice Input.' };
  }
  const missing = modelMissing(modelDir);
  if (missing) {
    return {
      ok: false,
      code: 'model-missing',
      error: app.isPackaged
        ? 'The voice model is missing from this install. Reinstall Klaussy to restore it.'
        : 'Voice model not downloaded. Run `npm run voice:fetch` and try again.',
    };
  }
  try {
    if (process.platform === 'darwin') {
      const granted = systemPreferences.getMediaAccessStatus('microphone') === 'granted'
        || await systemPreferences.askForMediaAccess('microphone');
      if (!granted) return micDenied();
    } else if (process.platform === 'win32' && systemPreferences.getMediaAccessStatus('microphone') === 'denied') {
      return micDenied();
    }
  } catch (err) {
    return { ok: false, error: 'Could not check microphone access: ' + ((err && err.message) || String(err)) };
  }
  return { ok: true };
}

async function openMicSettings(platform = process.platform) {
  const url = MIC_SETTINGS_URLS[platform];
  if (!url) return { ok: false };
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// Numbered so a small local model only has to answer with a digit.
// With an agent tab open most speech is for the agent, so the model is told to pick only requests aimed at Klaussy itself.
function buildIntentPrompt(text, actions, { agentTab = false } = {}) {
  const intro = agentTab
    ? 'Someone is talking to Klaussy, a desktop app where they dictate instructions to an AI coding agent.\n'
      + 'Almost everything they say is an instruction for the coding agent (run tests, edit code, start servers, open files, make pull requests). Those must get 0.\n'
      + 'Only when they are clearly asking Klaussy itself to open or show one of its own windows, panels or dialogs, pick that action.\n'
    : 'You map a spoken request to one action in a desktop app for coding agents.\n';
  return intro
    + 'Request: "' + String(text).replace(/"/g, "'") + '"\n'
    + 'Actions:\n'
    + actions.map((a, i) => (i + 1) + '. ' + a).join('\n')
    + '\nIf the request asks for one of these actions, reply with only its number.'
    + '\nIf it is a question, a coding instruction, or anything none of these actions does, reply 0.';
}

// The action the model picked, or null for "none" or anything that isn't one of the numbers offered.
function pickFromReply(reply, actions) {
  const m = /\d+/.exec(String(reply || ''));
  if (!m) return null;
  const n = Number(m[0]);
  return n >= 1 && n <= actions.length ? actions[n - 1] : null;
}

async function interpretWithOllama({ text, actions, agentTab = false } = {}) {
  const list = (Array.isArray(actions) ? actions : []).filter((a) => typeof a === 'string' && a).slice(0, 120);
  if (!text || !list.length) return { action: null };
  const model = await ollama.pickIntentModel();
  if (!model) return { action: null, unavailable: true };
  const reply = await ollama.generateText(buildIntentPrompt(text, list, { agentTab: agentTab === true }), { timeoutMs: 12000, numPredict: 8, prefer: model });
  if (!reply) return { action: null, unavailable: true };
  return { action: pickFromReply(reply, list) };
}

ipcMain.handle('voice-prepare', () => prepareVoice());
ipcMain.handle('voice-interpret', (_e, payload) => interpretWithOllama(payload));
ipcMain.handle('voice-mic-help', () => micHelp());
ipcMain.handle('voice-open-mic-settings', () => openMicSettings());

module.exports = { prepareVoice, micHelp, openMicSettings, buildIntentPrompt, pickFromReply, interpretWithOllama };
