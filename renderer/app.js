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

  // ---- Directory picker dialog (replaces native NSOpenPanel) ----
  // macOS's scopedbookmarksagent can wedge and freeze the app on Open; this
  // paste/drag prompt bypasses NSOpenPanel entirely. Returns a Promise that
  // resolves to the selected path or null on cancel.
  window.pickDirectoryPopup = (function () {
    const overlay = document.getElementById('dir-pick-overlay');
    const drop = document.getElementById('dir-pick-drop');
    const input = document.getElementById('dir-pick-input');
    const titleEl = document.getElementById('dir-pick-title');
    const errEl = document.getElementById('dir-pick-error');
    const okBtn = document.getElementById('dir-pick-ok');
    const cancelBtn = document.getElementById('dir-pick-cancel');
    const browseBtn = document.getElementById('dir-pick-browse');
    const recentsBtn = document.getElementById('dir-pick-recents-btn');
    const recentsList = document.getElementById('dir-pick-recents-list');
    let resolver = null;
    let activeRecentsKind = null; // populated per-open via opts.recentsKind

    function closeRecents() {
      recentsList.hidden = true;
      recentsBtn.setAttribute('aria-expanded', 'false');
    }

    function close(result) {
      overlay.style.display = 'none';
      input.value = '';
      errEl.textContent = '';
      drop.classList.remove('drag-over');
      closeRecents();
      activeRecentsKind = null;
      if (resolver) { const r = resolver; resolver = null; r(result); }
    }

    okBtn.addEventListener('click', function () {
      const v = input.value.trim();
      if (!v) { errEl.textContent = 'Enter a path or drag a folder in.'; return; }
      close(v);
    });
    cancelBtn.addEventListener('click', function () { close(null); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(null); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') okBtn.click();
      if (e.key === 'Escape') close(null);
    });

    ['dragenter', 'dragover'].forEach(function (evt) {
      drop.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation();
        drop.classList.add('drag-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      drop.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation();
        drop.classList.remove('drag-over');
      });
    });
    drop.addEventListener('drop', function (e) {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      const p = window.klaus.fs.getPathForFile(file);
      if (p) input.value = p;
    });

    // Native Finder Browse — uses the parentless browse-directory IPC so
    // it can't get wedged by the scopedbookmarksagent issue. Drag/paste
    // remain as fallbacks if it ever does hang.
    browseBtn.addEventListener('click', async function () {
      const dir = await window.klaus.repo.browseDirectory();
      if (dir) input.value = dir;
    });

    // Recents dropdown — only shown when the caller passes opts.recentsKind.
    // Lists paths from config.recentPaths[kind], picking fills the input,
    // × removes the entry from the cache.
    function escForAttr(s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }
    function openRecents() {
      if (!activeRecentsKind) return;
      window.klaus.repo.recentPathsGet().then(function (r) {
        const items = (r && r[activeRecentsKind]) || [];
        if (!items.length) {
          recentsList.innerHTML = '<div class="modal-recents-empty">No recent paths yet</div>';
        } else {
          recentsList.innerHTML = items.map(function (p) {
            return '<div class="modal-recents-item" data-path="' + escForAttr(p) + '">'
              + '<span class="modal-recents-pick">' + escForAttr(p) + '</span>'
              + '<button type="button" class="modal-recents-remove" title="Remove from recents" data-path="' + escForAttr(p) + '">×</button>'
            + '</div>';
          }).join('');
        }
        recentsList.hidden = false;
        recentsBtn.setAttribute('aria-expanded', 'true');
      });
    }
    recentsBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (recentsList.hidden) openRecents(); else closeRecents();
    });
    recentsList.addEventListener('click', function (e) {
      const rm = e.target.closest('.modal-recents-remove');
      if (rm) {
        e.stopPropagation();
        const p = rm.getAttribute('data-path');
        window.klaus.repo.recentPathsRemove(activeRecentsKind, p).then(openRecents);
        return;
      }
      const pick = e.target.closest('.modal-recents-item');
      if (pick) {
        e.stopPropagation();
        input.value = pick.getAttribute('data-path');
        closeRecents();
      }
    });
    document.addEventListener('click', function (e) {
      if (recentsList.hidden) return;
      if (recentsBtn.contains(e.target) || recentsList.contains(e.target)) return;
      closeRecents();
    });

    return function pickDirectoryPopup(opts) {
      opts = opts || {};
      titleEl.textContent = opts.title || 'Select folder';
      input.placeholder = opts.placeholder || 'Drag a folder here or paste a path';
      errEl.textContent = '';
      input.value = '';
      activeRecentsKind = opts.recentsKind || null;
      recentsBtn.hidden = !activeRecentsKind;
      closeRecents();
      overlay.style.display = 'flex';
      setTimeout(function () { input.focus(); }, 50);
      return new Promise(function (resolve) { resolver = resolve; });
    };
  })();

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

  // ---- Repo-intel notifications ----
  // conventions-cli runs in the background at session create; without these
  // toasts there is zero visible evidence it happened (artifacts land in the
  // BASE repo, which worktrees don't show).
  if (window.klaus.task.onRepoIntelEvent) {
    window.klaus.task.onRepoIntelEvent(function (ev) {
      if (!ev || !ev.repoPath) return;
      var repoName = ev.repoPath.split('/').filter(Boolean).pop();
      if (ev.type === 'started') {
        window.toast.info(repoName + (ev.enriching
          ? ': graphing the repo and building conventions-aware skills (klausify init + Claude enrichment — may take a few minutes)…'
          : ': graphing the repo and extracting conventions…'));
      } else if (ev.type === 'generated') {
        if (ev.enrichFailed) {
          window.toast.warn(repoName + ': repo graphed + skills ready, but Claude enrichment of CLAUDE.md failed — will retry on a later session');
        } else {
          window.toast.success(repoName + ': repo graphed + conventions ready'
            + (ev.wroteSkills ? ' (CLAUDE.md, rules, skills, import graph)' : ' (import graph)')
            + ' — agents are now conventions-aware');
        }
      } else if (ev.type === 'fresh') {
        window.toast.info(repoName + ': conventions + repo graph loaded (cached) — agents are conventions-aware');
      } else if (ev.type === 'failed') {
        window.toast.warn(repoName + ': repo analysis failed (' + (ev.error || 'is klausify/conventions installed?') + ') — agents run without repo intelligence');
      }
    });
  }

  // ---- Pre-commit review notifications ----
  // Both surfaces (Commit button + git hook from any terminal) broadcast
  // their lifecycle — seeing checks run, even on the good path, is the point.
  if (window.klaus.task.onPrecommitEvent) {
    window.klaus.task.onPrecommitEvent(function (ev) {
      if (!ev || !ev.wtName) return;
      if (ev.type === 'started') {
        window.toast.info('🛡 ' + ev.wtName + ': pre-commit review running — ' + (ev.provider || 'agent') + ' checking silent failures, secrets, debug leftovers, landmines + lint…');
      } else if (ev.type === 'passed') {
        window.toast.success('🛡 ' + ev.wtName + ': pre-commit review passed — staged changes clean across all lenses');
      } else if (ev.type === 'findings') {
        window.toast.warn('🛡 ' + ev.wtName + ': pre-commit review found ' + ev.findingsCount + ' issue' + (ev.findingsCount === 1 ? '' : 's') + ' — see the committing terminal or commit panel');
      } else if (ev.type === 'error') {
        window.toast.warn('🛡 ' + ev.wtName + ': pre-commit review could not run (' + (ev.error || 'unknown') + ') — commit proceeded unreviewed');
      }
    });
  }

  // ---- Handle Claude → shell conversion ----
  window.klaus.task.onConverted(function (data) {
    var t = tasks.get(data.id);
    if (!t) return;
    // Remember which agent just exited so the Resume button re-launches THAT
    // agent (not hardcoded to Claude).
    if (t.mode && t.mode !== 'shell') t.resumeAgent = t.mode;
    t.alive = true;
    t.mode = 'shell';
    updateSidebarItem(data.id);
    updateSidebarMode(data.id, 'shell');
    if (window.TerminalManager && TerminalManager.refreshAgentChip) TerminalManager.refreshAgentChip(data.id);
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
    // Keep the single global default-agent state in sync when it's changed in
    // Preferences, and refresh any agent split buttons showing it.
    if (prefs.defaultProvider !== undefined || prefs.defaultMode !== undefined) {
      if (!AppState.savedPrefs) AppState.savedPrefs = {};
      var dp = prefs.defaultProvider || prefs.defaultMode;
      AppState.savedPrefs.defaultProvider = dp;
      AppState.savedPrefs.defaultMode = dp;
      document.dispatchEvent(new CustomEvent('klaussy:default-agent-changed', { detail: { agent: dp } }));
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
      // A session may have been handed to this window ("Open in: New window")
      // — adopt those tasks before listing resumable worktrees so they render
      // as live terminals, not idle worktree rows.
      var adoptedPaths = [];
      var pendingIds = [];
      try {
        pendingIds = (await window.klaus.ui.claimPendingTasks()) || [];
      } catch (e) {
        console.error('[claim-pending-tasks]', e);
      }
      if (pendingIds.length) {
        // The claim is consumed — if rendering fails the ids can't be
        // re-claimed, so surface it loudly instead of showing the session's
        // worktrees as innocently idle rows.
        try {
          var allTasks = await window.klaus.task.list();
          pendingIds.forEach(function (tid) {
            var t = (allTasks || []).find(function (x) { return x.id === tid; });
            if (!t) return;
            try {
              addTaskToUI(t);
              adoptedPaths.push(t.worktreePath);
            } catch (e) {
              console.error('[adopt-task]', tid, e);
            }
          });
          if (adoptedPaths.length > 1) {
            TerminalManager.setLayout(adoptedPaths.length >= 3 ? 'grid' : 'columns');
          }
          if (adoptedPaths.length < pendingIds.length && window.toast) {
            window.toast.error('Some handed-off session terminals could not be rendered — their agents are still running; restart the app to reattach.');
          }
        } catch (e) {
          console.error('[adopt-pending-tasks]', e);
          if (window.toast) {
            window.toast.error('The session handed to this window could not be rendered — its agents are still running; restart the app to reattach.');
          }
        }
      }
      await loadWorktreeList(adoptedPaths);
    } else {
      loadExistingTasks();
    }
    // Commercial licence gate — dismissable, shows only on unactivated
    // packaged builds. Dev (`electron .`) is bypassed by main/state/license.
    if (window.LicenseActivation && typeof window.LicenseActivation.openIfNeeded === 'function') {
      window.LicenseActivation.openIfNeeded();
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

  async function loadWorktreeList(skipPaths) {
    var skip = skipPaths || [];
    var worktrees = await window.klaus.repo.listWorktrees();
    worktrees.forEach(function (wt) {
      if (skip.indexOf(wt.path) !== -1) return;
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
    item.dataset.repo = wt.repoPath || '';
    item.dataset.branch = wt.branch || '';

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
        '<button class="worktree-open-claude" title="Open with ' + escHtml(AppUtils.modeDisplayName(defaultAgent())) + '">' + escHtml(AppUtils.modeShortLabel(defaultAgent())) + '</button>' +
        '<button class="worktree-open-shell" title="Open shell">sh</button>' +
        '<button class="worktree-remove" title="Remove worktree">\u00d7</button>' +
      '</div>';

    item.querySelector('.worktree-open-claude').addEventListener('click', async function (e) {
      e.stopPropagation();
      var result;
      try { result = await window.klaus.task.attachWorktree(wt.path, defaultAgent()); }
      catch (err) { window.toast.error('Open failed: ' + (err && err.message || err)); return; }
      if (result && result.error) { window.toast.error('Open failed: ' + result.error); return; }
      if (!result) { window.toast.error('Open failed: no response from main process'); return; }
      addTaskToUI(result);
      switchToTask(result.id);
    });

    item.querySelector('.worktree-open-shell').addEventListener('click', async function (e) {
      e.stopPropagation();
      var result;
      try { result = await window.klaus.task.attachWorktree(wt.path, 'shell'); }
      catch (err) { window.toast.error('Open failed: ' + (err && err.message || err)); return; }
      if (result && result.error) { window.toast.error('Open failed: ' + result.error); return; }
      if (!result) { window.toast.error('Open failed: no response from main process'); return; }
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

  // Worktree rows render their quick-open button's label/title from the default
  // agent at creation time; when the default changes in Preferences, refresh
  // them in place so the button reflects the new agent (the click handler
  // already reads defaultAgent() live).
  function refreshWorktreeAgentButtons() {
    var agent = defaultAgent();
    var label = AppUtils.modeShortLabel(agent);
    var title = 'Open with ' + AppUtils.modeDisplayName(agent);
    taskList.querySelectorAll('.worktree-item .worktree-open-claude').forEach(function (btn) {
      btn.textContent = label;
      btn.title = title;
    });
  }
  document.addEventListener('klaussy:default-agent-changed', refreshWorktreeAgentButtons);

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
      item.dataset.repo = s.repoPath || '';
      item.dataset.branch = s.branch || '';

      var age = formatAge(s.savedAt);
      var pathShort = s.worktreePath ? s.worktreePath.split('/').slice(-2).join('/') : '';

      var modeLabel = s.mode === 'shell' ? 'SH' : AppUtils.modeShortLabel(s.mode);
      var modeTitle = s.mode === 'shell'
        ? 'Previous shell session'
        : 'Previous ' + AppUtils.modeDisplayName(s.mode) + ' session';
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
        try {
          if (s.mode === 'shell') {
            result = await window.klaus.task.attachWorktree(s.worktreePath, 'shell');
          } else {
            result = await window.klaus.session.resume(s);
          }
        } catch (err) {
          window.toast.error('Resume failed: ' + (err && err.message || err));
          btn.disabled = false;
          btn.textContent = s.mode === 'shell' ? 'Open' : 'Resume';
          return;
        }
        if (result && result.cancelled) { // user declined the trust prompt
          btn.disabled = false;
          btn.textContent = s.mode === 'shell' ? 'Open' : 'Resume';
          return;
        }
        if (!result || result.error) {
          window.toast.error('Resume failed: ' + ((result && result.error) || 'no response from main process'));
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
        var result;
        try { result = await window.klaus.task.attachWorktree(s.worktreePath, 'claude'); }
        catch (err) {
          window.toast.error('Open failed: ' + (err && err.message || err));
          btn.disabled = false;
          btn.textContent = 'New';
          return;
        }
        if (!result || result.error) {
          window.toast.error('Open failed: ' + ((result && result.error) || 'no response from main process'));
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
  const existingSessionSelect = document.getElementById('existing-session-select');
  const modalRepoRow = document.getElementById('modal-repo-row');
  const modalRepoPathEl = document.getElementById('modal-repo-path');
  const modalRepoBrowseBtn = document.getElementById('btn-modal-repo-browse');
  const modalRepoRecentsBtn = document.getElementById('btn-modal-repo-recents');
  const modalRepoRecentsList = document.getElementById('modal-repo-recents-list');
  const multiRepoRow = document.getElementById('modal-multirepo-row');
  const multiRepoRowsEl = document.getElementById('modal-multirepo-rows');
  const multiRepoAddBtn = document.getElementById('btn-modal-multirepo-add');
  const modalTabs = document.querySelectorAll('.modal-tab');
  const tabContents = document.querySelectorAll('.tab-content');

  let activeTab = 'new';
  let selectedMode = 'claude';
  let selectedBaseBranch = '';
  // True only once the user deliberately picks a base branch. The combobox is
  // pre-filled with the default branch, so without this flag "no name" would
  // always be read as "continue the default branch" and never as "name
  // required" — and checking out the default usually fails (it's already the
  // primary worktree's branch).
  let baseBranchUserPicked = false;

  // Shell selector
  const shellOptions = document.querySelectorAll('.shell-option');
  shellOptions.forEach(function (btn) {
    btn.addEventListener('click', function () {
      selectedMode = btn.dataset.shell;
      shellOptions.forEach(function (b) { b.classList.toggle('active', b === btn); });
    });
  });

  // "Open session in new window" — always visible; pre-checked when this
  // window is crowded (3+ open tasks).
  const windowSelector = document.getElementById('window-selector');
  const openNewWindowCheck = document.getElementById('open-new-window-check');

  // Tab switching
  var modalBaseSelect = document.getElementById('modal-base-branch');
  var baseBranchData = []; // [{ localName, isRemote, ... }]
  var baseBranchDefault = ''; // pre-selected branch (dev > main > master fallback)

  // The action button reads "Resume" on the Existing Session tab — nothing
  // is being created there.
  function syncCreateButtonLabel() {
    modalCreate.textContent = activeTab === 'existing' ? 'Resume' : 'Create';
  }

  modalTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      activeTab = tab.dataset.tab;
      modalTabs.forEach(function (t) { t.classList.toggle('active', t === tab); });
      tabContents.forEach(function (c) { c.classList.toggle('active', c.id === 'tab-' + activeTab); });
      modalError.textContent = '';
      clearFieldFlags();
      syncCreateButtonLabel();
      if (activeTab === 'new') {
        setTimeout(function () { modalInput.focus(); }, 50);
      }
    });
  });

  // Clear the name field's required-ring (and stale error) as soon as the
  // user starts typing a name.
  modalInput.addEventListener('input', function () {
    modalInput.classList.remove('modal-field-invalid');
    if (modalError) modalError.textContent = '';
  });

  // Primary base-branch select — lives inline in the source-repo row, same
  // style/behavior as the extra repo rows' selects. Change = a deliberate
  // pick (drives the "continue this branch" no-name flow).
  if (modalBaseSelect) {
    modalBaseSelect.addEventListener('change', function () {
      selectedBaseBranch = modalBaseSelect.value;
      baseBranchUserPicked = true;
      modalBaseSelect.classList.remove('modal-field-invalid');
      if (modalError) modalError.textContent = '';
    });
  }

  function renderBaseBranchSelect() {
    if (!modalBaseSelect) return;
    if (!baseBranchData.length) {
      modalBaseSelect.hidden = true;
      modalBaseSelect.innerHTML = '';
      return;
    }
    modalBaseSelect.innerHTML = baseBranchData.map(function (b) {
      var isDef = b.localName === baseBranchDefault;
      var sel = b.localName === selectedBaseBranch ? ' selected' : '';
      return '<option value="' + escHtml(b.localName) + '"' + sel + '>'
        + escHtml(b.localName) + (isDef ? ' (default)' : '')
        + '</option>';
    }).join('');
    modalBaseSelect.hidden = false;
  }

  // Optimistic populate from cached refs; then `git fetch` in the background
  // and re-render so remote branches stay fresh without blocking the modal.
  async function populateBaseBranchSelect() {
    if (!modalBaseSelect) return;
    if (!AppState.repoPath) {
      baseBranchData = [];
      baseBranchDefault = '';
      renderBaseBranchSelect();
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

    // Initial selection = default. Preserve user's prior pick across re-renders,
    // including custom (free-text) names that aren't in localNames — those are
    // resolved at submit time by the main process.
    if (!selectedBaseBranch) {
      selectedBaseBranch = baseBranchDefault;
    }
    renderBaseBranchSelect();
  }

  // Recents dropdown helper. items = [{ label, path }]. Wires the ▾ button
  // to toggle a list of paths next to its input. Each item has a × that
  // calls onRemove and re-opens the list with the updated set.
  function bindRecentsDropdown(button, list, opts) {
    function close() {
      list.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    }
    // Render one row. `it` = { path, label?, sub?, tag?, kind?, removable? }.
    // removable defaults to true (shows the ✕); discovered items pass false.
    function renderItem(it) {
      var p = it.path;
      var label = it.label && it.label !== p ? it.label : '';
      var subText = it.sub != null ? it.sub : (label ? p : '');
      var sub = subText ? '<span class="modal-recents-sub">' + escHtml(subText) + '</span>' : '';
      var main = label ? escHtml(label) : escHtml(p);
      var tag = it.tag ? '<span class="modal-recents-tag">' + escHtml(it.tag) + '</span>' : '';
      var rm = it.removable === false ? ''
        : '<button type="button" class="modal-recents-remove" title="Remove from recents" data-path="' + escHtml(p) + '">×</button>';
      return '<div class="modal-recents-item" data-path="' + escHtml(p) + '" data-kind="' + escHtml(it.kind || '') + '">'
        + '<span class="modal-recents-pick">' + main + sub + '</span>'
        + tag + rm
      + '</div>';
    }
    function open() {
      Promise.resolve(opts.loadItems()).then(function (data) {
        // `data` is either a flat item array or a list of { header, items }
        // sections. Normalize to sections so the renderer is uniform.
        var sections = (data && data.length && data[0] && data[0].items)
          ? data
          : [{ header: null, items: data || [] }];
        var total = sections.reduce(function (n, s) { return n + (s.items ? s.items.length : 0); }, 0);
        if (!total) {
          list.innerHTML = '<div class="modal-recents-empty">' + escHtml(opts.emptyText || 'No recent paths') + '</div>';
        } else {
          list.innerHTML = sections.filter(function (s) { return s.items && s.items.length; }).map(function (s) {
            var head = s.header ? '<div class="modal-recents-section">' + escHtml(s.header) + '</div>' : '';
            return head + s.items.map(renderItem).join('');
          }).join('');
        }
        list.hidden = false;
        button.setAttribute('aria-expanded', 'true');
      }).catch(function (err) {
        // A discovery call rejected (rare — handlers normally return []). Degrade
        // to the empty state and still open, rather than leaving a dead button.
        console.error('[recents-dropdown] loadItems failed:', err);
        list.innerHTML = '<div class="modal-recents-empty">' + escHtml(opts.emptyText || 'Could not load') + '</div>';
        list.hidden = false;
        button.setAttribute('aria-expanded', 'true');
      });
    }
    button.addEventListener('click', function (e) {
      e.stopPropagation();
      if (list.hidden) open(); else close();
    });
    list.addEventListener('click', function (e) {
      var rm = e.target.closest('.modal-recents-remove');
      if (rm) {
        e.stopPropagation();
        var p = rm.getAttribute('data-path');
        Promise.resolve(opts.onRemove(p)).then(open);
        return;
      }
      var pick = e.target.closest('.modal-recents-item');
      if (pick) {
        e.stopPropagation();
        var p = pick.getAttribute('data-path');
        opts.onPick(p, { kind: pick.getAttribute('data-kind') || '' });
        close();
      }
    });
    document.addEventListener('click', function (e) {
      if (list.hidden) return;
      if (button.contains(e.target) || list.contains(e.target)) return;
      close();
    });
  }

  // Discovery promises, cached per modal-open so toggling a dropdown doesn't
  // re-crawl the filesystem / re-shell `git worktree list`. Reset in showModal;
  // the repos cache is also invalidated when a discovered repo is adopted (it
  // then moves into the Projects section).
  var discoverReposCache = null;
  var discoverWorktreesCache = null;
  // Cache the promise, but drop it on rejection so the next open retries
  // instead of re-serving a permanently-rejected promise for the modal session.
  function getDiscoveredRepos() {
    if (!discoverReposCache) {
      discoverReposCache = window.klaus.repo.discoverRepos().catch(function (e) {
        discoverReposCache = null;
        throw e;
      });
    }
    return discoverReposCache;
  }
  function getDiscoveredWorktrees() {
    if (!discoverWorktreesCache) {
      discoverWorktreesCache = window.klaus.repo.discoverWorktrees().catch(function (e) {
        discoverWorktreesCache = null;
        throw e;
      });
    }
    return discoverWorktreesCache;
  }
  // Recently-pushed GitHub repos for the source-repo dropdown. Degrades to an
  // empty list when gh is missing/unauthed/offline — the section just doesn't
  // render, the rest of the dropdown is unaffected.
  var recentGhReposCache = null;
  function getRecentGithubRepos() {
    if (!recentGhReposCache) {
      recentGhReposCache = window.klaus.gh.listRecentRepos().then(function (res) {
        if (!res || res.error) {
          if (res && res.error) console.warn('[gh-recent-repos]', res.error);
          // Transient failure (gh offline/unauthed): drop the cache so the
          // next dropdown open retries, same as the rejection path below.
          recentGhReposCache = null;
          return [];
        }
        return res.repos || [];
      }).catch(function (e) {
        console.warn('[gh-recent-repos]', e);
        recentGhReposCache = null;
        return [];
      });
    }
    return recentGhReposCache;
  }

  // ---- Existing sessions (Existing Session tab) -----------------------------
  // A session is ONE unit no matter how many repos it spans. Worktrees under
  // ~/klaussy/sessions/<name>/ group by that folder name (the canonical
  // multi-repo layout); everything else (legacy single worktrees) groups by
  // branch under a separate "Other worktrees" optgroup so old work stays
  // reachable without flooding the session list.
  var existingSessionsMap = {}; // option value -> [{ path, branch, repoName, active }]
  var SESSION_DIR_RE = /\/klaussy\/sessions\/([^/]+)\//;

  // Shared by the Existing Session dropdown and the Manage Sessions modal:
  // worktrees under ~/klaussy/sessions/<name>/ group by that folder name,
  // everything else groups by branch ("legacy").
  function groupWorktreesIntoSessions(groups) {
    var sessions = {}; // name -> worktrees (session-folder layout)
    var legacy = {};   // branch -> worktrees (everything else)
    (groups || []).forEach(function (g) {
      (g.worktrees || []).forEach(function (w) {
        if (!w.branch) return;
        var entry = { path: w.path, branch: w.branch, repoName: g.repoName, active: !!w.active };
        var m = w.path.match(SESSION_DIR_RE);
        if (m) {
          (sessions[m[1]] = sessions[m[1]] || []).push(entry);
        } else {
          (legacy[w.branch] = legacy[w.branch] || []).push(entry);
        }
      });
    });
    return { sessions: sessions, legacy: legacy };
  }

  function populateExistingSessions() {
    var session = modalSession;
    existingSessionSelect.innerHTML = '<option value="">Loading sessions…</option>';
    getDiscoveredWorktrees().then(function (groups) {
      // A slow discovery from a previous modal open must not overwrite the
      // current open's data (stale `active` flags → double-resume).
      if (session !== modalSession) return;
      existingSessionsMap = {};
      var grouped = groupWorktreesIntoSessions(groups);
      var sessions = grouped.sessions;
      var legacy = grouped.legacy;

      var optionFor = function (value, label, wts) {
        existingSessionsMap[value] = wts;
        var repos = wts.map(function (w) { return w.repoName; }).join(', ');
        return '<option value="' + escHtml(value) + '" title="' + escHtml(repos) + '">'
          + escHtml(label) + ' — ' + wts.length + (wts.length === 1 ? ' repo (' : ' repos (') + escHtml(repos) + ')'
          + '</option>';
      };

      var sessionNames = Object.keys(sessions).sort();
      var legacyNames = Object.keys(legacy).sort();
      if (!sessionNames.length && !legacyNames.length) {
        existingSessionSelect.innerHTML = '<option value="">No sessions found</option>';
        return;
      }
      var html = '<option value="">Pick a session…</option>';
      if (sessionNames.length) {
        html += '<optgroup label="Sessions">' + sessionNames.map(function (n) {
          return optionFor('s:' + n, n, sessions[n]);
        }).join('') + '</optgroup>';
      }
      if (legacyNames.length) {
        html += '<optgroup label="Other worktrees">' + legacyNames.map(function (n) {
          return optionFor('b:' + n, n, legacy[n]);
        }).join('') + '</optgroup>';
      }
      existingSessionSelect.innerHTML = html;
    }).catch(function (e) {
      console.warn('[existing-sessions]', e);
      if (session === modalSession) {
        existingSessionSelect.innerHTML = '<option value="">Could not load sessions</option>';
      }
    });
  }

  // Resume one worktree of a session: prefer the saved session entry (carries
  // the agent + exact session id), else the worktree's latest Claude session,
  // else a fresh spawn — resume-session handles a null sessionId gracefully.
  async function resumeSessionWorktree(wt, sessionName, savedList, mode) {
    var saved = (savedList || []).find(function (s) { return s && s.worktreePath === wt.path; });
    var resumeMode = (saved && saved.mode) || mode;
    // Shell entries attach a plain shell — same special-case as the sidebar's
    // saved-session Resume path.
    if (resumeMode === 'shell') {
      return window.klaus.task.attachWorktree(wt.path, 'shell');
    }
    var sessionId = saved && saved.sessionId;
    if (!sessionId) {
      try { sessionId = await window.klaus.session.getLatest(wt.path); } catch (e) { sessionId = null; }
    }
    return window.klaus.session.resume({
      sessionId: sessionId || null,
      name: sessionName,
      worktreePath: wt.path,
      branch: wt.branch || sessionName,
      mode: resumeMode,
    });
  }

  // ---- Manage Sessions (sidebar) --------------------------------------------
  // Lists every session with a per-session Delete: warns that ALL work in the
  // session goes away, closes its open terminals, then removes the worktrees
  // and the session folder (delete-session IPC). Branches are kept.
  var sessionsModalOverlay = document.getElementById('sessions-modal-overlay');
  var sessionsModalList = document.getElementById('sessions-modal-list');
  var btnManageSessions = document.getElementById('btn-manage-sessions');
  var sessionsModalClose = document.getElementById('sessions-modal-close');

  function closeTasksOnPaths(paths) {
    return window.klaus.task.list().then(function (all) {
      var chain = Promise.resolve();
      (all || []).forEach(function (t) {
        if (paths.indexOf(t.worktreePath) === -1) return;
        chain = chain.then(function () {
          return window.klaus.task.kill(t.id).then(function () {
            if (AppState.tasks && AppState.tasks.has(t.id)) {
              TerminalManager.removeTaskFromUI(t.id);
            }
          }).catch(function (e) {
            console.warn('[delete-session kill]', t.id, e);
          });
        });
      });
      return chain;
    });
  }

  // Typed confirmation: the Delete button stays disabled until the user
  // types "delete". Returns a promise resolving true (confirmed) / false.
  var confirmDeleteSession = (function () {
    var overlay = document.getElementById('delete-session-overlay');
    var titleEl = document.getElementById('delete-session-title');
    var listEl = document.getElementById('delete-session-list');
    var input = document.getElementById('delete-session-input');
    var btnCancel = document.getElementById('delete-session-cancel');
    var btnConfirm = document.getElementById('delete-session-confirm');
    var resolver = null;

    function close(result) {
      overlay.style.display = 'none';
      if (resolver) {
        var r = resolver;
        resolver = null;
        r(result);
      }
    }
    btnCancel.addEventListener('click', function () { close(false); });
    btnConfirm.addEventListener('click', function () {
      if (!btnConfirm.disabled) close(true);
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close(false);
    });
    input.addEventListener('input', function () {
      btnConfirm.disabled = input.value.trim().toLowerCase() !== 'delete';
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !btnConfirm.disabled) close(true);
      if (e.key === 'Escape') close(false);
    });

    return function (name, wts) {
      return new Promise(function (resolve) {
        resolver = resolve;
        titleEl.textContent = 'Delete session "' + name + '"?';
        listEl.innerHTML = wts.map(function (w) {
          return '<div class="delete-session-item"><span class="delete-session-repo">' + escHtml(w.repoName) + '</span>'
            + '<span class="delete-session-path">' + escHtml(w.path) + '</span></div>';
        }).join('');
        input.value = '';
        btnConfirm.disabled = true;
        overlay.style.display = 'flex';
        setTimeout(function () { input.focus(); }, 50);
      });
    };
  })();

  async function deleteSessionFlow(name, wts) {
    var ok = await confirmDeleteSession(name, wts);
    if (!ok) return false;
    var paths = wts.map(function (w) { return w.path; });
    try {
      await closeTasksOnPaths(paths);
      var res = await window.klaus.task.deleteSession(paths);
      if (!res || res.error) {
        window.toast.error((res && res.error) || 'Delete failed');
        return true;
      }
      var failed = (res.results || []).filter(function (r) { return !r.ok; });
      var okCount = (res.results || []).length - failed.length;
      if (okCount) {
        window.toast.success('Deleted "' + name + '" (' + okCount + ' worktree' + (okCount === 1 ? '' : 's') + ')');
      }
      if (failed.length) {
        window.toast.error('Could not delete: ' + failed.map(function (f) {
          return f.path.split('/').pop() + ' (' + f.error + ')';
        }).join(' · '));
      }
      // Drop the deleted worktrees' idle rows from the sidebar.
      paths.forEach(function (p) {
        var row = taskList.querySelector('.worktree-item[data-path="' + CSS.escape(p) + '"]');
        if (row) row.remove();
      });
      discoverWorktreesCache = null;
    } catch (e) {
      console.error('[delete-session]', e);
      window.toast.error('Delete failed: ' + ((e && e.message) || e));
    }
    return true;
  }

  function renderSessionsModalList() {
    sessionsModalList.innerHTML = '<div class="sessions-modal-empty">Loading…</div>';
    discoverWorktreesCache = null;
    getDiscoveredWorktrees().then(function (groups) {
      var grouped = groupWorktreesIntoSessions(groups);
      var section = function (title, map) {
        var names = Object.keys(map).sort();
        if (!names.length) return '';
        return '<div class="sessions-modal-section">' + escHtml(title) + '</div>' + names.map(function (n) {
          var wts = map[n];
          var repos = wts.map(function (w) { return w.repoName; }).join(', ');
          var open = wts.some(function (w) { return w.active; });
          return '<div class="sessions-modal-row" data-name="' + escHtml(n) + '">'
            + '<div class="sessions-modal-info">'
            +   '<span class="sessions-modal-name">' + escHtml(n) + (open ? ' <span class="sessions-modal-open">open</span>' : '') + '</span>'
            +   '<span class="sessions-modal-sub">' + wts.length + (wts.length === 1 ? ' repo: ' : ' repos: ') + escHtml(repos) + '</span>'
            + '</div>'
            + '<button type="button" class="sessions-modal-delete" data-name="' + escHtml(n) + '">Delete</button>'
            + '</div>';
        }).join('');
      };
      var html = section('Sessions', grouped.sessions) + section('Other worktrees', grouped.legacy);
      sessionsModalList.innerHTML = html || '<div class="sessions-modal-empty">No sessions found</div>';

      sessionsModalList.querySelectorAll('.sessions-modal-delete').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var n = btn.dataset.name;
          var wts = grouped.sessions[n] || grouped.legacy[n] || [];
          if (!wts.length) return;
          btn.disabled = true;
          var acted = await deleteSessionFlow(n, wts);
          btn.disabled = false;
          if (acted) renderSessionsModalList();
        });
      });
    }).catch(function (e) {
      console.warn('[manage-sessions]', e);
      sessionsModalList.innerHTML = '<div class="sessions-modal-empty">Could not load sessions</div>';
    });
  }

  btnManageSessions.addEventListener('click', function () {
    sessionsModalOverlay.style.display = 'flex';
    renderSessionsModalList();
  });
  sessionsModalClose.addEventListener('click', function () {
    sessionsModalOverlay.style.display = 'none';
  });
  sessionsModalOverlay.addEventListener('click', function (e) {
    if (e.target === sessionsModalOverlay) sessionsModalOverlay.style.display = 'none';
  });
  // Switch the active repo (used by the source-repo Browse button, the
  // recents dropdown, and the drag-and-drop handler). Re-syncs the path
  // display and branch dropdown.
  function applyRepoSwitch(dir) {
    AppState.repoPath = dir;
    // A repo can't be both the source and an extra-row target — the fan-out
    // would hit "worktree already exists" on the duplicate.
    additionalRepoRows.filter(function (r) { return r.path === dir; }).forEach(removeRepoRow);
    if (modalRepoRow) modalRepoRow.classList.remove('modal-field-invalid');
    if (modalError) modalError.textContent = '';
    if (modalRepoPathEl) { modalRepoPathEl.textContent = dir; modalRepoPathEl.title = dir; }
    selectedBaseBranch = '';
    baseBranchUserPicked = false;
    populateBaseBranchSelect();
  }

  // Source-repo Browse: native Finder via browse-directory IPC. addProject
  // validates the picked folder is a git repo (offers git init if not)
  // and persists it into config.projects so it shows in the recents list
  // next time.
  modalRepoBrowseBtn.addEventListener('click', async function () {
    var dir = await window.klaus.repo.browseDirectory();
    if (!dir) return;
    var added = await window.klaus.repo.addProject(dir);
    if (!added) return;
    applyRepoSwitch(added.path);
  });

  // Source-repo dropdown: two sections. "Open repos" = base repos of worktrees
  // currently in the sidebar (auto-derived, not a user-managed list).
  // "Discovered" = git repos found on disk, excluding the open ones. Picking
  // either just makes it the active source repo.
  // Sections for both repo dropdowns (source repo + "Also create in"):
  // Open repos / GitHub recently-pushed / Discovered. `excludePaths` hides
  // repos already chosen elsewhere (the primary repo, existing chips).
  function buildRepoPickerSections(excludePaths) {
    var exclude = excludePaths || {};
    return Promise.all([
      getDiscoveredRepos(),
      getRecentGithubRepos(),
    ]).then(function (res) {
      var discovered = res[0] || [];
      var ghRepos = res[1] || [];
      var open = (window.ProjectSwitcher && window.ProjectSwitcher.sidebarRepos)
        ? window.ProjectSwitcher.sidebarRepos() : [];
      var openPaths = {};
      open.forEach(function (r) { openPaths[r.path] = true; });
      // GitHub items: already-cloned ones act like any local repo; the rest
      // get a "clone" tag and a gh: pseudo-path so onPick knows to clone
      // first. Skip ones whose clone is already in the Open section.
      var ghLocalPaths = {};
      var ghItems = ghRepos.filter(function (r) {
        return !(r.localPath && (openPaths[r.localPath] || exclude[r.localPath]));
      }).map(function (r) {
        if (r.localPath) ghLocalPaths[r.localPath] = true;
        return r.localPath
          ? { label: r.nameWithOwner, path: r.localPath, sub: r.localPath, kind: 'github', removable: false }
          : { label: r.nameWithOwner, path: 'gh:' + r.nameWithOwner, sub: 'Not cloned yet — select to clone', tag: 'clone', kind: 'github-clone', removable: false };
      });
      return [
        { header: 'Open repos', items: open.filter(function (r) { return !exclude[r.path]; }).map(function (r) {
          return { label: r.name, path: r.path, sub: r.path, kind: 'open', removable: false };
        }) },
        { header: 'GitHub — recently pushed', items: ghItems },
        { header: 'Discovered', items: (discovered || [])
          .filter(function (r) { return !openPaths[r.path] && !ghLocalPaths[r.path] && !exclude[r.path]; })
          .map(function (r) {
            return { label: r.name, path: r.path, sub: r.path, kind: 'discovered', removable: false };
          }) },
      ];
    });
  }

  // Clone a gh:-pseudo-path pick, then hand the local path to `onCloned`.
  // Shared by the source-repo picker (switches to it) and the multi-repo
  // picker (adds a chip).
  function cloneGithubPick(pseudoPath, onCloned, onFail) {
    var nameWithOwner = pseudoPath.replace(/^gh:/, '');
    window.toast.info('Cloning ' + nameWithOwner + '…');
    window.klaus.gh.cloneRepo(nameWithOwner).then(function (res) {
      if (!res || res.error) {
        if (onFail) onFail();
        window.toast.error((res && res.error) || 'Clone failed');
        return;
      }
      // The clone is now a configured project — refresh dropdown caches
      // so it shows under Open/Discovered next time.
      discoverReposCache = null;
      recentGhReposCache = null;
      window.toast.success('Cloned ' + nameWithOwner);
      onCloned(res.path);
    }).catch(function (e) {
      console.error('[gh-clone-repo]', e);
      if (onFail) onFail();
      window.toast.error('Clone failed: ' + ((e && e.message) || e));
    });
  }

  bindRecentsDropdown(modalRepoRecentsBtn, modalRepoRecentsList, {
    loadItems: function () { return buildRepoPickerSections(); },
    onPick: function (p, info) {
      if (info && info.kind === 'github-clone') {
        // Not on disk yet: clone into the default projects dir, then switch.
        if (modalRepoPathEl) {
          modalRepoPathEl.textContent = 'Cloning ' + p.replace(/^gh:/, '') + '…';
          modalRepoPathEl.title = '';
        }
        var restoreRepoLabel = function () {
          if (modalRepoPathEl) {
            modalRepoPathEl.textContent = AppState.repoPath || 'No repo selected';
            modalRepoPathEl.title = AppState.repoPath || '';
          }
        };
        cloneGithubPick(p, function (localPath) {
          window.klaus.repo.switchProject(localPath).then(function () {
            applyRepoSwitch(localPath);
          }).catch(function (e) {
            console.error('[switch-project]', e);
            restoreRepoLabel();
            window.toast.error('Cloned, but could not switch to ' + localPath);
          });
        }, restoreRepoLabel);
        return;
      }
      // Every other section is a real git repo on disk — just switch.
      window.klaus.repo.switchProject(p).then(function () { applyRepoSwitch(p); });
    },
    emptyText: 'No repos found',
  });

  // ---- Multi-repo rows ------------------------------------------------------
  // The "+" bar appends a repo-picker row identical to the source-repo one
  // (path display, Browse, ▾ dropdown, drag-and-drop) plus a ×. On submit the
  // same branch + worktree naming schema fans out to every row with a repo
  // picked — common when one ticket spans multiple repos. The resulting tasks
  // are independent; these rows are just creation-time input.
  var additionalRepoRows = []; // [{ el, pathEl, path, name }]
  // Clones started from a row's dropdown that haven't finished yet. Submit is
  // blocked while > 0 so a repo the user picked can't be silently missing
  // from the fan-out. Stamped with the modal session so a clone that finishes
  // after close/reopen doesn't write into the wrong session's rows.
  var pendingRepoClones = 0;
  var modalSession = 0;

  // Rows with a repo picked, primary-repo collisions and duplicates dropped.
  // Empty rows (added but never filled) are simply ignored.
  function selectedAdditionalRepos() {
    var seen = {};
    var out = [];
    additionalRepoRows.forEach(function (r) {
      if (!r.path || r.path === AppState.repoPath || seen[r.path]) return;
      seen[r.path] = true;
      out.push({ name: r.name, path: r.path, baseBranch: r.baseBranch || '' });
    });
    return out;
  }

  function setRepoRowPath(row, p) {
    row.path = p || null;
    row.name = p ? (p.split('/').filter(Boolean).pop() || p) : '';
    row.pathEl.textContent = p || 'No repo selected';
    row.pathEl.title = p || '';
    // Each repo gets its own base-branch select — repos in one ticket often
    // have different defaults (main vs master vs develop). Prefill with the
    // primary's picked base when this repo has that branch, else the repo's
    // own default. If the list can't load, the select stays hidden and
    // create-task resolves the default server-side.
    row.baseBranch = '';
    row.baseEl.hidden = true;
    row.baseEl.innerHTML = '';
    if (!p) return;
    var req = (row.branchReq || 0) + 1;
    row.branchReq = req;
    window.klaus.task.listBranches(p).then(function (res) {
      if (row.branchReq !== req || !row.el.isConnected || row.path !== p) return;
      var branches = (res && !res.error && res.branches) || [];
      if (!branches.length) return;
      var def = (selectedBaseBranch && branches.some(function (b) { return b.localName === selectedBaseBranch; }))
        ? selectedBaseBranch
        : (res.defaultBranch || branches[0].localName);
      row.baseEl.innerHTML = branches.map(function (b) {
        return '<option value="' + escHtml(b.localName) + '"' + (b.localName === def ? ' selected' : '') + '>'
          + escHtml(b.localName) + '</option>';
      }).join('');
      row.baseBranch = def;
      row.baseEl.hidden = false;
    }).catch(function (e) {
      console.warn('[multirepo list-branches]', e);
    });
  }

  function removeRepoRow(row) {
    additionalRepoRows = additionalRepoRows.filter(function (r) { return r !== row; });
    row.el.remove();
  }

  function addRepoRow() {
    var row = { el: null, pathEl: null, baseEl: null, path: null, name: '', baseBranch: '', branchReq: 0 };
    var el = document.createElement('div');
    el.className = 'modal-multirepo-item';
    el.innerHTML =
      '<span class="modal-repo-path">No repo selected</span>' +
      '<select class="mr-base" hidden title="Base branch in this repo"></select>' +
      '<button type="button" class="modal-input-btn mr-browse" title="Browse for a git repo">Browse</button>' +
      '<button type="button" class="modal-input-btn modal-recents-btn mr-recents" title="Projects &amp; discovered repos" aria-haspopup="listbox" aria-expanded="false">▾</button>' +
      '<button type="button" class="modal-input-btn mr-remove" title="Remove this repo">×</button>' +
      '<div class="modal-recents-list" hidden role="listbox"></div>';
    row.el = el;
    row.pathEl = el.querySelector('.modal-repo-path');
    row.baseEl = el.querySelector('.mr-base');
    row.baseEl.addEventListener('change', function () {
      row.baseBranch = row.baseEl.value;
    });

    el.querySelector('.mr-browse').addEventListener('click', async function () {
      var dir = await window.klaus.repo.browseDirectory();
      if (!dir) return;
      var added = await window.klaus.repo.addProject(dir);
      if (!added) return;
      setRepoRowPath(row, added.path);
    });

    el.querySelector('.mr-remove').addEventListener('click', function () {
      removeRepoRow(row);
    });

    bindRecentsDropdown(el.querySelector('.mr-recents'), el.querySelector('.modal-recents-list'), {
      loadItems: function () {
        var exclude = {};
        if (AppState.repoPath) exclude[AppState.repoPath] = true;
        additionalRepoRows.forEach(function (r) {
          if (r !== row && r.path) exclude[r.path] = true;
        });
        return buildRepoPickerSections(exclude);
      },
      onPick: function (p, info) {
        if (info && info.kind === 'github-clone') {
          var session = modalSession;
          var nameWithOwner = p.replace(/^gh:/, '');
          pendingRepoClones++;
          row.pathEl.textContent = 'Cloning ' + nameWithOwner + '…';
          cloneGithubPick(p, function (localPath) {
            pendingRepoClones = Math.max(0, pendingRepoClones - 1);
            if (session !== modalSession || !row.el.isConnected) return;
            setRepoRowPath(row, localPath);
          }, function () {
            pendingRepoClones = Math.max(0, pendingRepoClones - 1);
            if (session === modalSession && row.el.isConnected) setRepoRowPath(row, row.path);
          });
          return;
        }
        setRepoRowPath(row, p);
      },
      emptyText: 'No other repos found',
    });

    // Drag-and-drop parity with the source-repo row.
    ['dragenter', 'dragover'].forEach(function (evt) {
      el.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation();
        el.classList.add('drag-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      el.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation();
        el.classList.remove('drag-over');
      });
    });
    el.addEventListener('drop', async function (e) {
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      var p = window.klaus.fs.getPathForFile(file);
      if (!p) return;
      var added = await window.klaus.repo.addProject(p);
      if (!added) return;
      setRepoRowPath(row, added.path);
    });

    additionalRepoRows.push(row);
    multiRepoRowsEl.appendChild(el);
  }

  multiRepoAddBtn.addEventListener('click', function () { addRepoRow(); });

  // Source-repo drag-and-drop fallback. Drop a folder onto the row to
  // switch the active repo — same path as the Browse button.
  if (modalRepoRow) {
    ['dragenter', 'dragover'].forEach(function (evt) {
      modalRepoRow.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation();
        modalRepoRow.classList.add('drag-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      modalRepoRow.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation();
        modalRepoRow.classList.remove('drag-over');
      });
    });
    modalRepoRow.addEventListener('drop', async function (e) {
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      var p = window.klaus.fs.getPathForFile(file);
      if (!p) return;
      var added = await window.klaus.repo.addProject(p);
      if (!added) return;
      applyRepoSwitch(added.path);
    });
  }

  function showModal() {
    modalOverlay.style.display = 'flex';
    // Fresh discovery each time the modal opens so adopted repos / new
    // worktrees show up; cached within a single open across dropdown toggles.
    discoverReposCache = null;
    discoverWorktreesCache = null;
    recentGhReposCache = null;
    additionalRepoRows.slice().forEach(removeRepoRow);
    modalSession++;
    pendingRepoClones = 0;
    modalInput.value = '';
    modalError.textContent = '';
    clearFieldFlags();
    modalCreate.disabled = false;
    populateExistingSessions();
    // Default to this window; pre-check "new window" once it's crowded
    // (3+ open tasks).
    var openTaskCount = AppState.tasks ? AppState.tasks.size : 0;
    windowSelector.style.display = '';
    openNewWindowCheck.checked = openTaskCount >= 3;
    activeTab = 'new';
    selectedMode = AppState.savedPrefs.defaultProvider || AppState.savedPrefs.defaultMode || 'claude';
    modalTabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === 'new'); });
    tabContents.forEach(function (c) { c.classList.toggle('active', c.id === 'tab-new'); });
    shellOptions.forEach(function (b) { b.classList.toggle('active', b.dataset.shell === selectedMode); });
    syncCreateButtonLabel();
    selectedBaseBranch = '';
    baseBranchUserPicked = false;
    populateBaseBranchSelect();
    // Sync the source-repo display to whatever AppState says — buttons
    // and drag handlers were wired once at IIFE init.
    if (modalRepoPathEl) { modalRepoPathEl.textContent = AppState.repoPath || 'No repo selected'; modalRepoPathEl.title = AppState.repoPath || ''; }
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
        await window.klaus.task.setNotifyEnabled(id, newVal, 'idle');
      }},
      { label: (task.notifyCIEnabled !== false ? '\u2713 ' : '  ') + 'Notify on CI Pass/Fail', action: async function () {
        var newVal = task.notifyCIEnabled === false;
        task.notifyCIEnabled = newVal;
        await window.klaus.task.setNotifyEnabled(id, newVal, 'ci');
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
      var restartAgent = (task.mode && task.mode !== 'shell') ? task.mode : defaultAgent();
      items.push({ label: 'Restart ' + AppUtils.modeDisplayName(restartAgent), action: async function () {
        // restart-task respawns the task's original agent (consent/model/guard
        // handled in main) — not hardcoded to Claude.
        await window.klaus.task.restart(id);
        task.mode = restartAgent;
        updateSidebarMode(id, restartAgent);
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

  function defaultAgent() {
    return (AppState.savedPrefs && (AppState.savedPrefs.defaultProvider || AppState.savedPrefs.defaultMode)) || 'claude';
  }

  async function openFolderAsTask(mode) {
    mode = mode || defaultAgent();
    var dir = await window.pickDirectoryPopup({
      title: 'Open Folder in ' + AppUtils.modeDisplayName(mode),
      recentsKind: 'folders',
    });
    if (!dir) return;
    var result = await window.klaus.task.openFolder(dir, mode);
    if (!result || result.cancelled) return;
    if (result.error) {
      window.toast.error(result.error);
      return;
    }
    // Record on successful open so abandoned typing doesn't pollute the list.
    window.klaus.repo.recentPathsAdd('folders', dir);
    addTaskToUI(result);
    switchToTask(result.id);
  }

  function buildPaletteCommands() {
    var commands = [
      { label: 'New Task', action: function () { showModal(); } },
      { label: 'Open Folder…', action: function () { openFolderAsTask(defaultAgent()); } },
    ];
    // One "Open Folder in <Agent>…" entry per supported AI CLI, plus Shell.
    ((window.klaus.ui && window.klaus.ui.providers) || []).forEach(function (p) {
      commands.push({ label: 'Open Folder in ' + p.displayName + '…', action: function () { openFolderAsTask(p.id); } });
    });
    commands.push({ label: 'Open Folder in Shell…', action: function () { openFolderAsTask('shell'); } });
    commands.push.apply(commands, [
      { label: 'Toggle Diff Panel', action: function () { btnDiff.click(); } },
      { label: 'Change Theme', action: function () { showThemePicker(); } },
      { label: 'Preferences', action: function () { window.klaus.ui.openPreferences(); } },
      { label: 'New Window', action: function () { window.klaus.ui.newWindow(); } },
      { label: 'Zoom In', action: zoomIn },
      { label: 'Zoom Out', action: zoomOut },
      { label: 'Reset Zoom', action: zoomReset },
    ]);

    if (AppState.activeTaskId) {
      var task = tasks.get(AppState.activeTaskId);
      if (task) {
        commands.push({ label: 'Search in Terminal', action: function () { openSearch(AppState.activeTaskId); } });
        commands.push({ label: 'Clear Terminal', action: function () { task.terminal.clear(); } });
        commands.push({ label: 'Show Changes', action: function () { DiffPanel.show(task.worktreePath); btnDiff.classList.add('active'); } });
        commands.push({ label: 'Pop Out', action: function () { window.klaus.task.popOut(AppState.activeTaskId); } });
        commands.push({ label: 'Kill Task', action: function () { window.klaus.task.kill(AppState.activeTaskId).then(function () { removeTaskFromUI(AppState.activeTaskId); }); } });
        if (!task.alive) {
          var paletteAgent = (task.mode && task.mode !== 'shell') ? task.mode : defaultAgent();
          commands.push({ label: 'Restart ' + AppUtils.modeDisplayName(paletteAgent), action: function () {
            // Respawn the task's original agent via main (not hardcoded Claude).
            window.klaus.task.restart(AppState.activeTaskId).then(function () {
              task.mode = paletteAgent;
              updateSidebarMode(AppState.activeTaskId, paletteAgent);
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
    commands.push({ label: 'Run Slash Command…', action: function () { Dialogs.showSlashLauncher(); } });
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
    // Cmd+/: slash-command launcher — fire any installed /command into the
    // active terminal without remembering its plugin namespace.
    if (e.metaKey && e.key === '/') {
      e.preventDefault();
      if (window.Dialogs && Dialogs.showSlashLauncher) Dialogs.showSlashLauncher();
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
    btnOpenFolder.addEventListener('click', function () { openFolderAsTask(defaultAgent()); });
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
  // Exposed for the agents-panel router so "Open" on a PR-related agent can
  // remount the review surface without re-fetching the picker.
  window.enterPrReviewMode = enterPrReviewMode;

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
        var suffix = a.active ? ' (active)' : '';
        if (a.valid === false) suffix = ' (needs sign-in)';
        return '<option value="' + AppUtils.escAttr(a.username) + '"' + sel + ' data-valid="' + (a.valid === false ? 'false' : 'true') + '">'
          + AppUtils.escHtml(a.username) + suffix
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
      // needsLogin = main saw the target's token was already invalid and
      // refused to switch into it. Drive the in-app login flow instead of
      // surfacing a confusing error.
      if (sw && sw.needsLogin) {
        accountHint.textContent = 'Re-authenticating ' + target + '…';
        Dialogs.showGhLogin({
          onSuccess: async function () {
            accountHint.textContent = 'Signed in';
            await populateAccountSelect();
            await refreshLists();
          },
          // Reset the dropdown + hint if the user dismisses the login modal
          // — otherwise the hint lies about an in-progress operation that
          // never completes.
          onCancel: async function () {
            accountHint.textContent = '';
            await populateAccountSelect();
          },
        });
        return;
      }
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

  // Empty-state CTA: "Add a worktree" opens the same modal as the
  // sidebar's `+` New Task button. The modal's source-repo Browse/drag/
  // recents flow lets the user pick a repo from inside the modal even
  // before any project has been added.
  var emptyAddProj = document.getElementById('empty-state-add-project');
  if (emptyAddProj) {
    emptyAddProj.addEventListener('click', function () {
      btnNewTask.click();
    });
  }
  ['empty-state-open-folder', 'empty-state-open-folder-np'].forEach(function (linkId) {
    var link = document.getElementById(linkId);
    if (!link) return;
    link.addEventListener('click', function (e) {
      e.preventDefault();
      openFolderAsTask(defaultAgent());
    });
  });
  // Empty state stays in sync with project changes — the project-switcher
  // module dispatches `klaussy:project-changed` when projects change so we
  // can re-run the no-project check without polling.
  window.addEventListener('klaussy:project-changed', updateEmptyState);

  // Clear the red "required" ring from every field that can carry it.
  function clearFieldFlags() {
    [modalRepoRow, multiRepoRow, modalInput, modalBaseSelect, existingSessionSelect].forEach(function (el) {
      if (el) el.classList.remove('modal-field-invalid');
    });
  }
  // Abort a submit: re-enable Create, show the message, ring + focus the field.
  function failValidation(message, fieldEl) {
    modalCreate.disabled = false;
    syncCreateButtonLabel();
    modalError.textContent = message;
    if (fieldEl) {
      fieldEl.classList.add('modal-field-invalid');
      var focusEl = fieldEl.tagName === 'INPUT' ? fieldEl : fieldEl.querySelector('input, button');
      if (focusEl && focusEl.focus) setTimeout(function () { focusEl.focus(); }, 0);
    }
  }

  // Wrapper: an IPC rejection anywhere in the submit flow must not leave the
  // modal stuck on a disabled "Creating..." button with the error only in
  // DevTools.
  async function submitModal() {
    try {
      await submitModalInner();
    } catch (e) {
      console.error('[submitModal]', e);
      failValidation('Something went wrong: ' + ((e && e.message) || e), null);
    }
  }

  async function submitModalInner() {
    modalCreate.disabled = true;
    modalCreate.textContent = activeTab === 'existing' ? 'Resuming...' : 'Creating...';
    modalError.textContent = '';
    clearFieldFlags();

    // Snapshot everything the fan-out needs BEFORE the first await. The
    // primary create can take seconds (consent prompt, origin fetch) and the
    // inputs aren't locked meanwhile — live reads after the await could hand
    // secondary repos a different name/base/agent than the primary task got.
    var fanoutRepos = activeTab === 'new' ? selectedAdditionalRepos() : [];
    // Existing-session resume: filled in by the 'existing' branch below.
    var fanoutResume = [];
    var fanoutSavedList = [];
    var fanoutSessionName = '';
    var fanoutName = modalInput.value.trim();
    var fanoutBase = selectedBaseBranch;
    // Sessions live in the default ~/klaussy/sessions/<session>/<repo> layout
    // (resolved by the main process when no basePath is passed).
    var fanoutBasePath = null;
    var fanoutMode = selectedMode;
    var openInNewWindow = openNewWindowCheck.checked;

    var result;

    if (activeTab === 'new') {
      // A source repo is required for both create and checkout paths.
      if (!AppState.repoPath) {
        return failValidation('Select a source repo first.', modalRepoRow);
      }
      // A repo picked in an extra row is still cloning — submitting now
      // would silently drop it from the fan-out.
      if (pendingRepoClones > 0) {
        return failValidation('Still cloning a repo — give it a moment and try again.', multiRepoRow);
      }
      // Session layout is ~/klaussy/sessions/<session>/<repo folder name> —
      // two repos with the same folder name would collide on the second
      // create with a baffling "already exists" error.
      var baseNames = {};
      var nameCollision = null;
      [{ path: AppState.repoPath }].concat(fanoutRepos).forEach(function (r) {
        var b = (r.path || '').split('/').filter(Boolean).pop();
        if (baseNames[b] && baseNames[b] !== r.path) nameCollision = b;
        baseNames[b] = r.path;
      });
      if (nameCollision) {
        return failValidation('Two repos in this session share the folder name "' + nameCollision + '" — they would collide in the session folder. Rename one clone or create them as separate sessions.', multiRepoRow);
      }
      var name = modalInput.value.trim();
      if (name) {
        // The branch name is sanitized to [a-zA-Z0-9_-]; a name with no
        // letters/digits would collapse to an empty branch and fail in git.
        if (!/[a-zA-Z0-9]/.test(name)) {
          return failValidation('Name must include at least one letter or number.', modalInput);
        }
        // Name typed: create a new branch with that name, based on the
        // selected branch (or the default if none picked).
        result = await window.klaus.task.create(
          name,
          AppState.repoPath,
          selectedMode,
          null,
          undefined,
          selectedBaseBranch || null,
        );
      } else if (baseBranchUserPicked && selectedBaseBranch) {
        // No name, but the user *deliberately* picked a branch: check it out
        // directly so they can continue work on it in a fresh worktree. We
        // require an explicit pick (not the auto-default) so an unnamed submit
        // with the default branch still asks for a name instead of trying to
        // re-check-out the primary worktree's branch.
        // A branch can only live in one worktree — if it's already checked out,
        // tell the user to name a new branch off it rather than failing in git.
        var picked = baseBranchData.find(function (b) { return b.localName === selectedBaseBranch; });
        if (picked && picked.inWorktree) {
          return failValidation('"' + selectedBaseBranch + '" is already checked out in another worktree. Enter a name to branch off it instead.', modalBaseSelect);
        }
        result = await window.klaus.task.checkoutBranch(
          AppState.repoPath,
          selectedBaseBranch,
          selectedMode,
          null,
        );
      } else {
        return failValidation('Name the session, or pick an existing branch in the repo row to continue it.', modalInput);
      }
    } else {
      // Existing Session: resume every worktree in the picked session (one
      // unit across repos), each with its saved agent + session id where
      // known. Option values carry an "s:" / "b:" prefix (session folder vs
      // legacy branch group) — strip it for display/task naming.
      var sessKey = existingSessionSelect.value;
      if (!sessKey) {
        return failValidation('Pick a session to resume.', existingSessionSelect);
      }
      var sessName = sessKey.slice(2);
      var sessWts = (existingSessionsMap[sessKey] || []).filter(function (w) { return !w.active; });
      if (!sessWts.length) {
        return failValidation('Every worktree in this session is already open.', existingSessionSelect);
      }
      try {
        fanoutSavedList = (await window.klaus.session.listSaved()) || [];
      } catch (e) {
        fanoutSavedList = [];
      }
      fanoutSessionName = sessName;
      result = await resumeSessionWorktree(sessWts[0], sessName, fanoutSavedList, selectedMode);
      fanoutResume = sessWts.slice(1);
    }

    modalCreate.disabled = false;
    syncCreateButtonLabel();

    // User declined the agent's worktree-trust prompt — close quietly.
    if (result && result.cancelled) { hideModal(); return; }
    if (!result || result.error) {
      modalError.textContent = (result && result.error) || 'Failed to start the session.';
      return;
    }

    // Non-fatal: base branch couldn't be freshened from origin before the
    // worktree was created — the task still started from the local state.
    if (result.warning) window.toast.warn(result.warning);
    // Visible evidence of the pre-create fetch+pull ("pulled main a1b2c3d →
    // e4f5a6b" / "up to date") — silence here read as "nothing happened".
    if (result.freshenInfo) {
      var freshRepo = result.repoPath ? result.repoPath.split('/').filter(Boolean).pop() + ': ' : '';
      window.toast.info(freshRepo + result.freshenInfo);
    }


    // "New window": this window creates the tasks (instances are global) but
    // doesn't render them; the ids are handed to a fresh window once the
    // whole fan-out has finished.
    var newWindowIds = openInNewWindow ? [result.id] : null;
    var finalizeNewWindow = function () {
      if (!newWindowIds) return;
      var ids = newWindowIds;
      newWindowIds = null; // both fan-out chains call this; only fire once
      window.klaus.ui.newWindowWithTasks(ids).then(function (res) {
        if (res && res.error) throw new Error(res.error);
        window.toast.success('Session opened in a new window');
      }).catch(function (e) {
        console.error('[new-window-with-tasks]', e);
        // Don't strand invisible tasks: render them here instead.
        window.klaus.task.list().then(function (all) {
          var added = 0;
          var firstId = null;
          ids.forEach(function (tid) {
            if (AppState.tasks.get(tid)) return;
            var info = (all || []).find(function (x) { return x.id === tid; });
            if (!info) return;
            addTaskToUI(info);
            added++;
            if (firstId === null) firstId = tid;
          });
          if (added > 1 && TerminalManager.currentLayout() === 'single') {
            TerminalManager.setLayout(added >= 3 ? 'grid' : 'columns');
          }
          if (firstId !== null) switchToTask(firstId);
          window.toast.error('Could not open a new window — session opened here instead.');
        }).catch(function (e2) {
          console.error('[new-window fallback]', e2);
          window.toast.error('Could not open a new window or render the session here — its agents are still running; restart the app to reattach.');
        });
      });
    };

    hideModal();
    if (!newWindowIds) {
      addTaskToUI(result);
      switchToTask(result.id);
    }

    // Multi-repo / session-resume creates open side by side immediately — in
    // single layout the extra tasks would spawn invisibly and look like they
    // failed. Columns for two terminals, grid once there are three or more.
    var extraCount = fanoutRepos.length + fanoutResume.length;
    if (!newWindowIds && extraCount > 0 && TerminalManager.currentLayout() === 'single') {
      TerminalManager.setLayout(extraCount >= 2 ? 'grid' : 'columns');
    }
    if (newWindowIds && !extraCount) finalizeNewWindow();

    // Fan the same task out to the "Also create in" repos: same branch name
    // and worktree naming schema in each. Sequential on purpose — each spawn
    // can pop a worktree-consent prompt, and parallel creates would stack
    // dialogs. Per-repo failures don't stop the rest; they're reported at the
    // end so successful repos keep their tasks.
    if (fanoutRepos.length) {
      var failures = [];
      var skipped = [];
      var created = 0;
      var fanout = fanoutRepos.reduce(function (chain, repo) {
        return chain.then(function () {
          // Each row carries its own base branch (repos in one ticket often
          // default to different branches); fall back to the primary's pick,
          // and create-task still has baseBranchFallback as the last resort.
          var repoBase = repo.baseBranch || fanoutBase || null;
          var call = fanoutName
            ? window.klaus.task.create(fanoutName, repo.path, fanoutMode, fanoutBasePath, undefined, repoBase, true)
            : window.klaus.task.checkoutBranch(repo.path, repoBase || fanoutBase, fanoutMode, fanoutBasePath);
          return call.then(function (res) {
            // Everything in here counts as this repo's outcome — a throw from
            // addTaskToUI/toast must not kill the chain for the repos after it.
            try {
              if (!res || res.error) {
                failures.push(repo.name + ': ' + ((res && res.error) || 'failed'));
                return;
              }
              if (res.cancelled) { skipped.push(repo.name); return; }
              if (res.warning) window.toast.warn(repo.name + ': ' + res.warning);
              if (res.freshenInfo) window.toast.info(repo.name + ': ' + res.freshenInfo);
              if (newWindowIds) newWindowIds.push(res.id); else addTaskToUI(res);
              created++;
            } catch (e) {
              console.error('[multi-repo fanout]', repo.name, e);
              failures.push(repo.name + ': ' + ((e && e.message) || e));
            }
          }, function (e) {
            failures.push(repo.name + ': ' + ((e && e.message) || e));
          });
        });
      }, Promise.resolve());
      fanout.then(function () {
        if (failures.length) {
          window.toast.error('Could not create in ' + failures.join(' · '));
        }
        if (skipped.length) {
          window.toast.info('Skipped (trust prompt declined): ' + skipped.join(', '));
        }
        if (!failures.length && !skipped.length) {
          window.toast.success('Created in ' + (created + 1) + ' repos');
        }
        finalizeNewWindow();
      }).catch(function (e) {
        // Belt-and-braces: the chain shouldn't reject, but if it ever does the
        // user must not be left believing every repo got its task — and the
        // already-created tasks must still reach a window.
        console.error('[multi-repo fanout]', e);
        window.toast.error('Multi-repo creation was interrupted: ' + ((e && e.message) || e));
        finalizeNewWindow();
      });
    }

    // Existing-session fan-out: resume the rest of the session's worktrees.
    // Same sequential / per-repo failure semantics as the repo fan-out.
    if (fanoutResume.length) {
      var rsFailures = [];
      var rsSkipped = [];
      var rsResumed = 0;
      var rsFanout = fanoutResume.reduce(function (chain, wt) {
        return chain.then(function () {
          return resumeSessionWorktree(wt, fanoutSessionName, fanoutSavedList, fanoutMode).then(function (res) {
            try {
              if (!res || res.error) {
                rsFailures.push(wt.repoName + ': ' + ((res && res.error) || 'failed'));
                return;
              }
              if (res.cancelled) { rsSkipped.push(wt.repoName); return; }
              if (newWindowIds) newWindowIds.push(res.id); else addTaskToUI(res);
              rsResumed++;
            } catch (e) {
              console.error('[session resume fanout]', wt.path, e);
              rsFailures.push(wt.repoName + ': ' + ((e && e.message) || e));
            }
          }, function (e) {
            rsFailures.push(wt.repoName + ': ' + ((e && e.message) || e));
          });
        });
      }, Promise.resolve());
      rsFanout.then(function () {
        if (rsFailures.length) {
          window.toast.error('Could not resume ' + rsFailures.join(' · '));
        }
        if (rsSkipped.length) {
          window.toast.info('Skipped (trust prompt declined): ' + rsSkipped.join(', '));
        }
        if (!rsFailures.length && !rsSkipped.length) {
          window.toast.success('Resumed session in ' + (rsResumed + 1) + ' repos');
        }
        finalizeNewWindow();
      }).catch(function (e) {
        console.error('[session resume fanout]', e);
        window.toast.error('Session resume was interrupted: ' + ((e && e.message) || e));
        finalizeNewWindow();
      });
    }
  }
})();
