// Diff panel module — git status, diff viewer, staging, commits, inline comments
window.DiffPanel = window.DiffPanel || {};

(function(DP) {
  DP.panelEl = undefined;
  DP.fileListEl = undefined;
  DP.diffViewEl = undefined;
  DP.commitAreaEl = undefined;
  DP.commitInput = undefined;
  DP.currentWorktreePath = null;
  DP.currentFiles = [];
  DP.selectedFile = null;
  DP.commentCallback = null;
  DP.refreshInterval = null;
  DP.watchedWorktreePath = null;
  DP.unsubscribeWatcher = null;
  DP.currentParsedHunks = [];
  DP.currentRawDiff = '';
  DP.currentDiffStaged = false;
  DP.selectedLineKeys = new Set();
  DP.refreshPaused = false;
  DP.diffViewMode = (typeof localStorage !== 'undefined' && localStorage.getItem('diffViewMode')) || 'unified';

  // Branch diff mode state
  DP.diffMode = 'working'; // 'working' or 'branch'

  DP.baseBranch = null;
  DP.branchList = [];
  DP.remoteList = [];

  // Subscribe to the renderer event bus for task switches. updateWorktree is
  // the expensive path (re-fetches git state); skip when the panel isn't
  // visible — the original direct callers guarded with DiffPanel.isVisible().
  // Registered at module-load rather than inside init() so the subscription
  // is live even before init runs (task switches emit during startup).
  Events.on('task:switched', function (detail) {
    var task = detail && detail.task;
    if (!task) return;
    if (!DP.isVisible()) return;
    DP.updateWorktree(task.worktreePath);
    if (detail.refreshDiff) DP.refresh();
  });

  DP.init = function() {
    DP.panelEl = document.getElementById('diff-panel');
    DP.fileListEl = document.getElementById('diff-file-list');
    DP.diffViewEl = document.getElementById('diff-view');
    DP.commitAreaEl = document.getElementById('commit-area');
    DP.commitInput = document.getElementById('commit-message');

    document.getElementById('btn-refresh-diff').addEventListener('click', DP.refresh);
    document.getElementById('btn-close-diff').addEventListener('click', DP.hide);

    // D1: Fetch & Pull
    document.getElementById('btn-fetch').addEventListener('click', async function () {
      this.disabled = true;
      this.textContent = '...';
      if (DP.currentSessionName && DP.viewScope === 'session') {
        var paths = DP.getSessionWorktrees().map(function(w) { return w.path; });
        await Promise.all(paths.map(function(p) { return window.klaus.git.fetch(p); }));
      } else {
        var path = DP.currentWorktreePath || DP.getActiveWorktreePath();
        await window.klaus.git.fetch(path);
      }
      this.disabled = false;
      this.textContent = 'Fetch';
      DP.updateAheadBehind();
      DP.refresh();
    });
    document.getElementById('btn-pull').addEventListener('click', async function () {
      this.disabled = true;
      this.textContent = '...';
      if (DP.currentSessionName && DP.viewScope === 'session') {
        var paths = DP.getSessionWorktrees().map(function(w) { return w.path; });
        await Promise.all(paths.map(function(p) { return window.klaus.git.pull(p); }));
      } else {
        var path = DP.currentWorktreePath || DP.getActiveWorktreePath();
        await window.klaus.git.pull(path);
      }
      this.disabled = false;
      this.textContent = 'Pull';
      DP.updateAheadBehind();
      DP.refresh();
    });
    document.getElementById('btn-commit').addEventListener('click', DP.toggleCommitArea);
    document.getElementById('btn-push').addEventListener('click', DP.pushChanges);
    document.getElementById('btn-create-pr').addEventListener('click', DP.createPR);
    document.getElementById('btn-do-commit').addEventListener('click', DP.doCommit);
    document.getElementById('btn-claude-commit-msg').addEventListener('click', DP.generateCommitMessageWithClaude);

    DP.commitInput.addEventListener('keydown', (e) => {
      // Textarea default: Enter inserts a newline (important for multi-line
      // commit messages with a subject + body). Cmd/Ctrl+Enter submits.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        DP.doCommit();
      }
      if (e.key === 'Escape') {
        DP.commitAreaEl.style.display = 'none';
      }
    });

    DP.initSelectionExplain();
  };

  // --- Selection-based Explain ---

  DP.initSelectionExplain = function() {
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
        DP.refreshPaused = false;
        return;
      }
      // Check if the selection is inside the diff view
      var anchor = sel.anchorNode;
      var focus = sel.focusNode;
      if (!diffContent.contains(anchor) && !diffContent.contains(focus)) {
        fab.style.display = 'none';
        DP.refreshPaused = false;
        return;
      }
      // Pause refresh while text is selected
      DP.refreshPaused = true;
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
      var text = DP.getSelectedDiffText();
      if (text) { fab.style.display = 'none'; DP.explainSelection(text); }
    });

    commentBtn.addEventListener('click', function () {
      fab.style.display = 'none';
      DP.commentOnSelection();
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
        var text = DP.getSelectedDiffText();
        if (text) DP.explainSelection(text);
      } else if (item.dataset.action === 'comment') {
        DP.commentOnSelection();
      }
    });

    // Hide context menu on click elsewhere
    document.addEventListener('click', function () {
      menu.style.display = 'none';
    });
  };

  // Compute the PR comment range (side + line, optional start) from the current
  // text selection — maps selected text to .diff-line elements with data-*-ln.
  DP.computeSelectionCommentRange = function() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    var range = sel.getRangeAt(0);
    var allLines = Array.from(DP.diffViewEl.querySelectorAll('.diff-line'));
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
  };

  DP.commentOnSelection = function() {
    var pr = (window.PRPanel && window.PRPanel.getCurrentPR) ? window.PRPanel.getCurrentPR() : null;
    if (!pr || !pr.number || !pr.headRefOid) {
      window.toast.error('No PR loaded for this worktree.');
      return;
    }
    var range = DP.computeSelectionCommentRange();
    if (!range) {
      window.toast.error('Select one or more diff lines (add / delete / context) to comment on.');
      return;
    }
    var file = DP.selectedFile;
    if (!file) { window.toast.error('No file selected.'); return; }

    // Clear selection + dismiss any existing composer
    window.getSelection().removeAllRanges();
    var existing = DP.diffViewEl.querySelector('.diff-comment-area');
    if (existing) existing.remove();

    var rangeLabel = range.startLine
      ? file + ':L' + range.startLine + '-L' + range.line
      : file + ':L' + range.line;

    var area = document.createElement('div');
    area.className = 'diff-comment-area';
    area.innerHTML =
      '<div class="diff-comment-header">' +
        '<span>Comment on <code>' + DP.escHtml(rangeLabel) + '</code></span>' +
        '<button class="diff-comment-close" type="button" title="Close">&times;</button>' +
      '</div>' +
      '<textarea class="diff-comment-input" placeholder="Write a comment..." rows="3"></textarea>' +
      '<div class="diff-comment-actions">' +
        '<button class="diff-comment-post" type="button">Post</button>' +
      '</div>';

    var anchor = range.anchorEl || DP.diffViewEl.lastElementChild;
    anchor.after(area);

    var ta = area.querySelector('.diff-comment-input');
    var postBtn = area.querySelector('.diff-comment-post');
    ta.focus();

    function close() { area.remove(); DP.refreshPaused = false; }
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
      var result = await window.klaus.pr.addReviewComment({
        worktreePath: DP.currentWorktreePath,
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
        window.toast.error('Post failed: ' + result.error);
        postBtn.disabled = false;
        postBtn.textContent = 'Post';
        return;
      }
      close();
      if (window.PRPanel && window.PRPanel.loadPR) window.PRPanel.loadPR();
    });
  };

  DP.getSelectedDiffText = function() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    return sel.toString().trim();
  };

  DP.explainSelection = async function(text) {
    // Remove any existing explanation
    var existing = DP.diffViewEl.querySelector('.diff-explanation');
    if (existing) existing.remove();

    // Find where to insert the explanation — after the last selected line
    var sel = window.getSelection();
    var anchor = sel.focusNode;
    var lineEl = anchor;
    while (lineEl && !lineEl.classList) lineEl = lineEl.parentElement;
    while (lineEl && !lineEl.classList.contains('diff-line')) lineEl = lineEl.parentElement;
    var insertAfter = lineEl || DP.diffViewEl.lastElementChild;

    var file = DP.selectedFile || 'unknown';
    DP.runExplainStream({
      file: file,
      text: text,
      insertAfter: insertAfter,
      onClose: function () { DP.refreshPaused = false; },
    });

    // Clear selection but keep refresh paused until explanation is dismissed.
    window.getSelection().removeAllRanges();
  };

  // Shared streaming/backgrounded explain — used by selection-FAB and
  // per-hunk button. Mirrors pr-review.js explainSelection: same dedupeKey
  // formula, registry lookup for re-attachment, agent survives close.
  DP.runExplainStream = async function(opts) {
    var file = opts.file;
    var text = opts.text;
    var insertAfter = opts.insertAfter;
    var onClose = opts.onClose;
    if (!insertAfter) return;

    var dedupeKey = 'explain-diff::' + file + '::' + text;
    var existingAgent = await window.klaus.agents.findByDedupeKey(dedupeKey);
    var requestId = (existingAgent && existingAgent.status === 'running')
      ? existingAgent.id
      : 'exp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    var explanationEl = document.createElement('div');
    explanationEl.className = 'diff-explanation';
    explanationEl.dataset.requestId = requestId;
    explanationEl.innerHTML = '<div class="diff-explanation-header">'
        + '<span>Explanation</span>'
        + '<button class="diff-explanation-close" title="Close">&times;</button>'
      + '</div>'
      + '<div class="diff-explanation-body">Sending to the agent…</div>';
    insertAfter.after(explanationEl);

    var bodyEl = explanationEl.querySelector('.diff-explanation-body');
    var unsubChunk = null;
    var unsubDone = null;

    explanationEl.querySelector('.diff-explanation-close').addEventListener('click', function () {
      // Close the inline UI but keep the agent running in the registry.
      if (unsubChunk) unsubChunk();
      if (unsubDone) unsubDone();
      explanationEl.remove();
      if (onClose) onClose();
    });

    // Re-hydrate from a finished agent — paint and bail.
    if (existingAgent && existingAgent.status !== 'running') {
      if (existingAgent.status === 'error') {
        bodyEl.className = 'diff-explanation-body diff-error';
        bodyEl.textContent = existingAgent.error || 'Explain failed';
      } else {
        bodyEl.textContent = existingAgent.text || '(no output)';
      }
      return;
    }

    var accumulated = (existingAgent && existingAgent.text) || '';
    if (accumulated) bodyEl.textContent = accumulated;

    unsubChunk = window.klaus.ai.onExplainDiffChunk(requestId, function (chunk) {
      if (!accumulated) bodyEl.textContent = '';
      accumulated += chunk;
      bodyEl.textContent = accumulated;
      bodyEl.scrollTop = bodyEl.scrollHeight;
    });
    unsubDone = window.klaus.ai.onExplainDiffDone(requestId, function (result) {
      if (unsubChunk) { unsubChunk(); unsubChunk = null; }
      if (!bodyEl.isConnected) return;
      if (result && result.error) {
        bodyEl.className = 'diff-explanation-body diff-error';
        bodyEl.textContent = result.error;
      }
    });

    if (!existingAgent || existingAgent.status !== 'running') {
      window.klaus.ai.explainDiffStreamStart(requestId, DP.currentWorktreePath, file, text, null);
    }
  };

  // H3: file-watch replaces 5s polling. A 30s safety-net interval catches the
  // rare case where fs.watch misses an event (e.g. filesystem remounts).
  DP.startWatching = function(worktreePath) {
    if (DP.watchedWorktreePath === worktreePath) return;
    DP.stopWatching();
    if (!worktreePath) return;
    DP.watchedWorktreePath = worktreePath;
    window.klaus.fs.watchWorktree(worktreePath);
    DP.unsubscribeWatcher = window.klaus.fs.onWorktreeChanged(function (data) {
      if (data.worktreePath !== DP.watchedWorktreePath) return;
      DP.refresh();
      DP.updateAheadBehind();
    });
    if (DP.refreshInterval) clearInterval(DP.refreshInterval);
    DP.refreshInterval = setInterval(DP.refresh, 30000);
  };

  DP.stopWatching = function() {
    if (DP.unsubscribeWatcher) { try { DP.unsubscribeWatcher(); } catch (_) {} DP.unsubscribeWatcher = null; }
    if (DP.watchedWorktreePath) { window.klaus.fs.unwatchWorktree(DP.watchedWorktreePath); DP.watchedWorktreePath = null; }
    if (DP.refreshInterval) { clearInterval(DP.refreshInterval); DP.refreshInterval = null; }
  };

  DP.show = async function(worktreePath) {
    DP.currentWorktreePath = worktreePath;
    DP.panelEl.classList.add('visible');
    DP.selectedFile = null;
    DP.branchList = [];
    DP.remoteList = [];
    DP.diffViewEl.innerHTML = '<div class="diff-empty">Select a file to view diff</div>';
    await DP.refresh();
    DP.updateAheadBehind();
    DP.startWatching(worktreePath);
    DP.rehydrateCommitMessage();
    // Trigger refit after panel appears
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  };

  DP.hide = function() {
    DP.panelEl.classList.remove('visible');
    DP.stopWatching();
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  };

  DP.isVisible = function() {
    return DP.panelEl.classList.contains('visible');
  };

  DP.updateWorktree = function(worktreePath) {
    var changed = DP.currentWorktreePath !== worktreePath;
    DP.currentWorktreePath = worktreePath;

    var sessionName = null;
    if (window.Sidebar && window.Sidebar.getSessionName) {
      var allTasks = Array.from(AppState.tasks.values());
      var task = allTasks.find(function(t) { return t.worktreePath === worktreePath; });
      if (task) {
        sessionName = window.Sidebar.getSessionName(task);
      }
      if (!sessionName) {
        var wt = (AppState.inactiveWorktrees || []).find(function(x) { return x.path === worktreePath; });
        if (wt) sessionName = window.Sidebar.getSessionName(wt);
      }
    }
    
    DP.currentSessionName = sessionName;
    DP.viewScope = 'repo'; // Reset to repo scope!
    if (changed) {
      DP.selectedFile = null;
      DP.diffViewEl.innerHTML = '<div class="diff-empty">Select a file to view diff</div>';
      // Detach from any commit-message agent for the previous worktree.
      DP.resetCommitMsgState();
      DP.rehydrateCommitMessage();
    }
    // Force refresh even if paused (this is an explicit task switch, not auto-refresh)
    DP.refreshPaused = false;
    DP.refresh();
    DP.updateAheadBehind();
    if (DP.isVisible()) DP.startWatching(worktreePath);
    // Reload the currently active non-Changes tab
    if (window._reloadDiffTab) {
      var activeTab = document.querySelector('#diff-tabs .diff-tab.active');
      if (activeTab && activeTab.dataset.tab !== 'changes') {
        window._reloadDiffTab(activeTab.dataset.tab, worktreePath);
      }
    }
  };

  DP.updateSession = function(sessionName) {
    if (DP.unsubscribeWatcher) {
      DP.unsubscribeWatcher();
      DP.unsubscribeWatcher = null;
    }
    DP.currentSessionName = sessionName;
    DP.currentWorktreePath = null;
    DP.viewScope = 'session'; // Default to session scope!
    DP.selectedFile = null;
    DP.diffMode = 'working';
    DP.baseBranch = null;
    DP.branchList = [];
    DP.remoteList = [];
    DP.diffViewEl.innerHTML = '<div class="diff-empty">Select a file to view diff</div>';
    DP.refreshPaused = false;
    DP.refresh();
    DP.updateAheadBehind();
  };

  DP.getSessionWorktrees = function() {
    if (!DP.currentSessionName) return [];
    var worktrees = [];
    var seen = new Set();
    AppState.tasks.forEach(function(t) {
      if (window.Sidebar && window.Sidebar.getSessionName(t) === DP.currentSessionName) {
        if (!seen.has(t.worktreePath)) {
          seen.add(t.worktreePath);
          worktrees.push({ path: t.worktreePath, name: t.name, repoPath: t.repoPath, branch: t.branch });
        }
      }
    });
    AppState.inactiveWorktrees.forEach(function(wt) {
      if (window.Sidebar && window.Sidebar.getSessionName(wt) === DP.currentSessionName) {
        if (!seen.has(wt.path)) {
          seen.add(wt.path);
          worktrees.push({ path: wt.path, name: wt.name, repoPath: wt.repoPath, branch: wt.branch });
        }
      }
    });
    return worktrees;
  };

  DP.refreshSessionDiff = async function() {
    var wts = DP.getSessionWorktrees();
    var results = await Promise.all(wts.map(async function(wt) {
      try {
        var status = await window.klaus.git.status(wt.path);
        return { wt: wt, status: status };
      } catch (e) {
        return { wt: wt, error: e.message || e };
      }
    }));

    var mergedFiles = [];
    var anyError = null;
    results.forEach(function(r) {
      if (r.error) {
        anyError = r.error;
      } else if (r.status && r.status.files) {
        r.status.files.forEach(function(f) {
          mergedFiles.push({
            file: f.file,
            staged: f.staged,
            status: f.status,
            worktreePath: r.wt.path,
            repoName: r.wt.name,
            uniqueKey: r.wt.name + '/' + f.file
          });
        });
      }
    });

    if (anyError && mergedFiles.length === 0) {
      DP.fileListEl.innerHTML = '<div class="diff-error">' + DP.escHtml(anyError) + '</div>';
      return;
    }

    DP.currentFiles = mergedFiles;
    DP.renderFileList(mergedFiles, '');

    if (DP.selectedFile) {
      const still = DP.currentFiles.find(function (f) { return f.uniqueKey === DP.selectedFile; });
      if (still) {
        await DP.showFileDiff(still.file, still.staged, still.worktreePath);
      } else {
        DP.selectedFile = null;
        DP.diffViewEl.innerHTML = '<div class="diff-empty">File no longer has changes</div>';
      }
    }
  };

  DP.getActiveWorktreePath = function() {
    var taskId = AppState.activeTaskId || AppState.focusedTaskId;
    if (taskId) {
      var t = AppState.tasks.get(taskId);
      if (t && t.worktreePath) return t.worktreePath;
    }
    var wts = DP.getSessionWorktrees();
    if (wts.length > 0) return wts[0].path;
    return DP.currentWorktreePath;
  };

  DP.updateButtonStates = function() {
    var isAllRepos = DP.currentSessionName && DP.viewScope === 'session';
    var fetchBtn = document.getElementById('btn-fetch');
    var pullBtn = document.getElementById('btn-pull');
    var commitBtn = document.getElementById('btn-commit');
    var pushBtn = document.getElementById('btn-push');
    var prBtn = document.getElementById('btn-create-pr');
    
    if (fetchBtn) fetchBtn.title = isAllRepos ? 'Fetch all repos in session' : 'Fetch';
    if (pullBtn) pullBtn.title = isAllRepos ? 'Pull all repos in session' : 'Pull';
    if (commitBtn) commitBtn.title = isAllRepos ? 'Commit all' : 'Commit';
    if (pushBtn) pushBtn.title = isAllRepos ? 'Push all' : 'Push';
    if (prBtn) prBtn.title = isAllRepos ? 'PR all' : 'PR';
  };

  DP.refresh = async function() {
    if (!DP.currentWorktreePath && !DP.currentSessionName) return;
    if (DP.refreshPaused) return;
    if (DP.diffViewEl && DP.diffViewEl.querySelector('.diff-explanation')) return;

    if (DP.precommitCleared && !DP.precommitPending) {
      DP.precommitCleared = false;
      var cb = document.getElementById('btn-do-commit');
      if (cb && cb.textContent === 'Commit anyway') cb.textContent = 'Commit';
    }

    DP.updateButtonStates();

    if (DP.currentSessionName && DP.viewScope === 'session') {
      await DP.refreshSessionDiff();
      return;
    }

    if (DP.diffMode === 'branch') {
      await DP.refreshBranchDiff();
      return;
    }

    var path = DP.currentWorktreePath || DP.getActiveWorktreePath();
    if (!path) return;

    const result = await window.klaus.git.status(path);
    if (result.error) {
      DP.fileListEl.innerHTML = '<div class="diff-error">' + DP.escHtml(result.error) + '</div>';
      return;
    }
    DP.currentFiles = result.files;
    DP.renderFileList(result.files, result.branch);

    if (DP.selectedFile) {
      const still = DP.currentFiles.find(function (f) { return f.file === DP.selectedFile; });
      if (still) {
        await DP.showFileDiff(DP.selectedFile, still.staged, path);
      } else {
        DP.selectedFile = null;
        DP.diffViewEl.innerHTML = '<div class="diff-empty">File no longer has changes</div>';
      }
    }
  };

  DP.refreshBranchDiff = async function() {
    if (!DP.baseBranch) {
      DP.fileListEl.innerHTML = DP.renderModeToggle('') + '<div class="diff-empty">Select a base branch</div>';
      return;
    }
    var result = await window.klaus.git.branchFiles(DP.currentWorktreePath, DP.baseBranch);
    if (result.error) {
      DP.fileListEl.innerHTML = DP.renderModeToggle('') + '<div class="diff-error">' + DP.escHtml(result.error) + '</div>';
      return;
    }
    DP.currentFiles = result.files.map(function (f) { return { status: f.status, file: f.file, staged: false }; });
    DP.renderBranchFileList(result.files);

    if (DP.selectedFile) {
      var still = DP.currentFiles.find(function (f) { return f.file === DP.selectedFile; });
      if (still) {
        await DP.showFileDiff(DP.selectedFile, false);
      } else {
        DP.selectedFile = null;
        DP.diffViewEl.innerHTML = '<div class="diff-empty">File no longer has changes</div>';
      }
    }
  };

  DP.renderModeToggle = function(branchName) {
    var html = '';

    if (DP.currentSessionName) {
      // Session active: Render a single premium "Repo" vs "Session" scope toggle!
      var branchActive = DP.viewScope === 'repo' ? ' active' : '';
      var sessionActive = DP.viewScope === 'session' ? ' active' : '';
      
      html += '<div class="diff-mode-bar">';
      html += '<div class="diff-mode-toggle" style="width: 100%;">';
      html += '<button class="diff-mode-btn js-scope-repo' + branchActive + '" style="flex: 1; text-align: center;">Repo</button>';
      html += '<button class="diff-mode-btn js-scope-session' + sessionActive + '" style="flex: 1; text-align: center;">Session</button>';
      html += '</div>';
      if (branchName && DP.viewScope === 'repo') {
        html += '<span class="diff-branch-label" style="margin-left: 8px;">on <strong>' + DP.escHtml(branchName) + '</strong></span>';
      }
      html += '</div>';
    } else {
      // Standalone mode: Render the standard "Working" vs "Branch" mode toggle
      var workingActive = DP.diffMode === 'working' ? ' active' : '';
      var branchActive = DP.diffMode === 'branch' ? ' active' : '';

      html += '<div class="diff-mode-bar">';
      html += '<div class="diff-mode-toggle">';
      html += '<button class="diff-mode-btn js-mode-working' + workingActive + '">Working</button>';
      html += '<button class="diff-mode-btn js-mode-branch' + branchActive + '">Branch</button>';
      html += '</div>';

      if (DP.diffMode === 'branch') {
        html += '<select class="diff-base-select js-base-select">';
        var allBranches = DP.branchList.concat(DP.remoteList);
        for (var i = 0; i < allBranches.length; i++) {
          var b = allBranches[i];
          var sel = b === DP.baseBranch ? ' selected' : '';
          var isRemote = DP.remoteList.indexOf(b) >= 0 && DP.branchList.indexOf(b) < 0;
          html += '<option value="' + DP.escAttr(b) + '"' + sel + '>' + DP.escHtml(b) + '</option>';
        }
        html += '</select>';
      } else {
        if (branchName) {
          html += '<span class="diff-branch-label">on <strong>' + DP.escHtml(branchName) + '</strong></span>';
        }
      }
      html += '</div>';
    }

    return html;
  };

  DP.bindModeToggle = function() {
    var workingBtn = DP.fileListEl.querySelector('.js-mode-working');
    var branchBtn = DP.fileListEl.querySelector('.js-mode-branch');
    var selectEl = DP.fileListEl.querySelector('.js-base-select');
    var repoScopeBtn = DP.fileListEl.querySelector('.js-scope-repo');
    var sessionScopeBtn = DP.fileListEl.querySelector('.js-scope-session');

    if (workingBtn) {
      workingBtn.addEventListener('click', function () {
        if (DP.diffMode === 'working') return;
        DP.diffMode = 'working';
        DP.selectedFile = null;
        DP.diffViewEl.innerHTML = '<div class="diff-empty">Select a file to view diff</div>';
        DP.commitAreaEl.style.display = 'none';
        document.getElementById('diff-footer').style.display = '';
        DP.refresh();
      });
    }

    if (branchBtn) {
      branchBtn.addEventListener('click', async function () {
        if (DP.diffMode === 'branch') return;
        DP.diffMode = 'branch';
        DP.selectedFile = null;
        DP.diffViewEl.innerHTML = '<div class="diff-empty">Select a file to view diff</div>';
        document.getElementById('diff-footer').style.display = '';

        // Fetch branches if not cached
        if (DP.branchList.length === 0) {
          var path = DP.currentWorktreePath || DP.getActiveWorktreePath();
          var result = await window.klaus.git.branches(path);
          DP.branchList = result.branches || [];
          DP.remoteList = result.remotes || [];
        }
        // Auto-select a sensible default if not set
        if (!DP.baseBranch) {
          var defaults = ['main', 'master', 'dev', 'develop'];
          for (var i = 0; i < defaults.length; i++) {
            if (DP.branchList.indexOf(defaults[i]) >= 0 || DP.remoteList.indexOf('origin/' + defaults[i]) >= 0) {
              DP.baseBranch = DP.branchList.indexOf(defaults[i]) >= 0 ? defaults[i] : 'origin/' + defaults[i];
              break;
            }
          }
          if (!DP.baseBranch && DP.branchList.length > 0) DP.baseBranch = DP.branchList[0];
        }
        DP.refresh();
      });
    }

    if (selectEl) {
      selectEl.addEventListener('change', function () {
        DP.baseBranch = selectEl.value;
        DP.selectedFile = null;
        DP.diffViewEl.innerHTML = '<div class="diff-empty">Select a file to view diff</div>';
        DP.refresh();
      });
    }

    if (repoScopeBtn) {
      repoScopeBtn.addEventListener('click', function() {
        if (DP.viewScope === 'repo') return;
        DP.viewScope = 'repo';
        DP.selectedFile = null;
        DP.refresh();
      });
    }

    if (sessionScopeBtn) {
      sessionScopeBtn.addEventListener('click', function() {
        if (DP.viewScope === 'session') return;
        DP.viewScope = 'session';
        DP.selectedFile = null;
        DP.refresh();
      });
    }
  };

  DP.renderBranchFileList = function(files) {
    var html = DP.renderModeToggle('');

    if (files.length === 0) {
      html += '<div class="diff-empty">No changes from ' + DP.escHtml(DP.baseBranch) + '</div>';
      DP.fileListEl.innerHTML = html;
      DP.bindModeToggle();
      return;
    }

    html += '<div class="diff-section-header"><span>Changed files (' + files.length + ')</span></div>';
    files.forEach(function (f) {
      var statusClass = DP.getBranchStatusClass(f.status);
      var statusLabel = f.status.charAt(0);
      var sel = f.file === DP.selectedFile ? ' selected' : '';
      html +=
        '<div class="diff-file' + sel + '" data-file="' + DP.escAttr(f.file) + '" data-staged="false">' +
          '<span class="diff-file-status ' + statusClass + '">' + statusLabel + '</span>' +
          '<span class="diff-file-name" title="' + DP.escAttr(f.file) + '">' + DP.escHtml(DP.basename(f.file)) + '</span>' +
          '<span class="diff-file-path" title="' + DP.escAttr(f.file) + '">' + DP.escHtml(DP.dirname(f.file)) + '</span>' +
        '</div>';
    });

    DP.fileListEl.innerHTML = html;
    DP.bindModeToggle();

    DP.fileListEl.querySelectorAll('.diff-file').forEach(function (el) {
      var file = el.dataset.file;
      el.addEventListener('click', function () {
        DP.selectedFile = file;
        DP.fileListEl.querySelectorAll('.diff-file').forEach(function (f) { f.classList.remove('selected'); });
        el.classList.add('selected');
        DP.showFileDiff(file, false);
      });
    });
  };

  DP.getBranchStatusClass = function(status) {
    var s = status.trim();
    if (s.startsWith('M')) return 'modified';
    if (s.startsWith('A')) return 'added';
    if (s.startsWith('D')) return 'deleted';
    if (s.startsWith('R')) return 'renamed';
    return '';
  };

})(window.DiffPanel);
