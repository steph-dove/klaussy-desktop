// Startup guards that MUST run before any module reads userData (config.json,
// logs, license). Two problems this fixes:
//
//   1. Dev/installed config race. A `npm start` dev build and the installed
//      app share one userData dir, so both wrote the same config.json.tmp and
//      raced the rename → "saveConfig failed: ENOENT" + dropped session saves.
//      A non-packaged build now uses an isolated "<userData>-dev" dir, so the
//      two never touch the same files (and can run side by side).
//
//   2. Two copies of the SAME build. A second launch should focus the running
//      window and exit, not run a rival process against the same userData.
//
// requestSingleInstanceLock is keyed on userData, so the dev-isolation step
// MUST happen first — that gives the dev build its own lock, separate from the
// installed app's.
const { app } = require('electron');

// Returns true when this process is the primary and should keep booting. When
// false the caller must exit immediately (a primary is already running and has
// been signalled to focus its window via the 'second-instance' event).
function acquirePrimaryOrExit() {
  // E2E (Playwright) manages its own instance lifecycle and userData — don't
  // interfere with locking or path isolation there.
  if (process.env.KLAUSSY_E2E) return true;

  if (!app.isPackaged) {
    try {
      app.setPath('userData', app.getPath('userData') + '-dev');
    } catch (err) {
      console.error('[single-instance] dev userData isolation failed:', err.message);
    }
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  return true;
}

// Focus the existing window when a second copy of this build is launched.
// Attached during app-events bootstrap, where the window accessors live.
function installSecondInstanceFocus(getMainWindow, allWindows) {
  app.on('second-instance', () => {
    const win = getMainWindow() || (allWindows && allWindows.size ? [...allWindows][0] : null);
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

module.exports = { acquirePrimaryOrExit, installSecondInstanceFocus };
