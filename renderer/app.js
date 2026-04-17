(async function () {
  var tasks = AppState.tasks;
  var ciStatusMap = AppState.ciStatusMap;
  const isSecondaryWindow = new URLSearchParams(window.location.search).has('secondary');
  const layouts = ['single', 'columns', 'grid'];
  const layoutIcons = { single: '\u25A8', columns: '\u2759\u2759', grid: '\u2637' };

  const repoOverlay = document.getElementById('repo-overlay');
  const appEl = document.getElementById('app');
  const btnSelectRepo = document.getElementById('btn-select-repo');
  const taskList = document.getElementById('task-list');
  const btnNewTask = document.getElementById('btn-new-task');
  const btnLayout = document.getElementById('btn-layout');
  const btnDiff = document.getElementById('btn-diff');
  const terminalsEl = document.getElementById('terminals');
  const emptyState = document.getElementById('empty-state');
  const sidebar = document.getElementById('sidebar');
  const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
  const sidebarToggleIcon = document.getElementById('sidebar-toggle-icon');
  const sidebarToggleLabel = document.getElementById('sidebar-toggle-label');

  // ---- Prevent Electron default file drag-and-drop navigation ----
  document.addEventListener('dragover', function (e) {
    e.preventDefault();
  });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
  });

  // ---- Init Theme (Phase 5) ----
  ThemeManager.init();

  // ---- Init Diff Panel (Phase 1) & PR Panel ----
  DiffPanel.init();
  PRPanel.init();
  EnvPanel.init();
  ConflictPanel.init();
  DiffPanel.setCommentCallback(function (text) {
    if (AppState.activeTaskId) {
      window.klaus.writeTerminal(AppState.activeTaskId, text + '\n');
    }
  });

  // ---- Handle Claude → shell conversion ----
  window.klaus.onTaskConverted(function (data) {
    var t = tasks.get(data.id);
    if (!t) return;
    t.alive = true;
    t.mode = 'shell';
    updateSidebarItem(data.id);
    updateSidebarMode(data.id, 'shell');
    showResumeButton(data.id, t);
    // Refit terminal and sync size to new shell pty
    setTimeout(function () {
      t.fitAddon.fit();
      t.terminal.scrollToBottom();
      window.klaus.resizeTerminal(data.id, t.terminal.cols, t.terminal.rows);
    }, 100);
  });

  // ---- Handle notification click → focus task ----
  window.klaus.onNotificationClicked(function (data) {
    switchToTask(data.id);
  });

  // ---- CI/CD Status (Feature 3) ----
  window.klaus.onCIStatusUpdate(function (data) {
    ciStatusMap.set(data.id, data.runs);
    updateCIStatusIcon(data.id, data.runs);
  });

  function updateCIStatusIcon(taskId, runs) {
    var item = taskList.querySelector('.task-item[data-id="' + taskId + '"]');
    if (!item) return;
    var icon = item.querySelector('.ci-status-icon');
    if (!icon) return;

    if (!runs || runs.length === 0) {
      icon.className = 'ci-status-icon';
      icon.title = 'No CI runs';
      return;
    }

    var latest = runs[0];
    var status = latest.status;
    var conclusion = latest.conclusion;

    icon.removeAttribute('data-url');

    if (status === 'in_progress' || status === 'queued' || status === 'pending' || status === 'waiting') {
      icon.className = 'ci-status-icon ci-pending';
      icon.title = 'CI running: ' + (latest.name || '');
    } else if (conclusion === 'success') {
      icon.className = 'ci-status-icon ci-success';
      icon.title = 'CI passed: ' + (latest.name || '');
    } else if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled') {
      icon.className = 'ci-status-icon ci-failure';
      icon.title = 'CI failed: ' + (latest.name || '');
    } else {
      icon.className = 'ci-status-icon';
      icon.title = 'CI: ' + (conclusion || status || 'unknown');
    }

    if (latest.url) {
      icon.dataset.url = latest.url;
    }
  }

  // ---- Auto-fetch updates (Feature 15) ----
  window.klaus.onAutoFetchUpdate(function (data) {
    // If the updated task is active and diff panel is open, refresh ahead/behind
    if (data.id === AppState.activeTaskId && DiffPanel.isVisible()) {
      DiffPanel.updateAheadBehind();
    }
  });

  // ---- Save UI state before quit ----
  window.klaus.onBeforeQuit(function () {
    var state = {
      diffPanelOpen: DiffPanel.isVisible(),
      selectedFile: DiffPanel.getSelectedFile(),
    };
    window.klaus.saveUIState(state);
  });

  // Also save periodically in case of crash
  setInterval(function () {
    var state = {
      diffPanelOpen: DiffPanel.isVisible(),
      selectedFile: DiffPanel.getSelectedFile(),
    };
    window.klaus.saveUIState(state);
  }, 10000);

  // Diff panel toggle
  btnDiff.addEventListener('click', function () {
    if (DiffPanel.isVisible()) {
      DiffPanel.hide();
      btnDiff.classList.remove('active');
    } else {
      var task = tasks.get(AppState.activeTaskId);
      if (task) {
        DiffPanel.show(task.worktreePath);
        PRPanel.setWorktree(task.worktreePath);

        btnDiff.classList.add('active');
      }
    }
  });

  // ---- Diff Panel Resize ----
  (function () {
    var handle = document.getElementById('diff-resize-handle');
    var panel = document.getElementById('diff-panel');
    var dragging = false;
    var DEFAULT_WIDTH = 400;
    var MIN_WIDTH = 250;
    var MAX_WIDTH_RATIO = 0.8;

    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      dragging = true;
      handle.classList.add('active');
      panel.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var containerRight = panel.parentElement.getBoundingClientRect().right;
      var newWidth = containerRight - e.clientX;
      var maxWidth = window.innerWidth * MAX_WIDTH_RATIO;
      newWidth = Math.max(MIN_WIDTH, Math.min(newWidth, maxWidth));
      panel.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('active');
      panel.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.dispatchEvent(new Event('resize'));
    });

    // Double-click to toggle between default and expanded
    handle.addEventListener('dblclick', function () {
      var current = panel.getBoundingClientRect().width;
      if (current > DEFAULT_WIDTH + 50) {
        panel.style.width = DEFAULT_WIDTH + 'px';
      } else {
        panel.style.width = Math.floor(window.innerWidth * 0.6) + 'px';
      }
      window.dispatchEvent(new Event('resize'));
    });
  })();

  // ---- Project Switcher (extracted to project-switcher.js) ----
  var loadProjects = ProjectSwitcher.loadProjects;
  var filterTaskList = ProjectSwitcher.filterTaskList;

  // ---- New Window ----
  const btnNewWindow = document.getElementById('btn-new-window');
  btnNewWindow.addEventListener('click', function () {
    window.klaus.newWindow();
  });

  // ---- Preferences (B1-B4) ----
  const btnPrefs = document.getElementById('btn-prefs');
  btnPrefs.addEventListener('click', function () {
    window.klaus.openPreferences();
  });

  // Apply preference changes broadcast from main process
  window.klaus.onPreferencesChanged(function (prefs) {
    if (prefs.fontSize !== undefined || prefs.fontFamily !== undefined ||
        prefs.lineHeight !== undefined || prefs.cursorStyle !== undefined) {
      tasks.forEach(function (task, id) {
        if (prefs.fontSize !== undefined) {
          AppState.currentFontSize = prefs.fontSize;
          task.terminal.options.fontSize = prefs.fontSize;
        }
        if (prefs.fontFamily !== undefined) {
          task.terminal.options.fontFamily = prefs.fontFamily;
        }
        if (prefs.lineHeight !== undefined) {
          task.terminal.options.lineHeight = prefs.lineHeight;
        }
        if (prefs.cursorStyle !== undefined) {
          task.terminal.options.cursorStyle = prefs.cursorStyle;
        }
        task.fitAddon.fit();
        task.terminal.scrollToBottom();
        window.klaus.resizeTerminal(id, task.terminal.cols, task.terminal.rows);
      });
    }
    if (prefs.theme !== undefined) {
      ThemeManager.apply(prefs.theme.preset);
    }
  });

  // Load saved terminal preferences on startup
  window.klaus.getPreferences().then(function (prefs) {
    AppState.savedPrefs = prefs;
    if (prefs.fontSize && prefs.fontSize !== 13) AppState.currentFontSize = prefs.fontSize;
  });

  // ---- Theme Picker (Phase 5) ----
  const btnTheme = document.getElementById('btn-theme');
  const themeOverlay = document.getElementById('theme-overlay');
  const themeList = document.getElementById('theme-list');
  const themeClose = document.getElementById('theme-close');

  btnTheme.addEventListener('click', showThemePicker);

  function showThemePicker() {
    var presets = ThemeManager.getPresetList();
    var current = ThemeManager.getCurrent();
    themeList.innerHTML = '';

    presets.forEach(function (p) {
      var btn = document.createElement('button');
      btn.className = 'theme-option' + (p.id === current ? ' active' : '');
      btn.innerHTML = '<span class="theme-swatch" data-preset="' + p.id + '"></span>' + p.name;
      btn.addEventListener('click', function () {
        ThemeManager.apply(p.id);
        themeList.querySelectorAll('.theme-option').forEach(function (el) { el.classList.remove('active'); });
        btn.classList.add('active');
      });
      themeList.appendChild(btn);
    });

    themeOverlay.style.display = 'flex';
  }

  themeClose.addEventListener('click', function () { themeOverlay.style.display = 'none'; });
  themeOverlay.addEventListener('click', function (e) {
    if (e.target === themeOverlay) themeOverlay.style.display = 'none';
  });

  // Update terminal themes when theme changes
  window.addEventListener('theme-changed', function () {
    var theme = ThemeManager.getTerminalTheme();
    tasks.forEach(function (task) {
      task.terminal.options.theme = theme;
    });
  });

  // ---- File Viewer (C1) — renders inline in the diff panel ----

  // ---- File Browser (extracted to file-browser.js) ----
  var loadFileTree = FileBrowser.loadFileTree;
  var doProjectSearch = FileBrowser.doProjectSearch;

  // ---- Feature panels (extracted to history-panel.js, stash-panel.js) ----
  var loadHistory = HistoryPanel.loadHistory;
  var loadStash = StashPanel.loadStash;

  // ---- Global tab reload (called by PRPanel.reloadActiveTab) ----
  window._reloadDiffTab = function (tab, wt) {
    if (tab === 'files') loadFileTree(wt);
    else if (tab === 'history') loadHistory(wt);
    else if (tab === 'stash') loadStash(wt);
    else if (tab === 'search') doProjectSearch(wt);
    else if (tab === 'env') { EnvPanel.setWorktree(wt); EnvPanel.load(); }
  };

  var escHtml = AppUtils.escHtml;

  // ---- Sidebar toggle & manual resize ----
  var DEFAULT_SIDEBAR_WIDTH = 240;
  var MIN_SIDEBAR_WIDTH = 140;
  var MAX_SIDEBAR_RATIO = 0.4;

  function refitTerminals() {
    setTimeout(function () {
      if (currentLayout() !== 'single') {
        fitAllTerminals();
      } else if (AppState.activeTaskId != null) {
        var task = tasks.get(AppState.activeTaskId);
        if (task) {
          task.fitAddon.fit();
          window.klaus.resizeTerminal(AppState.activeTaskId, task.terminal.cols, task.terminal.rows);
        }
      }
    }, 250);
  }

  function toggleSidebar() {
    AppState.sidebarCollapsed = !AppState.sidebarCollapsed;
    sidebar.style.width = '';
    sidebar.style.minWidth = '';
    sidebar.classList.toggle('collapsed', AppState.sidebarCollapsed);
    sidebar.classList.remove('expanded');
    sidebarToggleIcon.textContent = AppState.sidebarCollapsed ? '\u25B6' : '\u25C0';
    sidebarToggleLabel.textContent = AppState.sidebarCollapsed ? 'Show' : 'Hide';
    refitTerminals();
  }

  btnSidebarToggle.addEventListener('click', toggleSidebar);

  // Drag handle on right edge of sidebar for manual resize
  var sidebarResizeHandle = document.createElement('div');
  sidebarResizeHandle.className = 'sidebar-resize-handle';
  sidebar.appendChild(sidebarResizeHandle);

  (function () {
    var dragging = false;
    var startX = 0;
    var startWidth = 0;

    sidebarResizeHandle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      sidebarResizeHandle.classList.add('active');
      sidebar.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var newWidth = startWidth + (e.clientX - startX);
      var maxWidth = window.innerWidth * MAX_SIDEBAR_RATIO;
      newWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(newWidth, maxWidth));
      sidebar.classList.remove('collapsed', 'expanded');
      AppState.sidebarCollapsed = false;
      sidebar.style.width = newWidth + 'px';
      sidebar.style.minWidth = newWidth + 'px';
      sidebarToggleIcon.textContent = '\u25C0';
      sidebarToggleLabel.textContent = 'Hide';
    });

    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      sidebarResizeHandle.classList.remove('active');
      sidebar.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      refitTerminals();
    });
  })();

  // ---- Init ----
  AppState.repoPath = await window.klaus.getRepo();
  if (AppState.repoPath) {
    showApp();
  } else {
    repoOverlay.style.display = 'flex';
  }

  btnSelectRepo.addEventListener('click', async function () {
    var selected = await window.klaus.selectRepo();
    if (selected) {
      AppState.repoPath = selected;
      // Also add to projects list
      await window.klaus.addProject();
      showApp();
    }
  });

  async function showApp() {
    repoOverlay.style.display = 'none';
    appEl.style.display = 'flex';
    await loadProjects();
    if (isSecondaryWindow) {
      await loadWorktreeList();
    } else {
      loadExistingTasks();
    }
  }

  async function loadExistingTasks() {
    var existing = await window.klaus.listTasks();
    for (var i = 0; i < existing.length; i++) {
      addTaskToUI(existing[i]);
    }

    // Show saved sessions that don't overlap with running tasks
    await loadSavedSessions(existing);

    // Also load worktrees that don't have active terminals
    var worktrees = await window.klaus.listWorktrees();
    var activePaths = existing.map(function (t) { return t.worktreePath; });
    worktrees.forEach(function (wt) {
      if (activePaths.indexOf(wt.path) === -1) {
        addWorktreeToSidebar(wt);
      }
    });
  }

  async function loadWorktreeList() {
    var worktrees = await window.klaus.listWorktrees();
    worktrees.forEach(function (wt) {
      addWorktreeToSidebar(wt);
    });
  }

  window._addWorktreeToSidebar = addWorktreeToSidebar;
  function addWorktreeToSidebar(wt) {
    // Don't add if already in sidebar (as a worktree item or active task)
    var existing = taskList.querySelector('.worktree-item[data-path="' + CSS.escape(wt.path) + '"]');
    if (existing) return;

    var item = document.createElement('div');
    item.className = 'task-item worktree-item';
    item.dataset.path = wt.path;

    var iconColor = AppUtils.iconColor(wt.name);
    var iconLetter = (wt.name || '?').charAt(0).toUpperCase();
    item.innerHTML =
      '<span class="status-dot idle"></span>' +
      '<span class="collapsed-icon" style="background:' + iconColor + '" title="' + escHtml(wt.name) + '">' + iconLetter + '</span>' +
      '<div class="saved-session-info">' +
        '<span class="task-name" title="' + escHtml(wt.path) + '">' + escHtml(wt.name) + '</span>' +
        '<span class="saved-session-detail">' + escHtml(wt.branch) + '</span>' +
      '</div>' +
      '<div class="saved-session-actions">' +
        '<button class="worktree-open-claude" title="Open with Claude Code">cc</button>' +
        '<button class="worktree-open-shell" title="Open shell">sh</button>' +
        '<button class="worktree-remove" title="Remove worktree">\u00d7</button>' +
      '</div>';

    item.querySelector('.worktree-open-claude').addEventListener('click', async function (e) {
      e.stopPropagation();
      var result = await window.klaus.attachWorktree(wt.path, 'claude');
      if (result.error) return;
      addTaskToUI(result);
      switchToTask(result.id);
    });

    item.querySelector('.worktree-open-shell').addEventListener('click', async function (e) {
      e.stopPropagation();
      var result = await window.klaus.attachWorktree(wt.path, 'shell');
      if (result.error) return;
      addTaskToUI(result);
      switchToTask(result.id);
    });

    item.querySelector('.worktree-remove').addEventListener('click', async function (e) {
      e.stopPropagation();
      await window.klaus.hideWorktree(wt.path);
      item.remove();
    });

    item.addEventListener('click', function () {
      if (AppState.sidebarCollapsed) {
        item.querySelector('.worktree-open-claude').click();
      }
    });

    taskList.appendChild(item);
  }

  async function loadSavedSessions(runningTasks) {
    var sessions = await window.klaus.listSavedSessions();
    if (!sessions || sessions.length === 0) return;

    // Filter out sessions that have a running task on the same worktree
    var runningPaths = (runningTasks || []).map(function (t) { return t.worktreePath; });
    sessions = sessions.filter(function (s) {
      return runningPaths.indexOf(s.worktreePath) === -1;
    });
    if (sessions.length === 0) return;

    sessions.forEach(function (s, idx) {
      var item = document.createElement('div');
      item.className = 'task-item saved-session';
      item.dataset.idx = idx;

      var age = formatAge(s.savedAt);
      var pathShort = s.worktreePath ? s.worktreePath.split('/').slice(-2).join('/') : '';

      var modeLabel = s.mode === 'shell' ? 'SH' : 'cc';
      var modeTitle = s.mode === 'shell' ? 'Previous shell session' : 'Previous session';
      var sIconColor = AppUtils.iconColor(s.name);
      var sIconLetter = (s.name || '?').charAt(0).toUpperCase();
      item.innerHTML =
        '<span class="status-dot saved"></span>' +
        '<span class="collapsed-icon" style="background:' + sIconColor + '" title="' + escHtml(s.name) + '">' + sIconLetter + '</span>' +
        '<span class="task-mode" title="' + modeTitle + '">' + modeLabel + '</span>' +
        '<div class="saved-session-info">' +
          '<span class="task-name" title="' + escHtml(s.worktreePath || '') + '">' + escHtml(s.name) + '</span>' +
          '<span class="saved-session-detail">' + escHtml(s.branch || pathShort) + ' &middot; ' + escHtml(age) + '</span>' +
        '</div>' +
        '<div class="saved-session-actions">' +
          (s.mode === 'shell'
            ? '<button class="saved-session-resume" title="Open shell">Open</button>'
            : '<button class="saved-session-resume" title="Resume conversation">Resume</button>' +
              '<button class="saved-session-new" title="New session on this worktree">New</button>') +
          '<button class="saved-session-dismiss" title="Dismiss">&times;</button>' +
        '</div>';

      item.querySelector('.saved-session-resume').addEventListener('click', async function (e) {
        e.stopPropagation();
        var btn = e.target;
        btn.disabled = true;
        btn.textContent = '...';
        var result;
        if (s.mode === 'shell') {
          result = await window.klaus.attachWorktree(s.worktreePath, 'shell');
        } else {
          result = await window.klaus.resumeSession(s);
        }
        if (result.error) {
          btn.textContent = 'Err';
          setTimeout(function () { btn.textContent = s.mode === 'shell' ? 'Open' : 'Resume'; btn.disabled = false; }, 2000);
          return;
        }
        item.remove();
        addTaskToUI(result);
        switchToTask(result.id);
        restoreUIState(result);
      });

      var newBtn = item.querySelector('.saved-session-new');
      if (newBtn) newBtn.addEventListener('click', async function (e) {
        e.stopPropagation();
        var btn = e.target;
        btn.disabled = true;
        btn.textContent = '...';
        var result = await window.klaus.attachWorktree(s.worktreePath, 'claude');
        if (result.error) {
          btn.textContent = 'Err';
          setTimeout(function () { btn.textContent = 'New'; btn.disabled = false; }, 2000);
          return;
        }
        item.remove();
        addTaskToUI(result);
        switchToTask(result.id);
      });

      item.addEventListener('click', function () {
        if (AppState.sidebarCollapsed) {
          item.querySelector('.saved-session-resume').click();
        }
      });

      item.querySelector('.saved-session-dismiss').addEventListener('click', function (e) {
        e.stopPropagation();
        item.remove();
        // Clear this session from saved list
        sessions.splice(idx, 1);
        var config_sessions = sessions.filter(function () { return true; });
        // If all dismissed, clear saved sessions entirely
        if (taskList.querySelectorAll('.saved-session').length === 0) {
          window.klaus.clearSavedSessions();
        }
      });

      taskList.appendChild(item);
    });
  }

  async function restoreUIState(task) {
    var uiState = await window.klaus.getUIState();

    // Scroll terminal to bottom after data loads
    var t = tasks.get(task.id);
    if (t && t.terminal) {
      // Give Claude time to send initial output
      setTimeout(function () {
        t.terminal.scrollToBottom();
      }, 2000);
    }

    if (!uiState) return;

    // Restore diff panel
    if (uiState.diffPanelOpen && task.worktreePath) {
      DiffPanel.show(task.worktreePath);
      PRPanel.setWorktree(task.worktreePath);

      btnDiff.classList.add('active');

      // Restore selected file after the file list loads
      if (uiState.selectedFile) {
        setTimeout(async function () {
          await DiffPanel.showFile(uiState.selectedFile);
        }, 1000);
      }
    }
  }

  var formatAge = AppUtils.formatAge;

  // ---- New Task (modal) ----
  const modalOverlay = document.getElementById('modal-overlay');
  const modalInput = document.getElementById('modal-input');
  const modalError = document.getElementById('modal-error');
  const modalCreate = document.getElementById('modal-create');
  const modalCancel = document.getElementById('modal-cancel');
  const pathDisplay = document.getElementById('path-display');
  const btnBrowse = document.getElementById('btn-browse');
  const basepathDisplay = document.getElementById('basepath-display');
  const btnBasepath = document.getElementById('btn-basepath');
  const modalTabs = document.querySelectorAll('.modal-tab');
  const tabContents = document.querySelectorAll('.tab-content');

  let activeTab = 'new';
  let selectedWorktreePath = null;
  let selectedBasePath = null;
  let selectedMode = 'claude';
  let selectedBranch = null;
  let branchData = [];

  // Shell selector
  const shellOptions = document.querySelectorAll('.shell-option');
  shellOptions.forEach(function (btn) {
    btn.addEventListener('click', function () {
      selectedMode = btn.dataset.shell;
      shellOptions.forEach(function (b) { b.classList.toggle('active', b === btn); });
    });
  });

  // Tab switching
  var branchFilter = document.getElementById('branch-filter');
  var branchListEl = document.getElementById('branch-list');

  modalTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      activeTab = tab.dataset.tab;
      modalTabs.forEach(function (t) { t.classList.toggle('active', t === tab); });
      tabContents.forEach(function (c) { c.classList.toggle('active', c.id === 'tab-' + activeTab); });
      modalError.textContent = '';
      if (activeTab === 'new') {
        setTimeout(function () { modalInput.focus(); }, 50);
      }
      if (activeTab === 'branch') {
        loadBranches();
        setTimeout(function () { branchFilter.focus(); }, 50);
      }
    });
  });

  async function loadBranches() {
    branchListEl.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:13px;">Loading branches...</div>';
    selectedBranch = null;
    var result = await window.klaus.listBranches(AppState.repoPath);
    if (result.error) {
      branchListEl.innerHTML = '<div style="padding:12px;color:var(--error);font-size:13px;">' + escHtml(result.error) + '</div>';
      return;
    }
    branchData = result.branches || [];
    renderBranches('');
  }

  function renderBranches(filter) {
    var filtered = branchData;
    if (filter) {
      var lc = filter.toLowerCase();
      filtered = branchData.filter(function (b) { return b.localName.toLowerCase().includes(lc); });
    }
    if (filtered.length === 0) {
      branchListEl.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:13px;">No matching branches</div>';
      return;
    }
    branchListEl.innerHTML = filtered.map(function (b) {
      return '<div class="branch-item' + (selectedBranch === b.localName ? ' selected' : '') + '" data-branch="' + escHtml(b.localName) + '" data-remote="' + b.isRemote + '">' +
        '<span class="branch-name">' + escHtml(b.localName) + '</span>' +
        (b.isRemote ? '<span class="branch-remote-tag">remote</span>' : '') +
        '<span class="branch-meta">' + escHtml(b.date || '') + '</span>' +
      '</div>';
    }).join('');
  }

  branchListEl.addEventListener('click', function (e) {
    var item = e.target.closest('.branch-item');
    if (!item) return;
    selectedBranch = item.dataset.branch;
    branchListEl.querySelectorAll('.branch-item').forEach(function (el) {
      el.classList.toggle('selected', el.dataset.branch === selectedBranch);
    });
  });

  branchFilter.addEventListener('input', function () {
    renderBranches(branchFilter.value.trim());
  });

  btnBrowse.addEventListener('click', async function () {
    var dir = await window.klaus.browseDirectory();
    if (dir) {
      selectedWorktreePath = dir;
      pathDisplay.textContent = dir;
      pathDisplay.classList.add('has-path');
    }
  });

  btnBasepath.addEventListener('click', async function () {
    var dir = await window.klaus.browseDirectory();
    if (dir) {
      selectedBasePath = dir;
      basepathDisplay.textContent = dir;
      basepathDisplay.classList.add('has-path');
    }
  });

  function showModal() {
    modalOverlay.style.display = 'flex';
    modalInput.value = '';
    modalError.textContent = '';
    modalCreate.disabled = false;
    selectedWorktreePath = null;
    pathDisplay.textContent = 'No directory selected';
    pathDisplay.classList.remove('has-path');
    selectedBasePath = null;
    basepathDisplay.textContent = 'Default';
    basepathDisplay.classList.remove('has-path');
    activeTab = 'new';
    selectedMode = AppState.savedPrefs.defaultMode || 'claude';
    modalTabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === 'new'); });
    tabContents.forEach(function (c) { c.classList.toggle('active', c.id === 'tab-new'); });
    shellOptions.forEach(function (b) { b.classList.toggle('active', b.dataset.shell === selectedMode); });
    selectedBranch = null;
    branchData = [];
    branchListEl.innerHTML = '';
    branchFilter.value = '';
    var envField = document.getElementById('modal-env-vars');
    if (envField) envField.value = '';
    // Show repo picker so user explicitly selects which repo to create worktree from
    var repoIndicator = document.getElementById('modal-repo-indicator');
    if (repoIndicator) {
      repoIndicator.innerHTML =
        '<strong>Repo:</strong> ' +
        '<span id="modal-repo-path" class="modal-repo-path">' + escHtml(AppState.repoPath || 'No repo selected') + '</span>' +
        ' <button id="btn-modal-repo-browse" class="modal-repo-browse">Browse</button>';
      repoIndicator.style.display = '';
      document.getElementById('btn-modal-repo-browse').addEventListener('click', async function () {
        var dir = await window.klaus.browseDirectory();
        if (dir) {
          AppState.repoPath = dir;
          document.getElementById('modal-repo-path').textContent = dir;
        }
      });
    }
    setTimeout(function () { modalInput.focus(); }, 50);
  }

  function hideModal() {
    modalOverlay.style.display = 'none';
    modalInput.value = '';
    modalError.textContent = '';
  }

  btnNewTask.addEventListener('click', showModal);
  modalCreate.addEventListener('click', submitModal);
  modalCancel.addEventListener('click', hideModal);
  modalOverlay.addEventListener('click', function (e) {
    if (e.target === modalOverlay) hideModal();
  });
  modalInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitModal();
    if (e.key === 'Escape') hideModal();
  });

  // ---- Terminal, Sidebar, Layout (extracted to terminal-manager.js, sidebar-manager.js) ----
  var addTaskToUI = TerminalManager.addTaskToUI;
  var removeTaskFromUI = TerminalManager.removeTaskFromUI;
  var switchToTask = TerminalManager.switchToTask;
  var rewireTerminal = TerminalManager.rewireTerminal;
  var currentLayout = TerminalManager.currentLayout;
  var fitAllTerminals = TerminalManager.fitAllTerminals;
  var zoomIn = TerminalManager.zoomIn;
  var zoomOut = TerminalManager.zoomOut;
  var zoomReset = TerminalManager.zoomReset;
  var updateSidebarItem = Sidebar.updateItem;
  var updateSidebarMode = Sidebar.updateMode;
  var showResumeButton = Sidebar.showResumeButton;
  var showUnreadBadge = Sidebar.showUnreadBadge;
  var hideUnreadBadge = Sidebar.hideUnreadBadge;

  // Expose context menu builder for terminal-manager
  window._showContextMenu = showContextMenu;


  // ---- Right-click context menu ----

  function showContextMenu(x, y, id) {
    var task = tasks.get(id);
    if (!task) return;

    var items = [
      { label: 'Copy', shortcut: '\u2318C', action: function () {
        var sel = task.terminal.getSelection();
        if (sel) navigator.clipboard.writeText(sel);
      }},
      { label: 'Paste', shortcut: '\u2318V', action: function () {
        navigator.clipboard.readText().then(function (text) {
          if (text) window.klaus.writeTerminal(id, text);
        });
      }},
      { sep: true },
      { label: 'Search', shortcut: '\u2318F', action: function () { openSearch(id); }},
      { label: 'Clear', shortcut: '\u2318K', action: function () { task.terminal.clear(); }},
      { sep: true },
      { label: 'Zoom In', shortcut: '\u2318+', action: zoomIn },
      { label: 'Zoom Out', shortcut: '\u2318\u2212', action: zoomOut },
      { label: 'Reset Zoom', shortcut: '\u23180', action: zoomReset },
      { sep: true },
      { label: 'Show Changes', action: function () {
        DiffPanel.show(task.worktreePath);
        PRPanel.setWorktree(task.worktreePath);
        btnDiff.classList.add('active');
      }},
      { label: 'Pop Out', action: async function () {
        await window.klaus.popOutTask(id);
      }},
      { label: 'Duplicate', action: async function () {
        var result = await window.klaus.duplicateTask(id);
        if (result && !result.error) {
          addTaskToUI(result);
          switchToTask(result.id);
        }
      }},
      { label: 'View File...', action: function () {
        var filePath = prompt('File path (relative to worktree):');
        if (filePath) {
          var full = task.worktreePath + '/' + filePath;
          window.openFileViewer(full, filePath);
        }
      }},
      { sep: true },
      { label: (task.notifyEnabled !== false ? '\u2713 ' : '  ') + 'Notify When Idle', action: async function () {
        var newVal = task.notifyEnabled === false;
        task.notifyEnabled = newVal;
        await window.klaus.setNotifyEnabled(id, newVal);
      }},
      { label: 'Export Transcript', action: async function () {
        var result = await window.klaus.exportTranscript(id);
        if (result.canceled || result.error) return;
        var buf = task.terminal.buffer.active;
        var lines = [];
        for (var i = 0; i < buf.length; i++) {
          var line = buf.getLine(i);
          if (line) lines.push(line.translateToString(true));
        }
        await window.klaus.writeTranscript(result.filePath, lines.join('\n'));
      }},
    ];

    if (!task.alive) {
      items.push({ sep: true });
      items.push({ label: 'Restart Claude', action: async function () {
        var sessionId = await window.klaus.getLatestSession(task.worktreePath);
        var cmd = sessionId ? 'claude --resume ' + sessionId : 'claude';
        window.klaus.writeTerminal(id, cmd + '\n');
        task.mode = 'claude';
        updateSidebarMode(id, 'claude');
        var resumeBtn = taskList.querySelector('.task-item[data-id="' + id + '"] .sidebar-resume-btn');
        if (resumeBtn) resumeBtn.remove();
      }});
    }

    ContextMenu.show(x, y, items);
  }

  // Keyboard shortcut: Cmd+G to toggle diff panel
  document.addEventListener('keydown', function (e) {
    if (e.metaKey && e.key === 'g') {
      e.preventDefault();
      btnDiff.click();
    }
  });

  // ---- Command Palette (A3) ----

  function buildPaletteCommands() {
    var commands = [
      { label: 'New Task', action: function () { showModal(); } },
      { label: 'Toggle Diff Panel', action: function () { btnDiff.click(); } },
      { label: 'Change Theme', action: function () { showThemePicker(); } },
      { label: 'Preferences', action: function () { window.klaus.openPreferences(); } },
      { label: 'New Window', action: function () { window.klaus.newWindow(); } },
      { label: 'Zoom In', action: zoomIn },
      { label: 'Zoom Out', action: zoomOut },
      { label: 'Reset Zoom', action: zoomReset },
    ];

    if (AppState.activeTaskId) {
      var task = tasks.get(AppState.activeTaskId);
      if (task) {
        commands.push({ label: 'Search in Terminal', action: function () { openSearch(AppState.activeTaskId); } });
        commands.push({ label: 'Clear Terminal', action: function () { task.terminal.clear(); } });
        commands.push({ label: 'Show Changes', action: function () { DiffPanel.show(task.worktreePath); btnDiff.classList.add('active'); } });
        commands.push({ label: 'Pop Out', action: function () { window.klaus.popOutTask(AppState.activeTaskId); } });
        commands.push({ label: 'Kill Task', action: function () { window.klaus.killTask(AppState.activeTaskId).then(function () { removeTaskFromUI(AppState.activeTaskId); }); } });
        if (!task.alive) {
          commands.push({ label: 'Restart Claude', action: function () {
            window.klaus.getLatestSession(task.worktreePath).then(function (sessionId) {
              var cmd = sessionId ? 'claude --resume ' + sessionId : 'claude';
              window.klaus.writeTerminal(AppState.activeTaskId, cmd + '\n');
              task.mode = 'claude';
              updateSidebarMode(AppState.activeTaskId, 'claude');
            });
          }});
        }
      }
    }

    tasks.forEach(function (t, id) {
      if (id !== AppState.activeTaskId) {
        commands.push({ label: 'Switch to: ' + t.name, action: function () { switchToTask(id); } });
      }
    });

    commands.push({ label: 'View Logs', action: showLogViewer });
    commands.push({ label: 'About Klaussy', action: showAboutDialog });

    return commands;
  }

  function showCommandPalette() {
    CommandPalette.show(buildPaletteCommands());
  }

  document.addEventListener('keydown', function (e) {
    if (e.metaKey && e.key === 'k') {
      e.preventDefault();
      showCommandPalette();
    }
  });

  // Task rename and reorder extracted to sidebar-manager.js

  // ---- About Dialog (A7) ----

  var showAboutDialog = Dialogs.showAbout;
  var showLogViewer = Dialogs.showLog;

  // ---- E3: Parse env vars from modal ----

  var modalEnvVars = document.getElementById('modal-env-vars');

  async function submitModal() {
    modalCreate.disabled = true;
    modalCreate.textContent = 'Creating...';
    modalError.textContent = '';

    // Parse env vars
    var envVars = {};
    var envText = modalEnvVars.value.trim();
    if (envText) {
      envText.split('\n').forEach(function (line) {
        var eq = line.indexOf('=');
        if (eq > 0) {
          envVars[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
        }
      });
    }

    var result;

    if (activeTab === 'new') {
      var name = modalInput.value.trim();
      if (!name) {
        modalCreate.disabled = false;
        modalCreate.textContent = 'Create';
        return;
      }
      result = await window.klaus.createTask(name, AppState.repoPath, selectedMode, selectedBasePath, Object.keys(envVars).length > 0 ? envVars : undefined);
    } else if (activeTab === 'branch') {
      if (!selectedBranch) {
        modalCreate.disabled = false;
        modalCreate.textContent = 'Create';
        modalError.textContent = 'Select a branch first.';
        return;
      }
      result = await window.klaus.checkoutBranch(AppState.repoPath, selectedBranch, selectedMode, selectedBasePath, Object.keys(envVars).length > 0 ? envVars : undefined);
    } else {
      if (!selectedWorktreePath) {
        modalCreate.disabled = false;
        modalCreate.textContent = 'Create';
        modalError.textContent = 'Select a directory first.';
        return;
      }
      result = await window.klaus.attachWorktree(selectedWorktreePath, selectedMode);
    }

    modalCreate.disabled = false;
    modalCreate.textContent = 'Create';

    if (result.error) {
      modalError.textContent = result.error;
      return;
    }

    hideModal();
    addTaskToUI(result);
    switchToTask(result.id);
  }
})();
