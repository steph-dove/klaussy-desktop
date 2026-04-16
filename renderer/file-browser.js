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

    fileViewerContent.style.display = 'block';
    fileViewerView.innerHTML = '<div class="file-viewer-header-inline"><span class="file-viewer-path">' + escHtml(fileName || filePath) + '</span><button class="file-viewer-blame-btn" title="Toggle blame annotations">Blame</button></div><div class="file-viewer-body">Loading...</div>';

    fileViewerView.querySelector('.file-viewer-blame-btn').addEventListener('click', function () {
      window.toggleBlame();
    });

    var result = await window.klaus.readFile(filePath);
    var body = fileViewerView.querySelector('.file-viewer-body');
    if (result.error) {
      body.innerHTML = '<span style="color: var(--error)">Error: ' + escHtml(result.error) + '</span>';
      return;
    }

    var ext = result.ext || '';
    var langMap = { js: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', md: 'markdown', json: 'json', html: 'xml', htm: 'xml', xml: 'xml', css: 'css', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'ini', sql: 'sql', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp' };
    var lang = langMap[ext];
    var highlighted;
    if (lang && window.hljs && window.hljs.getLanguage(lang)) {
      highlighted = window.hljs.highlight(result.content, { language: lang }).value;
    } else if (window.hljs) {
      highlighted = window.hljs.highlightAuto(result.content).value;
    } else {
      highlighted = escHtml(result.content);
    }

    var lines = highlighted.split('\n');
    body.innerHTML = lines.map(function (line, i) {
      var num = i + 1;
      var cls = (lineNumber && num === lineNumber) ? ' file-line-highlight' : '';
      return '<div class="file-view-line' + cls + '" data-line="' + num + '"><span class="file-line-num">' + num + '</span><span class="file-line">' + (line || ' ') + '</span></div>';
    }).join('');

    if (lineNumber) {
      var target = body.querySelector('[data-line="' + lineNumber + '"]');
      if (target) target.scrollIntoView({ block: 'center' });
    }

    body.addEventListener('click', function (e) {
      var sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      var word = getWordAtPoint(e.target, e.clientX, e.clientY);
      if (word && word.length >= 2) {
        searchSymbol(word, fileViewerWorktree);
      }
    });
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
    var path = header.querySelector('.file-viewer-path');
    if (!path) return;
    var fileName = path.textContent;
    var wt = task.worktreePath;
    var existing = fileViewerView.querySelectorAll('.blame-annotation');
    if (existing.length > 0) {
      existing.forEach(function (el) { el.remove(); });
      return;
    }
    var result = await window.klaus.gitBlame(wt, fileName);
    if (result.error || result.lines.length === 0) return;
    var lineEls = fileViewerView.querySelectorAll('.file-view-line');
    result.lines.forEach(function (blame, i) {
      if (i >= lineEls.length) return;
      var anno = document.createElement('span');
      anno.className = 'blame-annotation';
      anno.textContent = blame.hash + ' ' + blame.author.substring(0, 12);
      anno.title = blame.summary;
      lineEls[i].insertBefore(anno, lineEls[i].firstChild);
    });
  };

  return {
    loadFileTree: loadFileTree,
    doProjectSearch: doProjectSearch,
  };
})();
