// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// The desktop app and the browser version share one settings folder, so they
// can't run at once (main/util/instance-lock.js). When the desktop app starts
// while the browser version is running, it doesn't boot: it asks whether to
// open the browser version instead or switch to the desktop app.

const { app, dialog, shell } = require('electron');
const lock = require('../util/instance-lock');

// Returns true when the browser version holds the folder; the caller must not
// boot, and this module quits (or relaunches) the app after asking.
// Runs after acquirePrimaryOrExit, so userData is final.
function deferToBrowserHelper() {
  // The helper loads main.js itself, and E2E manages its own userData.
  if (app.isWebHelper || process.env.KLAUSSY_E2E) return false;

  const dir = app.getPath('userData');
  let result;
  try {
    result = lock.acquire(dir, { kind: 'desktop' });
    if (!result.ok && (!result.holder || result.holder.kind !== 'web')) {
      // This process already won Electron's own single-instance lock, so a
      // 'desktop' holder here is leftover from a crash (or a reused pid): take it.
      lock.discard(dir);
      result = lock.acquire(dir, { kind: 'desktop' });
    }
  } catch (err) {
    // Never keep the desktop app from starting over its own lock file.
    console.error('[browser-handoff] instance lock failed:', err.message);
    return false;
  }
  if (result.ok) {
    app.on('will-quit', () => lock.release(dir));
    return false;
  }
  if (!result.holder || result.holder.kind !== 'web') return false;
  app.whenReady().then(() => askAboutBrowser(dir, result.holder)).catch((err) => {
    console.error('[browser-handoff]', err);
    app.quit();
  });
  return true;
}

async function askAboutBrowser(dir, holder) {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Maussian is open in your browser',
    message: 'Maussian is already running in your browser.',
    detail: 'The browser and the desktop app share your projects and sessions, so only one runs at a time. '
      + 'Using the desktop app stops the browser version. It saves your sessions first, so you can resume them here.',
    buttons: ['Open in Browser', 'Use the Desktop App', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  });

  if (response === 0) {
    const url = lock.browserUrl(dir, holder);
    if (url) await shell.openExternal(url);
    else dialog.showErrorBox('Maussian', 'The browser version is still starting. Try again in a moment.');
    app.quit();
    return;
  }

  if (response === 1) {
    if (await lock.stopHolder(holder)) {
      app.relaunch();
    } else {
      dialog.showErrorBox('Maussian', 'The browser version didn’t stop. Stop it from its terminal, then open the desktop app again.');
    }
    app.quit();
    return;
  }

  app.quit();
}

module.exports = { deferToBrowserHelper };
