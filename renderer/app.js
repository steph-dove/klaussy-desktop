window.App = window.App || {};

(async function(App) {
  App.tasks = AppState.tasks;
  App.ciStatusMap = AppState.ciStatusMap;
  App.isSecondaryWindow = new URLSearchParams(window.location.search).has('secondary');
  App.layouts = ['single', 'columns', 'grid'];
  App.layoutIcons = { single: '\u25A8', columns: '\u2759\u2759', grid: '\u2637' };
  App.appEl = document.getElementById('app');
  App.taskList = document.getElementById('task-list');
  App.btnNewTask = document.getElementById('btn-new-task');
  App.btnLayout = document.getElementById('btn-layout');
  App.btnDiff = document.getElementById('btn-diff');
  App.terminalsEl = document.getElementById('terminals');
  App.emptyState = document.getElementById('empty-state');
  App.sidebar = document.getElementById('sidebar');
  App.btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
  App.sidebarToggleIcon = document.getElementById('sidebar-toggle-icon');
  App.sidebarToggleLabel = document.getElementById('sidebar-toggle-label');

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
  // klaussy-repo-conventions runs in the background at session create; without
  // these toasts there is zero visible evidence it happened (artifacts land in
  // the BASE repo, which worktrees don't show).
  if (window.klaus.task.onRepoIntelEvent) {
    window.klaus.task.onRepoIntelEvent(function (ev) {
      if (!ev) return;
      // Tool auto-install lifecycle (klaussy-repo-conventions + klaussy-agents
      // from PyPI) — these events carry no repoPath.
      if (ev.type === 'tools-installing') {
        window.toast.info('Installing repo-analysis tools (' + (ev.missing || []).join(', ') + ') via ' + (ev.installer || 'pipx') + '…');
        return;
      }
      if (ev.type === 'tools-installed') {
        window.toast.success('Repo-analysis tools installed (' + (ev.installed || []).join(', ') + ') — repo intelligence is ready');
        return;
      }
      if (ev.type === 'tools-failed') {
        window.toast.warn('Repo-analysis tools (' + (ev.missing || []).join(', ') + ') couldn’t be installed automatically (' + (ev.reason || 'unknown') + '). Klaussy will retry in the background.');
        return;
      }
      if (!ev.repoPath) return;
      var repoName = ev.repoPath.split('/').filter(Boolean).pop();
      if (ev.type === 'started') {
        window.toast.info(repoName + (ev.enriching
          ? ': graphing the repo and building conventions-aware skills (klaussy init + Claude enrichment — may take a few minutes)…'
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
        var why = ev.error || '';
        // A raw "spawn conventions ENOENT" is meaningless to users — the CLI
        // isn't on PATH yet. Translate it into something actionable.
        if (/ENOENT/i.test(why)) why = 'analysis tools not found on PATH — they may still be installing, or run: pipx install klaussy-repo-conventions klaussy-agents';
        else if (!why) why = 'is klaussy/conventions installed?';
        window.toast.warn(repoName + ': repo analysis unavailable (' + why + ') — agents run without repo intelligence');
      }
    });
  }

  // ---- Pre-commit review notifications ----
  // Both surfaces (Commit button + git hook from any terminal) broadcast
  // their lifecycle — seeing checks run, even on the good path, is the point.
  if (window.klaus.task.onPrecommitEvent) {
    window.klaus.task.onPrecommitEvent(function (ev) {
      if (!ev || !ev.wtName) return;
      var gate = ev.kind === 'push' ? 'pre-push review' : 'pre-commit review';
      var scope = ev.kind === 'push' ? 'push range' : 'staged changes';
      if (ev.type === 'started') {
        window.toast.info('🛡 ' + ev.wtName + ': ' + gate + ' running — ' + (ev.provider || 'agent') + ' checking silent failures, secrets, debug leftovers, landmines + lint…');
      } else if (ev.type === 'passed') {
        window.toast.success('🛡 ' + ev.wtName + ': ' + gate + ' passed — ' + scope + ' clean across all lenses');
      } else if (ev.type === 'findings') {
        window.toast.warn('🛡 ' + ev.wtName + ': ' + gate + ' found ' + ev.findingsCount + ' issue' + (ev.findingsCount === 1 ? '' : 's') + ' — see the terminal or commit panel');
      } else if (ev.type === 'error') {
        window.toast.warn('🛡 ' + ev.wtName + ': ' + gate + ' could not run (' + (ev.error || 'unknown') + ') — proceeded unreviewed');
      }
    });
  }

  // ---- Handle Claude → shell conversion ----
  window.klaus.task.onConverted(function (data) {
    var t = App.tasks.get(data.id);
    if (!t) return;
    // Remember which agent just exited so the Resume button re-launches THAT
    // agent (not hardcoded to Claude).
    if (t.mode && t.mode !== 'shell') t.resumeAgent = t.mode;
    t.alive = true;
    t.mode = 'shell';
    App.updateSidebarItem(data.id);
    App.updateSidebarMode(data.id, 'shell');
    if (window.TerminalManager && TerminalManager.refreshAgentChip) TerminalManager.refreshAgentChip(data.id);
    App.showResumeButton(data.id, t);
    // Refit terminal and sync size to new shell pty
    setTimeout(function () {
      t.fitAddon.fit();
      t.terminal.scrollToBottom();
      window.klaus.terminal.resize(data.id, t.terminal.cols, t.terminal.rows);
    }, 100);
  });

  // ---- Handle notification click → focus task ----
  window.klaus.task.onNotificationClicked(function (data) {
    App.switchToTask(data.id);
  });

  // ---- CI/CD Status (Feature 3) ----
  window.klaus.task.onCIStatusUpdate(function (data) {
    App.ciStatusMap.set(data.id, data.runs);
    App.updateCIStatusIcon(data.id, data.runs);
  });

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
  if (!App.isSecondaryWindow) {
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
  App.btnDiff.addEventListener('click', function () {
    if (DiffPanel.isVisible()) {
      DiffPanel.hide();
      App.btnDiff.classList.remove('active');
    } else {
      var task = App.tasks.get(AppState.activeTaskId);
      if (task) {
        DiffPanel.show(task.worktreePath);
        PRPanel.setWorktree(task.worktreePath);

        App.btnDiff.classList.add('active');
        if (!task.branch) App.forceFilesTab();
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
  App.filesTabBtn = document.querySelector('#diff-tabs .diff-tab[data-tab="files"]');

  window.BranchlessUI = {
    apply: function (task) {
      var branchless = !!(task && !task.branch);
      document.body.classList.toggle('task-branchless', branchless);
      if (branchless && DiffPanel.isVisible()) {
        var activeTab = document.querySelector('#diff-tabs .diff-tab.active');
        var hidden = activeTab && ['changes', 'pr', 'history', 'stash', 'env'].indexOf(activeTab.dataset.tab) !== -1;
        if (hidden) App.forceFilesTab();
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
  App.loadProjects = ProjectSwitcher.loadProjects;

  App.filterTaskList = ProjectSwitcher.filterTaskList;

  // ---- New Window ----
  App.btnNewWindow = document.getElementById('btn-new-window');

  App.btnNewWindow.addEventListener('click', function () {
    window.klaus.ui.newWindow();
  });

  // ---- Preferences (B1-B4) ----
  App.btnPrefs = document.getElementById('btn-prefs');

  App.btnPrefs.addEventListener('click', function () {
    window.klaus.ui.openPreferences();
  });

  // Apply preference changes broadcast from main process
  window.klaus.ui.onPreferencesChanged(function (prefs) {
    if (prefs.fontSize !== undefined || prefs.fontFamily !== undefined ||
        prefs.lineHeight !== undefined || prefs.cursorStyle !== undefined) {
      App.tasks.forEach(function (task, id) {
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
  App.btnTheme = document.getElementById('btn-theme');

  App.themeOverlay = document.getElementById('theme-overlay');
  App.themeList = document.getElementById('theme-list');
  App.themeClose = document.getElementById('theme-close');

  App.btnTheme.addEventListener('click', App.showThemePicker);

  App.themeClose.addEventListener('click', function () { App.themeOverlay.style.display = 'none'; });
  App.themeOverlay.addEventListener('click', function (e) {
    if (e.target === App.themeOverlay) App.themeOverlay.style.display = 'none';
  });

  // Update terminal themes when theme changes — primary AND sub-terminals, so
  // a live dark↔light switch doesn't leave an open sub-terminal on the stale
  // theme (e.g. dark fg on a now-light background).
  window.addEventListener('theme-changed', function () {
    var theme = ThemeManager.getTerminalTheme();
    App.tasks.forEach(function (task) {
      task.terminal.options.theme = theme;
      (task.subTerminals || []).forEach(function (sub) {
        if (sub && sub.terminal) sub.terminal.options.theme = theme;
      });
    });
  });

  // ---- File Viewer (C1) — renders inline in the diff panel ----

  // ---- File Browser (extracted to file-browser.js) ----
  App.loadFileTree = FileBrowser.loadFileTree;

  App.doProjectSearch = FileBrowser.doProjectSearch;

  // ---- Feature panels (extracted to history-panel.js, stash-panel.js) ----
  App.loadHistory = HistoryPanel.loadHistory;

  App.loadStash = StashPanel.loadStash;

  // ---- Global tab reload (called by PRPanel.reloadActiveTab) ----
  window._reloadDiffTab = function (tab, wt) {
    if (tab === 'files') App.loadFileTree(wt);
    else if (tab === 'history') App.loadHistory(wt);
    else if (tab === 'stash') App.loadStash(wt);
    else if (tab === 'search') App.doProjectSearch(wt);
    else if (tab === 'env') { EnvPanel.setWorktree(wt); EnvPanel.load(); }
  };

  App.escHtml = AppUtils.escHtml;

  // ---- Sidebar toggle & manual resize ----
  App.DEFAULT_SIDEBAR_WIDTH = 240;

  App.MIN_SIDEBAR_WIDTH = 140;
  App.MAX_SIDEBAR_RATIO = 0.4;

  App.btnSidebarToggle.addEventListener('click', App.toggleSidebar);

  // Drag handle on right edge of sidebar for manual resize
  App.sidebarResizeHandle = document.createElement('div');

  App.sidebarResizeHandle.className = 'sidebar-resize-handle';
  App.sidebar.appendChild(App.sidebarResizeHandle);

  (function () {
    var dragging = false;
    var startX = 0;
    var startWidth = 0;

    App.sidebarResizeHandle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startWidth = App.sidebar.getBoundingClientRect().width;
      App.sidebarResizeHandle.classList.add('active');
      App.sidebar.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var newWidth = startWidth + (e.clientX - startX);
      var maxWidth = window.innerWidth * App.MAX_SIDEBAR_RATIO;
      newWidth = Math.max(App.MIN_SIDEBAR_WIDTH, Math.min(newWidth, maxWidth));
      App.sidebar.classList.remove('collapsed', 'expanded');
      AppState.sidebarCollapsed = false;
      App.sidebar.style.width = newWidth + 'px';
      App.sidebar.style.minWidth = newWidth + 'px';
      App.sidebarToggleIcon.textContent = '\u25C0';
      App.sidebarToggleLabel.textContent = 'Hide';
    });

    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      App.sidebarResizeHandle.classList.remove('active');
      App.sidebar.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      App.refitTerminals();
    });
  })();

  // ---- Init ----
  AppState.repoPath = await window.klaus.repo.get();
  // Always show the app — the project-switcher's `+` button is the canonical
  // way to add a repo. The old "Select Repository" splash blocked startup
  // for first-runs without a project; the empty task list + project picker
  // handle that case fine on their own.
  App.showApp();

  window._addWorktreeToSidebar = App.addWorktreeToSidebar;

  document.addEventListener('klaussy:default-agent-changed', App.refreshWorktreeAgentButtons);

  App.formatAge = AppUtils.formatAge;

  // ---- New Task (modal) ----
  App.modalOverlay = document.getElementById('modal-overlay');

  App.modalInput = document.getElementById('modal-input');
  App.modalError = document.getElementById('modal-error');
  App.modalCreate = document.getElementById('modal-create');
  App.modalCancel = document.getElementById('modal-cancel');
  App.existingSessionSelect = document.getElementById('existing-session-select');
  // Searchable dropdown over the resume-session picker (the select stays the
  // source of truth; populateExistingSessions keeps rewriting its <option>s).
  if (window.SearchableSelect) {
    window.SearchableSelect.enhance(App.existingSessionSelect, {
      placeholder: 'Pick a session…',
      searchPlaceholder: 'Search sessions…',
    });
  }
  App.modalRepoRow = document.getElementById('modal-repo-row');
  App.modalRepoPathEl = document.getElementById('modal-repo-path');
  App.modalRepoBrowseBtn = document.getElementById('btn-modal-repo-browse');
  App.modalRepoRecentsBtn = document.getElementById('btn-modal-repo-recents');
  App.modalRepoRecentsList = document.getElementById('modal-repo-recents-list');
  App.multiRepoRow = document.getElementById('modal-multirepo-row');
  App.multiRepoRowsEl = document.getElementById('modal-multirepo-rows');
  App.multiRepoAddBtn = document.getElementById('btn-modal-multirepo-add');
  App.modalTabs = document.querySelectorAll('.modal-tab');
  App.tabContents = document.querySelectorAll('.tab-content');
  App.activeTab = 'new';
  App.selectedMode = 'claude';
  App.selectedBaseBranch = '';

  // True only once the user deliberately picks a base branch. The combobox is
  // pre-filled with the default branch, so without this flag "no name" would
  // always be read as "continue the default branch" and never as "name
  // required" — and checking out the default usually fails (it's already the
  // primary worktree's branch).
  App.baseBranchUserPicked = false;

  // Shell selector
  App.shellOptions = document.querySelectorAll('.shell-option');

  App.shellOptions.forEach(function (btn) {
    btn.addEventListener('click', function () {
      App.selectedMode = btn.dataset.shell;
      App.shellOptions.forEach(function (b) { b.classList.toggle('active', b === btn); });
    });
  });

  // "Open session in new window" — always visible; pre-checked when this
  // window is crowded (3+ open tasks).
  App.windowSelector = document.getElementById('window-selector');

  App.openNewWindowCheck = document.getElementById('open-new-window-check');

  // Tab switching
  App.modalBaseSelect = document.getElementById('modal-base-branch');

  App.baseBranchData = []; // [{ localName, isRemote, ... }]
  App.baseBranchDefault = ''; // pre-selected branch (dev > main > master fallback)

  App.modalTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      App.activeTab = tab.dataset.tab;
      App.modalTabs.forEach(function (t) { t.classList.toggle('active', t === tab); });
      App.tabContents.forEach(function (c) { c.classList.toggle('active', c.id === 'tab-' + App.activeTab); });
      App.modalError.textContent = '';
      App.clearFieldFlags();
      App.syncCreateButtonLabel();
      if (App.activeTab === 'new') {
        setTimeout(function () { App.modalInput.focus(); }, 50);
      }
    });
  });

  // Clear the name field's required-ring (and stale error) as soon as the
  // user starts typing a name.
  App.modalInput.addEventListener('input', function () {
    App.modalInput.classList.remove('modal-field-invalid');
    if (App.modalError) App.modalError.textContent = '';
  });

  // Primary base-branch select — lives inline in the source-repo row, same
  // style/behavior as the extra repo rows' selects. Change = a deliberate
  // pick (drives the "continue this branch" no-name flow).
  if (App.modalBaseSelect) {
    App.modalBaseSelect.addEventListener('change', function () {
      App.selectedBaseBranch = App.modalBaseSelect.value;
      App.baseBranchUserPicked = true;
      App.modalBaseSelect.classList.remove('modal-field-invalid');
      if (App.modalError) App.modalError.textContent = '';
    });
    // Searchable dropdown over the base-branch picker (branch lists get long).
    // It mirrors the select's `hidden` toggle, so it stays invisible until
    // branches load.
    if (window.SearchableSelect) {
      window.SearchableSelect.enhance(App.modalBaseSelect, {
        className: 'ss-base-branch',
        placeholder: 'Base branch',
        searchPlaceholder: 'Search branches…',
      });
    }
  }

  // Discovery promises, cached per modal-open so toggling a dropdown doesn't
  // re-crawl the filesystem / re-shell `git worktree list`. Reset in showModal;
  // the repos cache is also invalidated when a discovered repo is adopted (it
  // then moves into the Projects section).
  App.discoverReposCache = null;

  App.discoverWorktreesCache = null;

  // Recently-pushed GitHub repos for the source-repo dropdown. Degrades to an
  // empty list when gh is missing/unauthed/offline — the section just doesn't
  // render, the rest of the dropdown is unaffected.
  App.recentGhReposCache = null;

  // ---- Existing sessions (Existing Session tab) -----------------------------
  // A session is ONE unit no matter how many repos it spans. Worktrees under
  // ~/klaussy/sessions/<name>/ group by that folder name (the canonical
  // multi-repo layout); everything else (legacy single worktrees) groups by
  // branch under a separate "Other worktrees" optgroup so old work stays
  // reachable without flooding the session list.
  App.existingSessionsMap = {}; // option value -> [{ path, branch, repoName, active }]

  App.SESSION_DIR_RE = /\/klaussy\/sessions\/([^/]+)\//;

  // ---- Manage Sessions (sidebar) --------------------------------------------
  // Lists every session with a per-session Delete: warns that ALL work in the
  // session goes away, closes its open terminals, then removes the worktrees
  // and the session folder (delete-session IPC). Branches are kept.
  App.sessionsModalOverlay = document.getElementById('sessions-modal-overlay');

  App.sessionsModalList = document.getElementById('sessions-modal-list');
  App.btnManageSessions = document.getElementById('btn-manage-sessions');
  App.sessionsModalClose = document.getElementById('sessions-modal-close');

  // Typed confirmation: the Delete button stays disabled until the user
  // types "delete". Returns a promise resolving true (confirmed) / false.
  App.confirmDeleteSession = (function () {
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
          return '<div class="delete-session-item"><span class="delete-session-repo">' + App.escHtml(w.repoName) + '</span>'
            + '<span class="delete-session-path">' + App.escHtml(w.path) + '</span></div>';
        }).join('');
        input.value = '';
        btnConfirm.disabled = true;
        overlay.style.display = 'flex';
        setTimeout(function () { input.focus(); }, 50);
      });
    };
  })();

  App.btnManageSessions.addEventListener('click', function () {
    App.sessionsModalOverlay.style.display = 'flex';
    App.renderSessionsModalList();
  });
  App.sessionsModalClose.addEventListener('click', function () {
    App.sessionsModalOverlay.style.display = 'none';
  });
  App.sessionsModalOverlay.addEventListener('click', function (e) {
    if (e.target === App.sessionsModalOverlay) App.sessionsModalOverlay.style.display = 'none';
  });

  // Source-repo Browse: native Finder via browse-directory IPC. addProject
  // validates the picked folder is a git repo (offers git init if not)
  // and persists it into config.projects so it shows in the recents list
  // next time.
  App.modalRepoBrowseBtn.addEventListener('click', async function () {
    var dir = await window.klaus.repo.browseDirectory();
    if (!dir) return;
    var added = await window.klaus.repo.addProject(dir);
    if (!added) return;
    App.applyRepoSwitch(added.path);
  });

  App.bindRecentsDropdown(App.modalRepoRecentsBtn, App.modalRepoRecentsList, {
    loadItems: function () { return App.buildRepoPickerSections(); },
    onPick: function (p, info) {
      if (info && info.kind === 'github-clone') {
        // Not on disk yet: clone into the default projects dir, then switch.
        if (App.modalRepoPathEl) {
          App.modalRepoPathEl.textContent = 'Cloning ' + p.replace(/^gh:/, '') + '…';
          App.modalRepoPathEl.title = '';
        }
        var restoreRepoLabel = function () {
          if (App.modalRepoPathEl) {
            App.modalRepoPathEl.textContent = AppState.repoPath || 'No repo selected';
            App.modalRepoPathEl.title = AppState.repoPath || '';
          }
        };
        App.cloneGithubPick(p, function (localPath) {
          window.klaus.repo.switchProject(localPath).then(function () {
            App.applyRepoSwitch(localPath);
          }).catch(function (e) {
            console.error('[switch-project]', e);
            restoreRepoLabel();
            window.toast.error('Cloned, but could not switch to ' + localPath);
          });
        }, restoreRepoLabel);
        return;
      }
      // Every other section is a real git repo on disk — just switch.
      window.klaus.repo.switchProject(p).then(function () { App.applyRepoSwitch(p); });
    },
    emptyText: 'No repos found',
  });

  // ---- Multi-repo rows ------------------------------------------------------
  // The "+" bar appends a repo-picker row identical to the source-repo one
  // (path display, Browse, ▾ dropdown, drag-and-drop) plus a ×. On submit the
  // same branch + worktree naming schema fans out to every row with a repo
  // picked — common when one ticket spans multiple repos. The resulting tasks
  // are independent; these rows are just creation-time input.
  App.additionalRepoRows = []; // [{ el, pathEl, path, name }]

  // Clones started from a row's dropdown that haven't finished yet. Submit is
  // blocked while > 0 so a repo the user picked can't be silently missing
  // from the fan-out. Stamped with the modal session so a clone that finishes
  // after close/reopen doesn't write into the wrong session's rows.
  App.pendingRepoClones = 0;

  App.modalSession = 0;

  App.multiRepoAddBtn.addEventListener('click', function () { App.addRepoRow(); });

  // Source-repo drag-and-drop fallback. Drop a folder onto the row to
  // switch the active repo — same path as the Browse button.
  if (App.modalRepoRow) {
    ['dragenter', 'dragover'].forEach(function (evt) {
      App.modalRepoRow.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation();
        App.modalRepoRow.classList.add('drag-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      App.modalRepoRow.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation();
        App.modalRepoRow.classList.remove('drag-over');
      });
    });
    App.modalRepoRow.addEventListener('drop', async function (e) {
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      var p = window.klaus.fs.getPathForFile(file);
      if (!p) return;
      var added = await window.klaus.repo.addProject(p);
      if (!added) return;
      App.applyRepoSwitch(added.path);
    });
  }

  App.btnNewTask.addEventListener('click', App.showModal);
  App.modalCreate.addEventListener('click', App.submitModal);
  App.modalCancel.addEventListener('click', App.hideModal);
  App.modalOverlay.addEventListener('click', function (e) {
    if (e.target === App.modalOverlay) App.hideModal();
  });
  App.modalInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') App.submitModal();
    if (e.key === 'Escape') App.hideModal();
  });

  // ---- Terminal, Sidebar, Layout (extracted to terminal-manager.js, sidebar-manager.js) ----
  App.addTaskToUI = TerminalManager.addTaskToUI;

  App.removeTaskFromUI = TerminalManager.removeTaskFromUI;
  App.switchToTask = TerminalManager.switchToTask;
  App.rewireTerminal = TerminalManager.rewireTerminal;
  App.currentLayout = TerminalManager.currentLayout;
  App.fitAllTerminals = TerminalManager.fitAllTerminals;
  App.zoomIn = TerminalManager.zoomIn;
  App.zoomOut = TerminalManager.zoomOut;
  App.zoomReset = TerminalManager.zoomReset;
  App.updateSidebarItem = Sidebar.updateItem;
  App.updateSidebarMode = Sidebar.updateMode;
  App.showResumeButton = Sidebar.showResumeButton;
  App.showUnreadBadge = Sidebar.showUnreadBadge;
  App.hideUnreadBadge = Sidebar.hideUnreadBadge;

  // Expose context menu builder for terminal-manager
  window._showContextMenu = App.showContextMenu;

  // Keyboard shortcut: Cmd+G to toggle diff panel
  document.addEventListener('keydown', function (e) {
    if (e.metaKey && e.key === 'g') {
      e.preventDefault();
      App.btnDiff.click();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.metaKey && e.key === 'k') {
      if (App.shouldInlineEdit(e)) {
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
      App.showCommandPalette();
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

  App.prReviewRoot = document.getElementById('pr-review-root');

  App.terminalArea = document.getElementById('terminal-area');
  App.diffPanelEl = document.getElementById('diff-panel');
  App.btnOpenFolder = document.getElementById('btn-open-folder');
  if (App.btnOpenFolder) {
    App.btnOpenFolder.addEventListener('click', function () { App.openFolderAsTask(App.defaultAgent()); });
  }

  App.btnRunApp = document.getElementById('btn-run-app');
  if (App.btnRunApp) {
    App.btnRunApp.addEventListener('click', function () {
      if (typeof window.runApp === 'function') window.runApp();
    });
  }

  App.btnTreeCollapse = document.getElementById('btn-tree-collapse');
  if (App.btnTreeCollapse) {
    var filesTabContent = document.getElementById('files-tab-content');
    var TREE_COLLAPSED_KEY = 'klaussy.fileTreeCollapsed';
    // Restore on load — user's preference sticks across sessions.
    if (localStorage.getItem(TREE_COLLAPSED_KEY) === '1') {
      filesTabContent.classList.add('tree-collapsed');
      App.btnTreeCollapse.textContent = '▸';
      App.btnTreeCollapse.title = 'Show file tree';
    }
    App.btnTreeCollapse.addEventListener('click', function () {
      var collapsed = filesTabContent.classList.toggle('tree-collapsed');
      App.btnTreeCollapse.textContent = collapsed ? '▸' : '▾';
      App.btnTreeCollapse.title = collapsed ? 'Show file tree' : 'Collapse file tree';
      localStorage.setItem(TREE_COLLAPSED_KEY, collapsed ? '1' : '0');
    });
  }

  App.btnReviewPr = document.getElementById('btn-review-pr');
  App.prReviewMounted = false;

  if (App.btnReviewPr) {
    App.btnReviewPr.addEventListener('click', function () { App.showPrPicker(); });
  }

  // Exposed for pr-review.js to call when main clears state.
  window.exitPrReviewMode = App.exitPrReviewMode;
  // Exposed for the agents-panel router so "Open" on a PR-related agent can
  // remount the review surface without re-fetching the picker.
  window.enterPrReviewMode = App.enterPrReviewMode;

  // G5: when "Check out locally" finishes in main, pick up the new task in
  // the main window (pop-out closes itself via the null state broadcast).
  window.klaus.pr.onCheckoutReady(function (task) {
    if (!task || typeof task.id !== 'number') return;
    App.addTaskToUI(task);
  });

  // A backgrounded PR-implement run wants attention (finished / errored /
  // paused after a turn while no surface was attached). Toast it so the user
  // knows to reopen the PR — works from any view, even the tasks layout.
  if (window.klaus.pr.onImplementAttention) {
    window.klaus.pr.onImplementAttention(function (ev) {
      if (!ev || !window.toast) return;
      var pr = ev.prNumber ? ('PR #' + ev.prNumber) : 'A PR';
      if (ev.status === 'error') {
        window.toast.warn(pr + ': background implement run hit an error — reopen the PR to view');
      } else if (ev.status === 'cancelled') {
        window.toast.info(pr + ': background implement run was cancelled');
      } else if (ev.status === 'paused') {
        window.toast.info(pr + ': implement agent finished a turn and may need your input — reopen the PR');
      } else {
        window.toast.success(pr + ': background implement run finished — reopen the PR to review');
      }
    });
  }

  // Keep the main-window panel visibility in sync with main-process state
  // changes (e.g. the pop-out's "pop back in" button clears popout → we want
  // the main panel mounted again; prReviewClose from anywhere unmounts us).
  window.klaus.pr.onReviewState(function (state) {
    if (!state) {
      App.exitPrReviewMode();
    } else if (!state.popped) {
      // No pop-out → panel should be mounted.
      if (!App.prReviewMounted) App.enterPrReviewMode();
    } else {
      // Popped out → hide the main-window panel so both surfaces don't show
      // the same thing. Keep state in main; remount on pop-in.
      if (App.prReviewMounted) {
        window.PrReview.unmount();
        App.prReviewRoot.style.display = 'none';
        App.terminalArea.style.display = '';
        if (App.diffPanelEl) App.diffPanelEl.style.display = App.diffPanelEl.dataset.prevDisplay || '';
        App.prReviewMounted = false;
      }
    }
  });

  // Task rename and reorder extracted to sidebar-manager.js

  // ---- About Dialog (A7) ----

  App.showAboutDialog = Dialogs.showAbout;

  App.showLogViewer = Dialogs.showLog;

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
  App.emptyAddProj = document.getElementById('empty-state-add-project');

  if (App.emptyAddProj) {
    App.emptyAddProj.addEventListener('click', function () {
      App.btnNewTask.click();
    });
  }
  ['empty-state-open-folder', 'empty-state-open-folder-np'].forEach(function (linkId) {
    var link = document.getElementById(linkId);
    if (!link) return;
    link.addEventListener('click', function (e) {
      e.preventDefault();
      App.openFolderAsTask(App.defaultAgent());
    });
  });
  // Empty state stays in sync with project changes — the project-switcher
  // module dispatches `klaussy:project-changed` when projects change so we
  // can re-run the no-project check without polling.
  window.addEventListener('klaussy:project-changed', App.updateEmptyState);

})(window.App);
