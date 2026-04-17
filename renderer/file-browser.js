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
    fileViewerView.innerHTML =
      '<div class="file-viewer-header-inline">' +
        '<span class="file-viewer-path">' + escHtml(fileName || filePath) + '</span>' +
        '<span class="file-editor-status"></span>' +
        '<button class="file-viewer-blame-btn" title="Toggle blame annotations">Blame</button>' +
      '</div>' +
      '<div class="file-viewer-body">Loading...</div>';

    fileViewerView.querySelector('.file-viewer-blame-btn').addEventListener('click', function () {
      window.toggleBlame();
    });

    var result = await window.klaus.readFile(filePath);
    var body = fileViewerView.querySelector('.file-viewer-body');
    var statusEl = fileViewerView.querySelector('.file-editor-status');
    if (result.error) {
      body.innerHTML = '<span style="color: var(--error)">Error: ' + escHtml(result.error) + '</span>';
      return;
    }

    var savedContent = result.content;
    var currentFilePath = filePath;

    // Build textarea editor with line numbers gutter
    body.innerHTML =
      '<div class="file-editor-wrap">' +
        '<div class="file-line-gutter" aria-hidden="true"></div>' +
        '<textarea class="file-editor-textarea" spellcheck="false"></textarea>' +
      '</div>';

    var textarea = body.querySelector('.file-editor-textarea');
    var gutter = body.querySelector('.file-line-gutter');
    textarea.value = result.content;

    function updateGutter() {
      var count = textarea.value.split('\n').length;
      var nums = [];
      for (var i = 1; i <= count; i++) nums.push(i);
      gutter.textContent = nums.join('\n');
    }
    updateGutter();

    // Sync gutter scroll with textarea
    textarea.addEventListener('scroll', function () {
      gutter.scrollTop = textarea.scrollTop;
    });

    // Jump to line
    if (lineNumber) {
      var lines = textarea.value.split('\n');
      var pos = 0;
      for (var i = 0; i < Math.min(lineNumber - 1, lines.length); i++) {
        pos += lines[i].length + 1;
      }
      textarea.setSelectionRange(pos, pos);
      // Scroll line into view — approximate line height
      requestAnimationFrame(function () {
        textarea.focus();
        var approxLineH = parseFloat(getComputedStyle(textarea).lineHeight) || 18;
        textarea.scrollTop = Math.max(0, (lineNumber - 5) * approxLineH);
        gutter.scrollTop = textarea.scrollTop;
      });
    }

    // Track modifications
    textarea.addEventListener('input', function () {
      updateGutter();
      if (textarea.value !== savedContent) {
        statusEl.textContent = 'Modified';
        statusEl.className = 'file-editor-status modified';
      } else {
        statusEl.textContent = '';
        statusEl.className = 'file-editor-status';
      }
    });

    // Tab inserts spaces, Cmd/Ctrl+S saves
    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var start = textarea.selectionStart;
        var end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        textarea.dispatchEvent(new Event('input'));
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveFile();
      }
    });

    async function saveFile() {
      statusEl.textContent = 'Saving...';
      statusEl.className = 'file-editor-status saving';
      var content = textarea.value;
      var writeResult = await window.klaus.writeFile(currentFilePath, content);
      if (writeResult.error) {
        statusEl.textContent = 'Save failed';
        statusEl.className = 'file-editor-status error';
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

  async function loadFileTree(overrideWt) {
    var task = AppState.activeTaskId ? AppState.tasks.get(AppState.activeTaskId) : null;
    var wt = overrideWt || (task ? task.worktreePath : null);
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
    var header = fileViewerView.querySelector('.file-viewer-header-inline');
    if (!header) return;
    var pathEl = header.querySelector('.file-viewer-path');
    if (!pathEl) return;
    var fileName = pathEl.textContent;
    var wt = task.worktreePath;
    var gutter = fileViewerView.querySelector('.file-line-gutter');
    if (!gutter) return;

    // Toggle off if blame is showing
    if (gutter.dataset.blame === '1') {
      gutter.dataset.blame = '';
      gutter.classList.remove('blame-active');
      var textarea = fileViewerView.querySelector('.file-editor-textarea');
      if (textarea) {
        var count = textarea.value.split('\n').length;
        var nums = [];
        for (var i = 1; i <= count; i++) nums.push(i);
        gutter.textContent = nums.join('\n');
      }
      return;
    }

    var result = await window.klaus.gitBlame(wt, fileName);
    if (result.error || result.lines.length === 0) return;
    gutter.dataset.blame = '1';
    gutter.classList.add('blame-active');
    gutter.textContent = result.lines.map(function (blame, i) {
      return blame.hash.substring(0, 7) + ' ' + blame.author.substring(0, 10);
    }).join('\n');
  };

  return {
    loadFileTree: loadFileTree,
    doProjectSearch: doProjectSearch,
  };
})();
