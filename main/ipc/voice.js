// Never throws; the renderer shows `error`, and offers the OS mic settings when `code` is 'mic-denied'.

const { ipcMain, app, shell, systemPreferences } = require('electron');
const { modelMissing } = require('../bootstrap/voice-protocol');
const { loadConfig } = require('../util/config');

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

ipcMain.handle('voice-prepare', () => prepareVoice());
ipcMain.handle('voice-mic-help', () => micHelp());
ipcMain.handle('voice-open-mic-settings', () => openMicSettings());

module.exports = { prepareVoice, micHelp, openMicSettings };
