// Electron keeps one permission handler per session; everything stays granted except the mic, which only the main window gets while voice input is on.

const { session } = require('electron');
const { loadConfig } = require('../util/config');

function decidePermission(permission, details = {}, voiceEnabled = false) {
  if (permission !== 'media') return true;
  if (!voiceEnabled) return false;
  let url;
  try {
    url = new URL(String(details.requestingUrl || ''));
  } catch {
    return false;
  }
  const types = details.mediaTypes || [];
  return url.protocol === 'file:'
    && url.pathname.endsWith('/renderer/index.html')
    && types.length > 0
    && types.every((t) => t === 'audio');
}

function install() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const voiceEnabled = permission === 'media' && loadConfig().voiceInput === true;
    callback(decidePermission(permission, details, voiceEnabled));
  });
}

module.exports = { decidePermission, install };
