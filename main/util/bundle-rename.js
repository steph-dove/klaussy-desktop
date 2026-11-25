// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// The Mac app's executable stays "Klaussy" (package.json mac.executableName): Squirrel renames
// the bundle when an update's executable name differs, and then fails to relaunch because it
// spawns its helper from inside the old, already-moved bundle. Keeping the name lets updates
// install in place and reopen. So the bundle still arrives as Klaussy.app, and this renames it
// to Maussian.app as the app quits, where no relaunch is needed and the Dock's alias follows.
const fs = require('fs');
const path = require('path');

const OLD_BUNDLE = 'Klaussy.app';
const NEW_BUNDLE = 'Maussian.app';

// A folder's path with symlinks resolved, lowercased: APFS volumes are case-insensitive by
// default, so /applications and /Applications are the same folder.
function sameDirKey(dir, realpath) {
  try { return realpath(dir).toLowerCase(); } catch { return path.resolve(dir).toLowerCase(); }
}

// The rename to make for an app whose executable is at execPath, or null. Only an installed
// Klaussy.app directly in an Applications folder, and never over an existing Maussian.app.
function bundleRename(execPath, { platform, packaged, home, exists, realpath = (p) => p }) {
  if (platform !== 'darwin' || !packaged || !execPath) return null;
  const bundle = path.resolve(execPath, '..', '..', '..');
  if (path.basename(bundle) !== OLD_BUNDLE) return null;
  const dir = path.dirname(bundle);
  // Without a home folder there's no ~/Applications to match (and path.join would make a
  // relative 'Applications').
  const allowed = ['/Applications', ...(home && path.isAbsolute(home) ? [path.join(home, 'Applications')] : [])];
  const key = sameDirKey(dir, realpath);
  if (!allowed.some((a) => sameDirKey(a, realpath) === key)) return null;
  const target = path.join(dir, NEW_BUNDLE);
  if (exists(target)) return null;
  return { from: bundle, to: target };
}

// Wires the rename to the app's quit. It only renames once this session's update check has
// come back with nothing to install: an update downloaded now, or cached from an earlier
// session (electron-updater reports that one again once its check runs), installs at the
// bundle's current path as the app quits, and moving the bundle first is what broke reopening.
// A quit before the check finishes just leaves the rename for the next one. After a
// permission error (a non-admin user, App Management) it stops trying, so it doesn't fail
// on every quit; a marker in userData records that.
const GIVE_UP_FILE = 'bundle-rename-skipped';
function installRenameOnQuit({
  app, autoUpdater, log, execPath = process.execPath, platform = process.platform,
  home = require('os').homedir(), fsImpl = fs,
}) {
  let nothingToInstall = false;
  autoUpdater.on('update-not-available', () => { nothingToInstall = true; });
  autoUpdater.on('update-available', () => { nothingToInstall = false; });
  autoUpdater.on('update-downloaded', () => { nothingToInstall = false; });

  const marker = path.join(app.getPath('userData'), GIVE_UP_FILE);
  app.on('will-quit', () => {
    if (!nothingToInstall || fsImpl.existsSync(marker)) return;
    const move = bundleRename(execPath, {
      platform, packaged: app.isPackaged, home, exists: fsImpl.existsSync, realpath: fsImpl.realpathSync,
    });
    if (!move) return;
    try {
      fsImpl.renameSync(move.from, move.to);
      log.info('[updater] renamed the app bundle', move.from, '->', move.to);
    } catch (err) {
      log.warn('[updater] bundle rename failed', err && err.message);
      if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
        try { fsImpl.writeFileSync(marker, `${new Date().toISOString()} ${err.code}\n`); } catch {}
      }
    }
  });
}

module.exports = { bundleRename, installRenameOnQuit, OLD_BUNDLE, NEW_BUNDLE, GIVE_UP_FILE };
