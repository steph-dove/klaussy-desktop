window.FileBrowser = (function () {
  var escHtml = AppUtils.escHtml;

  var fileViewerContent = document.getElementById('file-viewer-content');
  var fileViewerView = document.getElementById('file-viewer-view');
  var fileTree = document.getElementById('file-tree');
  var fileTreeFilter = document.getElementById('file-tree-filter');
  var projectSearchInput = document.getElementById('project-search-input');
  var projectSearchResults = document.getElementById('project-search-results');
  var searchTimer = null;

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
        '<span class="file-viewer-path">' + escHtml(fileName || filePath) + '</span>' +
        '<span class="file-editor-status"></span>' +
        (runCmd ? '<button class="file-viewer-run-btn" title="Run ' + escHtml(runCmd.friendly) + '">▶</button>' : '') +
        '<button class="file-viewer-save-btn" title="Save (⌘S)" disabled>Save</button>' +
        '<button class="file-viewer-blame-btn" title="Toggle blame annotations">Blame</button>' +
      '</div>' +
      '<div class="file-viewer-body"><div class="file-editor-monaco"></div></div>';

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

    // Cmd+click on a word jumps to the Search tab with that symbol, mirroring
    // the old textarea behavior. A proper go-to-definition lands in Phase I3.
    currentEditor.onMouseDown(function (e) {
      var orig = e.event.browserEvent;
      if (!orig || !(orig.metaKey || orig.ctrlKey)) return;
      if (!e.target || !e.target.position || !fileViewerWorktree) return;
      var word = currentModel.getWordAtPosition(e.target.position);
      if (word && word.word) searchSymbol(word.word, fileViewerWorktree);
    });

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

  function getWordAtPoint(element, x, y) {
    if (!element || !element.textContent) return null;
    var range = document.caretRangeFromPoint(x, y);
    if (!range) return null;
    var node = range.startNode || range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return null;
    var text = node.textContent;
    var offset = range.startOffset;
    var start = offset;
    var end = offset;
    var wordChars = /[a-zA-Z0-9_$]/;
    while (start > 0 && wordChars.test(text[start - 1])) start--;
    while (end < text.length && wordChars.test(text[end])) end++;
    return text.substring(start, end);
  }

  function searchSymbol(word, worktreePath) {
    document.querySelectorAll('#diff-tabs .diff-tab').forEach(function (t) { t.classList.remove('active'); });
    document.querySelector('#diff-tabs .diff-tab[data-tab="search"]').classList.add('active');
    ['changes-tab-content', 'pr-tab-content', 'files-tab-content'].forEach(function (id) {
      document.getElementById(id).style.display = 'none';
    });
    document.getElementById('search-tab-content').style.display = '';
    projectSearchInput.value = word;
    doProjectSearch();
  }

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
    var query = projectSearchInput.value.trim();
    if (!query) {
      projectSearchResults.innerHTML = '';
      return;
    }
    var task = AppState.activeTaskId ? AppState.tasks.get(AppState.activeTaskId) : null;
    var wt = overrideWt || (task ? task.worktreePath : null);
    if (!wt) {
      projectSearchResults.innerHTML = '<div class="file-tree-empty">No active task</div>';
      return;
    }
    projectSearchResults.innerHTML = '<div class="file-tree-empty">Searching...</div>';
    var result = await window.klaus.searchFiles(wt, query);
    if (result.error) {
      projectSearchResults.innerHTML = '<div class="file-tree-empty">Error: ' + escHtml(result.error) + '</div>';
      return;
    }
    if (result.results.length === 0) {
      projectSearchResults.innerHTML = '<div class="file-tree-empty">No matches found</div>';
      return;
    }
    var grouped = {};
    result.results.forEach(function (r) {
      if (!grouped[r.file]) grouped[r.file] = [];
      grouped[r.file].push(r);
    });
    projectSearchResults.innerHTML = '';
    Object.keys(grouped).forEach(function (file) {
      var fileHeader = document.createElement('div');
      fileHeader.className = 'search-result-file';
      fileHeader.textContent = file;
      fileHeader.addEventListener('click', function () {
        window.openFileViewer(wt + '/' + file, file);
      });
      projectSearchResults.appendChild(fileHeader);
      grouped[file].forEach(function (match) {
        var line = document.createElement('div');
        line.className = 'search-result-line';
        line.innerHTML = '<span class="search-line-num">' + match.line + '</span>' + escHtml(match.text.substring(0, 200));
        line.addEventListener('click', function () {
          window.openFileViewer(wt + '/' + file, file, match.line);
        });
        projectSearchResults.appendChild(line);
      });
    });
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
