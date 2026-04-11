(async function () {
  const tasks = new Map(); // id -> { name, terminal, fitAddon, container, cleanup[], alive }
  let activeTaskId = null;
  let focusedTaskId = null;
  let repoPath = null;
  const isSecondaryWindow = new URLSearchParams(window.location.search).has('secondary');
  const layouts = ['single', 'columns', 'grid'];
  const layoutIcons = { single: '\u25A8', columns: '\u2759\u2759', grid: '\u2637' };
  let layoutIndex = 0;
  let currentFontSize = 13;

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

  // ---- Init Theme (Phase 5) ----
  ThemeManager.init();

  // ---- Init Diff Panel (Phase 1) & PR Panel ----
  DiffPanel.init();
  PRPanel.init();
  DiffPanel.setCommentCallback(function (text) {
    if (activeTaskId) {
      window.klaus.writeTerminal(activeTaskId, text + '\n');
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
      window.klaus.resizeTerminal(data.id, t.terminal.cols, t.terminal.rows);
    }, 100);
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
      var task = tasks.get(activeTaskId);
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

  // ---- Project Switcher (Phase 3) ----
  const projectSelect = document.getElementById('project-select');
  const btnAddProject = document.getElementById('btn-add-project');

  async function loadProjects() {
    var projects = await window.klaus.listProjects();
    var current = await window.klaus.getRepo();
    projectSelect.innerHTML = '';

    if (projects.length === 0 && current) {
      // Migrate: single repo into projects list
      await window.klaus.switchProject(current);
      projects = [{ name: current.split('/').pop(), path: current }];
    }

    projects.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.path;
      opt.textContent = p.name;
      if (p.path === current) opt.selected = true;
      projectSelect.appendChild(opt);
    });

    if (projects.length === 0) {
      var opt = document.createElement('option');
      opt.textContent = 'No projects';
      opt.disabled = true;
      projectSelect.appendChild(opt);
    }
  }

  projectSelect.addEventListener('change', async function () {
    var newPath = projectSelect.value;
    if (newPath) {
      await window.klaus.switchProject(newPath);
      repoPath = newPath;
    }
  });

  btnAddProject.addEventListener('click', async function () {
    var result = await window.klaus.addProject();
    if (result) {
      repoPath = result.path;
      await loadProjects();
    }
  });

  // ---- New Window ----
  const btnNewWindow = document.getElementById('btn-new-window');
  btnNewWindow.addEventListener('click', function () {
    window.klaus.newWindow();
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

  // ---- File Viewer (Phase 7) ----
  const fileViewerOverlay = document.getElementById('file-viewer-overlay');
  const fileViewerName = document.getElementById('file-viewer-name');
  const fileViewerContent = document.getElementById('file-viewer-content');
  const fileViewerClose = document.getElementById('file-viewer-close');

  fileViewerClose.addEventListener('click', function () { fileViewerOverlay.style.display = 'none'; });
  fileViewerOverlay.addEventListener('click', function (e) {
    if (e.target === fileViewerOverlay) fileViewerOverlay.style.display = 'none';
  });

  window.openFileViewer = async function (filePath, fileName) {
    fileViewerName.textContent = fileName || filePath;
    fileViewerContent.innerHTML = 'Loading...';
    fileViewerOverlay.style.display = 'flex';

    var result = await window.klaus.readFile(filePath);
    if (result.error) {
      fileViewerContent.innerHTML = '<span style="color: var(--error)">Error: ' + result.error + '</span>';
      return;
    }

    // Render with line numbers
    var lines = result.content.split('\n');
    fileViewerContent.innerHTML = lines.map(function (line) {
      return '<span class="file-line">' + escHtml(line) + '</span>';
    }).join('\n');
  };

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- Sidebar resize: default -> expanded -> collapsed -> default ----
  const sidebarStates = ['default', 'expanded', 'collapsed'];
  const sidebarLabels = { default: 'Expand', expanded: 'Collapse', collapsed: 'Show' };
  const sidebarIcons = { default: '\u25B6', expanded: '\u25C0', collapsed: '\u25B6' };
  let sidebarIndex = 0;

  function cycleSidebar() {
    sidebarIndex = (sidebarIndex + 1) % sidebarStates.length;
    var state = sidebarStates[sidebarIndex];
    sidebar.classList.remove('expanded', 'collapsed');
    if (state !== 'default') sidebar.classList.add(state);
    sidebarToggleLabel.textContent = sidebarLabels[state];
    sidebarToggleIcon.textContent = sidebarIcons[state];

    setTimeout(function () {
      if (currentLayout() !== 'single') {
        fitAllTerminals();
      } else if (activeTaskId != null) {
        var task = tasks.get(activeTaskId);
        if (task) {
          task.fitAddon.fit();
          window.klaus.resizeTerminal(activeTaskId, task.terminal.cols, task.terminal.rows);
        }
      }
    }, 250);
  }

  btnSidebarToggle.addEventListener('click', cycleSidebar);

  // ---- Init ----
  repoPath = await window.klaus.getRepo();
  if (repoPath) {
    showApp();
  } else {
    repoOverlay.style.display = 'flex';
  }

  btnSelectRepo.addEventListener('click', async function () {
    var selected = await window.klaus.selectRepo();
    if (selected) {
      repoPath = selected;
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

  function addWorktreeToSidebar(wt) {
    // Don't add if already in sidebar (as a worktree item or active task)
    var existing = taskList.querySelector('.worktree-item[data-path="' + CSS.escape(wt.path) + '"]');
    if (existing) return;

    var item = document.createElement('div');
    item.className = 'task-item worktree-item';
    item.dataset.path = wt.path;

    item.innerHTML =
      '<span class="status-dot idle"></span>' +
      '<div class="saved-session-info">' +
        '<span class="task-name" title="' + escHtml(wt.path) + '">' + escHtml(wt.name) + '</span>' +
        '<span class="saved-session-detail">' + escHtml(wt.branch) + '</span>' +
      '</div>' +
      '<div class="saved-session-actions">' +
        '<button class="worktree-open-claude" title="Open with Claude Code">cc</button>' +
        '<button class="worktree-open-shell" title="Open shell">sh</button>' +
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
      item.innerHTML =
        '<span class="status-dot saved"></span>' +
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

  function formatAge(isoString) {
    if (!isoString) return '';
    var ms = Date.now() - new Date(isoString).getTime();
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    return days + 'd ago';
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

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

  // Shell selector
  const shellOptions = document.querySelectorAll('.shell-option');
  shellOptions.forEach(function (btn) {
    btn.addEventListener('click', function () {
      selectedMode = btn.dataset.shell;
      shellOptions.forEach(function (b) { b.classList.toggle('active', b === btn); });
    });
  });

  // Tab switching
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
    selectedMode = 'claude';
    modalTabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === 'new'); });
    tabContents.forEach(function (c) { c.classList.toggle('active', c.id === 'tab-new'); });
    shellOptions.forEach(function (b) { b.classList.toggle('active', b.dataset.shell === 'claude'); });
    setTimeout(function () { modalInput.focus(); }, 50);
  }

  function hideModal() {
    modalOverlay.style.display = 'none';
    modalInput.value = '';
    modalError.textContent = '';
  }

  async function submitModal() {
    modalCreate.disabled = true;
    modalCreate.textContent = 'Creating...';
    modalError.textContent = '';

    var result;

    if (activeTab === 'new') {
      var name = modalInput.value.trim();
      if (!name) {
        modalCreate.disabled = false;
        modalCreate.textContent = 'Create';
        return;
      }
      result = await window.klaus.createTask(name, repoPath, selectedMode, selectedBasePath);
    } else {
      if (!selectedWorktreePath) {
        modalError.textContent = 'Please select a directory first.';
        modalCreate.disabled = false;
        modalCreate.textContent = 'Create';
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

  function addTaskToUI(task) {
    var id = task.id;
    var name = task.name;
    var worktreePath = task.worktreePath;
    var branch = task.branch;

    // Create terminal
    var Terminal = window.Terminal;
    var FitAddon = window.FitAddon;

    var termTheme = ThemeManager.getTerminalTheme();
    var terminal = new Terminal({
      cursorBlink: true,
      fontSize: currentFontSize,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      scrollback: 10000,
      theme: termTheme,
      allowProposedApi: true,
    });

    var fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);

    var SearchAddon = window.SearchAddon;
    var searchAddon = new SearchAddon.SearchAddon();
    terminal.loadAddon(searchAddon);

    var WebLinksAddon = window.WebLinksAddon;
    var webLinksAddon = new WebLinksAddon.WebLinksAddon(function (_event, uri) {
      window.klaus.openExternal(uri);
    });
    terminal.loadAddon(webLinksAddon);

    // Create container with grid label
    var container = document.createElement('div');
    container.className = 'terminal-container';
    container.dataset.id = id;

    var label = document.createElement('div');
    label.className = 'grid-label';
    label.innerHTML = '<span class="grid-dot ' + (task.alive !== false ? 'alive' : 'exited') + '"></span>' + escHtml(name);

    // In single mode: click to switch. In multi mode: click to focus, drag to reorder.
    label.addEventListener('click', function () {
      if (currentLayout() === 'single') {
        switchToTask(id);
      } else {
        // Just focus this terminal (update diff panel etc)
        focusedTaskId = id;
        var t = tasks.get(id);
        if (t && DiffPanel.isVisible()) {
          DiffPanel.updateWorktree(t.worktreePath);
          PRPanel.setWorktree(t.worktreePath);
        }
      }
    });

    // Drag-and-drop reordering
    label.draggable = true;
    label.addEventListener('dragstart', function (e) {
      if (currentLayout() === 'single') { e.preventDefault(); return; }
      container.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id.toString());
    });
    label.addEventListener('dragend', function () {
      container.classList.remove('dragging');
      terminalsEl.querySelectorAll('.terminal-container').forEach(function (el) {
        el.classList.remove('drag-over');
      });
    });
    container.addEventListener('dragover', function (e) {
      if (currentLayout() === 'single') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var dragging = terminalsEl.querySelector('.dragging');
      if (dragging && dragging !== container) {
        container.classList.add('drag-over');
      }
    });
    container.addEventListener('dragleave', function () {
      container.classList.remove('drag-over');
    });
    container.addEventListener('drop', function (e) {
      e.preventDefault();
      container.classList.remove('drag-over');
      var dragging = terminalsEl.querySelector('.dragging');
      if (!dragging || dragging === container) return;

      // Determine position: insert before or after based on drop position
      var rect = container.getBoundingClientRect();
      var isVertical = currentLayout() === 'grid';
      var mid = isVertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
      var pos = isVertical ? e.clientY : e.clientX;

      if (pos < mid) {
        terminalsEl.insertBefore(dragging, container);
      } else {
        terminalsEl.insertBefore(dragging, container.nextSibling);
      }

      fitAllTerminals();
    });

    container.appendChild(label);

    terminalsEl.appendChild(container);
    terminal.open(container);

    // Scroll-to-bottom button
    var scrollBtn = document.createElement('button');
    scrollBtn.className = 'terminal-scroll-bottom';
    scrollBtn.innerHTML = '&#8595;';
    scrollBtn.title = 'Scroll to bottom';
    scrollBtn.style.display = 'none';
    container.appendChild(scrollBtn);

    scrollBtn.addEventListener('click', function () {
      terminal.scrollToBottom();
      scrollBtn.style.display = 'none';
    });

    // Show/hide based on scroll position
    terminal.onScroll(function () {
      var buf = terminal.buffer.active;
      var atBottom = buf.viewportY >= buf.baseY;
      scrollBtn.style.display = atBottom ? 'none' : 'block';
    });

    // Track focus — update diff panel when terminal receives focus
    terminal.textarea.addEventListener('focus', function () {
      if (focusedTaskId !== id) {
        focusedTaskId = id;
        var t = tasks.get(id);
        if (t && DiffPanel.isVisible()) {
          DiffPanel.updateWorktree(t.worktreePath);
          PRPanel.setWorktree(t.worktreePath);
        }
      }
    });

    // Custom key handling
    terminal.attachCustomKeyEventHandler(function (e) {
      if (e.type !== 'keydown') return true;
      var meta = e.metaKey;

      if (e.key === 'Enter' && e.shiftKey) {
        window.klaus.writeTerminal(id, '\n');
        return false;
      }
      if (meta && e.key === 'c') {
        var sel = terminal.getSelection();
        if (sel) { navigator.clipboard.writeText(sel); return false; }
        return true;
      }
      if (meta && e.key === 'v') {
        navigator.clipboard.readText().then(function (text) {
          if (text) window.klaus.writeTerminal(id, text);
        });
        return false;
      }
      if (meta && e.key === 'f') {
        openSearch(id);
        return false;
      }
      if (meta && e.key === 'k') {
        terminal.clear();
        return false;
      }
      if (meta && (e.key === '=' || e.key === '+')) {
        zoomIn();
        return false;
      }
      if (meta && e.key === '-') {
        zoomOut();
        return false;
      }
      if (meta && e.key === '0') {
        zoomReset();
        return false;
      }
      return true;
    });

    // File drag-and-drop
    container.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.stopPropagation();
      container.classList.add('drag-over');
    });

    container.addEventListener('dragleave', function (e) {
      e.preventDefault();
      container.classList.remove('drag-over');
    });

    container.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      container.classList.remove('drag-over');
      var files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        var paths = files.map(function (f) {
          var p = f.path;
          return p.includes(' ') ? '"' + p + '"' : p;
        }).join(' ');
        window.klaus.writeTerminal(id, paths);
      }
    });

    // Wire up I/O
    var cleanup = [];

    var removeDataListener = window.klaus.onTerminalData(id, function (data) {
      terminal.write(data);
      if (activeTaskId !== id) {
        showUnreadBadge(id);
      }
    });
    cleanup.push(removeDataListener);

    var removeExitListener = window.klaus.onTerminalExit(id, function () {
      var t = tasks.get(id);
      if (!t) return;
      t.alive = false;
      updateSidebarItem(id);
    });
    cleanup.push(removeExitListener);

    terminal.onData(function (data) {
      window.klaus.writeTerminal(id, data);
    });

    // Right-click context menu
    container.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, id);
    });

    var taskEntry = {
      id: id, name: name, worktreePath: worktreePath, branch: branch,
      mode: task.mode || 'claude',
      terminal: terminal, fitAddon: fitAddon, searchAddon: searchAddon,
      container: container, cleanup: cleanup,
      alive: task.alive !== false,
    };
    tasks.set(id, taskEntry);

    renderSidebarItem(taskEntry);
    emptyState.style.display = 'none';
    switchToTask(id);
  }

  function renderSidebarItem(task) {
    var item = document.createElement('div');
    item.className = 'task-item';
    item.dataset.id = task.id;

    var modeLabel = task.mode === 'shell' ? 'sh' : 'cc';
    item.innerHTML =
      '<span class="status-dot ' + (task.alive ? 'alive' : 'exited') + '"></span>' +
      '<span class="task-mode" title="' + (task.mode === 'shell' ? 'Shell' : 'Claude Code') + '">' + modeLabel + '</span>' +
      '<span class="task-name" title="' + escHtml(task.worktreePath) + '">' + escHtml(task.name) + '</span>' +
      '<span class="unread-badge"></span>' +
      '<button class="task-close" title="Remove">&times;</button>';

    item.addEventListener('click', function (e) {
      if (e.target.classList.contains('task-close')) return;
      switchToTask(task.id);
    });

    item.querySelector('.task-close').addEventListener('click', async function (e) {
      e.stopPropagation();
      // Save worktree info before removing
      var wt = {
        path: task.worktreePath,
        name: task.name,
        branch: task.branch || '',
      };
      await window.klaus.killTask(task.id);
      removeTaskFromUI(task.id);
      // Add back as an available worktree item
      addWorktreeToSidebar(wt);
    });

    taskList.appendChild(item);
  }

  function updateSidebarItem(id) {
    var task = tasks.get(id);
    if (!task) return;
    var item = taskList.querySelector('.task-item[data-id="' + id + '"]');
    if (item) {
      var dot = item.querySelector('.status-dot');
      dot.className = 'status-dot ' + (task.alive ? 'alive' : 'exited');
    }
    var gridDot = task.container.querySelector('.grid-dot');
    if (gridDot) {
      gridDot.className = 'grid-dot ' + (task.alive ? 'alive' : 'exited');
    }
  }

  function rewireTerminal(id) {
    var task = tasks.get(id);
    if (!task) return;

    // Remove ALL old IPC listeners to prevent duplicates
    if (task.cleanup) {
      task.cleanup.forEach(function (fn) { fn(); });
    }
    task.cleanup = [];

    var removeDataListener = window.klaus.onTerminalData(id, function (data) {
      task.terminal.write(data);
      if (activeTaskId !== id) {
        showUnreadBadge(id);
      }
    });
    task.cleanup.push(removeDataListener);

    var removeExitListener = window.klaus.onTerminalExit(id, function () {
      var t = tasks.get(id);
      if (!t) return;
      t.alive = false;
      updateSidebarItem(id);
    });
    task.cleanup.push(removeExitListener);
  }

  function updateSidebarMode(id, mode) {
    var item = taskList.querySelector('.task-item[data-id="' + id + '"]');
    if (!item) return;
    var modeEl = item.querySelector('.task-mode');
    if (modeEl) {
      modeEl.textContent = mode === 'shell' ? 'sh' : 'cc';
      modeEl.title = mode === 'shell' ? 'Shell' : 'Claude Code';
    }
  }

  function showResumeButton(id, task) {
    var item = taskList.querySelector('.task-item[data-id="' + id + '"]');
    if (!item) return;
    // Remove existing resume button if any
    var existing = item.querySelector('.sidebar-resume-btn');
    if (existing) existing.remove();

    var btn = document.createElement('button');
    btn.className = 'sidebar-resume-btn';
    btn.textContent = 'Resume';
    btn.title = 'Resume Claude session';

    // Insert before the close button
    var closeBtn = item.querySelector('.task-close');
    if (closeBtn) {
      item.insertBefore(btn, closeBtn);
    } else {
      item.appendChild(btn);
    }

    btn.addEventListener('click', async function (e) {
      e.stopPropagation();
      // Type the resume command into the existing shell
      var sessionId = await window.klaus.getLatestSession(task.worktreePath);
      var cmd = sessionId ? 'claude --resume ' + sessionId : 'claude';
      window.klaus.writeTerminal(id, cmd + '\n');
      task.mode = 'claude';
      updateSidebarMode(id, 'claude');
      btn.remove();
    });
  }

  function removeTaskFromUI(id) {
    var task = tasks.get(id);
    if (!task) return;

    task.cleanup.forEach(function (fn) { fn(); });
    task.terminal.dispose();
    task.container.remove();

    var item = taskList.querySelector('.task-item[data-id="' + id + '"]');
    if (item) item.remove();

    tasks.delete(id);

    if (activeTaskId === id) {
      activeTaskId = null;
      var remaining = Array.from(tasks.keys());
      if (remaining.length > 0) {
        switchToTask(remaining[0]);
      } else {
        emptyState.style.display = 'flex';
      }
    }
  }

  function switchToTask(id) {
    activeTaskId = id;
    focusedTaskId = id;

    hideUnreadBadge(id);

    taskList.querySelectorAll('.task-item').forEach(function (el) {
      el.classList.toggle('active', Number(el.dataset.id) === id);
    });

    terminalsEl.querySelectorAll('.terminal-container').forEach(function (el) {
      el.classList.toggle('active', Number(el.dataset.id) === id);
    });

    var task = tasks.get(id);
    if (task) {
      setTimeout(function () {
        task.fitAddon.fit();
        window.klaus.resizeTerminal(id, task.terminal.cols, task.terminal.rows);
        task.terminal.focus();
      }, 50);

      // Update diff panel if visible
      if (DiffPanel.isVisible()) {
        DiffPanel.updateWorktree(task.worktreePath);
        PRPanel.setWorktree(task.worktreePath);
      }
    }
  }

  // ---- Layout cycling ----
  function currentLayout() {
    return layouts[layoutIndex];
  }

  function applyLayout() {
    var layout = currentLayout();
    terminalsEl.classList.remove('columns-view', 'grid-view');
    btnLayout.classList.toggle('active', layout !== 'single');
    btnLayout.textContent = layoutIcons[layout];
    btnLayout.title = 'Layout: ' + layout + ' (click to cycle)';

    if (layout === 'single') {
      if (activeTaskId != null) {
        switchToTask(activeTaskId);
      }
    } else {
      terminalsEl.classList.add(layout === 'columns' ? 'columns-view' : 'grid-view');
      terminalsEl.querySelectorAll('.terminal-container').forEach(function (el) {
        el.classList.remove('active');
      });
      fitAllTerminals();
    }
  }

  function cycleLayout() {
    layoutIndex = (layoutIndex + 1) % layouts.length;
    applyLayout();
  }

  function fitAllTerminals() {
    setTimeout(function () {
      tasks.forEach(function (task, id) {
        task.fitAddon.fit();
        window.klaus.resizeTerminal(id, task.terminal.cols, task.terminal.rows);
      });
    }, 50);
  }

  btnLayout.addEventListener('click', cycleLayout);

  // ---- Font zoom ----
  var MIN_FONT = 8;
  var MAX_FONT = 28;

  function setFontSize(size) {
    currentFontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, size));
    tasks.forEach(function (task, id) {
      task.terminal.options.fontSize = currentFontSize;
      task.fitAddon.fit();
      window.klaus.resizeTerminal(id, task.terminal.cols, task.terminal.rows);
    });
  }

  function zoomIn() { setFontSize(currentFontSize + 1); }
  function zoomOut() { setFontSize(currentFontSize - 1); }
  function zoomReset() { setFontSize(13); }

  // ---- Search (Cmd+F) ----
  var searchBar = document.getElementById('search-bar');
  var searchInput = document.getElementById('search-input');
  var searchCount = document.getElementById('search-count');
  var searchPrev = document.getElementById('search-prev');
  var searchNext = document.getElementById('search-next');
  var searchCloseBtn = document.getElementById('search-close');
  var searchTaskId = null;

  function openSearch(id) {
    searchTaskId = id;
    searchBar.style.display = 'flex';
    searchInput.value = '';
    searchCount.textContent = '';
    setTimeout(function () { searchInput.focus(); }, 50);
  }

  function closeSearch() {
    searchBar.style.display = 'none';
    searchInput.value = '';
    searchCount.textContent = '';
    if (searchTaskId != null) {
      var task = tasks.get(searchTaskId);
      if (task) task.terminal.focus();
    }
    searchTaskId = null;
  }

  function doSearch(direction) {
    if (searchTaskId == null) return;
    var task = tasks.get(searchTaskId);
    if (!task) return;
    var term = searchInput.value;
    if (!term) return;
    if (direction === 'prev') {
      task.searchAddon.findPrevious(term);
    } else {
      task.searchAddon.findNext(term);
    }
  }

  searchInput.addEventListener('input', function () { doSearch('next'); });
  searchNext.addEventListener('click', function () { doSearch('next'); });
  searchPrev.addEventListener('click', function () { doSearch('prev'); });
  searchCloseBtn.addEventListener('click', closeSearch);
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSearch();
    if (e.key === 'Enter' && e.shiftKey) { doSearch('prev'); e.preventDefault(); }
    else if (e.key === 'Enter') { doSearch('next'); e.preventDefault(); }
  });

  // ---- Unread badge ----
  function showUnreadBadge(id) {
    var item = taskList.querySelector('.task-item[data-id="' + id + '"]');
    if (!item) return;
    var badge = item.querySelector('.unread-badge');
    if (badge) badge.classList.add('visible');
  }

  function hideUnreadBadge(id) {
    var item = taskList.querySelector('.task-item[data-id="' + id + '"]');
    if (!item) return;
    var badge = item.querySelector('.unread-badge');
    if (badge) badge.classList.remove('visible');
  }

  // ---- Right-click context menu ----
  var contextMenu = null;

  function removeContextMenu() {
    if (contextMenu) {
      contextMenu.remove();
      contextMenu = null;
    }
  }

  document.addEventListener('click', removeContextMenu);
  document.addEventListener('contextmenu', removeContextMenu);

  function showContextMenu(x, y, id) {
    removeContextMenu();
    var task = tasks.get(id);
    if (!task) return;

    var menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

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
      // Phase 1: Open diff panel for this task
      { label: 'Show Changes', shortcut: '', action: function () {
        DiffPanel.show(task.worktreePath);
        PRPanel.setWorktree(task.worktreePath);
        btnDiff.classList.add('active');
      }},
      // Phase 4: Pop out to separate window
      { label: 'Pop Out', shortcut: '', action: async function () {
        await window.klaus.popOutTask(id);
      }},
      // Phase 7: View files in worktree
      { label: 'View File...', shortcut: '', action: function () {
        var filePath = prompt('File path (relative to worktree):');
        if (filePath) {
          var full = task.worktreePath + '/' + filePath;
          window.openFileViewer(full, filePath);
        }
      }},
    ];

    // Restart if exited
    if (!task.alive) {
      items.push({ sep: true });
      items.push({ label: 'Restart Claude', shortcut: '', action: async function () {
        var sessionId = await window.klaus.getLatestSession(task.worktreePath);
        var cmd = sessionId ? 'claude --resume ' + sessionId : 'claude';
        window.klaus.writeTerminal(id, cmd + '\n');
        task.mode = 'claude';
        updateSidebarMode(id, 'claude');
        var resumeBtn = taskList.querySelector('.task-item[data-id="' + id + '"] .sidebar-resume-btn');
        if (resumeBtn) resumeBtn.remove();
      }});
    }

    items.forEach(function (entry) {
      if (entry.sep) {
        var sep = document.createElement('div');
        sep.className = 'context-menu-sep';
        menu.appendChild(sep);
        return;
      }
      var item = document.createElement('div');
      item.className = 'context-menu-item';
      item.innerHTML = entry.label + '<span class="shortcut">' + entry.shortcut + '</span>';
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        removeContextMenu();
        entry.action();
      });
      menu.appendChild(item);
    });

    document.body.appendChild(menu);
    contextMenu = menu;

    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';
  }

  // Handle window resize
  window.addEventListener('resize', function () {
    if (currentLayout() !== 'single') {
      fitAllTerminals();
    } else if (activeTaskId != null) {
      var task = tasks.get(activeTaskId);
      if (task) {
        task.fitAddon.fit();
        window.klaus.resizeTerminal(activeTaskId, task.terminal.cols, task.terminal.rows);
      }
    }
  });

  // Keyboard shortcut: Cmd+G to toggle diff panel
  document.addEventListener('keydown', function (e) {
    if (e.metaKey && e.key === 'g') {
      e.preventDefault();
      btnDiff.click();
    }
  });
})();
