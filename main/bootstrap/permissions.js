// Electron keeps one permission handler per session; everything stays granted except the mic, which only the app's own main page gets while voice input is on.

const path = require('path');
const { pathToFileURL } = require('url');
const { session, app } = require('electron');
const { loadConfig } = require('../util/config');

function mainPageUrl() {
  return pathToFileURL(path.join(app.getAppPath(), 'renderer', 'index.html')).href;
}

function decidePermission(permission, details = {}, voiceEnabled = false, pageUrl = mainPageUrl()) {
  if (permission !== 'media') return true;
  if (!voiceEnabled) return false;
  let url;
  try {
    url = new URL(String(details.requestingUrl || ''));
  } catch {
    return false;
  }
  // Secondary windows load the same page with ?secondary and never record.
  if (url.searchParams.has('secondary')) return false;
  url.search = '';
  url.hash = '';
  const types = details.mediaTypes || [];
  return url.href === new URL(pageUrl).href
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
