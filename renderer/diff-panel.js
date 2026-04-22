// Diff panel module — git status, diff viewer, staging, commits, inline comments
window.DiffPanel = (function () {
  let panelEl, fileListEl, diffViewEl, commitAreaEl, commitInput;
  let currentWorktreePath = null;
  let currentFiles = [];
  let selectedFile = null;
  let commentCallback = null;
  let refreshInterval = null;
  let watchedWorktreePath = null;
  let unsubscribeWatcher = null;
  let currentParsedHunks = [];
  let currentRawDiff = '';
  let currentDiffStaged = false;
  let selectedLineKeys = new Set();
  let refreshPaused = false;
  let diffViewMode = (typeof localStorage !== 'undefined' && localStorage.getItem('diffViewMode')) || 'unified';

  // Branch diff mode state
  let diffMode = 'working'; // 'working' or 'branch'
  let baseBranch = null;
  let branchList = [];
  let remoteList = [];

  function init() {
    panelEl = document.getElementById('diff-panel');
    fileListEl = document.getElementById('diff-file-list');
    diffViewEl = document.getElementById('diff-view');
    commitAreaEl = document.getElementById('commit-area');
    commitInput = document.getElementById('commit-message');

    document.getElementById('btn-refresh-diff').addEventListener('click', refresh);
    document.getElementById('btn-close-diff').addEventListener('click', hide);

    // D1: Fetch & Pull
    document.getElementById('btn-fetch').addEventListener('click', async function () {
      this.disabled = true;
      this.textContent = '...';
      var result = await window.klaus.gitFetch(currentWorktreePath);
      this.disabled = false;
      this.textContent = 'Fetch';
      updateAheadBehind();
      refresh();
    });
    document.getElementById('btn-pull').addEventListener('click', async function () {
      this.disabled = true;
      this.textContent = '...';
      var result = await window.klaus.gitPull(currentWorktreePath);
      this.disabled = false;
      this.textContent = 'Pull';
      updateAheadBehind();
      refresh();
    });
    document.getElementById('btn-commit').addEventListener('click', toggleCommitArea);
    document.getElementById('btn-push').addEventListener('click', pushChanges);
    document.getElementById('btn-create-pr').addEventListener('click', createPR);
    document.getElementById('btn-do-commit').addEventListener('click', doCommit);

    commitInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doCommit();
      }
      if (e.key === 'Escape') {
        commitAreaEl.style.display = 'none';
      }
    });

    initSelectionExplain();
  }

  // --- Selection-based Explain ---

  function initSelectionExplain() {
    // Create floating action group (Explain + Comment).
    var fab = document.createElement('div');
    fab.id = 'diff-selection-fab';
    fab.style.display = 'none';
    fab.innerHTML =
      '<button id="explain-selection-btn" type="button" title="Explain selection">Explain</button>' +
      '<button id="comment-selection-btn" type="button" title="Post as PR review comment">Comment</button>';
    document.body.appendChild(fab);

    // Create right-click context menu
    var menu = document.createElement('div');
    menu.id = 'diff-context-menu';
    menu.style.display = 'none';
    menu.innerHTML =
      '<div class="diff-ctx-item" data-action="explain">Explain Selection</div>' +
      '<div class="diff-ctx-item" data-action="comment">Post PR Comment…</div>';
    document.body.appendChild(menu);

    var commentBtn = fab.querySelector('#comment-selection-btn');

    // Track selection in the diff view area
    var diffContent = document.getElementById('diff-content');
    if (!diffContent) return;

    // Show floating button when text is selected in the diff
    // Also pause auto-refresh so the selection isn't lost
    document.addEventListener('selectionchange', function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        fab.style.display = 'none';
        refreshPaused = false;
        return;
      }
      // Check if the selection is inside the diff view
      var anchor = sel.anchorNode;
      var focus = sel.focusNode;
      if (!diffContent.contains(anchor) && !diffContent.contains(focus)) {
        fab.style.display = 'none';
        refreshPaused = false;
        return;
      }
      // Pause refresh while text is selected
      refreshPaused = true;
      // Position near the end of the selection
      var range = sel.getRangeAt(0);
      var rect = range.getBoundingClientRect();
      fab.style.display = 'flex';
      fab.style.top = (rect.top - 32 + window.scrollY) + 'px';
      fab.style.left = Math.max(4, rect.right - fab.offsetWidth) + 'px';
    });

    // Prevent selection loss on button mousedown
    fab.addEventListener('mousedown', function (e) { e.preventDefault(); });

    fab.querySelector('#explain-selection-btn').addEventListener('click', function () {
      var text = getSelectedDiffText();
      if (text) { fab.style.display = 'none'; explainSelection(text); }
    });

    commentBtn.addEventListener('click', function () {
      fab.style.display = 'none';
      commentOnSelection();
    });

    // Right-click context menu in diff area
    diffContent.addEventListener('contextmenu', function (e) {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
      if (!diffContent.contains(sel.anchorNode)) return;

      e.preventDefault();
      menu.style.display = 'block';
      menu.style.top = e.clientY + 'px';
      menu.style.left = e.clientX + 'px';
    });

    menu.addEventListener('click', function (e) {
      var item = e.target.closest('.diff-ctx-item');
      if (!item) return;
      menu.style.display = 'none';
      if (item.dataset.action === 'explain') {
        var text = getSelectedDiffText();
        if (text) explainSelection(text);
      } else if (item.dataset.action === 'comment') {
        commentOnSelection();
      }
    });

    // Hide context menu on click elsewhere
    document.addEventListener('click', function () {
      menu.style.display = 'none';
    });
  }

  // Compute the PR comment range (side + line, optional start) from the current
  // text selection — maps selected text to .diff-line elements with data-*-ln.
  function computeSelectionCommentRange() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    var range = sel.getRangeAt(0);
    var allLines = Array.from(diffViewEl.querySelectorAll('.diff-line'));
    var touched = allLines.filter(function (el) {
      try { return range.intersectsNode(el); } catch (_) { return false; }
    });
    var rightLines = [], leftLines = [];
    touched.forEach(function (el) {
      if (el.classList.contains('diff-add') || el.classList.contains('diff-context')) {
        var n = parseInt(el.dataset.newLn, 10);
        if (!isNaN(n)) rightLines.push(n);
      } else if (el.classList.contains('diff-del')) {
        var o = parseInt(el.dataset.oldLn, 10);
        if (!isNaN(o)) leftLines.push(o);
      }
    });
    var useRight = rightLines.length > 0;
    var pool = useRight ? rightLines : leftLines;
    if (!pool.length) return null;
    pool.sort(function (a, b) { return a - b; });
    var side = useRight ? 'RIGHT' : 'LEFT';
    var first = pool[0], last = pool[pool.length - 1];
    var out = { side: side, line: last };
    if (first !== last) { out.startLine = first; out.startSide = side; }
    // Remember the anchor element for where to insert the composer
    out.anchorEl = touched[touched.length - 1];
    return out;
  }

  function commentOnSelection() {
    var pr = (window.PRPanel && window.PRPanel.getCurrentPR) ? window.PRPanel.getCurrentPR() : null;
    if (!pr || !pr.number || !pr.headRefOid) {
      alert('No PR loaded for this worktree.');
      return;
    }
    var range = computeSelectionCommentRange();
    if (!range) {
      alert('Select one or more diff lines (add / delete / context) to comment on.');
      return;
    }
    var file = selectedFile;
    if (!file) { alert('No file selected.'); return; }

    // Clear selection + dismiss any existing composer
    window.getSelection().removeAllRanges();
    var existing = diffViewEl.querySelector('.diff-comment-area');
    if (existing) existing.remove();

    var rangeLabel = range.startLine
      ? file + ':L' + range.startLine + '-L' + range.line
      : file + ':L' + range.line;

    var area = document.createElement('div');
    area.className = 'diff-comment-area';
    area.innerHTML =
      '<div class="diff-comment-header">' +
        '<span>Comment on <code>' + escHtml(rangeLabel) + '</code></span>' +
        '<button class="diff-comment-close" type="button" title="Close">&times;</button>' +
      '</div>' +
      '<textarea class="diff-comment-input" placeholder="Write a comment..." rows="3"></textarea>' +
      '<div class="diff-comment-actions">' +
        '<button class="diff-comment-post" type="button">Post</button>' +
      '</div>';

    var anchor = range.anchorEl || diffViewEl.lastElementChild;
    anchor.after(area);

    var ta = area.querySelector('.diff-comment-input');
    var postBtn = area.querySelector('.diff-comment-post');
    ta.focus();

    function close() { area.remove(); refreshPaused = false; }
    area.querySelector('.diff-comment-close').addEventListener('click', close);
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') close();
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); postBtn.click(); }
    });

    postBtn.addEventListener('click', async function () {
      var body = ta.value.trim();
      if (!body) return;
      postBtn.disabled = true;
      postBtn.textContent = '...';
      var result = await window.klaus.prAddReviewComment({
        worktreePath: currentWorktreePath,
        prNumber: pr.number,
        body: body,
        path: file,
        line: range.line,
        side: range.side,
        startLine: range.startLine || null,
        startSide: range.startSide || null,
        commitId: pr.headRefOid,
      });
      if (result && result.error) {
        alert('Post failed: ' + result.error);
        postBtn.disabled = false;
        postBtn.textContent = 'Post';
        return;
      }
      close();
      if (window.PRPanel && window.PRPanel.loadPR) window.PRPanel.loadPR();
    });
  }

  function getSelectedDiffText() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    return sel.toString().trim();
  }

  async function explainSelection(text) {
    // Remove any existing explanation
    var existing = diffViewEl.querySelector('.diff-explanation');
    if (existing) existing.remove();

    // Find where to insert the explanation — after the last selected line
    var sel = window.getSelection();
    var anchor = sel.focusNode;
    var lineEl = anchor;
    while (lineEl && !lineEl.classList) lineEl = lineEl.parentElement;
    while (lineEl && !lineEl.classList.contains('diff-line')) lineEl = lineEl.parentElement;
    var insertAfter = lineEl || diffViewEl.lastElementChild;

    // Show loading
    var explanationEl = document.createElement('div');
    explanationEl.className = 'diff-explanation';
    explanationEl.innerHTML = '<div class="diff-explanation-header"><span>Explanation</span><button class="diff-explanation-close">&times;</button></div>' +
      '<div class="diff-explanation-body">Thinking...</div>';
    insertAfter.after(explanationEl);

    explanationEl.querySelector('.diff-explanation-close').addEventListener('click', function () {
      explanationEl.remove();
      refreshPaused = false;
    });

    // Clear selection but keep refresh paused until explanation is dismissed
    window.getSelection().removeAllRanges();

    var file = selectedFile || 'unknown';
    var result = await window.klaus.explainDiff(currentWorktreePath, file, text);

    if (result.error) {
      explanationEl.querySelector('.diff-explanation-body').className = 'diff-explanation-body diff-error';
      explanationEl.querySelector('.diff-explanation-body').textContent = result.error;
    } else {
      explanationEl.querySelector('.diff-explanation-body').textContent = result.explanation;
    }
  }

  // H3: file-watch replaces 5s polling. A 30s safety-net interval catches the
  // rare case where fs.watch misses an event (e.g. filesystem remounts).
  function startWatching(worktreePath) {
    if (watchedWorktreePath === worktreePath) return;
    stopWatching();
    if (!worktreePath) return;
    watchedWorktreePath = worktreePath;
    window.klaus.watchWorktree(worktreePath);
    unsubscribeWatcher = window.klaus.onWorktreeChanged(function (data) {
      if (data.worktreePath !== watchedWorktreePath) return;
      refresh();
      updateAheadBehind();
    });
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(refresh, 30000);
  }

  function stopWatching() {
    if (unsubscribeWatcher) { try { unsubscribeWatcher(); } catch (_) {} unsubscribeWatcher = null; }
    if (watchedWorktreePath) { window.klaus.unwatchWorktree(watchedWorktreePath); watchedWorktreePath = null; }
    if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
  }

  async function show(worktreePath) {
    currentWorktreePath = worktreePath;
    panelEl.classList.add('visible');
    selectedFile = null;
    branchList = [];
    remoteList = [];
    diffViewEl.innerHTML = '<div class="diff-empty">Select a file to view diff</div>';
    await refresh();
    updateAheadBehind();
    startWatching(worktreePath);
    // Trigger refit after panel appears
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  }

  function hide() {
    panelEl.classList.remove('visible');
    stopWatching();
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  }

  function isVisible() {
    return panelEl.classList.contains('visible');
  }

  function updateWorktree(worktreePath) {
    var changed = currentWorktreePath !== worktreePath;
    currentWorktreePath = worktreePath;
    if (changed) {
      selectedFile = null;
      diffViewEl.innerHTML = '<div class="diff-empty">Select a file to view diff</div>';
    }
    // Force refresh even if paused (this is an explicit task switch, not auto-refresh)
    refreshPaused = false;
    refresh();
    updateAheadBehind();
    if (isVisible()) startWatching(worktreePath);
    // Reload the currently active non-Changes tab
    if (window._reloadDiffTab) {
      var activeTab = document.querySelector('#diff-tabs .diff-tab.active');
      if (activeTab && activeTab.dataset.tab !== 'changes') {
        window._reloadDiffTab(activeTab.dataset.tab, worktreePath);
      }
    }
  }

  async function refresh() {
    if (!currentWorktreePath) return;
    if (refreshPaused) return;
    // Don't refresh if an explanation is being shown
    if (diffViewEl && diffViewEl.querySelector('.diff-explanation')) return;

    if (diffMode === 'branch') {
      await refreshBranchDiff();
      return;
    }

    const result = await window.klaus.gitStatus(currentWorktreePath);
    if (result.error) {
      fileListEl.innerHTML = '<div class="diff-error">' + escHtml(result.error) + '</div>';
      return;
    }
    currentFiles = result.files;
    renderFileList(result.files, result.branch);

    if (selectedFile) {
      const still = currentFiles.find(function (f) { return f.file === selectedFile; });
      if (still) {
        await showFileDiff(selectedFile, still.staged);
      } else {
        selectedFile = null;
        diffViewEl.innerHTML = '<div class="diff-empty">File no longer has changes</div>';
      }
    }
  }

  async function refreshBranchDiff() {
    if (!baseBranch) {
      fileListEl.innerHTML = renderModeToggle('') + '<div class="diff-empty">Select a base branch</div>';
      return;
    }
    var result = await window.klaus.gitBranchFiles(currentWorktreePath, baseBranch);
    if (result.error) {
      fileListEl.innerHTML = renderModeToggle('') + '<div class="diff-error">' + escHtml(result.error) + '</div>';
      return;
    }
    currentFiles = result.files.map(function (f) { return { status: f.status, file: f.file, staged: false }; });
    renderBranchFileList(result.files);

    if (selectedFile) {
      var still = currentFiles.find(function (f) { return f.file === selectedFile; });
      if (still) {
        await showFileDiff(selectedFile, false);
      } else {
        selectedFile = null;
        diffViewEl.innerHTML = '<div class="diff-empty">File no longer has changes</div>';
      }
    }
  }

  function renderModeToggle(branchName) {
    var workingActive = diffMode === 'working' ? ' active' : '';
    var branchActive = diffMode === 'branch' ? ' active' : '';

    var html = '<div class="diff-mode-bar">';
    html += '<div class="diff-mode-toggle">';
    html += '<button class="diff-mode-btn js-mode-working' + workingActive + '">Working</button>';
    html += '<button class="diff-mode-btn js-mode-branch' + branchActive + '">Branch</button>';
    html += '</div>';

    if (diffMode === 'branch') {
      html += '<select class="diff-base-select js-base-select">';
      var allBranches = branchList.concat(remoteList);
      for (var i = 0; i < allBranches.length; i++) {
        var b = allBranches[i];
        var sel = b === baseBranch ? ' selected' : '';
        var isRemote = remoteList.indexOf(b) >= 0 && branchList.indexOf(b) < 0;
        html += '<option value="' + escAttr(b) + '"' + sel + '>' + escHtml(b) + '</option>';
      }
      html += '</select>';
    } else {
      if (branchName) {
        html += '<span class="diff-branch-label">on <strong>' + escHtml(branchName) + '</strong></span>';
      }
    }

    html += '</div>';
    return html;
  }

  function bindModeToggle() {
    var workingBtn = fileListEl.querySelector('.js-mode-working');
    var branchBtn = fileListEl.querySelector('.js-mode-branch');
    var selectEl = fileListEl.querySelector('.js-base-select');

    if (workingBtn) {
      workingBtn.addEventListener('click', function () {
        if (diffMode === 'working') return;
        diffMode = 'working';
        selectedFile = null;
        diffViewEl.innerHTML = '<div class="diff-empty">Select a file to view diff</div>';
        commitAreaEl.style.display = 'none';
        document.getElementById('diff-footer').style.display = '';
        refresh();
      });
    }

    if (branchBtn) {
      branchBtn.addEventListener('click', async function () {
        if (diffMode === 'branch') return;
        diffMode = 'branch';
        selectedFile = null;
        diffViewEl.innerHTML = '<div class="diff-empty">Select a file to view diff</div>';
        document.getElementById('diff-footer').style.display = '';

        // Fetch branches if not cached
        if (branchList.length === 0) {
          var result = await window.klaus.gitBranches(currentWorktreePath);
          branchList = result.branches || [];
          remoteList = result.remotes || [];
        }
        // Auto-select a sensible default if not set
        if (!baseBranch) {
          var defaults = ['main', 'master', 'dev', 'develop'];
          for (var i = 0; i < defaults.length; i++) {
            if (branchList.indexOf(defaults[i]) >= 0 || remoteList.indexOf('origin/' + defaults[i]) >= 0) {
              baseBranch = branchList.indexOf(defaults[i]) >= 0 ? defaults[i] : 'origin/' + defaults[i];
              break;
            }
          }
          if (!baseBranch && branchList.length > 0) baseBranch = branchList[0];
        }
        refresh();
      });
    }

    if (selectEl) {
      selectEl.addEventListener('change', function () {
        baseBranch = selectEl.value;
        selectedFile = null;
        diffViewEl.innerHTML = '<div class="diff-empty">Select a file to view diff</div>';
        refresh();
      });
    }
  }

  function renderBranchFileList(files) {
    var html = renderModeToggle('');

    if (files.length === 0) {
      html += '<div class="diff-empty">No changes from ' + escHtml(baseBranch) + '</div>';
      fileListEl.innerHTML = html;
      bindModeToggle();
      return;
    }

    html += '<div class="diff-section-header"><span>Changed files (' + files.length + ')</span></div>';
    files.forEach(function (f) {
      var statusClass = getBranchStatusClass(f.status);
      var statusLabel = f.status.charAt(0);
      var sel = f.file === selectedFile ? ' selected' : '';
      html +=
        '<div class="diff-file' + sel + '" data-file="' + escAttr(f.file) + '" data-staged="false">' +
          '<span class="diff-file-status ' + statusClass + '">' + statusLabel + '</span>' +
          '<span class="diff-file-name" title="' + escAttr(f.file) + '">' + escHtml(basename(f.file)) + '</span>' +
          '<span class="diff-file-path" title="' + escAttr(f.file) + '">' + escHtml(dirname(f.file)) + '</span>' +
        '</div>';
    });

    fileListEl.innerHTML = html;
    bindModeToggle();

    fileListEl.querySelectorAll('.diff-file').forEach(function (el) {
      var file = el.dataset.file;
      el.addEventListener('click', function () {
        selectedFile = file;
        fileListEl.querySelectorAll('.diff-file').forEach(function (f) { f.classList.remove('selected'); });
        el.classList.add('selected');
        showFileDiff(file, false);
      });
    });
  }

  function getBranchStatusClass(status) {
    var s = status.trim();
    if (s.startsWith('M')) return 'modified';
    if (s.startsWith('A')) return 'added';
    if (s.startsWith('D')) return 'deleted';
    if (s.startsWith('R')) return 'renamed';
    return '';
  }

  function renderFileList(files, branch) {
    var staged = files.filter(function (f) { return f.staged; });
    var unstaged = files.filter(function (f) { return !f.staged; });

    var html = renderModeToggle(branch);

    if (files.length === 0) {
      html += '<div class="diff-empty">No changes</div>';
      fileListEl.innerHTML = html;
      bindModeToggle();
      return;
    }

    if (staged.length > 0) {
      html += '<div class="diff-section-header"><span>Staged (' + staged.length + ')</span>';
      html += '<button class="diff-section-btn js-unstage-all" title="Unstage all">Unstage All</button></div>';
      staged.forEach(function (f) { html += renderFileItem(f, true); });
    }

    if (unstaged.length > 0) {
      html += '<div class="diff-section-header"><span>Changes (' + unstaged.length + ')</span>';
      html += '<button class="diff-section-btn js-stage-all" title="Stage all">Stage All</button></div>';
      unstaged.forEach(function (f) { html += renderFileItem(f, false); });
    }

    fileListEl.innerHTML = html;
    bindModeToggle();
    addCheckoutToBranchSelect();
    checkConflicts();

    // Bind section buttons
    var stageAllBtn = fileListEl.querySelector('.js-stage-all');
    if (stageAllBtn) stageAllBtn.addEventListener('click', stageAll);
    var unstageAllBtn = fileListEl.querySelector('.js-unstage-all');
    if (unstageAllBtn) unstageAllBtn.addEventListener('click', unstageAll);

    // Bind file clicks and action buttons
    fileListEl.querySelectorAll('.diff-file').forEach(function (el) {
      var file = el.dataset.file;
      var isStaged = el.dataset.staged === 'true';

      el.addEventListener('click', function (e) {
        if (e.target.closest('.diff-file-action')) return;
        selectedFile = file;
        fileListEl.querySelectorAll('.diff-file').forEach(function (f) { f.classList.remove('selected'); });
        el.classList.add('selected');
        showFileDiff(file, isStaged);
      });

      el.addEventListener('dblclick', function (e) {
        if (e.target.closest('.diff-file-action')) return;
        e.preventDefault();
        e.stopPropagation();
        window.getSelection().removeAllRanges();
        var fab = document.getElementById('explain-selection-btn');
        if (fab) fab.style.display = 'none';
        refreshPaused = true;
        var fullPath = currentWorktreePath + '/' + file;
        setTimeout(function () {
          if (typeof window.openFileViewer === 'function') {
            window.openFileViewer(fullPath, file);
          }
          refreshPaused = false;
        }, 50);
      });
    });

    fileListEl.querySelectorAll('.diff-file-action').forEach(function (btn) {
      btn.addEventListener('click', async function (e) {
        e.stopPropagation();
        var file = btn.dataset.file;
        var action = btn.dataset.action;
        if (action === 'stage') {
          await window.klaus.gitStage(currentWorktreePath, [file]);
        } else if (action === 'unstage') {
          await window.klaus.gitUnstage(currentWorktreePath, [file]);
        } else if (action === 'discard') {
          // Use a visible confirmation
          btn.textContent = '?';
          btn.title = 'Click again to confirm discard';
          btn.dataset.action = 'discard-confirm';
        } else if (action === 'discard-confirm') {
          await window.klaus.gitDiscard(currentWorktreePath, [file]);
        }
        if (action !== 'discard') await refresh();
      });
    });
  }

  function renderFileItem(f, isStaged) {
    var statusClass = getStatusClass(f.status);
    var statusLabel = getStatusLabel(f.status);
    var sel = f.file === selectedFile ? ' selected' : '';

    var actions = '';
    if (isStaged) {
      actions = '<button class="diff-file-action" data-file="' + escAttr(f.file) + '" data-action="unstage" title="Unstage">\u2212</button>';
    } else {
      actions =
        '<button class="diff-file-action" data-file="' + escAttr(f.file) + '" data-action="stage" title="Stage">+</button>' +
        '<button class="diff-file-action" data-file="' + escAttr(f.file) + '" data-action="discard" title="Discard">\u2715</button>';
    }

    return (
      '<div class="diff-file' + sel + '" data-file="' + escAttr(f.file) + '" data-staged="' + isStaged + '">' +
        '<span class="diff-file-status ' + statusClass + '">' + statusLabel + '</span>' +
        '<span class="diff-file-name" title="' + escAttr(f.file) + '">' + escHtml(basename(f.file)) + '</span>' +
        '<span class="diff-file-path" title="' + escAttr(f.file) + '">' + escHtml(dirname(f.file)) + '</span>' +
        '<span class="diff-file-actions">' + actions + '</span>' +
      '</div>'
    );
  }

  async function showFileDiff(file, staged) {
    var result;
    currentDiffStaged = !!staged;
    selectedLineKeys = new Set();
    if (diffMode === 'branch' && baseBranch) {
      result = await window.klaus.gitBranchDiff(currentWorktreePath, baseBranch, file);
    } else {
      result = await window.klaus.gitDiff(currentWorktreePath, file, staged);
    }
    if (result.error || !result.diff) {
      // For untracked files, try to show file content
      if (!result.diff) {
        var fileResult = await window.klaus.readFile(currentWorktreePath + '/' + file);
        if (fileResult.content) {
          var lang = detectLang(file);
          var highlighted = null;
          if (typeof hljs !== 'undefined') {
            try {
              highlighted = lang
                ? hljs.highlight(fileResult.content, { language: lang, ignoreIllegals: true })
                : hljs.highlightAuto(fileResult.content);
            } catch (e) {}
          }
          var hLines = null;
          if (highlighted) {
            hLines = splitHighlightedLines(highlighted.value);
            try { hLines = hLines.map(enhanceLine); } catch (e) {}
          }
          var contentLines = fileResult.content.split('\n');
          diffViewEl.innerHTML = renderViewFullFileLink(file) + '<div class="diff-line diff-header">New file: ' + escHtml(file) + '</div>' +
            contentLines.map(function (line, idx) {
              return '<div class="diff-line diff-add"><span class="diff-prefix">+</span><span class="diff-code">' +
                (hLines ? hLines[idx] : escHtml(line)) + '</span></div>';
            }).join('');
          bindViewFullFileLink(file);
          return;
        }
      }
      diffViewEl.innerHTML = '<div class="diff-empty">No diff available</div>';
      return;
    }
    currentRawDiff = result.diff;
    var diffHtml = diffViewMode === 'split' ? renderDiffSplit(result.diff) : renderDiff(result.diff);
    diffViewEl.innerHTML = renderViewFullFileLink(file) + diffHtml;
    bindViewFullFileLink(file);
    bindViewModeToggle(file);
    bindInlineComments(file);
    bindExplainButtons(file);
    bindPartialStaging(file);
  }

  function renderViewFullFileLink(file) {
    var unifiedActive = diffViewMode === 'unified' ? ' active' : '';
    var splitActive = diffViewMode === 'split' ? ' active' : '';
    return '<div class="diff-view-full-file">'
      + '<a href="#" class="js-view-full-file">View full file</a>'
      + '<a href="#" class="js-edit-full-file">Edit</a>'
      + ' <span class="diff-view-full-path">' + escHtml(file) + '</span>'
      + '<div class="diff-view-mode-toggle" role="group" aria-label="Diff view mode">'
        + '<button type="button" class="diff-view-mode-btn js-view-mode-unified' + unifiedActive + '" title="Unified view">Unified</button>'
        + '<button type="button" class="diff-view-mode-btn js-view-mode-split' + splitActive + '" title="Side-by-side view">Split</button>'
      + '</div>'
      + '</div>';
  }

  function bindViewModeToggle(file) {
    var unifiedBtn = diffViewEl.querySelector('.js-view-mode-unified');
    var splitBtn = diffViewEl.querySelector('.js-view-mode-split');
    function setMode(mode) {
      if (diffViewMode === mode) return;
      diffViewMode = mode;
      try { localStorage.setItem('diffViewMode', mode); } catch (_) {}
      selectedLineKeys = new Set();
      if (file && selectedFile === file) showFileDiff(file, currentDiffStaged);
    }
    if (unifiedBtn) unifiedBtn.addEventListener('click', function () { setMode('unified'); });
    if (splitBtn) splitBtn.addEventListener('click', function () { setMode('split'); });
  }

  function bindViewFullFileLink(file) {
    var link = diffViewEl.querySelector('.js-view-full-file');
    if (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        var fullPath = currentWorktreePath + '/' + file;
        if (typeof window.openFileViewer === 'function') {
          window.openFileViewer(fullPath, file);
        }
      });
    }
    var editLink = diffViewEl.querySelector('.js-edit-full-file');
    if (editLink) {
      editLink.addEventListener('click', function (e) {
        e.preventDefault();
        var fullPath = currentWorktreePath + '/' + file;
        if (typeof window.openFileViewer === 'function') {
          window.openFileViewer(fullPath, file);
        }
      });
    }
  }

  function bindInlineComments(file) {
    diffViewEl.querySelectorAll('.diff-line.diff-add, .diff-line.diff-del, .diff-line.diff-context').forEach(function (lineEl) {
      lineEl.addEventListener('click', function () {
        // Don't trigger comment if user is selecting text
        var sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        if (!commentCallback) return;
        // Remove any existing inline comment
        var existing = diffViewEl.querySelector('.inline-comment');
        if (existing) existing.remove();

        var wrap = document.createElement('div');
        wrap.className = 'inline-comment';
        wrap.innerHTML = '<input type="text" placeholder="Comment for Claude..." class="inline-comment-input" />';
        lineEl.after(wrap);

        var inp = wrap.querySelector('input');
        inp.focus();
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            var text = inp.value.trim();
            if (text && commentCallback) commentCallback('Regarding ' + file + ': ' + text);
            wrap.remove();
          }
          if (e.key === 'Escape') wrap.remove();
        });
      });
    });
  }

  function bindExplainButtons(file) {
    diffViewEl.querySelectorAll('.diff-explain-btn').forEach(function (btn) {
      btn.addEventListener('click', async function (e) {
        e.stopPropagation();
        var hunkIndex = parseInt(btn.dataset.hunkIndex, 10);
        var hunk = currentParsedHunks[hunkIndex];
        if (!hunk) return;

        // Remove any existing explanation
        var existing = diffViewEl.querySelector('.diff-explanation');
        if (existing) existing.remove();

        // Show loading state
        btn.disabled = true;
        btn.textContent = 'Thinking...';

        var hunkText = hunk.lines.join('\n');
        var result = await window.klaus.explainDiff(currentWorktreePath, file, hunkText);

        btn.disabled = false;
        btn.textContent = 'Explain';

        // Insert explanation below the hunk header
        var hunkEl = btn.closest('.diff-hunk');
        var explanationEl = document.createElement('div');
        explanationEl.className = 'diff-explanation';

        if (result.error) {
          explanationEl.innerHTML = '<div class="diff-explanation-header"><span>Explanation</span><button class="diff-explanation-close">&times;</button></div>' +
            '<div class="diff-explanation-body diff-error">' + escHtml(result.error) + '</div>';
        } else {
          explanationEl.innerHTML = '<div class="diff-explanation-header"><span>Explanation</span><button class="diff-explanation-close">&times;</button></div>' +
            '<div class="diff-explanation-body">' + escHtml(result.explanation) + '</div>';
        }

        hunkEl.after(explanationEl);

        explanationEl.querySelector('.diff-explanation-close').addEventListener('click', function () {
          explanationEl.remove();
        });
      });
    });
  }

  // D6: Partial-hunk staging
  // Build a unified patch from a subset of selected lines within currentParsedHunks.
  //   Stage   (pre=HEAD, post=working; apply forward): unselected - → context, unselected + → drop
  //   Unstage (pre=HEAD, post=index;   apply with -R): unselected + → context, unselected - → drop
  // The post-image of the patch must match the state we apply against (working tree for
  // stage, index for unstage -R), which is why the rules are swapped.
  function buildPartialPatch(file, lineKeys, reverse) {
    if (!currentRawDiff || !currentParsedHunks.length) return null;

    // Extract file header: everything from the start of currentRawDiff up to the first @@.
    var rawLines = currentRawDiff.split('\n');
    var headerLines = [];
    for (var i = 0; i < rawLines.length; i++) {
      if (rawLines[i].startsWith('@@')) break;
      headerLines.push(rawLines[i]);
    }
    // Guard: no diff --git header means we synthesize one so git apply knows the path.
    var hasGitHeader = headerLines.some(function (l) { return l.startsWith('diff --git'); });
    if (!hasGitHeader) {
      headerLines = ['diff --git a/' + file + ' b/' + file, '--- a/' + file, '+++ b/' + file];
    }

    var patchHunks = [];
    for (var h = 0; h < currentParsedHunks.length; h++) {
      var hunk = currentParsedHunks[h];
      var header = hunk.lines[0];
      var body = hunk.lines.slice(1);

      // Does this hunk contain any selected lines? If not, skip.
      var anySelected = false;
      for (var k = 1; k <= body.length; k++) {
        if (lineKeys.has(h + ':' + k)) { anySelected = true; break; }
      }
      if (!anySelected) continue;

      // Transform body lines
      var outLines = [];
      var lastKept = false;
      for (var b = 0; b < body.length; b++) {
        var bodyLine = body[b];
        var key = h + ':' + (b + 1);
        var selected = lineKeys.has(key);

        if (bodyLine.startsWith('+')) {
          if (selected) { outLines.push(bodyLine); lastKept = true; }
          else if (reverse) { outLines.push(' ' + bodyLine.substring(1)); lastKept = true; } // unstage: + → context
          else { lastKept = false; } // stage: unselected + → drop
        } else if (bodyLine.startsWith('-')) {
          if (selected) { outLines.push(bodyLine); lastKept = true; }
          else if (reverse) { lastKept = false; } // unstage: unselected - → drop
          else { outLines.push(' ' + bodyLine.substring(1)); lastKept = true; } // stage: - → context
        } else if (bodyLine.startsWith('\\')) {
          // "\ No newline at end of file" applies to the previous line
          if (lastKept) outLines.push(bodyLine);
        } else {
          outLines.push(bodyLine); // context
          lastKept = true;
        }
      }

      // Recompute @@ header: old_count = context + '-' lines; new_count = context + '+' lines.
      var hm = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (!hm) continue;
      var oldStart = parseInt(hm[1], 10);
      var newStart = parseInt(hm[2], 10);
      var trailing = hm[3] || '';
      var oldCount = 0, newCount = 0;
      for (var o = 0; o < outLines.length; o++) {
        var c = outLines[o].charAt(0);
        if (c === ' ') { oldCount++; newCount++; }
        else if (c === '-') { oldCount++; }
        else if (c === '+') { newCount++; }
      }
      // Skip hunks that became no-ops (all context) — can happen if all selections dropped.
      var hasChange = outLines.some(function (l) {
        return l.charAt(0) === '+' || l.charAt(0) === '-';
      });
      if (!hasChange) continue;

      var newHeader = '@@ -' + oldStart + ',' + oldCount + ' +' + newStart + ',' + newCount + ' @@' + trailing;
      patchHunks.push(newHeader);
      patchHunks = patchHunks.concat(outLines);
    }

    if (patchHunks.length === 0) return null;

    return headerLines.concat(patchHunks).join('\n') + '\n';
  }

  async function applyPartialPatch(file, lineKeys, reverse) {
    var patch = buildPartialPatch(file, lineKeys, reverse);
    if (!patch) {
      alert('Nothing to ' + (reverse ? 'unstage' : 'stage') + '.');
      return;
    }
    var result = await window.klaus.gitApplyPatch(currentWorktreePath, patch, reverse);
    if (result.error) {
      alert((reverse ? 'Unstage' : 'Stage') + ' failed:\n' + result.error);
      return;
    }
    selectedLineKeys = new Set();
    await refresh();
  }

  function bindPartialStaging(file) {
    if (diffMode !== 'working') return;

    // Checkbox selection
    diffViewEl.querySelectorAll('.diff-stage-check').forEach(function (cb) {
      cb.addEventListener('click', function (e) {
        e.stopPropagation(); // don't trigger bindInlineComments click-to-comment
      });
      cb.addEventListener('change', function () {
        var key = cb.dataset.lineKey;
        if (cb.checked) selectedLineKeys.add(key);
        else selectedLineKeys.delete(key);
        updatePartialActionBar(file);
      });
    });

    // "Stage hunk" / "Unstage hunk" buttons
    diffViewEl.querySelectorAll('.diff-stage-hunk-btn').forEach(function (btn) {
      btn.addEventListener('click', async function (e) {
        e.stopPropagation();
        var hi = parseInt(btn.dataset.hunkIndex, 10);
        var hunk = currentParsedHunks[hi];
        if (!hunk) return;
        // Select every +/- line in this hunk.
        var keys = new Set();
        for (var b = 0; b < hunk.lines.length - 1; b++) {
          var line = hunk.lines[b + 1];
          if (line.startsWith('+') || line.startsWith('-')) {
            keys.add(hi + ':' + (b + 1));
          }
        }
        btn.disabled = true;
        btn.textContent = '...';
        await applyPartialPatch(file, keys, currentDiffStaged);
      });
    });

    updatePartialActionBar(file);
  }

  function updatePartialActionBar(file) {
    var existing = document.getElementById('diff-partial-action-bar');
    if (existing) existing.remove();
    if (selectedLineKeys.size === 0) {
      refreshPaused = false;
      return;
    }
    // Keep auto-refresh from wiping the selection.
    refreshPaused = true;

    var verb = currentDiffStaged ? 'Unstage' : 'Stage';
    var bar = document.createElement('div');
    bar.id = 'diff-partial-action-bar';
    bar.innerHTML =
      '<span class="partial-count">' + selectedLineKeys.size + ' line' + (selectedLineKeys.size === 1 ? '' : 's') + ' selected</span>' +
      '<button class="partial-cancel" type="button">Cancel</button>' +
      '<button class="partial-apply" type="button">' + verb + ' selected</button>';

    // Prefer inserting after the diff-view element inside the diff panel, stuck to bottom
    var diffContent = document.getElementById('diff-content');
    (diffContent || diffViewEl).appendChild(bar);

    bar.querySelector('.partial-cancel').addEventListener('click', function () {
      selectedLineKeys = new Set();
      diffViewEl.querySelectorAll('.diff-stage-check').forEach(function (cb) { cb.checked = false; });
      updatePartialActionBar(file);
    });
    bar.querySelector('.partial-apply').addEventListener('click', async function () {
      bar.querySelector('.partial-apply').disabled = true;
      bar.querySelector('.partial-apply').textContent = '...';
      await applyPartialPatch(file, selectedLineKeys, currentDiffStaged);
    });
  }

  // Parse hunks from raw diff text + bulk-highlight code lines. Shared by
  // unified and split renderers. Populates currentParsedHunks as a side effect.
  function parseAndHighlight(diffText) {
    var lines = diffText.split('\n');
    var hunks = [];
    var currentHunk = [];
    var hunkStart = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('@@')) {
        if (currentHunk.length > 0) hunks.push({ start: hunkStart, lines: currentHunk.slice() });
        currentHunk = [lines[i]];
        hunkStart = i;
      } else if (hunkStart >= 0) {
        if (lines[i].startsWith('diff ')) {
          hunks.push({ start: hunkStart, lines: currentHunk.slice() });
          currentHunk = [];
          hunkStart = -1;
        } else {
          currentHunk.push(lines[i]);
        }
      }
    }
    if (currentHunk.length > 0) hunks.push({ start: hunkStart, lines: currentHunk.slice() });

    var lang = detectLang(selectedFile);
    var codeLines = [];
    var lineMap = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.startsWith('+') && !line.startsWith('+++')) {
        codeLines.push(line.substring(1));
        lineMap.push({ idx: i, prefix: '+', type: 'add' });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        codeLines.push(line.substring(1));
        lineMap.push({ idx: i, prefix: '-', type: 'del' });
      } else if (!line.startsWith('@@') && !line.startsWith('diff ') &&
                 !line.startsWith('index ') && !line.startsWith('new file') &&
                 !line.startsWith('deleted file') && !line.startsWith('+++') &&
                 !line.startsWith('---')) {
        codeLines.push(line.length > 0 ? line.substring(1) : '');
        lineMap.push({ idx: i, prefix: ' ', type: 'context' });
      }
    }

    var highlightedLines = {};
    if (typeof hljs !== 'undefined' && codeLines.length > 0) {
      var codeBlock = codeLines.join('\n');
      try {
        var result = lang
          ? hljs.highlight(codeBlock, { language: lang, ignoreIllegals: true })
          : hljs.highlightAuto(codeBlock);
        var hLines = splitHighlightedLines(result.value);
        try { hLines = hLines.map(enhanceLine); } catch (_) {}
        for (var j = 0; j < lineMap.length && j < hLines.length; j++) {
          highlightedLines[lineMap[j].idx] = hLines[j];
        }
      } catch (e) {
        console.error('[hljs] Syntax highlighting failed:', e, e.stack);
      }
    }

    currentParsedHunks = hunks;
    return { lines: lines, hunks: hunks, highlightedLines: highlightedLines };
  }

  function renderDiff(diffText) {
    var parsed = parseAndHighlight(diffText);
    var lines = parsed.lines;
    var hunks = parsed.hunks;
    var highlightedLines = parsed.highlightedLines;

    // Partial-staging UI only shown in working mode (not branch diff)
    var allowStaging = diffMode === 'working';
    var stageVerb = currentDiffStaged ? 'Unstage' : 'Stage';

    var html = '';
    var oldLn = 0, newLn = 0; // running line counters driven by @@ headers
    var currentHunkIdx = -1;
    var lineInHunk = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var cls = 'diff-line';

      if (line.startsWith('+++') || line.startsWith('---')) {
        cls += ' diff-meta';
        html += '<div class="' + cls + '">' + escHtml(line) + '</div>';
      } else if (line.startsWith('@@')) {
        cls += ' diff-hunk';
        var hm = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hm) { oldLn = parseInt(hm[1], 10) - 1; newLn = parseInt(hm[2], 10) - 1; }
        var hi = hunks.findIndex(function (h) { return h.start === i; });
        currentHunkIdx = hi;
        lineInHunk = 0;
        if (hi >= 0) {
          var stageBtn = allowStaging
            ? '<button class="diff-stage-hunk-btn" data-hunk-index="' + hi + '" title="' + stageVerb + ' this hunk">' + stageVerb + ' hunk</button>'
            : '';
          html += '<div class="' + cls + '" data-hunk-index="' + hi + '">' +
            '<span class="diff-hunk-text">' + escHtml(line) + '</span>' +
            '<button class="diff-explain-btn" data-hunk-index="' + hi + '" title="Explain this change">Explain</button>' +
            stageBtn +
            '</div>';
        } else {
          html += '<div class="' + cls + '">' + escHtml(line) + '</div>';
        }
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        newLn++;
        lineInHunk++;
        cls += ' diff-add';
        html += '<div class="' + cls + '" data-new-ln="' + newLn + '" data-side="RIGHT"><span class="diff-prefix">+</span><span class="diff-code">' + (highlightedLines[i] || escHtml(line.substring(1))) + '</span></div>';
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        oldLn++;
        lineInHunk++;
        cls += ' diff-del';
        html += '<div class="' + cls + '" data-old-ln="' + oldLn + '" data-side="LEFT"><span class="diff-prefix">-</span><span class="diff-code">' + (highlightedLines[i] || escHtml(line.substring(1))) + '</span></div>';
      } else if (line.startsWith('diff ')) {
        cls += ' diff-header';
        html += '<div class="' + cls + '">' + escHtml(line) + '</div>';
      } else if (line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
        cls += ' diff-meta';
        html += '<div class="' + cls + '">' + escHtml(line) + '</div>';
      } else {
        oldLn++; newLn++;
        if (currentHunkIdx >= 0) lineInHunk++;
        cls += ' diff-context';
        html += '<div class="' + cls + '" data-old-ln="' + oldLn + '" data-new-ln="' + newLn + '" data-side="RIGHT"><span class="diff-prefix"> </span><span class="diff-code">' + (highlightedLines[i] || escHtml(line.length > 0 ? line.substring(1) : '')) + '</span></div>';
      }
    }

    return html;
  }

  // H1: Side-by-side split view. Reuses parseAndHighlight so hunks + hljs pipeline
  // match the unified renderer exactly. Pairs consecutive - with + into rows; pure
  // adds/dels get a blank slot on the opposite side. D6 checkboxes live in the
  // pane that owns the line (LEFT for -, RIGHT for +).
  function renderDiffSplit(diffText) {
    var parsed = parseAndHighlight(diffText);
    var lines = parsed.lines;
    var hunks = parsed.hunks;
    var highlightedLines = parsed.highlightedLines;

    var allowStaging = diffMode === 'working';
    var stageVerb = currentDiffStaged ? 'Unstage' : 'Stage';

    var html = '';

    // File meta (everything before the first @@ of the first hunk) rendered
    // full-width above the grid so paths, diff header, new/deleted markers,
    // and binary-file notices stay visible.
    var firstHunkLineIdx = hunks.length > 0 ? hunks[0].start : lines.length;
    for (var i = 0; i < firstHunkLineIdx; i++) {
      var meta = lines[i];
      if (!meta) continue;
      if (meta.startsWith('diff ')) {
        html += '<div class="diff-split-meta diff-header">' + escHtml(meta) + '</div>';
      } else {
        html += '<div class="diff-split-meta diff-meta">' + escHtml(meta) + '</div>';
      }
    }

    hunks.forEach(function (hunk, hi) {
      var header = hunk.lines[0];
      var hm = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      var oldLn = hm ? parseInt(hm[1], 10) - 1 : 0;
      var newLn = hm ? parseInt(hm[2], 10) - 1 : 0;

      var stageBtn = allowStaging
        ? '<button class="diff-stage-hunk-btn" data-hunk-index="' + hi + '" title="' + stageVerb + ' this hunk">' + stageVerb + ' hunk</button>'
        : '';
      html += '<div class="diff-line diff-hunk diff-split-hunk-header" data-hunk-index="' + hi + '">'
        + '<span class="diff-hunk-text">' + escHtml(header) + '</span>'
        + '<button class="diff-explain-btn" data-hunk-index="' + hi + '" title="Explain this change">Explain</button>'
        + stageBtn
        + '</div>';

      var body = hunk.lines.slice(1);
      var bodyStartIdx = hunk.start + 1; // index into `lines` for body[0]
      var b = 0;

      function paneAdd(info) {
        var cls = 'diff-line diff-split-right diff-add';
        var code = highlightedLines[info.idx] || escHtml(info.text);
        return '<div class="' + cls + '" data-new-ln="' + info.newLn + '" data-side="RIGHT">'
          + '<span class="diff-ln-gutter">' + info.newLn + '</span>'
          + '<span class="diff-prefix">+</span>'
          + '<span class="diff-code">' + code + '</span>'
          + '</div>';
      }
      function paneDel(info) {
        var cls = 'diff-line diff-split-left diff-del';
        var code = highlightedLines[info.idx] || escHtml(info.text);
        return '<div class="' + cls + '" data-old-ln="' + info.oldLn + '" data-side="LEFT">'
          + '<span class="diff-ln-gutter">' + info.oldLn + '</span>'
          + '<span class="diff-prefix">-</span>'
          + '<span class="diff-code">' + code + '</span>'
          + '</div>';
      }
      function paneBlank(side) {
        return '<div class="diff-line diff-blank diff-split-' + side + '"></div>';
      }
      function paneContext(info, side) {
        var cls = 'diff-line diff-split-' + side + ' diff-context';
        var code = highlightedLines[info.idx] || escHtml(info.text);
        var lnAttr = side === 'left'
          ? 'data-old-ln="' + info.oldLn + '"'
          : 'data-new-ln="' + info.newLn + '" data-side="RIGHT"';
        var lnVal = side === 'left' ? info.oldLn : info.newLn;
        return '<div class="' + cls + '" ' + lnAttr + '>'
          + '<span class="diff-ln-gutter">' + lnVal + '</span>'
          + '<span class="diff-prefix"> </span>'
          + '<span class="diff-code">' + code + '</span>'
          + '</div>';
      }

      while (b < body.length) {
        var line = body[b];
        if (line.startsWith('\\')) { b++; continue; } // no-newline marker — skip in split view
        if (line.startsWith(' ') || line === '') {
          oldLn++; newLn++;
          var ctxInfo = { idx: bodyStartIdx + b, oldLn: oldLn, newLn: newLn, text: line.length > 0 ? line.substring(1) : '' };
          html += paneContext(ctxInfo, 'left') + paneContext(ctxInfo, 'right');
          b++;
        } else {
          // Line keys use body index (b+1) to match buildPartialPatch, which
          // is body-index-based. Counting content lines instead would drift
          // whenever a `\ No newline` marker sits inside the hunk body.
          var dels = [];
          while (b < body.length && body[b].startsWith('-')) {
            oldLn++;
            dels.push({ idx: bodyStartIdx + b, oldLn: oldLn, key: hi + ':' + (b + 1), text: body[b].substring(1) });
            b++;
          }
          while (b < body.length && body[b].startsWith('\\')) b++;
          var adds = [];
          while (b < body.length && body[b].startsWith('+')) {
            newLn++;
            adds.push({ idx: bodyStartIdx + b, newLn: newLn, key: hi + ':' + (b + 1), text: body[b].substring(1) });
            b++;
          }
          while (b < body.length && body[b].startsWith('\\')) b++;
          var rowCount = Math.max(dels.length, adds.length);
          for (var k = 0; k < rowCount; k++) {
            html += (dels[k] ? paneDel(dels[k]) : paneBlank('left'));
            html += (adds[k] ? paneAdd(adds[k]) : paneBlank('right'));
          }
        }
      }
    });

    return '<div class="diff-split-grid">' + html + '</div>';
  }

  function toggleCommitArea() {
    var visible = commitAreaEl.style.display !== 'none';
    commitAreaEl.style.display = visible ? 'none' : 'flex';
    if (!visible) commitInput.focus();
  }

  async function doCommit() {
    var msg = commitInput.value.trim();
    if (!msg) return;
    var btn = document.getElementById('btn-do-commit');
    btn.disabled = true;
    btn.textContent = 'Committing...';
    var result = await window.klaus.gitCommit(currentWorktreePath, msg);
    btn.disabled = false;
    btn.textContent = 'Commit';
    if (result.error) {
      alert('Commit failed: ' + result.error);
      return;
    }
    commitInput.value = '';
    commitAreaEl.style.display = 'none';
    await refresh();
  }

  async function pushChanges() {
    var btn = document.getElementById('btn-push');
    btn.disabled = true;
    btn.textContent = 'Pushing...';
    var result = await window.klaus.gitPush(currentWorktreePath);
    btn.disabled = false;
    if (result.error) {
      btn.textContent = 'Failed';
      setTimeout(function () { btn.textContent = 'Push'; }, 2000);
      alert('Push failed: ' + result.error);
      return;
    }
    btn.textContent = 'Pushed!';
    setTimeout(function () { btn.textContent = 'Push'; }, 2000);
  }

  async function createPR() {
    var title = prompt('PR title:');
    if (!title) return;
    var body = prompt('PR description (optional):') || '';
    var btn = document.getElementById('btn-create-pr');
    btn.disabled = true;
    btn.textContent = 'Creating...';
    var result = await window.klaus.createPR(currentWorktreePath, title, body);
    btn.disabled = false;
    btn.textContent = 'PR';
    if (result.error) {
      alert('PR creation failed: ' + result.error);
      return;
    }
    if (result.url) {
      window.klaus.openExternal(result.url);
    }
    // Refresh PR panel so it picks up the new PR
    if (window.PRPanel) window.PRPanel.loadPR();
  }

  async function stageAll() {
    var unstaged = currentFiles.filter(function (f) { return !f.staged; }).map(function (f) { return f.file; });
    if (unstaged.length > 0) {
      await window.klaus.gitStage(currentWorktreePath, unstaged);
      await refresh();
    }
  }

  async function unstageAll() {
    var staged = currentFiles.filter(function (f) { return f.staged; }).map(function (f) { return f.file; });
    if (staged.length > 0) {
      await window.klaus.gitUnstage(currentWorktreePath, staged);
      await refresh();
    }
  }

  function setCommentCallback(fn) {
    commentCallback = fn;
  }

  // Feature 13: Keyboard shortcut to send selected diff/hunk to Claude
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'E') {
      e.preventDefault();
      if (!commentCallback) return;

      // Try selected text first
      var sel = window.getSelection();
      var selectedText = sel && !sel.isCollapsed ? sel.toString().trim() : '';

      if (!selectedText && currentParsedHunks.length > 0) {
        // Fall back to all hunks of the selected file
        selectedText = currentParsedHunks.map(function (h) { return h.lines.join('\n'); }).join('\n');
      }

      if (!selectedText || !selectedFile) return;

      var prompt = 'Regarding ' + selectedFile + ':\n```\n' + selectedText + '\n```\nPlease review this code change.';
      commentCallback(prompt);
    }
  });

  function getStatusClass(status) {
    var s = status.trim();
    if (s.startsWith('M')) return 'modified';
    if (s.startsWith('A') || s === '??') return 'added';
    if (s.startsWith('D')) return 'deleted';
    if (s.startsWith('R')) return 'renamed';
    return '';
  }

  function getStatusLabel(status) {
    var s = status.trim();
    if (s === '??') return 'U';
    return s.replace(/\s/g, '').charAt(0) || '?';
  }

  // Post-process a single highlighted line to add VS Code-like coloring
  // for patterns hljs doesn't tokenize: function calls, decorators, self/cls, CONSTANTS
  function enhanceLine(html) {
    // We need to only modify text that's NOT inside an existing span tag.
    // Strategy: split on tags, enhance only the text segments.
    var parts = html.split(/(<[^>]+>)/);
    var inSpan = 0;
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part.startsWith('<span')) { inSpan++; continue; }
      if (part === '</span>') { inSpan--; continue; }
      if (part.startsWith('<')) continue; // other tags
      if (inSpan > 0) continue; // inside an hljs span, skip

      // Enhance plain text segments
      // object.method( — color object as module, method as call
      part = part.replace(/\b([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)(\()/g,
        '<span class="hljs-module">$1</span>.<span class="hljs-call">$2</span>$3');
      // Remaining function calls: word followed by ( that we didn't already catch
      part = part.replace(/\b([a-zA-Z_]\w*)(\()/g, function(m, name, paren) {
        // Don't re-wrap spans or things we just wrapped
        if (name === 'span' || name === 'class') return m;
        return '<span class="hljs-call">' + name + '</span>' + paren;
      });
      // self/cls keyword
      part = part.replace(/\b(self|cls)\b/g, '<span class="hljs-self">$1</span>');
      // CONSTANT_NAMES (all caps with underscores, 2+ chars)
      part = part.replace(/\b([A-Z][A-Z0-9_]{1,})\b/g, '<span class="hljs-constant">$1</span>');
      // Decorators
      part = part.replace(/(@[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, '<span class="hljs-decorator">$1</span>');

      parts[i] = part;
    }
    return parts.join('');
  }

  // Split hljs-highlighted HTML by newlines, carrying open <span> tags
  // across line boundaries so each line is self-contained.
  function splitHighlightedLines(html) {
    var rawLines = html.split('\n');
    var result = [];
    var openSpans = []; // stack of open span tags (full tag strings)

    for (var i = 0; i < rawLines.length; i++) {
      var line = rawLines[i];

      // Prepend any spans that were open from previous lines
      var prefix = openSpans.join('');

      // Parse this line to track span opens/closes
      var spanOpenRe = /<span[^>]*>/g;
      var spanCloseRe = /<\/span>/g;
      var match;

      // Collect all opens and closes in order
      var events = [];
      while ((match = spanOpenRe.exec(line)) !== null) {
        events.push({ pos: match.index, type: 'open', tag: match[0] });
      }
      while ((match = spanCloseRe.exec(line)) !== null) {
        events.push({ pos: match.index, type: 'close' });
      }
      events.sort(function (a, b) { return a.pos - b.pos; });

      for (var j = 0; j < events.length; j++) {
        if (events[j].type === 'open') {
          openSpans.push(events[j].tag);
        } else {
          openSpans.pop();
        }
      }

      // Close any spans still open at end of this line, for valid HTML
      var suffix = '';
      for (var k = 0; k < openSpans.length; k++) {
        suffix += '</span>';
      }

      result.push(prefix + line + suffix);
    }

    return result;
  }

  var EXT_TO_LANG = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
    cs: 'csharp', swift: 'swift', kt: 'kotlin', scala: 'scala',
    php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
    html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    md: 'markdown', sql: 'sql', r: 'r',
    lua: 'lua', perl: 'perl', pl: 'perl',
    dockerfile: 'dockerfile', makefile: 'makefile',
  };

  function detectLang(filename) {
    if (!filename) return null;
    var name = filename.split('/').pop().toLowerCase();
    // Handle special filenames
    if (name === 'dockerfile') return 'dockerfile';
    if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
    var ext = name.split('.').pop();
    return EXT_TO_LANG[ext] || null;
  }

  function basename(p) { return p.split('/').pop(); }
  function dirname(p) {
    var parts = p.split('/');
    parts.pop();
    return parts.length > 0 ? parts.join('/') + '/' : '';
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  }

  async function showFile(file) {
    if (!file || !currentWorktreePath) return;
    selectedFile = file;
    // Highlight the file in the list
    fileListEl.querySelectorAll('.diff-file').forEach(function (el) {
      el.classList.toggle('selected', el.dataset.file === file);
    });
    await showFileDiff(file, false);
  }

  function getSelectedFile() {
    return selectedFile;
  }

  // D1: Ahead/behind counts
  async function updateAheadBehind() {
    if (!currentWorktreePath) return;
    var el = document.getElementById('ahead-behind');
    var result = await window.klaus.gitAheadBehind(currentWorktreePath);
    var parts = [];
    if (result.ahead > 0) parts.push('\u2191' + result.ahead);
    if (result.behind > 0) parts.push('\u2193' + result.behind);
    el.textContent = parts.join(' ');
    el.title = (result.ahead || 0) + ' ahead, ' + (result.behind || 0) + ' behind';
  }

  // D2: Branch checkout (integrated into mode toggle)
  function addCheckoutToBranchSelect() {
    var branchLabel = fileListEl.querySelector('.diff-branch-label');
    if (!branchLabel || diffMode !== 'working') return;

    branchLabel.style.cursor = 'pointer';
    branchLabel.title = 'Click to switch branch';
    branchLabel.addEventListener('click', async function () {
      if (branchList.length === 0) {
        var result = await window.klaus.gitBranches(currentWorktreePath);
        branchList = result.branches || [];
        remoteList = result.remotes || [];
      }

      var allBranches = branchList.concat(remoteList);
      var choice = prompt('Switch to branch:\n\n' + allBranches.join('\n'));
      if (!choice || !choice.trim()) return;

      var res = await window.klaus.gitCheckout(currentWorktreePath, choice.trim());
      if (res.error) {
        alert('Checkout failed: ' + res.error);
      } else {
        refresh();
        updateAheadBehind();
      }
    });
  }

  // D7: Conflict detection
  async function checkConflicts() {
    if (!currentWorktreePath) return;
    var result = await window.klaus.gitConflicts(currentWorktreePath);
    if (result.files && result.files.length > 0) {
      var conflictBanner = fileListEl.querySelector('.conflict-banner');
      if (!conflictBanner) {
        conflictBanner = document.createElement('div');
        conflictBanner.className = 'conflict-banner';
        fileListEl.insertBefore(conflictBanner, fileListEl.firstChild);
      }
      conflictBanner.innerHTML = '\u26A0 ' + result.files.length + ' conflicted file' + (result.files.length > 1 ? 's' : '') +
        ' \u2014 <span class="conflict-files">' + result.files.map(escHtml).join(', ') + '</span>' +
        ' <button class="conflict-resolve-btn">Resolve</button>';
      conflictBanner.querySelector('.conflict-resolve-btn').addEventListener('click', function () {
        if (window.ConflictPanel && currentWorktreePath) {
          window.ConflictPanel.show(currentWorktreePath);
        }
      });
    }
  }

  return { init: init, show: show, hide: hide, isVisible: isVisible, refresh: refresh, updateWorktree: updateWorktree, setCommentCallback: setCommentCallback, showFile: showFile, getSelectedFile: getSelectedFile, updateAheadBehind: updateAheadBehind };
})();
