// Electron keeps one permission handler per session; everything stays granted except the mic, which only the app's main window and PR review pop-out get while voice input is on (the default).

const path = require('path');
const { pathToFileURL } = require('url');
const { session, app } = require('electron');
const { loadConfig } = require('../util/config');

function voicePageUrls() {
  return ['index.html', 'pr-review.html'].map((page) => pathToFileURL(path.join(app.getAppPath(), 'renderer', page)).href);
}

function decidePermission(permission, details = {}, voiceEnabled = false, pageUrls = voicePageUrls()) {
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
  return [].concat(pageUrls).some((u) => url.href === new URL(u).href)
    && types.length > 0
    && types.every((t) => t === 'audio');
}

function install() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const voiceEnabled = permission === 'media' && loadConfig().voiceInput !== false;
    callback(decidePermission(permission, details, voiceEnabled));
  });
}

module.exports = { decidePermission, install };
