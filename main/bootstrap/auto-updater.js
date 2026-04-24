// Auto-update wiring via electron-updater + GitHub Releases.
//
// Silent-until-relevant behavior:
//   - On app start, checks GitHub Releases for a newer version.
//   - If one's found, downloads in the background.
//   - When the download finishes, pops a small modal: "Update ready.
//     Restart now / Later." User picks.
//   - Errors go to electron-log (viewable via Help → View Logs) — never
//     surfaced to the user, since update failures are usually transient
//     network blips and nagging the user about them is worse than silence.
//
// Dev-mode no-op: electron-updater refuses to run from `electron .`, so this
// is inert in development. Only kicks in on signed, packaged builds.

const { app, dialog, BrowserWindow } = require('electron');
const log = require('electron-log');

let _installed = false;

function install() {
  if (_installed) return;
  _installed = true;

  // Dev builds have no `app.isPackaged === true`, so skip the whole dance.
  if (!app.isPackaged) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    log.warn('[updater] electron-updater not installed; skipping');
    return;
  }

  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => log.error('[updater] error', err));
  autoUpdater.on('checking-for-update', () => log.info('[updater] checking for update'));
  autoUpdater.on('update-available', (info) => log.info('[updater] update available', info && info.version));
  autoUpdater.on('update-not-available', () => log.info('[updater] up to date'));
  autoUpdater.on('download-progress', (p) => log.info(`[updater] ${Math.round(p.percent)}%`));
  autoUpdater.on('update-downloaded', async (info) => {
    log.info('[updater] update downloaded', info && info.version);
    const win = BrowserWindow.getAllWindows()[0];
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Klaussy ${info && info.version ? info.version : ''} is ready to install.`,
      detail: 'Restart the app to apply the update, or choose Later and it will install next time you quit.',
    });
    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  // Tiny delay so the main window finishes painting before we start a
  // potentially bandwidth-heavy download on boot.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => log.warn('[updater] check failed', err));
  }, 5000);
}

// Manual "Check for updates" menu item handler — surfaced in the app menu.
async function checkNow() {
  if (!app.isPackaged) {
    const win = BrowserWindow.getAllWindows()[0];
    dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['OK'],
      title: 'Updates',
      message: 'Auto-updates are disabled in development builds.',
    });
    return;
  }
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }
  const win = BrowserWindow.getAllWindows()[0];
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo || !result.updateInfo.version) {
      dialog.showMessageBox(win, {
        type: 'info',
        buttons: ['OK'],
        title: 'Updates',
        message: 'Klaussy is up to date.',
      });
    }
    // If an update is found, the existing event handlers take over.
  } catch (err) {
    dialog.showMessageBox(win, {
      type: 'error',
      buttons: ['OK'],
      title: 'Update check failed',
      message: (err && err.message) || String(err),
    });
  }
}

module.exports = { install, checkNow };
