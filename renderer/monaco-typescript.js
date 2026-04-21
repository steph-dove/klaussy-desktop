// Project-wide TS/JS awareness for Monaco (Phase I2).
//
// Monaco ships a TypeScript worker that can cross-reference multiple files
// — but only files it knows about (i.e., models registered in Monaco's
// registry). By default we only create a model for the currently open file,
// which makes imports to sibling files appear broken.
//
// This module scans the active worktree for TS/JS/JSX/TSX/D.TS files,
// bulk-reads their content, and creates "hidden" Monaco models for each.
// The TS worker picks them up automatically once the model exists under a
// valid `file://` URI. Models are disposed when the worktree changes to
// avoid leaking memory across navigations.
//
// Cap chosen (1500 files) keeps a large monorepo sub-folder workable
// without blowing up memory on a full vendor tree. If a project exceeds
// the cap we silently skip project loading — cross-file intel is lost but
// single-file editing still works, and the project still opens.

(function () {
  var MAX_PROJECT_FILES = 1500;
  var TS_JS_RE = /\.(t|j)sx?$|\.d\.ts$/i;

  var loadedWorktree = null;
  var projectModels = []; // monaco.editor.ITextModel[]
  var loadPromise = null;

  function configureDefaults(monaco) {
    var ts = monaco.languages.typescript;
    if (!ts) return;

    var compilerOpts = {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      isolatedModules: false,
      skipLibCheck: true,
      strict: false,
      noEmit: true,
    };
    ts.typescriptDefaults.setCompilerOptions(compilerOpts);
    ts.javascriptDefaults.setCompilerOptions(compilerOpts);

    // The worker only refreshes diagnostics when the model is open in an
    // editor; enabling eager diagnostics keeps hidden (sibling) models from
    // poisoning the output with phantom errors.
    ts.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      onlyVisible: false,
    });
  }

  function disposeProjectModels() {
    for (var i = 0; i < projectModels.length; i++) {
      try { projectModels[i].dispose(); } catch (_) {}
    }
    projectModels = [];
  }

  function filterTsJsPaths(paths) {
    var out = [];
    for (var i = 0; i < paths.length; i++) {
      if (TS_JS_RE.test(paths[i])) out.push(paths[i]);
    }
    return out;
  }

  // Returns a promise — callers can await it if they want to know when
  // sibling models are ready, but the editor is already usable before then.
  window.MonacoProject = {
    // True if the given Monaco URI corresponds to a model we created as part
    // of the worktree scan. File-browser uses this to reuse project models
    // instead of creating/disposing a fresh one on every open — disposing a
    // project model removes it from the TS worker's awareness, which
    // silently kills cross-file diagnostics.
    isProjectModel: function (uri) {
      if (!uri) return false;
      var s = uri.toString();
      for (var i = 0; i < projectModels.length; i++) {
        var m = projectModels[i];
        if (m && !m.isDisposed() && m.uri.toString() === s) return true;
      }
      return false;
    },

    loadWorktree: async function (worktreePath) {
      if (!worktreePath) return;
      if (loadedWorktree === worktreePath && loadPromise) return loadPromise;
      // Different worktree — drop stale models before loading the new set.
      if (loadedWorktree !== worktreePath) disposeProjectModels();
      loadedWorktree = worktreePath;

      loadPromise = (async function () {
        var monaco = await window.MonacoReady;
        configureDefaults(monaco);

        var listResult = await window.klaus.listFiles(worktreePath);
        if (!listResult || listResult.error) return;
        var tsPaths = filterTsJsPaths(listResult.files || []);
        if (tsPaths.length === 0 || tsPaths.length > MAX_PROJECT_FILES) return;

        var bulk = await window.klaus.readFilesBulk(worktreePath, tsPaths, 256 * 1024);
        if (!bulk || !bulk.files) return;

        for (var rel in bulk.files) {
          if (!Object.prototype.hasOwnProperty.call(bulk.files, rel)) continue;
          var abs = worktreePath.replace(/\/$/, '') + '/' + rel;
          var uri = monaco.Uri.file(abs);
          // Skip URIs that already have a model — the active editor owns its
          // own model for the file the user opened, and we must not shadow it.
          if (monaco.editor.getModel(uri)) continue;
          try {
            var m = monaco.editor.createModel(bulk.files[rel], undefined, uri);
            projectModels.push(m);
          } catch (_) { /* ignore malformed URIs, binary, etc. */ }
        }
      })();
      return loadPromise;
    },

    // Called when the active worktree changes (or file-viewer closes) so
    // we don't keep thousands of models for a worktree no longer in use.
    unloadWorktree: function () {
      loadedWorktree = null;
      loadPromise = null;
      disposeProjectModels();
    },
  };
})();
