// Never throws; the renderer shows `error` when the model or macOS mic access is missing.

const { ipcMain, app, systemPreferences } = require('electron');
const { modelMissing } = require('../bootstrap/voice-protocol');
const { loadConfig } = require('../util/config');

async function prepareVoice({ modelDir } = {}) {
  if (loadConfig().voiceInput !== true) {
    return { ok: false, error: 'Voice input is off. Turn it on in Preferences › Voice Input.' };
  }
  const missing = modelMissing(modelDir);
  if (missing) {
    return {
      ok: false,
      error: app.isPackaged
        ? 'The voice model is missing from this install. Reinstall Klaussy to restore it.'
        : 'Voice model not downloaded. Run `npm run voice:fetch` and try again.',
    };
  }
  if (process.platform === 'darwin') {
    try {
      const granted = systemPreferences.getMediaAccessStatus('microphone') === 'granted'
        || await systemPreferences.askForMediaAccess('microphone');
      if (!granted) {
        return { ok: false, error: 'Microphone access is off. Allow Klaussy in System Settings › Privacy & Security › Microphone.' };
      }
    } catch (err) {
      return { ok: false, error: 'Could not check microphone access: ' + ((err && err.message) || String(err)) };
    }
  }
  return { ok: true };
}

ipcMain.handle('voice-prepare', () => prepareVoice());

module.exports = { prepareVoice };
