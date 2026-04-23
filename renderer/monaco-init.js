// Boot Monaco via its AMD loader. The renderer has `contextIsolation: true`
// and `nodeIntegration: false`, so the loader's web path is what runs here.
//
// Workers: Chrome disallows loading a Worker from a file:// script unless we
// pre-build the worker URL as a data: URL that importScripts the real worker
// relative to Monaco's base. Standard Electron+Monaco pattern.
//
// Lazy: editor.main is big (~2MB parse + workers). Starting load on every
// window open penalizes users who only use terminals. `window.MonacoReady`
// is now a getter-backed property — the expensive `require(['vs/editor/
// editor.main'])` fires only when something actually awaits it. Callers
// doing `await window.MonacoReady` keep working without change.

(function () {
  var loaderScript = document.querySelector('script[src*="monaco-editor/min/vs/loader.js"]');
  if (!loaderScript) {
    console.error('[monaco] loader.js script tag not found; did index.html drop it?');
    return;
  }

  // Absolute file:// URL of monaco-editor/min/vs/, used by workers to locate siblings.
  var loaderSrc = loaderScript.src; // e.g. file:///…/node_modules/monaco-editor/min/vs/loader.js
  var vsBase = loaderSrc.replace(/loader\.js$/, ''); // …/min/vs/
  var minBase = vsBase.replace(/vs\/$/, ''); // …/min/

  self.MonacoEnvironment = {
    getWorkerUrl: function (_moduleId, _label) {
      var src =
        'self.MonacoEnvironment = { baseUrl: ' + JSON.stringify(minBase) + ' };\n' +
        'importScripts(' + JSON.stringify(vsBase + 'base/worker/workerMain.js') + ');';
      return 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);
    },
  };

  var _monacoPromise = null;
  function loadMonaco() {
    if (_monacoPromise) return _monacoPromise;
    _monacoPromise = new Promise(function (resolve, reject) {
      if (typeof require !== 'function' || !require.config) {
        reject(new Error('Monaco AMD loader did not expose require.config'));
        return;
      }
      require.config({ paths: { vs: vsBase.replace(/\/$/, '') } });
      require(['vs/editor/editor.main'], function () {
        resolve(window.monaco);
      }, function (err) {
        console.error('[monaco] editor.main failed to load', err);
        reject(err);
      });
    });
    return _monacoPromise;
  }

  // Explicit API for callers that want to signal intent.
  window.getMonaco = loadMonaco;

  // Back-compat: reading `window.MonacoReady` triggers the load on first
  // access. BEWARE: even `if (window.MonacoReady)` will trigger it — callers
  // must not probe for existence; use `window.getMonaco` when they only want
  // to check availability without starting the load.
  Object.defineProperty(window, 'MonacoReady', {
    configurable: true,
    get: function () { return loadMonaco(); },
  });
})();
