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
    if (currentModel && !currentModelIsProject) {
      try { currentModel.dispose(); } catch (_) {}
    }
    currentModel = null;
    currentModelIsProject = false;
    currentBlameLines = null;
    currentViewerWorktree = null;
    currentFilePath = null;
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

  // Called from terminal-manager.switchToTask when the active task changes.
  // The file viewer belongs to one worktree at a time; showing it against a
  // different worktree is confusing (and blame / diff hooks would target the
  // wrong repo), so we close it on task switch.
  window.closeFileViewerOnTaskSwitch = function (_newWorktreePath) {
    // Always close on task switch. The real close trigger for worktree
    // changes lives inside loadFileTree (it has a reliable signal); this
    // hook is a backup for task removal / no-active-task transitions.
    disposeCurrentEditor();
    fileViewerContent.style.display = 'none';
    fileViewerView.innerHTML = '';
  };

  // ---- File Viewer (C1) ----

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
    var runCmd = runCommandForPath(filePath);
    fileViewerView.innerHTML =
      '<div class="file-viewer-header-inline">' +
        '<button class="file-viewer-nav-btn" data-nav="back" title="Back (⌘⌥←)" disabled>◀</button>' +
        '<button class="file-viewer-nav-btn" data-nav="forward" title="Forward (⌘⌥→)" disabled>▶</button>' +
        '<span class="file-viewer-breadcrumbs"></span>' +
        '<span class="file-editor-status"></span>' +
        '<span class="file-viewer-problems-badge" hidden></span>' +
        (runCmd ? '<button class="file-viewer-run-btn" title="Run ' + escHtml(runCmd.friendly) + '">▶</button>' : '') +
        '<button class="file-viewer-save-btn" title="Save (⌘S)" disabled>Save</button>' +
        '<button class="file-viewer-blame-btn" title="Toggle blame annotations">Blame</button>' +
      '</div>' +
      '<div class="file-viewer-body"><div class="file-editor-monaco"></div></div>';

    renderBreadcrumbs(filePath);
    updateNavButtons();
    fileViewerView.querySelectorAll('.file-viewer-nav-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.dataset.nav === 'back') goBack();
        else goForward();
      });
    });
    if (!programmaticNav) pushNav(filePath, lineNumber || 1);

    var statusEl = fileViewerView.querySelector('.file-editor-status');
    var saveBtn = fileViewerView.querySelector('.file-viewer-save-btn');
    fileViewerView.querySelector('.file-viewer-blame-btn').addEventListener('click', function () {
      window.toggleBlame();
    });
    saveBtn.addEventListener('click', function () { saveFile(); });
    var runBtn = fileViewerView.querySelector('.file-viewer-run-btn');
    if (runBtn) {
      runBtn.addEventListener('click', function () { runCurrentFile(); });
    }

    // Dispose any prior instance eagerly so a failed read doesn't leave the
    // editor from the previous file hanging around behind an error state.
    disposeCurrentEditor();

    var result = await window.klaus.readFile(filePath);
    var body = fileViewerView.querySelector('.file-viewer-body');
    if (result.error) {
      body.innerHTML = '<span style="color: var(--error)">Error: ' + escHtml(result.error) + '</span>';
      return;
    }

    if (!window.MonacoReady) {
      body.innerHTML = '<span style="color: var(--error)">Editor failed to load (Monaco not initialized).</span>';
      return;
    }

    var monaco;
    try {
      monaco = await window.MonacoReady;
    } catch (err) {
      body.innerHTML = '<span style="color: var(--error)">Editor failed to load: ' + escHtml(err.message || String(err)) + '</span>';
      return;
    }

    var savedContent = result.content;
    currentFilePath = filePath;
    var mountEl = body.querySelector('.file-editor-monaco');
    currentViewerWorktree = fileViewerWorktree;

    // For TS/JS, kick off the project scan in the background so cross-file
    // imports resolve. Awaited below so the current file's model, if the
    // scan created one for it, is available to reuse.
    var projectReady = null;
    if (fileViewerWorktree && window.MonacoProject && isTsJsPath(filePath)) {
      projectReady = window.MonacoProject.loadWorktree(fileViewerWorktree);
    }
    if (projectReady) { try { await projectReady; } catch (_) {} }

    // For LSP-backed languages (currently Python via pyright), start the
    // server on first file open per worktree. LspClient.attachModel handles
    // didOpen/didChange/didClose wiring once the model exists.
    // Triggered after model creation below.

    // `monaco.Uri.file` gives Monaco a proper URI so it can auto-detect the
    // language from the extension. If the project scan already created a
    // model at this URI, reuse it — disposing it would pull the file out of
    // the TS worker's view and silently break cross-file diagnostics. Sync
    // its content to disk only if it hasn't been edited in memory.
    var uri = monaco.Uri.file(filePath);
    var existing = monaco.editor.getModel(uri);
    if (existing && window.MonacoProject && window.MonacoProject.isProjectModel(uri)) {
      currentModel = existing;
      currentModelIsProject = true;
    } else {
      if (existing) { try { existing.dispose(); } catch (_) {} }
      currentModel = monaco.editor.createModel(result.content, undefined, uri);
      currentModelIsProject = false;
    }

    // Register the model with the LSP layer (no-op unless the language has
    // an LSP server configured). Safe to call before editor creation —
    // LspClient only needs the model + the file path.
    if (window.LspClient && fileViewerWorktree) {
      window.LspClient.attachModel(currentModel, filePath, fileViewerWorktree);
    }

    currentEditor = monaco.editor.create(mountEl, {
      model: currentModel,
      theme: currentMonacoTheme(),
      automaticLayout: true,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
      tabSize: 2,
      renderWhitespace: 'selection',
    });

    // Cmd+S intercepts the browser Save page shortcut and routes to our writer.
    currentEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () { saveFile(); });
    currentEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow, function () { goBack(); });
    currentEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.RightArrow, function () { goForward(); });

    // Problems badge: watch markers on this model and update the count pill.
    // onDidChangeMarkers fires with the list of affected URIs; we update only
    // when our current model's URI is in the list. Initial render covers the
    // case where markers already exist (e.g. pyright's first publish landed
    // before the editor was mounted — the stash-and-replay path in lsp-client).
    updateProblemsBadge(monaco, currentModel);
    currentMarkerDisposable = monaco.editor.onDidChangeMarkers(function (uris) {
      if (!currentModel || currentModel.isDisposed()) return;
      var our = currentModel.uri.toString();
      for (var i = 0; i < uris.length; i++) {
        if (uris[i].toString() === our) { updateProblemsBadge(monaco, currentModel); return; }
      }
    });

    // Cmd+click → go-to-definition is wired up by Monaco via the LSP /
    // TS-worker definition providers. We just need to route cross-file
    // targets back through openFileViewer — Monaco calls the code-editor
    // service to open a URI it doesn't own, and by default falls back to
    // null (no-op). Overriding openCodeEditor is the standard Monaco-in-a-
    // host pattern for 0.45.
    interceptCrossFileOpen(currentEditor, monaco);

    function refreshDirtyState() {
      if (!currentModel) return;
      var dirty = currentModel.getValue() !== savedContent;
      if (dirty) {
        statusEl.textContent = 'Modified';
        statusEl.className = 'file-editor-status modified';
      } else {
        statusEl.textContent = '';
        statusEl.className = 'file-editor-status';
      }
      if (saveBtn) saveBtn.disabled = !dirty;
    }

    currentEditor.onDidChangeModelContent(refreshDirtyState);

    // When we reuse a project model, it may already carry unsaved edits from
    // a prior viewing session. Evaluate dirty state now so the Modified
    // indicator and Save button come up correctly without waiting for a keystroke.
    if (currentModelIsProject) refreshDirtyState();

    if (lineNumber) {
      var lineCount = currentModel.getLineCount();
      var target = Math.max(1, Math.min(lineNumber, lineCount));
      currentEditor.revealLineInCenter(target);
      currentEditor.setPosition({ lineNumber: target, column: 1 });
    }
    currentEditor.focus();

    async function saveFile() {
      if (!currentModel) return;
      var content = currentModel.getValue();
      if (content === savedContent) return;
      statusEl.textContent = 'Saving...';
      statusEl.className = 'file-editor-status saving';
      if (saveBtn) saveBtn.disabled = true;
      var writeResult = await window.klaus.writeFile(currentFilePath, content);
      if (writeResult.error) {
        statusEl.textContent = 'Save failed';
        statusEl.className = 'file-editor-status error';
        if (saveBtn) saveBtn.disabled = false;
        return;
      }
      savedContent = content;
      statusEl.textContent = 'Saved';
      statusEl.className = 'file-editor-status saved';
      setTimeout(function () {
        if (statusEl.textContent === 'Saved') {
          statusEl.textContent = '';
          statusEl.className = 'file-editor-status';
        }
      }, 2000);
      if (window.DiffPanel && window.DiffPanel.isVisible()) {
        window.DiffPanel.refresh();
      }
      if (window.LspClient) window.LspClient.notifyDidSave(currentFilePath);
    }
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
    var result = await window.klaus.listFiles(wt);
    if (result.error) {
      fileTree.innerHTML = '<div class="file-tree-empty">Error: ' + escHtml(result.error) + '</div>';
      return;
    }
    fileTreeData = result.files;
    renderFileTree('');
  }

  function renderFileTree(filter) {
    var filtered = fileTreeData;
    if (filter) {
      var q = filter.toLowerCase();
      filtered = fileTreeData.filter(function (f) { return f.toLowerCase().includes(q); });
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
    renderTreeNode(tree, fileTree, 0);
  }

  function renderTreeNode(node, container, depth) {
    var dirs = Object.keys(node).filter(function (k) { return k !== '_files'; }).sort();
    dirs.forEach(function (dir) {
      var dirEl = document.createElement('div');
      dirEl.className = 'file-tree-dir';
      var label = document.createElement('div');
      label.className = 'file-tree-label';
      label.style.paddingLeft = (depth * 16 + 8) + 'px';
      label.innerHTML = '<span class="file-tree-arrow">&#9654;</span> ' + escHtml(dir);
      var children = document.createElement('div');
      children.className = 'file-tree-children';
      children.style.display = 'none';
      label.addEventListener('click', function () {
        var open = children.style.display !== 'none';
        children.style.display = open ? 'none' : '';
        label.querySelector('.file-tree-arrow').innerHTML = open ? '&#9654;' : '&#9660;';
      });
      dirEl.appendChild(label);
      dirEl.appendChild(children);
      container.appendChild(dirEl);
      renderTreeNode(node[dir], children, depth + 1);
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

  fileTreeFilter.addEventListener('input', function () {
    renderFileTree(fileTreeFilter.value);
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
    var result = await window.klaus.searchFiles(wt, query, maxPerFile);
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
    var result = await window.klaus.replaceInFiles(wt, files, query, replacement);
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
    if (!currentEditor || !currentModel || !window.monaco) return;
    var header = fileViewerView.querySelector('.file-viewer-header-inline');
    if (!header) return;
    var pathEl = header.querySelector('.file-viewer-path');
    if (!pathEl) return;
    var fileName = pathEl.textContent;

    // Toggle off if blame is already rendering — restore default line numbers.
    if (currentBlameLines) {
      currentBlameLines = null;
      currentEditor.updateOptions({ lineNumbers: 'on', lineNumbersMinChars: 5 });
      fileViewerView.classList.remove('blame-active');
      return;
    }

    var result = await window.klaus.gitBlame(task.worktreePath, fileName);
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

  return {
    loadFileTree: loadFileTree,
    doProjectSearch: doProjectSearch,
  };
})();
