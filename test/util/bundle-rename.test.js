const test = require('node:test');
const assert = require('node:assert/strict');
const { bundleRename } = require('../../main/util/bundle-rename');

const EXE = '/Applications/Klaussy.app/Contents/MacOS/Klaussy';
const env = (over = {}) => ({
  platform: 'darwin', packaged: true, home: '/Users/octo', exists: () => false, ...over,
});

test('an installed Klaussy.app in /Applications is renamed to Maussian.app', () => {
  assert.deepEqual(bundleRename(EXE, env()), {
    from: '/Applications/Klaussy.app', to: '/Applications/Maussian.app',
  });
});

test('one in the home Applications folder is renamed there', () => {
  const exe = '/Users/octo/Applications/Klaussy.app/Contents/MacOS/Klaussy';
  assert.deepEqual(bundleRename(exe, env()), {
    from: '/Users/octo/Applications/Klaussy.app', to: '/Users/octo/Applications/Maussian.app',
  });
});

test('an existing Maussian.app is never replaced', () => {
  assert.equal(bundleRename(EXE, env({ exists: (p) => p === '/Applications/Maussian.app' })), null);
});

test('a bundle already called Maussian.app stays as it is', () => {
  assert.equal(bundleRename('/Applications/Maussian.app/Contents/MacOS/Klaussy', env()), null);
});

test('a copy the user moved or renamed elsewhere is left alone', () => {
  for (const exe of [
    '/Users/octo/Downloads/Klaussy.app/Contents/MacOS/Klaussy',
    '/Applications/Tools/Klaussy.app/Contents/MacOS/Klaussy',
    '/Applications/My Klaussy.app/Contents/MacOS/Klaussy',
    '/private/var/folders/x/AppTranslocation/y/d/Klaussy.app/Contents/MacOS/Klaussy',
  ]) {
    assert.equal(bundleRename(exe, env()), null, exe);
  }
});

test('nothing happens off macOS, in a dev build, or without a path', () => {
  assert.equal(bundleRename(EXE, env({ platform: 'win32' })), null);
  assert.equal(bundleRename(EXE, env({ packaged: false })), null);
  assert.equal(bundleRename('', env()), null);
});

// ---- the quit wiring ------------------------------------------------------------------

const { EventEmitter } = require('node:events');
const { installRenameOnQuit, GIVE_UP_FILE } = require('../../main/util/bundle-rename');

// A fake app and updater, and an fs that records renames and markers.
function harness({ renameError } = {}) {
  const app = new EventEmitter();
  app.isPackaged = true;
  app.getPath = () => '/userdata';
  const autoUpdater = new EventEmitter();
  const files = new Set();
  const renames = [];
  const fsImpl = {
    existsSync: (p) => files.has(p),
    realpathSync: (p) => p,
    renameSync: (from, to) => { if (renameError) throw renameError; renames.push([from, to]); },
    writeFileSync: (p) => files.add(p),
  };
  const log = { info() {}, warn() {} };
  installRenameOnQuit({ app, autoUpdater, log, execPath: EXE, platform: 'darwin', home: '/Users/octo', fsImpl });
  return { app, autoUpdater, renames, files };
}

test('no rename on a quit before the update check has answered', () => {
  const h = harness();
  h.app.emit('will-quit');
  assert.deepEqual(h.renames, []);
});

test('renames once the check found nothing to install', () => {
  const h = harness();
  h.autoUpdater.emit('update-not-available');
  h.app.emit('will-quit');
  assert.deepEqual(h.renames, [['/Applications/Klaussy.app', '/Applications/Maussian.app']]);
});

test('an update found or downloaded (this session or cached) blocks the rename', () => {
  for (const ev of ['update-available', 'update-downloaded']) {
    const h = harness();
    h.autoUpdater.emit('update-not-available');
    h.autoUpdater.emit(ev);
    h.app.emit('will-quit');
    assert.deepEqual(h.renames, [], ev);
  }
});

test('a permission error stops later attempts; other errors retry', () => {
  const denied = harness({ renameError: Object.assign(new Error('denied'), { code: 'EPERM' }) });
  denied.autoUpdater.emit('update-not-available');
  denied.app.emit('will-quit');
  assert.ok(denied.files.has(require('node:path').join('/userdata', GIVE_UP_FILE)));

  const busy = harness({ renameError: Object.assign(new Error('busy'), { code: 'EBUSY' }) });
  busy.autoUpdater.emit('update-not-available');
  busy.app.emit('will-quit');
  assert.equal(busy.files.size, 0);
});

test('paths match through symlinks and case; no home means only /Applications', () => {
  const realpath = (p) => (p.toLowerCase() === '/users/octo/applications' ? '/Volumes/Data/octo/Applications' : p);
  const viaLink = '/Volumes/Data/octo/Applications/Klaussy.app/Contents/MacOS/Klaussy';
  assert.ok(bundleRename(viaLink, env({ realpath })));
  assert.ok(bundleRename('/applications/Klaussy.app/Contents/MacOS/Klaussy', env()));
  // With no home, a path under the current folder's Applications must not match.
  const cwdApps = require('node:path').join(process.cwd(), 'Applications/Klaussy.app/Contents/MacOS/Klaussy');
  const fromCwd = { realpath: (p) => require('node:path').resolve(p) };
  assert.equal(bundleRename(cwdApps, env({ home: '', ...fromCwd })), null);
  assert.ok(bundleRename(EXE, env({ home: '' })));
});
