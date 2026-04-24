(async function () {
  var tasks = AppState.tasks;
  var ciStatusMap = AppState.ciStatusMap;
  const isSecondaryWindow = new URLSearchParams(window.location.search).has('secondary');
  const layouts = ['single', 'columns', 'grid'];
  const layoutIcons = { single: '\u25A8', columns: '\u2759\u2759', grid: '\u2637' };

  const appEl = document.getElementById('app');
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
      window.klaus.terminal.write(AppState.activeTaskId, text + '\n');
    }
  });

  // ---- Handle Claude → shell conversion ----
  window.klaus.task.onConverted(function (data) {
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
      window.klaus.terminal.resize(data.id, t.terminal.cols, t.terminal.rows);
    }, 100);
  });

  // ---- Handle notification click → focus task ----
  window.klaus.task.onNotificationClicked(function (data) {
    switchToTask(data.id);
  });

  // ---- CI/CD Status (Feature 3) ----
  window.klaus.task.onCIStatusUpdate(function (data) {
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
  window.klaus.task.onAutoFetchUpdate(function (data) {
    // If the updated task is active and diff panel is open, refresh ahead/behind
    if (data.id === AppState.activeTaskId && DiffPanel.isVisible()) {
      DiffPanel.updateAheadBehind();
    }
  });

  // ---- Save UI state before quit ----
  // Only the main window owns the persistent UI state — secondary windows
  // and popouts would otherwise clobber each other on their own timer ticks.
  if (!isSecondaryWindow) {
    window.klaus.session.onBeforeQuit(function () {
      var state = {
        diffPanelOpen: DiffPanel.isVisible(),
        selectedFile: DiffPanel.getSelectedFile(),
      };
      window.klaus.session.saveUIState(state);
    });

    // Also save periodically in case of crash
    setInterval(function () {
      var state = {
        diffPanelOpen: DiffPanel.isVisible(),
        selectedFile: DiffPanel.getSelectedFile(),
      };
      window.klaus.session.saveUIState(state);
    }, 10000);
  }

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
        if (!task.branch) forceFilesTab();
      }
    }
  });

  // ---- Branchless-task UI (Open Folder flow) ----
  //
  // Tasks opened via "Open Folder" have no branch. The orange warning banner
  // lives inside the specific terminal's container (not globally), so it only
  // covers that pane in grid/columns view. What the active-task signal still
  // controls: which tabs are visible in the diff panel (git-only tabs hide
  // when the active task is branchless) and the default Files tab selection.
  var filesTabBtn = document.querySelector('#diff-tabs .diff-tab[data-tab="files"]');

  function forceFilesTab() {
    if (filesTabBtn && !filesTabBtn.classList.contains('active')) filesTabBtn.click();
  }

  window.BranchlessUI = {
    apply: function (task) {
      var branchless = !!(task && !task.branch);
      document.body.classList.toggle('task-branchless', branchless);
      if (branchless && DiffPanel.isVisible()) {
        var activeTab = document.querySelector('#diff-tabs .diff-tab.active');
        var hidden = activeTab && ['changes', 'pr', 'history', 'stash', 'env'].indexOf(activeTab.dataset.tab) !== -1;
        if (hidden) forceFilesTab();
      }
    },
  };
  // Subscribe to the task-switch event instead of being called directly from
  // terminal-manager. The `.apply` method stays exposed for any caller that
  // needs to force a re-evaluation without a full task switch.
  Events.on('task:switched', function (detail) {
    window.BranchlessUI.apply(detail && detail.task);
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
    window.klaus.ui.newWindow();
  });

  // ---- Preferences (B1-B4) ----
  const btnPrefs = document.getElementById('btn-prefs');
  btnPrefs.addEventListener('click', function () {
    window.klaus.ui.openPreferences();
  });

  // Apply preference changes broadcast from main process
  window.klaus.ui.onPreferencesChanged(function (prefs) {
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
        window.klaus.terminal.resize(id, task.terminal.cols, task.terminal.rows);
      });
    }
    if (prefs.theme !== undefined) {
      ThemeManager.apply(prefs.theme.preset);
    }
  });

  // Load saved terminal preferences on startup
  window.klaus.ui.getPreferences().then(function (prefs) {
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
          window.klaus.terminal.resize(AppState.activeTaskId, task.terminal.cols, task.terminal.rows);
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
  AppState.repoPath = await window.klaus.repo.get();
  // Always show the app — the project-switcher's `+` button is the canonical
  // way to add a repo. The old "Select Repository" splash blocked startup
  // for first-runs without a project; the empty task list + project picker
  // handle that case fine on their own.
  showApp();

  // Swap the empty-state copy based on whether the user has a project yet.
  // Helps first-runs — without a project, "Click + to create a new task"
  // is a dead end since task creation needs a repo.
  function updateEmptyState() {
    var defaultEl = document.getElementById('empty-state-default');
    var noProjEl = document.getElementById('empty-state-no-project');
    if (!defaultEl || !noProjEl) return;
    var noProject = !AppState.repoPath;
    defaultEl.style.display = noProject ? 'none' : '';
    noProjEl.style.display = noProject ? '' : 'none';
  }

  async function showApp() {
    appEl.style.display = 'flex';
    await loadProjects();
    updateEmptyState();
    if (isSecondaryWindow) {
      await loadWorktreeList();
    } else {
      loadExistingTasks();
    }
  }

  async function loadExistingTasks() {
    var existing = await window.klaus.task.list();
    for (var i = 0; i < existing.length; i++) {
      addTaskToUI(existing[i]);
    }

    // Show saved sessions that don't overlap with running tasks
    await loadSavedSessions(existing);

    // Also load worktrees that don't have active terminals
    var worktrees = await window.klaus.repo.listWorktrees();
    var activePaths = existing.map(function (t) { return t.worktreePath; });
    worktrees.forEach(function (wt) {
      if (activePaths.indexOf(wt.path) === -1) {
        addWorktreeToSidebar(wt);
      }
    });
  }

  async function loadWorktreeList() {
    var worktrees = await window.klaus.repo.listWorktrees();
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
      var result = await window.klaus.task.attachWorktree(wt.path, 'claude');
      if (result.error) return;
      addTaskToUI(result);
      switchToTask(result.id);
    });

    item.querySelector('.worktree-open-shell').addEventListener('click', async function (e) {
      e.stopPropagation();
      var result = await window.klaus.task.attachWorktree(wt.path, 'shell');
      if (result.error) return;
      addTaskToUI(result);
      switchToTask(result.id);
    });

    item.querySelector('.worktree-remove').addEventListener('click', async function (e) {
      e.stopPropagation();
      await window.klaus.repo.hideWorktree(wt.path);
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
    var sessions = await window.klaus.session.listSaved();
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
          result = await window.klaus.task.attachWorktree(s.worktreePath, 'shell');
        } else {
          result = await window.klaus.session.resume(s);
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
        var result = await window.klaus.task.attachWorktree(s.worktreePath, 'claude');
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
        // Persist removal by stable identity (worktreePath + sessionId) rather
        // than the captured `idx` — splice-by-idx silently removed the wrong
        // row after any earlier dismiss shifted the array, and the removal
        // was only persisted when ALL rows had been dismissed.
        window.klaus.session.dismissSaved(s);
      });

      taskList.appendChild(item);
    });
  }

  async function restoreUIState(task) {
    var uiState = await window.klaus.session.getUIState();

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
  let selectedBaseBranch = '';

  // Shell selector
  const shellOptions = document.querySelectorAll('.shell-option');
  shellOptions.forEach(function (btn) {
    btn.addEventListener('click', function () {
      selectedMode = btn.dataset.shell;
      shellOptions.forEach(function (b) { b.classList.toggle('active', b === btn); });
    });
  });

  // Tab switching
  var baseBranchInput = document.getElementById('modal-base-branch-input');
  var baseBranchList = document.getElementById('modal-base-branch-list');
  var baseBranchData = []; // [{ localName, isRemote, ... }]
  var baseBranchDefault = ''; // pre-selected branch (dev > main > master fallback)

  modalTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      activeTab = tab.dataset.tab;
      modalTabs.forEach(function (t) { t.classList.toggle('active', t === tab); });
      tabContents.forEach(function (c) { c.classList.toggle('active', c.id === 'tab-' + activeTab); });
      modalError.textContent = '';
      if (activeTab === 'new') {
        setTimeout(function () { modalInput.focus(); }, 50);
      }
    });
  });

  // Combobox wiring — input shows the picked branch (or filter text); list
  // opens on focus; click outside dismisses; arrow keys navigate.
  if (baseBranchInput) {
    baseBranchInput.addEventListener('focus', function () {
      // First focus = clear placeholder default + open list with everything visible.
      if (baseBranchInput.classList.contains('has-default')) {
        baseBranchInput.classList.remove('has-default');
        baseBranchInput.value = '';
      }
      renderBaseBranchOptions('');
      baseBranchList.hidden = false;
    });
    baseBranchInput.addEventListener('input', function () {
      renderBaseBranchOptions(baseBranchInput.value.trim());
      baseBranchList.hidden = false;
    });
    baseBranchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { baseBranchList.hidden = true; baseBranchInput.blur(); }
      else if (e.key === 'Enter') {
        var first = baseBranchList.querySelector('.basebranch-option');
        if (first) { e.preventDefault(); pickBaseBranch(first.dataset.branch); }
      }
    });
    document.addEventListener('mousedown', function (e) {
      if (!document.getElementById('basebranch-combobox').contains(e.target)) {
        baseBranchList.hidden = true;
        // Restore the picked value if the user typed nothing then dismissed.
        if (selectedBaseBranch && baseBranchInput.value.trim() === '') {
          setBaseBranchInputDisplay(selectedBaseBranch, selectedBaseBranch === baseBranchDefault);
        }
      }
    });
  }

  function setBaseBranchInputDisplay(branchName, isDefault) {
    if (!baseBranchInput) return;
    baseBranchInput.value = branchName + (isDefault ? ' (default)' : '');
    baseBranchInput.classList.toggle('has-default', !!isDefault);
  }

  function pickBaseBranch(name) {
    selectedBaseBranch = name;
    setBaseBranchInputDisplay(name, name === baseBranchDefault);
    baseBranchList.hidden = true;
  }

  function renderBaseBranchOptions(filter) {
    if (!baseBranchList) return;
    var lc = (filter || '').toLowerCase();
    var matches = baseBranchData.filter(function (b) {
      return !lc || b.localName.toLowerCase().includes(lc);
    });
    if (matches.length === 0) {
      baseBranchList.innerHTML = '<div class="basebranch-option-empty">No matching branches</div>';
      return;
    }
    baseBranchList.innerHTML = matches.map(function (b) {
      var defCls = b.localName === baseBranchDefault ? ' is-default' : '';
      var tag = b.localName === baseBranchDefault ? 'default'
        : b.isRemote ? 'remote' : '';
      return '<div class="basebranch-option' + defCls + '" data-branch="' + escHtml(b.localName) + '">'
        + '<span>' + escHtml(b.localName) + '</span>'
        + (tag ? '<span class="basebranch-option-tag">' + tag + '</span>' : '')
      + '</div>';
    }).join('');
    baseBranchList.querySelectorAll('.basebranch-option').forEach(function (el) {
      el.addEventListener('mousedown', function (e) {
        // mousedown (not click) so we fire before the input's blur dismiss.
        e.preventDefault();
        pickBaseBranch(el.dataset.branch);
      });
    });
  }

  // Optimistic populate from cached refs; then `git fetch` in the background
  // and re-render so remote branches stay fresh without blocking the modal.
  async function populateBaseBranchSelect() {
    if (!baseBranchInput) return;
    if (!AppState.repoPath) {
      baseBranchData = [];
      baseBranchDefault = '';
      baseBranchInput.value = 'No project selected';
      baseBranchInput.classList.add('has-default');
      return;
    }
    await loadBaseBranchData();
    try { await window.klaus.git.fetch(AppState.repoPath); } catch (_) {}
    await loadBaseBranchData();
  }

  async function loadBaseBranchData() {
    var result = await window.klaus.task.listBranches(AppState.repoPath);
    if (result.error || !result.branches) {
      baseBranchData = [];
      baseBranchDefault = '';
      return;
    }

    // Preferred default order — pick the first branch that exists.
    var preferred = ['dev', 'main', 'master'];
    var localNames = result.branches.map(function (b) { return b.localName; });
    baseBranchDefault = preferred.find(function (p) { return localNames.indexOf(p) !== -1; })
      || result.defaultBranch
      || (result.branches[0] && result.branches[0].localName)
      || '';

    // Pin the default to the top of the list, then everything else alphabetically.
    var sorted = result.branches.slice().sort(function (a, b) {
      if (a.localName === baseBranchDefault) return -1;
      if (b.localName === baseBranchDefault) return 1;
      return a.localName.localeCompare(b.localName);
    });
    baseBranchData = sorted;

    // Initial selection = default. Preserve user's prior pick across re-renders.
    if (!selectedBaseBranch || localNames.indexOf(selectedBaseBranch) === -1) {
      selectedBaseBranch = baseBranchDefault;
    }
    setBaseBranchInputDisplay(selectedBaseBranch, selectedBaseBranch === baseBranchDefault);
  }

  btnBrowse.addEventListener('click', async function () {
    var dir = await window.klaus.repo.browseDirectory();
    if (dir) {
      selectedWorktreePath = dir;
      pathDisplay.textContent = dir;
      pathDisplay.classList.add('has-path');
    }
  });

  btnBasepath.addEventListener('click', async function () {
    var dir = await window.klaus.repo.browseDirectory();
    if (dir) {
      selectedBasePath = dir;
      basepathDisplay.textContent = dir;
      basepathDisplay.classList.add('has-path');
    }
  });

  function defaultBasePathDisplay() {
    if (!AppState.repoPath) return 'Default';
    var p = AppState.repoPath;
    var slash = p.lastIndexOf('/');
    return slash > 0 ? p.substring(0, slash) : 'Default';
  }

  function showModal() {
    modalOverlay.style.display = 'flex';
    modalInput.value = '';
    modalError.textContent = '';
    modalCreate.disabled = false;
    selectedWorktreePath = null;
    pathDisplay.textContent = 'No directory selected';
    pathDisplay.classList.remove('has-path');
    selectedBasePath = null;
    // Show the actual default location (the repo's parent dir) so the user
    // can see where the worktree will land without clicking Change.
    basepathDisplay.textContent = defaultBasePathDisplay();
    basepathDisplay.classList.remove('has-path');
    activeTab = 'new';
    selectedMode = AppState.savedPrefs.defaultMode || 'claude';
    modalTabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === 'new'); });
    tabContents.forEach(function (c) { c.classList.toggle('active', c.id === 'tab-new'); });
    shellOptions.forEach(function (b) { b.classList.toggle('active', b.dataset.shell === selectedMode); });
    selectedBaseBranch = '';
    populateBaseBranchSelect();
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
        var dir = await window.klaus.repo.browseDirectory();
        if (dir) {
          AppState.repoPath = dir;
          document.getElementById('modal-repo-path').textContent = dir;
          // Switching repos: clear the cached selection then re-fetch +
          // re-populate the branch dropdown for the new project. Update
          // the location display unless the user already overrode it.
          selectedBaseBranch = '';
          populateBaseBranchSelect();
          if (!selectedBasePath) basepathDisplay.textContent = defaultBasePathDisplay();
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
          if (text) window.klaus.terminal.write(id, text);
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
        await window.klaus.task.popOut(id);
      }},
      { label: 'Duplicate', action: async function () {
        var result = await window.klaus.task.duplicate(id);
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
        await window.klaus.task.setNotifyEnabled(id, newVal);
      }},
      { label: 'Export Transcript', action: async function () {
        var result = await window.klaus.task.exportTranscript(id);
        if (result.canceled || result.error) return;
        var buf = task.terminal.buffer.active;
        var lines = [];
        for (var i = 0; i < buf.length; i++) {
          var line = buf.getLine(i);
          if (line) lines.push(line.translateToString(true));
        }
        await window.klaus.task.writeTranscript(id, lines.join('\n'));
      }},
    ];

    if (!task.alive) {
      items.push({ sep: true });
      items.push({ label: 'Restart Claude', action: async function () {
        var sessionId = await window.klaus.session.getLatest(task.worktreePath);
        var cmd = sessionId ? 'claude --resume ' + sessionId : 'claude';
        window.klaus.terminal.write(id, cmd + '\n');
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

  async function openFolderAsTask(mode) {
    var dir = await window.klaus.repo.browseDirectory();
    if (!dir) return;
    var result = await window.klaus.task.openFolder(dir, mode || 'claude');
    if (!result || result.error) {
      if (result && result.error) window.toast.error(result.error);
      return;
    }
    addTaskToUI(result);
    switchToTask(result.id);
  }

  function buildPaletteCommands() {
    var commands = [
      { label: 'New Task', action: function () { showModal(); } },
      { label: 'Open Folder…', action: function () { openFolderAsTask('claude'); } },
      { label: 'Open Folder in Shell…', action: function () { openFolderAsTask('shell'); } },
      { label: 'Toggle Diff Panel', action: function () { btnDiff.click(); } },
      { label: 'Change Theme', action: function () { showThemePicker(); } },
      { label: 'Preferences', action: function () { window.klaus.ui.openPreferences(); } },
      { label: 'New Window', action: function () { window.klaus.ui.newWindow(); } },
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
        commands.push({ label: 'Pop Out', action: function () { window.klaus.task.popOut(AppState.activeTaskId); } });
        commands.push({ label: 'Kill Task', action: function () { window.klaus.task.kill(AppState.activeTaskId).then(function () { removeTaskFromUI(AppState.activeTaskId); }); } });
        if (!task.alive) {
          commands.push({ label: 'Restart Claude', action: function () {
            window.klaus.session.getLatest(task.worktreePath).then(function (sessionId) {
              var cmd = sessionId ? 'claude --resume ' + sessionId : 'claude';
              window.klaus.terminal.write(AppState.activeTaskId, cmd + '\n');
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

    commands.push({ label: 'Review Pull Request\u2026', action: function () { showPrPicker(); } });
    commands.push({ label: 'How to use Klaussy', action: function () { Dialogs.showHowToUse(); } });
    commands.push({ label: 'Keyboard shortcuts', action: function () { Dialogs.showShortcuts(); } });
    commands.push({ label: 'Skills & Commands', action: function () { Dialogs.showSkills(); } });
    commands.push({ label: 'Memory (CLAUDE.md)', action: function () { Dialogs.showMemory(); } });
    commands.push({ label: 'MCP Servers', action: function () { Dialogs.showMcpServers(); } });
    commands.push({ label: 'Plugins', action: function () { Dialogs.showPlugins(); } });
    commands.push({ label: 'GitHub accounts', action: function () { Dialogs.showGhAccounts(); } });
    commands.push({ label: 'Check dependencies\u2026', action: function () { Dialogs.checkAndPromptDeps({ force: true }); } });
    commands.push({ label: 'View Logs', action: showLogViewer });
    commands.push({ label: 'Send feedback\u2026', action: function () { Dialogs.openFeedback(); } });
    commands.push({ label: 'About Klaussy', action: showAboutDialog });

    return commands;
  }

  function showCommandPalette() {
    CommandPalette.show(buildPaletteCommands());
  }

  // Cmd+K is overloaded: globally it opens the command palette, but inside a
  // Monaco editor it starts inline-edit (K3). Monaco's addCommand requires
  // the editor to have text focus; if the user clicked the tab bar or anywhere
  // in the file viewer that isn't the text area, focus is lost and pressing
  // Cmd+K here would hijack to the palette. So we route directly to inline-edit
  // whenever the Monaco editor exists — via its hasTextFocus() (best signal)
  // OR by inspecting the target/active element for a .monaco-editor ancestor.
  function shouldInlineEdit(e) {
    var target = e && e.target;
    if (target && target.closest && target.closest('.monaco-editor')) return true;
    var active = document.activeElement;
    if (active && active.closest && active.closest('.monaco-editor')) return true;
    var ed = window.FileBrowser && window.FileBrowser.getActiveEditor
      && window.FileBrowser.getActiveEditor();
    if (ed && ed.hasTextFocus && ed.hasTextFocus()) return true;
    return false;
  }

  document.addEventListener('keydown', function (e) {
    if (e.metaKey && e.key === 'k') {
      if (shouldInlineEdit(e)) {
        // Let Monaco's own Cmd+K binding fire — we're just yielding here. If
        // Monaco's binding doesn't catch it for some reason (out-of-date focus
        // state), start inline-edit explicitly.
        var ed = window.FileBrowser && window.FileBrowser.getActiveEditor
          && window.FileBrowser.getActiveEditor();
        if (ed && window.InlineEdit && window.InlineEdit.start) {
          e.preventDefault();
          window.InlineEdit.start(ed);
        }
        return;
      }
      e.preventDefault();
      showCommandPalette();
    }
    // Cmd+P: quick open. `capture: false` is fine — Monaco doesn't rebind
    // this by default, and we have no other Cmd+P consumer.
    if (e.metaKey && e.key === 'p' && !e.shiftKey) {
      e.preventDefault();
      if (window.QuickOpen) window.QuickOpen.show();
    }
  });

  // Invalidate QuickOpen's file cache when the active worktree changes —
  // otherwise stale results for one worktree show up after switching tasks.
  window.addEventListener('load-file-tree', function () {
    if (window.QuickOpen) window.QuickOpen.invalidate();
  });

  // ---- Phase G: PR review takeover ----

  var prReviewRoot = document.getElementById('pr-review-root');
  var terminalArea = document.getElementById('terminal-area');
  var diffPanelEl = document.getElementById('diff-panel');
  var btnOpenFolder = document.getElementById('btn-open-folder');
  if (btnOpenFolder) {
    btnOpenFolder.addEventListener('click', function () { openFolderAsTask('claude'); });
  }

  var btnRunApp = document.getElementById('btn-run-app');
  if (btnRunApp) {
    btnRunApp.addEventListener('click', function () {
      if (typeof window.runApp === 'function') window.runApp();
    });
  }

  var btnTreeCollapse = document.getElementById('btn-tree-collapse');
  if (btnTreeCollapse) {
    var filesTabContent = document.getElementById('files-tab-content');
    var TREE_COLLAPSED_KEY = 'klaussy.fileTreeCollapsed';
    // Restore on load — user's preference sticks across sessions.
    if (localStorage.getItem(TREE_COLLAPSED_KEY) === '1') {
      filesTabContent.classList.add('tree-collapsed');
      btnTreeCollapse.textContent = '▸';
      btnTreeCollapse.title = 'Show file tree';
    }
    btnTreeCollapse.addEventListener('click', function () {
      var collapsed = filesTabContent.classList.toggle('tree-collapsed');
      btnTreeCollapse.textContent = collapsed ? '▸' : '▾';
      btnTreeCollapse.title = collapsed ? 'Show file tree' : 'Collapse file tree';
      localStorage.setItem(TREE_COLLAPSED_KEY, collapsed ? '1' : '0');
    });
  }

  var btnReviewPr = document.getElementById('btn-review-pr');
  var prReviewMounted = false;

  if (btnReviewPr) {
    btnReviewPr.addEventListener('click', function () { showPrPicker(); });
  }

  function enterPrReviewMode() {
    if (prReviewMounted) return;
    // Hide the worktree-centric layout. Diff panel gets set aside too — the
    // review has its own diff view and shouldn't compete for the right rail.
    terminalArea.style.display = 'none';
    if (diffPanelEl) diffPanelEl.dataset.prevDisplay = diffPanelEl.style.display || '';
    if (diffPanelEl) diffPanelEl.style.display = 'none';
    prReviewRoot.style.display = '';
    window.PrReview.mount({ host: prReviewRoot, isPopout: false });
    prReviewMounted = true;
  }

  function exitPrReviewMode() {
    if (!prReviewMounted) return;
    window.PrReview.unmount();
    prReviewRoot.style.display = 'none';
    terminalArea.style.display = '';
    if (diffPanelEl) diffPanelEl.style.display = diffPanelEl.dataset.prevDisplay || '';
    prReviewMounted = false;
  }

  // Exposed for pr-review.js to call when main clears state.
  window.exitPrReviewMode = exitPrReviewMode;

  // G5: when "Check out locally" finishes in main, pick up the new task in
  // the main window (pop-out closes itself via the null state broadcast).
  window.klaus.pr.onCheckoutReady(function (task) {
    if (!task || typeof task.id !== 'number') return;
    addTaskToUI(task);
  });

  // Keep the main-window panel visibility in sync with main-process state
  // changes (e.g. the pop-out's "pop back in" button clears popout → we want
  // the main panel mounted again; prReviewClose from anywhere unmounts us).
  window.klaus.pr.onReviewState(function (state) {
    if (!state) {
      exitPrReviewMode();
    } else if (!state.popped) {
      // No pop-out → panel should be mounted.
      if (!prReviewMounted) enterPrReviewMode();
    } else {
      // Popped out → hide the main-window panel so both surfaces don't show
      // the same thing. Keep state in main; remount on pop-in.
      if (prReviewMounted) {
        window.PrReview.unmount();
        prReviewRoot.style.display = 'none';
        terminalArea.style.display = '';
        if (diffPanelEl) diffPanelEl.style.display = diffPanelEl.dataset.prevDisplay || '';
        prReviewMounted = false;
      }
    }
  });

  async function showPrPicker() {
    var overlay = document.createElement('div');
    overlay.className = 'pr-picker-overlay';
    overlay.innerHTML =
      '<div class="pr-picker">'
        + '<div class="pr-picker-header">Review a Pull Request</div>'
        + '<div class="pr-picker-account-row">'
          + '<label class="pr-picker-account-label">Account:</label>'
          + '<select class="pr-picker-account"><option>Loading…</option></select>'
          + '<span class="pr-picker-account-hint" aria-live="polite"></span>'
        + '</div>'
        + '<div class="pr-picker-url-row">'
          + '<input type="text" class="pr-picker-url" placeholder="Paste a GitHub PR URL" />'
          + '<button class="pr-picker-start" type="button" disabled>Start review</button>'
        + '</div>'
        + '<div class="pr-picker-recent"></div>'
        + '<div class="pr-picker-list"><div class="pr-picker-loading">Loading open PRs\u2026</div></div>'
        + '<div class="pr-picker-footer"><button class="pr-picker-cancel">Cancel</button></div>'
      + '</div>';
    document.body.appendChild(overlay);

    function close() { overlay.remove(); }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('.pr-picker-cancel').addEventListener('click', close);

    var urlInput = overlay.querySelector('.pr-picker-url');
    var startBtn = overlay.querySelector('.pr-picker-start');
    urlInput.focus();

    var accountSelect = overlay.querySelector('.pr-picker-account');
    var accountHint = overlay.querySelector('.pr-picker-account-hint');
    var recentEl = overlay.querySelector('.pr-picker-recent');
    var listEl = overlay.querySelector('.pr-picker-list');

    function updateStartEnabled() { startBtn.disabled = !urlInput.value.trim(); }
    urlInput.addEventListener('input', function () {
      updateStartEnabled();
      // Typing/pasting a new URL invalidates any "Switched to X" hint.
      accountHint.textContent = '';
    });

    // Parse {owner, repo, number} from a GitHub PR URL for autodetect.
    function parsePrUrl(s) {
      if (!s) return null;
      var m = s.match(/https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (!m) return null;
      return { owner: m[1], repo: m[2].replace(/\.git$/, ''), number: parseInt(m[3], 10) };
    }

    // Before loading, check whether the currently-active gh account can see
    // this PR. If a different logged-in account has access, silently switch.
    async function ensureAccountCanSeeUrl(url) {
      var parsed = parsePrUrl(url);
      if (!parsed) return;
      var det = await window.klaus.gh.detectAccountForRepo(parsed.owner, parsed.repo, parsed.number);
      if (!det || det.error || !det.username) return;
      if (det.active) return;
      var sw = await window.klaus.gh.switchAccount(det.username);
      if (sw && sw.error) return;
      accountHint.textContent = 'Switched to ' + det.username;
      if (accountSelect) accountSelect.value = det.username;
    }

    async function startFromUrl() {
      var url = urlInput.value.trim();
      if (!url) return;
      try { await ensureAccountCanSeeUrl(url); } catch (_) {}
      urlInput.disabled = true;
      startBtn.disabled = true;
      startBtn.textContent = 'Loading\u2026';
      var result = await window.klaus.pr.load({ url: url });
      if (result.error) {
        urlInput.disabled = false;
        startBtn.textContent = 'Start review';
        updateStartEnabled();
        window.toast.error('Failed to load PR:\n' + result.error);
        return;
      }
      close();
    }

    urlInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); startFromUrl(); }
    });
    startBtn.addEventListener('click', startFromUrl);

    // Populate the account dropdown from `gh auth status`. Active account is
    // the selected option. Hide the row when there's only one account (or
    // gh isn't authed) so the UI doesn't get cluttered.
    async function populateAccountSelect() {
      var res = await window.klaus.gh.listAccounts();
      var accounts = (res && res.accounts) || [];
      if (accounts.length === 0) {
        var row = overlay.querySelector('.pr-picker-account-row');
        if (row) row.style.display = 'none';
        return;
      }
      accountSelect.innerHTML = accounts.map(function (a) {
        var sel = a.active ? ' selected' : '';
        return '<option value="' + AppUtils.escAttr(a.username) + '"' + sel + '>'
          + AppUtils.escHtml(a.username) + (a.active ? ' (active)' : '')
          + '</option>';
      }).join('');
    }

    // Recent + project-open lists, extracted so account-switch can re-run it.
    async function refreshLists() {
      recentEl.innerHTML = '';
      recentEl.style.display = '';
      listEl.innerHTML = '<div class="pr-picker-loading">Loading open PRs…</div>';

      window.klaus.pr.recent().then(function (r) {
        var items = (r && r.items) || [];
        if (items.length === 0) { recentEl.style.display = 'none'; return; }
        recentEl.innerHTML = '<div class="pr-picker-section-head">Recently reviewed</div>'
          + items.map(function (it) {
            var stateLabel = it.isDraft ? 'draft' : (it.state || 'open').toLowerCase();
            return '<div class="pr-picker-item" data-url="' + AppUtils.escAttr(it.url || '') + '">'
              + '<span class="pr-picker-num">#' + AppUtils.escHtml(it.number) + '</span>'
              + '<span class="pr-picker-title">' + AppUtils.escHtml(it.title || '') + '</span>'
              + '<span class="pr-picker-author">' + AppUtils.escHtml(it.author || '') + '</span>'
              + '<span class="pr-picker-state pr-state-' + AppUtils.escAttr(stateLabel) + '">' + AppUtils.escHtml(stateLabel) + '</span>'
            + '</div>';
          }).join('');
        recentEl.querySelectorAll('.pr-picker-item').forEach(function (row) {
          row.addEventListener('click', async function () {
            row.style.opacity = '0.5';
            try { await ensureAccountCanSeeUrl(row.dataset.url); } catch (_) {}
            var loadResult = await window.klaus.pr.load({ url: row.dataset.url });
            if (loadResult.error) {
              window.toast.error('Failed to load PR:\n' + loadResult.error);
              row.style.opacity = '1';
              return;
            }
            close();
          });
        });
      });

      var result = await window.klaus.pr.list();
      if (result.error) {
        // No active project is the most common case here; treat it as an info
        // hint rather than a hard error so the user can still paste a URL.
        var msg = result.error || '';
        var isNoProject = /no active project/i.test(msg);
        var cls = isNoProject ? 'pr-picker-empty' : 'pr-picker-error';
        listEl.innerHTML = '<div class="pr-picker-section-head">Open in current project</div>'
          + '<div class="' + AppUtils.escAttr(cls) + '">' + (isNoProject ? 'Add a project to list its open PRs, or paste a URL above to review any PR you have access to.' : AppUtils.escHtml(msg)) + '</div>';
        return;
      }
      if (!result.prs || result.prs.length === 0) {
        listEl.innerHTML = '<div class="pr-picker-section-head">Open in current project</div>'
          + '<div class="pr-picker-empty">No open PRs in this repo.</div>';
        return;
      }
      listEl.innerHTML = '<div class="pr-picker-section-head">Open in current project</div>'
        + result.prs.map(function (pr) {
          var author = (pr.author && (pr.author.login || pr.author.name)) || '';
          var stateLabel = pr.isDraft ? 'draft' : (pr.state || '').toLowerCase();
          return '<div class="pr-picker-item" data-number="' + AppUtils.escAttr(String(pr.number)) + '">'
            + '<span class="pr-picker-num">#' + AppUtils.escHtml(pr.number) + '</span>'
            + '<span class="pr-picker-title">' + AppUtils.escHtml(pr.title || '') + '</span>'
            + '<span class="pr-picker-author">' + AppUtils.escHtml(author) + '</span>'
            + '<span class="pr-picker-state pr-state-' + AppUtils.escAttr(stateLabel) + '">' + AppUtils.escHtml(stateLabel) + '</span>'
          + '</div>';
        }).join('');
      listEl.querySelectorAll('.pr-picker-item').forEach(function (row) {
        row.addEventListener('click', async function () {
          row.style.opacity = '0.5';
          var loadResult = await window.klaus.pr.load({ number: parseInt(row.dataset.number, 10) });
          if (loadResult.error) {
            window.toast.error('Failed to load PR:\n' + loadResult.error);
            row.style.opacity = '1';
            return;
          }
          close();
        });
      });
    }

    accountSelect.addEventListener('change', async function () {
      var target = accountSelect.value;
      if (!target) return;
      accountHint.textContent = 'Switching…';
      accountSelect.disabled = true;
      var sw = await window.klaus.gh.switchAccount(target);
      accountSelect.disabled = false;
      if (sw && sw.error) {
        accountHint.textContent = 'Switch failed: ' + sw.error;
        await populateAccountSelect();
        return;
      }
      accountHint.textContent = 'Switched to ' + target;
      await populateAccountSelect();
      await refreshLists();
    });

    await populateAccountSelect();
    await refreshLists();
  }

  // Task rename and reorder extracted to sidebar-manager.js

  // ---- About Dialog (A7) ----

  var showAboutDialog = Dialogs.showAbout;
  var showLogViewer = Dialogs.showLog;

  // View → How to use Klaussy menu item routes here.
  if (window.klaus.ui.onShowHowToUse) {
    window.klaus.ui.onShowHowToUse(function () { Dialogs.showHowToUse(); });
  }
  if (window.klaus.ui.onShowFeedback) {
    window.klaus.ui.onShowFeedback(function () { Dialogs.openFeedback(); });
  }
  if (window.klaus.ui.onShowLogs) {
    window.klaus.ui.onShowLogs(function () { Dialogs.showLog(); });
  }
  if (window.klaus.ui.onShowSkills) {
    window.klaus.ui.onShowSkills(function () { Dialogs.showSkills(); });
  }
  if (window.klaus.ui.onShowMemory) {
    window.klaus.ui.onShowMemory(function () { Dialogs.showMemory(); });
  }
  if (window.klaus.ui.onShowMcp) {
    window.klaus.ui.onShowMcp(function () { Dialogs.showMcpServers(); });
  }
  if (window.klaus.ui.onShowPlugins) {
    window.klaus.ui.onShowPlugins(function () { Dialogs.showPlugins(); });
  }
  if (window.klaus.ui.onShowShortcuts) {
    window.klaus.ui.onShowShortcuts(function () { Dialogs.showShortcuts(); });
  }
  if (window.klaus.ui.onShowGhAccounts) {
    window.klaus.ui.onShowGhAccounts(function () { Dialogs.showGhAccounts(); });
  }

  // Probe gh + claude on startup (silent if everything's set up). Stays out
  // of the way for steady-state users; only first-runs / broken setups see
  // the dialog. Manual invocation also available via the command palette.
  setTimeout(function () { Dialogs.checkAndPromptDeps(); }, 800);

  // Empty-state CTA: "Add a project" delegates to the same flow as the
  // project switcher's `+` button.
  var emptyAddProj = document.getElementById('empty-state-add-project');
  if (emptyAddProj) {
    emptyAddProj.addEventListener('click', function () {
      var btn = document.getElementById('btn-add-project');
      if (btn) btn.click();
    });
  }
  ['empty-state-open-folder', 'empty-state-open-folder-np'].forEach(function (linkId) {
    var link = document.getElementById(linkId);
    if (!link) return;
    link.addEventListener('click', function (e) {
      e.preventDefault();
      openFolderAsTask('claude');
    });
  });
  // Empty state stays in sync with project changes — the project-switcher
  // module dispatches `klaussy:project-changed` when projects change so we
  // can re-run the no-project check without polling.
  window.addEventListener('klaussy:project-changed', updateEmptyState);

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
      if (name) {
        // Name typed: create a new branch with that name, based on the
        // selected branch (or the default if none picked).
        result = await window.klaus.task.create(
          name,
          AppState.repoPath,
          selectedMode,
          selectedBasePath,
          Object.keys(envVars).length > 0 ? envVars : undefined,
          selectedBaseBranch || null,
        );
      } else if (selectedBaseBranch) {
        // No name + branch picked: check that branch out directly so the
        // user can continue work on it in a fresh worktree.
        result = await window.klaus.task.checkoutBranch(
          AppState.repoPath,
          selectedBaseBranch,
          selectedMode,
          selectedBasePath,
          Object.keys(envVars).length > 0 ? envVars : undefined,
        );
      } else {
        modalCreate.disabled = false;
        modalCreate.textContent = 'Create';
        modalError.textContent = 'Enter a name (creates a new branch) or pick an existing branch to continue.';
        return;
      }
    } else {
      if (!selectedWorktreePath) {
        modalCreate.disabled = false;
        modalCreate.textContent = 'Create';
        modalError.textContent = 'Select a directory first.';
        return;
      }
      result = await window.klaus.task.attachWorktree(selectedWorktreePath, selectedMode);
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
