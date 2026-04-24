window.FileBrowser = (function () {
  var escHtml = AppUtils.escHtml;

  var fileViewerContent = document.getElementById('file-viewer-content');
  var fileViewerView = document.getElementById('file-viewer-view');
  var fileTree = document.getElementById('file-tree');
  var fileTreeFilter = document.getElementById('file-tree-filter');
  var projectSearchInput = document.getElementById('project-search-input');
  var projectReplaceInput = document.getElementById('project-replace-input');
  var projectReplaceBtn = document.getElementById('project-replace-btn');
  var projectSearchResults = document.getElementById('project-search-results');
  var searchTimer = null;
  var lastSearchHits = []; // { file, line, text }[] from the last search
  var lastSearchQuery = '';
  var excludedFiles = new Set(); // files deselected from replace

  var fileTreeData = [];
  var fileTreeWorktree = null;
  var fileViewerWorktree = null;

  // Monaco editor instance + its model are owned by the module so we can
  // dispose them across file switches. The editor is always disposed on
  // switch. The model is disposed only if it's a one-off (non-project) model
  // — project models are shared with the TS worker for cross-file intel and
  // disposing them silently breaks sibling diagnostics.
  var currentEditor = null;
  var currentModel = null;
  var currentModelIsProject = false;
  var currentBlameLines = null;
  var currentViewerWorktree = null;
  var currentFilePath = null;
  var currentMarkerDisposable = null;

  // ---- K1: Tabs state ----
  // Each open file is a tab with its own model + savedContent. The single
  // currentEditor swaps its model on tab switch. Tabs share the header
  // (save button, breadcrumbs, run, blame) — those all reflect the active tab.
  var tabs = []; // [{ filePath, model, isProjectModel, savedContent }]
  var activeTabIndex = -1;
  var viewerInitialized = false;

  function findTab(filePath) {
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].filePath === filePath) return i;
    }
    return -1;
  }

  // K7 — gutter decorations for git-changed lines. `gitGutterDecorationIds`
  // holds the last-applied decoration IDs so we can swap them on refresh.
  var gitGutterDecorationIds = [];

  async function refreshGitGutter() {
    if (!currentEditor || !currentFilePath || !currentViewerWorktree) return;
    // Path relative to the worktree — git diff wants the relative form.
    var rel = currentFilePath;
    if (rel.indexOf(currentViewerWorktree + '/') === 0) {
      rel = rel.slice(currentViewerWorktree.length + 1);
    }
    var result = await window.klaus.git.fileHunks(currentViewerWorktree, rel);
    var hunks = (result && result.hunks) || [];
    var monaco = await window.MonacoReady;
    var decorations = hunks.map(function (h) {
      var cls = 'git-gutter-' + h.type;
      return {
        range: new monaco.Range(h.from, 1, h.to, 1),
        options: {
          isWholeLine: false,
          linesDecorationsClassName: cls,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      };
    });
    gitGutterDecorationIds = currentEditor.deltaDecorations(gitGutterDecorationIds, decorations);
  }

  function currentMonacoTheme() {
    // ThemeManager adds `light-syntax` to body when the active preset uses
    // GitHub-style light syntax colors; its absence means dark.
    var isLight = document.body.classList.contains('light-syntax');
    return isLight ? 'vs' : 'vs-dark';
  }

  window.addEventListener('theme-changed', function () {
    if (window.monaco && window.monaco.editor) {
      window.monaco.editor.setTheme(currentMonacoTheme());
    }
  });

  function disposeCurrentEditor() {
    if (currentMarkerDisposable) { try { currentMarkerDisposable.dispose(); } catch (_) {} currentMarkerDisposable = null; }
    if (currentEditor) { try { currentEditor.dispose(); } catch (_) {} currentEditor = null; }
    tabs.forEach(function (t) {
      if (!t.isProjectModel) { try { t.model.dispose(); } catch (_) {} }
    });
    tabs = [];
    activeTabIndex = -1;
    viewerInitialized = false;
    currentModel = null;
    currentModelIsProject = false;
    currentBlameLines = null;
    currentViewerWorktree = null;
    currentFilePath = null;
  }

  // K8 — status bar helpers.
  function updateStatusPosition(line, col) {
    var el = fileViewerView.querySelector('.statusbar-position');
    if (el) el.textContent = 'Ln ' + line + ', Col ' + col;
  }
  function updateStatusLanguage(model) {
    var el = fileViewerView.querySelector('.statusbar-language');
    if (!el) return;
    var id = model && !model.isDisposed() ? (model.getLanguageId() || '') : '';
    el.textContent = id;
  }
  function updateStatusDiagnostics(monaco, model) {
    var el = fileViewerView.querySelector('.statusbar-diagnostics');
    if (!el) return;
    if (!model || model.isDisposed()) { el.hidden = true; return; }
    var markers = monaco.editor.getModelMarkers({ resource: model.uri });
    var errors = 0, warnings = 0;
    for (var i = 0; i < markers.length; i++) {
      if (markers[i].severity === monaco.MarkerSeverity.Error) errors += 1;
      else warnings += 1;
    }
    if (errors + warnings === 0) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = '⛔ ' + errors + '  ⚠ ' + warnings;
  }
  function updateStatusBranch() {
    var el = fileViewerView.querySelector('.statusbar-branch');
    if (!el) return;
    var task = AppState.activeTaskId ? AppState.tasks.get(AppState.activeTaskId) : null;
    var branch = task && task.branch ? task.branch : '';
    el.textContent = branch ? '⎇ ' + branch : '';
    el.hidden = !branch;
  }

  // Count markers by severity on the model and update the pill. Monaco's
  // MarkerSeverity: 8=Error, 4=Warning, 2=Info, 1=Hint. We roll Info/Hint
  // under the "warning" visual (amber) to keep the pill binary — users
  // care most about "anything to fix here" vs "hard errors".
  function updateProblemsBadge(monaco, model) {
    var badge = document.querySelector('.file-viewer-problems-badge');
    if (!badge) return;
    if (!model || model.isDisposed()) {
      badge.hidden = true;
      return;
    }
    var markers = monaco.editor.getModelMarkers({ resource: model.uri });
    var errors = 0, warnings = 0;
    for (var i = 0; i < markers.length; i++) {
      var s = markers[i].severity;
      if (s === monaco.MarkerSeverity.Error) errors += 1;
      else warnings += 1;
    }
    var total = errors + warnings;
    if (total === 0) {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    badge.className = 'file-viewer-problems-badge' + (errors > 0 ? ' has-error' : ' has-warning');
    var parts = [];
    if (errors > 0) parts.push(errors + ' error' + (errors === 1 ? '' : 's'));
    if (warnings > 0) parts.push(warnings + ' warning' + (warnings === 1 ? '' : 's'));
    badge.textContent = (errors > 0 ? '⛔ ' : '⚠ ') + total;
    badge.title = parts.join(', ');
  }

  // Whether we should eagerly load sibling TS/JS models for cross-file intel.
  // Only kicks in for TS/JS/JSX/TSX/D.TS — other languages (JSON, CSS, HTML,
  // Markdown…) work fine in isolation and don't benefit from project-wide
  // model population.
  function isTsJsPath(filePath) {
    return /\.(t|j)sx?$|\.d\.ts$/i.test(filePath);
  }

  // Map file extensions to their run commands. Only the small set of languages
  // where per-file `cmd path` execution is idiomatic — things like Rust or Go
  // that need project-level build/run are handled by the Run App button instead.
  function runCommandForPath(filePath) {
    var ext = (filePath.split('.').pop() || '').toLowerCase();
    var basename = filePath.split('/').pop();
    if (ext === 'py') return { cmd: 'python3', friendly: 'python3 ' + basename };
    if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return { cmd: 'node', friendly: 'node ' + basename };
    if (ext === 'ts' || ext === 'tsx') return { cmd: 'npx tsx', friendly: 'npx tsx ' + basename };
    if (ext === 'sh' || ext === 'bash') return { cmd: 'bash', friendly: 'bash ' + basename };
    if (ext === 'rb') return { cmd: 'ruby', friendly: 'ruby ' + basename };
    return null;
  }

  // Shell-quote a single argument for zsh/bash. We pass the absolute file path,
  // which may contain spaces or `$` — single-quoting is enough for our inputs.
  function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  function runCurrentFile() {
    if (!currentFilePath) return;
    var run = runCommandForPath(currentFilePath);
    if (!run) return;
    var taskId = AppState.activeTaskId;
    if (taskId == null) return;
    var command = run.cmd + ' ' + shellQuote(currentFilePath);
    if (window.TerminalManager && window.TerminalManager.runInSubTerminal) {
      window.TerminalManager.runInSubTerminal(taskId, '▶ Run', command);
    }
  }

  // Fire the "figure out how to run this app and run it" flow. Hands the job
  // to Claude Code running in a sub-terminal — it inspects README / package.json
  // / pyproject / etc., picks a command, and (with tool-use approval) runs it.
  // User sees the full session interactively.
  function runApp() {
    var taskId = AppState.activeTaskId;
    if (taskId == null) return;
    var prompt = 'Find how to run this app in the current working directory ' +
      'and run it. Show its output. If there is ambiguity between dev vs prod ' +
      'or between multiple entry points, pick the most likely dev entry point ' +
      'and note your choice.';
    var command = 'claude ' + shellQuote(prompt);
    if (window.TerminalManager && window.TerminalManager.runInSubTerminal) {
      window.TerminalManager.runInSubTerminal(taskId, '▶ Run App', command);
    }
  }

  // Expose runApp for the file-tree header button.
  window.runApp = runApp;

  // ---- Multi-file navigation (I6) ----

  // Browser-style history of viewer navigations. Each entry is
  // { filePath, line }. navIndex points at the currently-displayed entry;
  // back/forward move along the stack without pushing new entries.
  // programmaticNav suppresses the push on openFileViewer calls that come
  // from back/forward themselves.
  var navStack = [];
  var navIndex = -1;
  var programmaticNav = false;

  function pushNav(filePath, line) {
    // Collapse consecutive duplicates at the same file+line. Also drop any
    // forward history past navIndex — Chrome-style: new nav replaces the
    // abandoned forward branch.
    var top = navStack[navIndex];
    if (top && top.filePath === filePath && top.line === line) return;
    navStack = navStack.slice(0, navIndex + 1);
    navStack.push({ filePath: filePath, line: line || 1 });
    navIndex = navStack.length - 1;
    updateNavButtons();
  }

  async function goBack() {
    if (navIndex <= 0) return;
    navIndex -= 1;
    var entry = navStack[navIndex];
    programmaticNav = true;
    try {
      await window.openFileViewer(entry.filePath, entry.filePath.split('/').pop(), entry.line);
    } finally {
      programmaticNav = false;
      updateNavButtons();
    }
  }

  async function goForward() {
    if (navIndex >= navStack.length - 1) return;
    navIndex += 1;
    var entry = navStack[navIndex];
    programmaticNav = true;
    try {
      await window.openFileViewer(entry.filePath, entry.filePath.split('/').pop(), entry.line);
    } finally {
      programmaticNav = false;
      updateNavButtons();
    }
  }

  function updateNavButtons() {
    var back = document.querySelector('.file-viewer-nav-btn[data-nav="back"]');
    var fwd = document.querySelector('.file-viewer-nav-btn[data-nav="forward"]');
    if (back) back.disabled = navIndex <= 0;
    if (fwd) fwd.disabled = navIndex >= navStack.length - 1;
  }

  function renderBreadcrumbs(filePath) {
    var el = document.querySelector('.file-viewer-breadcrumbs');
    if (!el) return;
    var wt = fileViewerWorktree;
    // Show the path relative to the worktree when possible — absolute paths
    // are noisy and the worktree root is implicit from the Files tab header.
    var rel = filePath;
    if (wt && filePath.indexOf(wt + '/') === 0) rel = filePath.slice(wt.length + 1);
    var parts = rel.split('/').filter(Boolean);
    el.innerHTML = parts
      .map(function (p, i) {
        var cls = i === parts.length - 1 ? 'crumb-leaf' : 'crumb-dir';
        return '<span class="' + cls + '">' + escHtml(p) + '</span>';
      })
      .join('<span class="crumb-sep">/</span>');
  }

  // Monaco delegates cross-file opens (e.g. go-to-def that lands in another
  // file) to `_codeEditorService.openCodeEditor`. In an embedded host the
  // default returns null — meaning "I don't know how to open that, do nothing."
  // Overriding it lets us route the target URI to our own viewer.
  function interceptCrossFileOpen(editor, monaco) {
    try {
      var svc = editor._codeEditorService;
      if (!svc || svc.__klaussyPatched) return;
      var orig = svc.openCodeEditor ? svc.openCodeEditor.bind(svc) : null;
      svc.openCodeEditor = async function (input, sourceEditor, sideBySide) {
        var result = orig ? await orig(input, sourceEditor, sideBySide) : null;
        if (result) return result;
        // Monaco couldn't open it via its internal services — route to us.
        if (!input || !input.resource) return null;
        var fsPath = input.resource.fsPath || input.resource.path;
        if (!fsPath) return null;
        var selection = input.options && input.options.selection;
        var line = selection ? selection.startLineNumber : 1;
        window.openFileViewer(fsPath, fsPath.split('/').pop(), line);
        return sourceEditor;
      };
      svc.__klaussyPatched = true;
    } catch (err) {
      console.warn('[nav] cross-file opener patch failed', err);
    }
  }

  // The file viewer belongs to one worktree at a time; showing it against a
  // different worktree is confusing (and blame / diff hooks would target the
  // wrong repo), so we close it on task switch. Subscribes via the event
  // bus instead of being poked directly from terminal-manager.
  function closeFileViewerOnTaskSwitch() {
    disposeCurrentEditor();
    fileViewerContent.style.display = 'none';
    fileViewerView.innerHTML = '';
  }
  Events.on('task:switched', closeFileViewerOnTaskSwitch);
  // Back-compat for older callers that still invoke this as a function.
  window.closeFileViewerOnTaskSwitch = closeFileViewerOnTaskSwitch;

  // ---- File Viewer (C1 + K1 tabs) ----

  // Builds the persistent viewer shell: tab bar + header + editor container.
  // Runs once per "session" (until a worktree switch wipes everything); after
  // that we just swap the editor's model on tab clicks instead of rebuilding.
  async function ensureViewerInitialized() {
    if (viewerInitialized) return true;
    fileViewerView.innerHTML =
      '<div class="file-viewer-tabs"></div>' +
      '<div class="file-viewer-header-inline">' +
        '<button class="file-viewer-nav-btn" data-nav="back" title="Back (⌘⌥←)" disabled>◀</button>' +
        '<button class="file-viewer-nav-btn" data-nav="forward" title="Forward (⌘⌥→)" disabled>▶</button>' +
        '<span class="file-viewer-breadcrumbs"></span>' +
        '<span class="file-editor-status"></span>' +
        '<span class="file-viewer-problems-badge" hidden></span>' +
        '<button class="file-viewer-run-btn" title="Run" hidden>▶</button>' +
        '<button class="file-viewer-save-btn" title="Save (⌘S)" disabled>Save</button>' +
        '<button class="file-viewer-blame-btn" title="Toggle blame annotations">Blame</button>' +
      '</div>' +
      '<div class="file-viewer-body"><div class="file-editor-monaco"></div></div>' +
      '<div class="file-viewer-statusbar">' +
        '<span class="statusbar-left">' +
          '<span class="statusbar-item statusbar-position">Ln 1, Col 1</span>' +
          '<span class="statusbar-item statusbar-language"></span>' +
        '</span>' +
        '<span class="statusbar-right">' +
          '<span class="statusbar-item statusbar-diagnostics" hidden></span>' +
          '<span class="statusbar-item statusbar-branch"></span>' +
          '<span class="statusbar-item statusbar-encoding">UTF-8</span>' +
        '</span>' +
      '</div>';

    fileViewerView.querySelectorAll('.file-viewer-nav-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.dataset.nav === 'back') goBack();
        else goForward();
      });
    });
    fileViewerView.querySelector('.file-viewer-blame-btn').addEventListener('click', function () {
      window.toggleBlame();
    });
    fileViewerView.querySelector('.file-viewer-save-btn').addEventListener('click', saveFile);
    fileViewerView.querySelector('.file-viewer-run-btn').addEventListener('click', runCurrentFile);

    // Tab bar: click switches, close X closes, middle-click closes.
    var tabBar = fileViewerView.querySelector('.file-viewer-tabs');
    tabBar.addEventListener('click', function (e) {
      var tabEl = e.target.closest('.file-viewer-tab');
      if (!tabEl) return;
      var idx = parseInt(tabEl.dataset.tabIndex, 10);
      if (isNaN(idx)) return;
      if (e.target.classList.contains('tab-close')) {
        e.stopPropagation();
        closeTab(idx);
      } else {
        activateTab(idx);
      }
    });
    tabBar.addEventListener('auxclick', function (e) {
      if (e.button !== 1) return; // middle-click only
      var tabEl = e.target.closest('.file-viewer-tab');
      if (!tabEl) return;
      var idx = parseInt(tabEl.dataset.tabIndex, 10);
      if (!isNaN(idx)) closeTab(idx);
    });

    // Monaco is lazy-loaded; first `await window.MonacoReady` starts the
    // require(). If the init module itself never loaded (wrong path / bad
    // bundle), `window.getMonaco` won't be defined and we bail without
    // triggering a rejected-promise path.
    if (typeof window.getMonaco !== 'function') {
      fileViewerView.querySelector('.file-viewer-body').innerHTML =
        '<span style="color: var(--error)">Editor failed to load (Monaco not initialized).</span>';
      return false;
    }
    var monaco;
    try { monaco = await window.getMonaco(); }
    catch (err) {
      fileViewerView.querySelector('.file-viewer-body').innerHTML =
        '<span style="color: var(--error)">Editor failed to load: ' + escHtml(err.message || String(err)) + '</span>';
      return false;
    }

    currentEditor = monaco.editor.create(fileViewerView.querySelector('.file-editor-monaco'), {
      theme: currentMonacoTheme(),
      automaticLayout: true,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
      tabSize: 2,
      renderWhitespace: 'selection',
    });

    // Word-completion provider needs Monaco to exist. Previously
    // word-complete.js wired itself via MonacoReady.then() at module init,
    // which triggered the lazy Monaco load even if the user never opened a
    // file. Register on editor creation instead — the provider is a global
    // monaco.languages registration, so once is enough.
    if (window.WordComplete && typeof window.WordComplete.register === 'function') {
      try { window.WordComplete.register(monaco); } catch (_) {}
    }

    currentEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveFile);
    currentEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow, goBack);
    currentEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.RightArrow, goForward);
    currentEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, function () {
      if (activeTabIndex >= 0) closeTab(activeTabIndex);
    });
    // K3: inline AI edit. Cmd+K in the editor starts the prompt widget.
    // The document-level Cmd+K (command palette in app.js) only fires when
    // the editor isn't focused, since Monaco's addCommand stops propagation.
    currentEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, function () {
      if (window.InlineEdit) window.InlineEdit.start(currentEditor);
    });
    if (window.InlineEdit && window.InlineEdit.setWorktreeGetter) {
      window.InlineEdit.setWorktreeGetter(function () { return currentViewerWorktree; });
    }
    // K6: manual AI completion trigger. Cmd+Shift+Space fires claude with
    // the cursor context; response shows as ghost text via Monaco's inline
    // completions. Tab accepts, Esc dismisses (both Monaco-native).
    currentEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Space, function () {
      if (window.InlineComplete) window.InlineComplete.trigger(currentEditor);
    });
    if (window.InlineComplete && window.InlineComplete.setWorktreeGetter) {
      window.InlineComplete.setWorktreeGetter(function () { return currentViewerWorktree; });
    }
    // Cmd+1 … Cmd+9 switches to the Nth tab (1-indexed, matches VS Code).
    for (var i = 0; i < 9; i++) {
      (function (n) {
        currentEditor.addCommand(
          monaco.KeyMod.CtrlCmd | (monaco.KeyCode.Digit1 + n),
          function () { if (tabs[n]) activateTab(n); }
        );
      })(i);
    }

    interceptCrossFileOpen(currentEditor, monaco);

    currentEditor.onDidChangeModelContent(refreshDirtyState);
    currentEditor.onDidChangeCursorPosition(function (e) {
      updateStatusPosition(e.position.lineNumber, e.position.column);
    });
    currentMarkerDisposable = monaco.editor.onDidChangeMarkers(function (uris) {
      var tab = tabs[activeTabIndex];
      if (!tab || !tab.model || tab.model.isDisposed()) return;
      var our = tab.model.uri.toString();
      for (var i = 0; i < uris.length; i++) {
        if (uris[i].toString() === our) {
          updateProblemsBadge(monaco, tab.model);
          updateStatusDiagnostics(monaco, tab.model);
          return;
        }
      }
    });

    viewerInitialized = true;
    return true;
  }

  // Reads the file, attaches the model to the LSP layer, and pushes a tab
  // entry. Returns the tab index, or -1 on error. Does NOT activate the tab
  // — caller decides when to switch.
  async function createTab(filePath) {
    var result = await window.klaus.fs.readFile(filePath);
    if (result.error) {
      var body = fileViewerView.querySelector('.file-viewer-body');
      if (body) body.innerHTML = '<span style="color: var(--error)">Error: ' + escHtml(result.error) + '</span>';
      return -1;
    }

    var monaco = await window.MonacoReady;

    // For TS/JS, kick off the project scan so cross-file imports resolve.
    // Awaited here so a reusable project model, if any, is available below.
    if (fileViewerWorktree && window.MonacoProject && isTsJsPath(filePath)) {
      try { await window.MonacoProject.loadWorktree(fileViewerWorktree); } catch (_) {}
    }

    // monaco.Uri.file assigns the URI Monaco uses for this file. If the
    // project scan already created a model at this URI, reuse it — disposing
    // it would pull the file out of the TS worker's cross-file view.
    var uri = monaco.Uri.file(filePath);
    var existing = monaco.editor.getModel(uri);
    var model, isProjectModel;
    if (existing && window.MonacoProject && window.MonacoProject.isProjectModel(uri)) {
      model = existing;
      isProjectModel = true;
    } else {
      if (existing) { try { existing.dispose(); } catch (_) {} }
      model = monaco.editor.createModel(result.content, undefined, uri);
      isProjectModel = false;
    }

    if (window.LspClient && fileViewerWorktree) {
      window.LspClient.attachModel(model, filePath, fileViewerWorktree);
    }

    tabs.push({ filePath: filePath, model: model, isProjectModel: isProjectModel, savedContent: result.content });
    return tabs.length - 1;
  }

  async function activateTab(index, line) {
    if (index < 0 || index >= tabs.length) return;
    activeTabIndex = index;
    var tab = tabs[index];
    currentModel = tab.model;
    currentFilePath = tab.filePath;
    currentModelIsProject = tab.isProjectModel;
    currentViewerWorktree = fileViewerWorktree;
    var monaco = await window.MonacoReady;

    if (currentEditor) currentEditor.setModel(tab.model);

    if (line) {
      var lineCount = tab.model.getLineCount();
      var target = Math.max(1, Math.min(line, lineCount));
      if (currentEditor) {
        currentEditor.revealLineInCenter(target);
        currentEditor.setPosition({ lineNumber: target, column: 1 });
      }
    }
    if (currentEditor) currentEditor.focus();

    renderTabs();
    renderBreadcrumbs(tab.filePath);
    updateRunButtonForTab(tab.filePath);
    refreshDirtyState();
    updateProblemsBadge(monaco, tab.model);
    updateStatusDiagnostics(monaco, tab.model);
    updateStatusLanguage(tab.model);
    updateStatusBranch();
    var pos = currentEditor && currentEditor.getPosition();
    if (pos) updateStatusPosition(pos.lineNumber, pos.column);
    refreshGitGutter();
  }

  function closeTab(index) {
    if (index < 0 || index >= tabs.length) return;
    var tab = tabs[index];
    if (!tab.isProjectModel) {
      try { tab.model.dispose(); } catch (_) {}
    }
    tabs.splice(index, 1);
    if (tabs.length === 0) {
      // Last tab closed — hide the viewer entirely and reset state. Next
      // openFileViewer will rebuild the shell.
      disposeCurrentEditor();
      fileViewerContent.style.display = 'none';
      fileViewerView.innerHTML = '';
      return;
    }
    if (index < activeTabIndex) {
      activeTabIndex -= 1;
      renderTabs();
    } else if (index === activeTabIndex) {
      activeTabIndex = Math.min(index, tabs.length - 1);
      activateTab(activeTabIndex);
    } else {
      renderTabs();
    }
  }

  function renderTabs() {
    var container = fileViewerView.querySelector('.file-viewer-tabs');
    if (!container) return;
    container.innerHTML = tabs.map(function (tab, i) {
      var basename = tab.filePath.split('/').pop();
      var active = i === activeTabIndex ? ' active' : '';
      var dirty = tab.model && !tab.model.isDisposed() && tab.model.getValue() !== tab.savedContent ? ' dirty' : '';
      return '<div class="file-viewer-tab' + active + dirty + '" data-tab-index="' + i + '" title="' + escHtml(tab.filePath) + '">' +
               '<span class="tab-name">' + escHtml(basename) + '</span>' +
               '<span class="tab-dirty-dot">●</span>' +
               '<button class="tab-close" title="Close (⌘W)">×</button>' +
             '</div>';
    }).join('');
  }

  function updateRunButtonForTab(filePath) {
    var btn = fileViewerView.querySelector('.file-viewer-run-btn');
    if (!btn) return;
    var runCmd = runCommandForPath(filePath);
    if (runCmd) {
      btn.hidden = false;
      btn.title = 'Run ' + runCmd.friendly;
    } else {
      btn.hidden = true;
    }
  }

  function refreshDirtyState() {
    var statusEl = fileViewerView.querySelector('.file-editor-status');
    var saveBtn = fileViewerView.querySelector('.file-viewer-save-btn');
    var tab = tabs[activeTabIndex];
    if (!tab || !statusEl || !saveBtn || !tab.model || tab.model.isDisposed()) return;
    var dirty = tab.model.getValue() !== tab.savedContent;
    if (dirty) {
      statusEl.textContent = 'Modified';
      statusEl.className = 'file-editor-status modified';
    } else {
      statusEl.textContent = '';
      statusEl.className = 'file-editor-status';
    }
    saveBtn.disabled = !dirty;
    // Update the active tab's dirty-dot class without re-rendering the whole bar.
    var tabEl = fileViewerView.querySelectorAll('.file-viewer-tab')[activeTabIndex];
    if (tabEl) tabEl.classList.toggle('dirty', dirty);
  }

  async function saveFile() {
    var tab = tabs[activeTabIndex];
    if (!tab || !tab.model || tab.model.isDisposed()) return;
    var content = tab.model.getValue();
    if (content === tab.savedContent) return;
    var statusEl = fileViewerView.querySelector('.file-editor-status');
    var saveBtn = fileViewerView.querySelector('.file-viewer-save-btn');
    if (statusEl) { statusEl.textContent = 'Saving...'; statusEl.className = 'file-editor-status saving'; }
    if (saveBtn) saveBtn.disabled = true;
    var writeResult = await window.klaus.fs.writeFile(tab.filePath, content);
    if (writeResult.error) {
      if (statusEl) { statusEl.textContent = 'Save failed'; statusEl.className = 'file-editor-status error'; }
      if (saveBtn) saveBtn.disabled = false;
      return;
    }
    tab.savedContent = content;
    if (statusEl) { statusEl.textContent = 'Saved'; statusEl.className = 'file-editor-status saved'; }
    setTimeout(function () {
      if (statusEl && statusEl.textContent === 'Saved') {
        statusEl.textContent = '';
        statusEl.className = 'file-editor-status';
      }
    }, 2000);
    refreshDirtyState();
    if (window.DiffPanel && window.DiffPanel.isVisible()) window.DiffPanel.refresh();
    if (window.LspClient) window.LspClient.notifyDidSave(tab.filePath);
    refreshGitGutter();
  }

  window.openFileViewer = async function (filePath, fileName, lineNumber) {
    var diffPanel = document.getElementById('diff-panel');
    if (!diffPanel.classList.contains('visible')) {
      document.getElementById('btn-diff').click();
    }

    document.querySelectorAll('#diff-tabs .diff-tab').forEach(function (t) { t.classList.remove('active'); });
    document.querySelector('#diff-tabs .diff-tab[data-tab="files"]').classList.add('active');
    ['changes-tab-content', 'pr-tab-content', 'search-tab-content'].forEach(function (id) {
      document.getElementById(id).style.display = 'none';
    });
    document.getElementById('files-tab-content').style.display = '';

    if (!fileTreeData.length) loadFileTree();

    var task = AppState.activeTaskId ? AppState.tasks.get(AppState.activeTaskId) : null;
    fileViewerWorktree = task ? task.worktreePath : null;

    fileViewerContent.style.display = 'flex';

    if (!programmaticNav) pushNav(filePath, lineNumber || 1);

    var ok = await ensureViewerInitialized();
    if (!ok) return;

    var existing = findTab(filePath);
    if (existing >= 0) {
      await activateTab(existing, lineNumber);
      return;
    }
    var newIndex = await createTab(filePath);
    if (newIndex < 0) return;
    await activateTab(newIndex, lineNumber);
  };

  // ---- File Tree (C2) ----

  function updateWorktreeLabel(wt) {
    var el = document.getElementById('file-tree-worktree-label');
    if (!el) return;
    if (!wt) { el.textContent = ''; el.title = ''; return; }
    var basename = wt.split('/').filter(Boolean).pop() || wt;
    el.textContent = basename;
    el.title = wt;
  }

  async function loadFileTree(overrideWt) {
    var task = AppState.activeTaskId ? AppState.tasks.get(AppState.activeTaskId) : null;
    var wt = overrideWt || (task ? task.worktreePath : null);
    updateWorktreeLabel(wt);
    // Belt-and-suspenders: the file-tree reload is the most reliable signal
    // that the active worktree changed. If the open file belongs to a
    // different worktree, close it here regardless of the switchToTask hook.
    if (currentViewerWorktree && currentViewerWorktree !== wt) {
      var prevWorktree = currentViewerWorktree;
      disposeCurrentEditor();
      fileViewerContent.style.display = 'none';
      fileViewerView.innerHTML = '';
      // Drop the old worktree's sibling TS/JS models — they'd otherwise
      // linger across navigations and pollute the TS worker with stale
      // files from unrelated projects.
      if (window.MonacoProject) window.MonacoProject.unloadWorktree();
      // Shut down any LSP servers tied to the old worktree.
      if (window.LspClient) window.LspClient.unloadWorktree(prevWorktree);
    }
    if (!wt) {
      fileTree.innerHTML = '<div class="file-tree-empty">No active task</div>';
      return;
    }
    if (wt === fileTreeWorktree && fileTreeData.length > 0) {
      renderFileTree(fileTreeFilter.value);
      return;
    }
    fileTreeWorktree = wt;
    fileTree.innerHTML = '<div class="file-tree-empty">Loading...</div>';
    var result = await window.klaus.fs.listFiles(wt);
    if (result.error) {
      fileTree.innerHTML = '<div class="file-tree-empty">Error: ' + escHtml(result.error) + '</div>';
      return;
    }
    fileTreeData = result.files;
    renderFileTree('');
  }

  function renderFileTree(filter) {
    var filtered = fileTreeData;
    var hasFilter = false;
    if (filter) {
      var q = filter.toLowerCase();
      filtered = fileTreeData.filter(function (f) { return f.toLowerCase().includes(q); });
      hasFilter = true;
    }
    var tree = {};
    filtered.forEach(function (filepath) {
      var parts = filepath.split('/');
      var node = tree;
      parts.forEach(function (part, i) {
        if (i === parts.length - 1) {
          if (!node._files) node._files = [];
          node._files.push({ name: part, path: filepath });
        } else {
          if (!node[part]) node[part] = {};
          node = node[part];
        }
      });
    });
    fileTree.innerHTML = '';
    // With a filter active, auto-expand matched paths so the user sees the
    // results without having to click through directories. Without a filter,
    // lazy mode keeps the initial render cheap — collapsed directories don't
    // build their subtrees until the user opens them.
    renderTreeNode(tree, fileTree, 0, { autoExpand: hasFilter });
  }

  // Build the children of a single directory node. Pulled out of renderTreeNode
  // so it can be called lazily on click (collapsed dirs defer their child DOM)
  // and eagerly in filter mode (expanded automatically).
  function buildChildren(node, container, depth, opts) {
    var dirs = Object.keys(node).filter(function (k) { return k !== '_files'; }).sort();
    dirs.forEach(function (dir) {
      renderDir(dir, node[dir], container, depth, opts);
    });
    if (node._files) {
      node._files.sort(function (a, b) { return a.name.localeCompare(b.name); });
      node._files.forEach(function (file) {
        var fileEl = document.createElement('div');
        fileEl.className = 'file-tree-file';
        fileEl.style.paddingLeft = (depth * 16 + 8) + 'px';
        fileEl.textContent = file.name;
        fileEl.title = file.path;
        fileEl.addEventListener('click', function () {
          window.openFileViewer(fileTreeWorktree + '/' + file.path, file.path);
        });
        container.appendChild(fileEl);
      });
    }
  }

  function renderDir(name, node, container, depth, opts) {
    var autoExpand = opts && opts.autoExpand;
    var dirEl = document.createElement('div');
    dirEl.className = 'file-tree-dir';
    var label = document.createElement('div');
    label.className = 'file-tree-label';
    label.style.paddingLeft = (depth * 16 + 8) + 'px';
    label.innerHTML = '<span class="file-tree-arrow">&#9654;</span> ' + escHtml(name);
    var children = document.createElement('div');
    children.className = 'file-tree-children';
    children.style.display = 'none';

    // Lazy: don't build the child DOM until this directory is first opened.
    // Tracking with a flag on the element so we only build once, then toggle
    // display on subsequent clicks. Saves O(files) DOM construction on tree
    // render for collapsed subtrees — the main perf win of virtualization
    // without needing a flat-list windowing framework.
    var built = false;
    function openDir() {
      if (!built) {
        buildChildren(node, children, depth + 1, opts);
        built = true;
      }
      children.style.display = '';
      label.querySelector('.file-tree-arrow').innerHTML = '&#9660;';
    }
    function closeDir() {
      children.style.display = 'none';
      label.querySelector('.file-tree-arrow').innerHTML = '&#9654;';
    }
    label.addEventListener('click', function () {
      if (children.style.display === 'none') openDir(); else closeDir();
    });

    dirEl.appendChild(label);
    dirEl.appendChild(children);
    container.appendChild(dirEl);

    if (autoExpand) openDir();
  }

  function renderTreeNode(node, container, depth, opts) {
    buildChildren(node, container, depth, opts);
  }

  // Debounce: rebuilding the entire tree synchronously on every keystroke
  // is O(files) work per character (up to WALK_FILE_CAP = 10k DOM nodes).
  var fileTreeFilterDebounce;
  fileTreeFilter.addEventListener('input', function () {
    clearTimeout(fileTreeFilterDebounce);
    fileTreeFilterDebounce = setTimeout(function () {
      renderFileTree(fileTreeFilter.value);
    }, 120);
  });

  // ---- Project Search (C3) ----

  async function doProjectSearch(overrideWt) {
    var query = projectSearchInput.value;
    if (!query) {
      projectSearchResults.innerHTML = '';
      lastSearchHits = [];
      lastSearchQuery = '';
      updateReplaceButton();
      return;
    }
    var task = AppState.activeTaskId ? AppState.tasks.get(AppState.activeTaskId) : null;
    var wt = overrideWt || (task ? task.worktreePath : null);
    if (!wt) {
      projectSearchResults.innerHTML = '<div class="file-tree-empty">No active task</div>';
      return;
    }
    projectSearchResults.innerHTML = '<div class="file-tree-empty">Searching...</div>';
    // When the replace field has content, fetch more matches per file so the
    // user can see everything they're about to change. 100 is a soft cap —
    // enough to cover most practical cases without blowing the UI.
    var maxPerFile = projectReplaceInput.value ? 100 : 5;
    var result = await window.klaus.fs.searchFiles(wt, query, maxPerFile);
    if (result.error) {
      projectSearchResults.innerHTML = '<div class="file-tree-empty">Error: ' + escHtml(result.error) + '</div>';
      return;
    }
    if (result.results.length === 0) {
      projectSearchResults.innerHTML = '<div class="file-tree-empty">No matches found</div>';
      lastSearchHits = [];
      lastSearchQuery = query;
      updateReplaceButton();
      return;
    }
    lastSearchHits = result.results;
    lastSearchQuery = query;
    excludedFiles.clear();
    renderSearchResults(wt);
    updateReplaceButton();
  }

  function renderSearchResults(wt) {
    var grouped = {};
    lastSearchHits.forEach(function (r) {
      if (!grouped[r.file]) grouped[r.file] = [];
      grouped[r.file].push(r);
    });
    var replaceText = projectReplaceInput.value;
    var query = lastSearchQuery;
    projectSearchResults.innerHTML = '';
    Object.keys(grouped).forEach(function (file) {
      var hits = grouped[file];
      var fileHeader = document.createElement('div');
      fileHeader.className = 'search-result-file';
      // Per-file checkbox visible in replace mode. Unchecked files are skipped
      // when the user hits Apply.
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'search-result-file-check';
      checkbox.checked = !excludedFiles.has(file);
      checkbox.title = 'Include this file in replace';
      checkbox.addEventListener('click', function (e) { e.stopPropagation(); });
      checkbox.addEventListener('change', function () {
        if (checkbox.checked) excludedFiles.delete(file);
        else excludedFiles.add(file);
        updateReplaceButton();
      });
      fileHeader.appendChild(checkbox);
      var label = document.createElement('span');
      label.className = 'search-result-file-label';
      label.textContent = file + '  (' + hits.length + ')';
      label.addEventListener('click', function () { window.openFileViewer(wt + '/' + file, file); });
      fileHeader.appendChild(label);
      projectSearchResults.appendChild(fileHeader);
      hits.forEach(function (match) {
        var line = document.createElement('div');
        line.className = 'search-result-line';
        var text = match.text.substring(0, 200);
        var html = '<span class="search-line-num">' + match.line + '</span>' + highlightMatches(text, query);
        if (replaceText) {
          var afterText = text.split(query).join(replaceText);
          html += '<div class="search-result-replace-preview">→ ' +
            highlightReplacements(afterText.substring(0, 200), replaceText) + '</div>';
        }
        line.innerHTML = html;
        line.addEventListener('click', function () { window.openFileViewer(wt + '/' + file, file, match.line); });
        projectSearchResults.appendChild(line);
      });
    });
  }

  function highlightMatches(text, query) {
    if (!query) return escHtml(text);
    var parts = text.split(query);
    return parts
      .map(function (p) { return escHtml(p); })
      .join('<mark class="search-hit-match">' + escHtml(query) + '</mark>');
  }

  function highlightReplacements(text, replacement) {
    if (!replacement) return escHtml(text);
    var parts = text.split(replacement);
    return parts
      .map(function (p) { return escHtml(p); })
      .join('<mark class="search-hit-replace">' + escHtml(replacement) + '</mark>');
  }

  function updateReplaceButton() {
    if (!projectReplaceBtn) return;
    var includedFiles = new Set();
    lastSearchHits.forEach(function (r) {
      if (!excludedFiles.has(r.file)) includedFiles.add(r.file);
    });
    var hitCount = lastSearchHits.filter(function (r) { return !excludedFiles.has(r.file); }).length;
    var hasReplace = !!projectReplaceInput.value;
    projectReplaceBtn.disabled = !hasReplace || hitCount === 0 || !lastSearchQuery;
    projectReplaceBtn.textContent = hitCount > 0
      ? 'Replace in ' + includedFiles.size + ' file' + (includedFiles.size === 1 ? '' : 's')
      : 'Replace';
  }

  async function doProjectReplace() {
    var query = lastSearchQuery;
    var replacement = projectReplaceInput.value;
    if (!query) return;
    var task = AppState.activeTaskId ? AppState.tasks.get(AppState.activeTaskId) : null;
    var wt = task ? task.worktreePath : null;
    if (!wt) return;
    var files = [];
    var seen = new Set();
    lastSearchHits.forEach(function (r) {
      if (excludedFiles.has(r.file)) return;
      if (seen.has(r.file)) return;
      seen.add(r.file);
      files.push(r.file);
    });
    if (!files.length) return;
    var ok = window.confirm(
      'Replace "' + query + '" with "' + replacement + '" in ' + files.length + ' file' +
      (files.length === 1 ? '' : 's') + '?\n\nThis rewrites files on disk and cannot be undone from here.'
    );
    if (!ok) return;
    projectReplaceBtn.disabled = true;
    projectReplaceBtn.textContent = 'Replacing…';
    var result = await window.klaus.fs.replaceInFiles(wt, files, query, replacement);
    if (result.error) {
      alert('Replace failed: ' + result.error);
      updateReplaceButton();
      return;
    }
    // Re-run search so the UI reflects the post-replace state (usually zero
    // hits for the original query).
    projectReplaceInput.value = '';
    await doProjectSearch(wt);
    if (window.DiffPanel && window.DiffPanel.isVisible()) window.DiffPanel.refresh();
  }

  // Event listeners for tab switching
  window.addEventListener('load-file-tree', function (e) { loadFileTree(e.detail && e.detail.worktreePath); });
  window.addEventListener('reload-tab-files', function (e) { loadFileTree(e.detail && e.detail.worktreePath); });
  // H3's watcher: file changed outside our save path — refresh the gutter.
  window.addEventListener('worktree-changed', function () { refreshGitGutter(); });
  // Switching projects invalidates any open file — the path may not even
  // exist in the new project. Always close.
  window.addEventListener('klaussy:project-changed', function () {
    if (window.closeFileViewerOnTaskSwitch) window.closeFileViewerOnTaskSwitch(null);
  });
  window.addEventListener('load-search', function (e) {
    if (projectSearchInput.value.trim()) doProjectSearch(e.detail && e.detail.worktreePath);
  });
  window.addEventListener('reload-tab-search', function (e) {
    if (projectSearchInput.value.trim()) doProjectSearch(e.detail && e.detail.worktreePath);
  });

  projectSearchInput.addEventListener('input', function () {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(doProjectSearch, 400);
  });
  projectSearchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchTimer) clearTimeout(searchTimer);
      doProjectSearch();
    }
  });

  if (projectReplaceInput) {
    var replaceInputModeArmed = false;
    projectReplaceInput.addEventListener('input', function () {
      var task = AppState.activeTaskId ? AppState.tasks.get(AppState.activeTaskId) : null;
      var wt = task ? task.worktreePath : null;
      // First time the replace field gets content during this search, re-query
      // so the per-file match cap jumps from 5 → 100. After that, subsequent
      // keystrokes just re-render the preview locally; the hit set is stable.
      if (projectReplaceInput.value && !replaceInputModeArmed && lastSearchHits.length && wt) {
        replaceInputModeArmed = true;
        doProjectSearch(wt);
        return;
      }
      if (!projectReplaceInput.value) replaceInputModeArmed = false;
      if (wt && lastSearchHits.length) renderSearchResults(wt);
      updateReplaceButton();
    });
    projectReplaceInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !projectReplaceBtn.disabled) {
        e.preventDefault();
        doProjectReplace();
      }
    });
  }
  if (projectReplaceBtn) projectReplaceBtn.addEventListener('click', doProjectReplace);

  // ---- Blame toggle (D5) ----

  window.toggleBlame = async function () {
    var task = AppState.activeTaskId ? AppState.tasks.get(AppState.activeTaskId) : null;
    if (!task) return;
    if (!currentEditor || !currentModel || !window.monaco || !currentFilePath) return;
    // git blame wants the path relative to the worktree.
    var fileName = currentFilePath;
    if (currentViewerWorktree && fileName.indexOf(currentViewerWorktree + '/') === 0) {
      fileName = fileName.slice(currentViewerWorktree.length + 1);
    }

    // Toggle off if blame is already rendering — restore default line numbers.
    if (currentBlameLines) {
      currentBlameLines = null;
      currentEditor.updateOptions({ lineNumbers: 'on', lineNumbersMinChars: 5 });
      fileViewerView.classList.remove('blame-active');
      return;
    }

    var result = await window.klaus.git.blame(task.worktreePath, fileName);
    if (result.error || !result.lines || result.lines.length === 0) return;

    // Replace the line-number column with "<hash> <author>" — mirrors the
    // pre-Monaco behavior (git blame swaps out numbers). Monaco re-renders
    // when the function reference changes, so the closure-captured blame
    // array updates the gutter without any explicit refresh call.
    currentBlameLines = result.lines;
    currentEditor.updateOptions({
      lineNumbers: function (ln) {
        var b = currentBlameLines ? currentBlameLines[ln - 1] : null;
        if (!b) return String(ln);
        return ((b.hash || '').substring(0, 7) + ' ' + (b.author || '').substring(0, 10)).trim();
      },
      lineNumbersMinChars: 22,
    });
    fileViewerView.classList.add('blame-active');
  };

  // Cmd+K is overloaded (global command palette vs in-editor inline-edit).
  // Export a getter so app.js's document-level handler can tell whether to
  // route to inline-edit when a file is open — without depending on focus,
  // which is unreliable after clicks on the tab bar or elsewhere in the
  // file viewer.
  function getActiveEditor() {
    // `currentEditor` is closed over; if no file is open it's undefined.
    return (typeof currentEditor !== 'undefined') ? currentEditor : null;
  }

  return {
    loadFileTree: loadFileTree,
    doProjectSearch: doProjectSearch,
    getActiveEditor: getActiveEditor,
  };
})();
