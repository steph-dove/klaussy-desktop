// Test-time stub for `require('electron')`.
//
// The real electron API is only available inside an Electron process; `node
// --test` runs in plain Node, so any module that does `require('electron')`
// would fail at load. We intercept the require before the modules under test
// are loaded and return a stub that covers the surface main/util/* actually
// touches: `app.getPath('userData')` for config / logging / path-gate. If
// another module starts reaching into electron, extend the stub here.
//
// Every test file that loads code from main/ must `require('./setup')` (or
// '../setup' etc.) as the FIRST require so the interception is in place
// before any module under test loads.

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

// Per-run userData dir. Tests should treat this as shared; individual tests
// that need isolation should mkdtemp their own subdir.
const testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-test-'));

const fakeApp = {
  getPath(name) {
    if (name === 'userData') return testUserData;
    if (name === 'documents') return path.join(testUserData, 'Documents');
    if (name === 'home') return os.homedir();
    return testUserData;
  },
  getVersion: () => '0.0.0-test',
  getName: () => 'Klaussy',
  setName: () => {},
  on: () => {},
  whenReady: () => Promise.resolve(),
  dock: null,
};

const electronStub = {
  app: fakeApp,
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  dialog: {},
  shell: { openPath: () => {}, openExternal: () => {} },
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  Notification: class {},
  contextBridge: { exposeInMainWorld: () => {} },
  ipcRenderer: { invoke: () => Promise.resolve(), on: () => {}, send: () => {} },
  webUtils: { getPathForFile: () => '' },
};

const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, ...rest);
};

module.exports = { testUserData, fakeApp, electronStub };
