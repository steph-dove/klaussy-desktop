window.TerminalManager = (function () {
  var escHtml = AppUtils.escHtml;
  var tasks = AppState.tasks;
  var terminalsEl = document.getElementById('terminals');
  var emptyState = document.getElementById('empty-state');
  var btnLayout = document.getElementById('btn-layout');
  var taskList = document.getElementById('task-list');
  var layouts = ['single', 'columns', 'grid'];
  var layoutIcons = { single: '\u25A8', columns: '\u2759\u2759', grid: '\u2637' };

  // ---- addTaskToUI ----

  function addTaskToUI(task) {
    var id = task.id;
    var name = task.name;
    var worktreePath = task.worktreePath;
    var branch = task.branch;

    var Terminal = window.Terminal;
    var FitAddon = window.FitAddon;
    var termTheme = ThemeManager.getTerminalTheme();

    var terminal = new Terminal({
      cursorBlink: true,
      fontSize: AppState.currentFontSize,
      fontFamily: AppState.savedPrefs.fontFamily || "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      lineHeight: AppState.savedPrefs.lineHeight || 1.2,
      cursorStyle: AppState.savedPrefs.cursorStyle || 'block',
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

    var container = document.createElement('div');
    container.className = 'terminal-container';
    container.dataset.id = id;

    var label = document.createElement('div');
    label.className = 'grid-label';
    label.innerHTML = '<span class="grid-dot ' + (task.alive !== false ? 'alive' : 'exited') + '"></span>' + escHtml(name);

    label.addEventListener('click', function () {
      if (currentLayout() === 'single') {
        switchToTask(id);
      } else {
        AppState.focusedTaskId = id;
        AppState.activeTaskId = id;
        var t = tasks.get(id);
        if (t && DiffPanel.isVisible()) {
          DiffPanel.updateWorktree(t.worktreePath);
          PRPanel.setWorktree(t.worktreePath);
        }
      }
    });

    // Grid drag-and-drop reordering
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
    terminal.onScroll(function () {
      var buf = terminal.buffer.active;
      var atBottom = buf.viewportY >= buf.baseY;
      scrollBtn.style.display = atBottom ? 'none' : 'block';
    });

    // Track focus
    terminal.textarea.addEventListener('focus', function () {
      if (AppState.focusedTaskId !== id) {
        AppState.focusedTaskId = id;
        AppState.activeTaskId = id;
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
        window.klaus.writeTerminal(id, '\x1b[13;2u');
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
      if (meta && e.key === 'f') { SearchBar.open(id); return false; }
      if (meta && e.key === 'k') { terminal.clear(); return false; }
      if (meta && (e.key === '=' || e.key === '+')) { zoomIn(); return false; }
      if (meta && e.key === '-') { zoomOut(); return false; }
      if (meta && e.key === '0') { zoomReset(); return false; }
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
      if (AppState.activeTaskId !== id) {
        Sidebar.showUnreadBadge(id);
      }
    });
    cleanup.push(removeDataListener);

    var removeExitListener = window.klaus.onTerminalExit(id, function () {
      var t = tasks.get(id);
      if (!t) return;
      t.alive = false;
      Sidebar.updateItem(id);
    });
    cleanup.push(removeExitListener);

    terminal.onData(function (data) {
      window.klaus.writeTerminal(id, data);
    });

    // Right-click context menu
    container.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      window._showContextMenu(e.clientX, e.clientY, id);
    }, true);

    var taskEntry = {
      id: id, name: name, worktreePath: worktreePath, branch: branch,
      mode: task.mode || 'claude',
      terminal: terminal, fitAddon: fitAddon, searchAddon: searchAddon,
      container: container, cleanup: cleanup,
      alive: task.alive !== false,
      notifyEnabled: true,
      subTerminals: [], activeSubId: null,
    };
    tasks.set(id, taskEntry);

    // Sub-terminal tab bar
    var subTabBar = document.createElement('div');
    subTabBar.className = 'sub-terminal-tabs';
    subTabBar.innerHTML =
      '<button class="sub-tab active" data-sub-id="0">Primary</button>' +
      '<button class="sub-tab-add" title="Add shell tab">+</button>';
    container.insertBefore(subTabBar, label.nextSibling);

    subTabBar.addEventListener('click', function (e) {
      e.stopPropagation();
      AppState.focusedTaskId = id;
      AppState.activeTaskId = id;
      var t = tasks.get(id);
      if (t && DiffPanel.isVisible()) {
        DiffPanel.updateWorktree(t.worktreePath);
        DiffPanel.refresh();
        PRPanel.setWorktree(t.worktreePath);
      }
    });

    subTabBar.querySelector('.sub-tab[data-sub-id="0"]').addEventListener('click', function () {
      switchSubTerminal(taskEntry, null);
    });

    subTabBar.querySelector('.sub-tab-add').addEventListener('click', async function () {
      var result = await window.klaus.addSubTerminal(id, 'Shell');
      if (result.error) return;
      addSubTerminalTab(taskEntry, result.subId, result.label);
    });

    window.klaus.getNotifyEnabled(id).then(function (val) {
      taskEntry.notifyEnabled = val;
    });

    Sidebar.renderItem(taskEntry);
    emptyState.style.display = 'none';
    switchToTask(id);
  }

  // ---- Sub-terminal Management ----

  function addSubTerminalTab(taskEntry, subId, label) {
    var id = taskEntry.id;
    var container = taskEntry.container;
    var subTabBar = container.querySelector('.sub-terminal-tabs');
    var addBtn = subTabBar.querySelector('.sub-tab-add');

    var tab = document.createElement('button');
    tab.className = 'sub-tab';
    tab.dataset.subId = subId;
    tab.innerHTML = escHtml(label) + ' <span class="sub-tab-close">&times;</span>';
    subTabBar.insertBefore(tab, addBtn);

    var Terminal = window.Terminal;
    var FitAddon = window.FitAddon;
    var termTheme = ThemeManager.getTerminalTheme();

    var subTerminal = new Terminal({
      cursorBlink: true,
      fontSize: AppState.currentFontSize,
      fontFamily: AppState.savedPrefs.fontFamily || "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      lineHeight: AppState.savedPrefs.lineHeight || 1.2,
      cursorStyle: AppState.savedPrefs.cursorStyle || 'block',
      scrollback: 10000,
      theme: termTheme,
      allowProposedApi: true,
    });

    var subFitAddon = new FitAddon.FitAddon();
    subTerminal.loadAddon(subFitAddon);

    var subWrapper = document.createElement('div');
    subWrapper.className = 'sub-terminal-wrapper';
    subWrapper.dataset.subId = subId;
    subWrapper.style.display = 'none';
    container.appendChild(subWrapper);
    subTerminal.open(subWrapper);

    var subCleanup = [];
    var removeData = window.klaus.onSubTerminalData(id, subId, function (data) {
      subTerminal.write(data);
    });
    subCleanup.push(removeData);

    var removeExit = window.klaus.onSubTerminalExit(id, subId, function () {
      var sub = taskEntry.subTerminals.find(function (s) { return s.subId === subId; });
      if (sub) sub.alive = false;
    });
    subCleanup.push(removeExit);

    subTerminal.onData(function (data) {
      window.klaus.writeTerminal(id, data, subId);
    });

    subTerminal.attachCustomKeyEventHandler(function (e) {
      if (e.type !== 'keydown') return true;
      var meta = e.metaKey;
      if (e.key === 'Enter' && e.shiftKey) {
        window.klaus.writeTerminal(id, '\x1b[13;2u', subId);
        return false;
      }
      if (meta && e.key === 'c') {
        var sel = subTerminal.getSelection();
        if (sel) { navigator.clipboard.writeText(sel); return false; }
        return true;
      }
      if (meta && e.key === 'v') {
        navigator.clipboard.readText().then(function (text) {
          if (text) window.klaus.writeTerminal(id, text, subId);
        });
        return false;
      }
      if (meta && e.key === 'k') { subTerminal.clear(); return false; }
      return true;
    });

    var subEntry = {
      subId: subId, label: label, terminal: subTerminal, fitAddon: subFitAddon,
      wrapper: subWrapper, tab: tab, cleanup: subCleanup, alive: true,
    };
    taskEntry.subTerminals.push(subEntry);

    tab.addEventListener('click', function (e) {
      if (e.target.classList.contains('sub-tab-close')) return;
      switchSubTerminal(taskEntry, subId);
    });

    tab.querySelector('.sub-tab-close').addEventListener('click', async function (e) {
      e.stopPropagation();
      await window.klaus.killSubTerminal(id, subId);
      subCleanup.forEach(function (fn) { fn(); });
      subTerminal.dispose();
      subWrapper.remove();
      tab.remove();
      var idx = taskEntry.subTerminals.indexOf(subEntry);
      if (idx !== -1) taskEntry.subTerminals.splice(idx, 1);
      if (taskEntry.activeSubId === subId) {
        switchSubTerminal(taskEntry, null);
      }
    });

    switchSubTerminal(taskEntry, subId);
  }

  function switchSubTerminal(taskEntry, subId) {
    var container = taskEntry.container;
    taskEntry.activeSubId = subId;

    var xtermEls = container.querySelectorAll(':scope > .xterm');
    xtermEls.forEach(function (el) {
      el.style.display = subId === null || subId === undefined ? '' : 'none';
    });

    container.querySelectorAll('.sub-terminal-wrapper').forEach(function (w) {
      w.style.display = parseInt(w.dataset.subId, 10) === subId ? '' : 'none';
    });

    container.querySelectorAll('.sub-tab').forEach(function (t) {
      var tabSubId = t.dataset.subId === '0' ? null : parseInt(t.dataset.subId, 10);
      var isActive = (subId === null || subId === undefined) ? t.dataset.subId === '0' : tabSubId === subId;
      t.classList.toggle('active', isActive);
    });

    setTimeout(function () {
      if (subId === null || subId === undefined) {
        taskEntry.fitAddon.fit();
        taskEntry.terminal.focus();
        window.klaus.resizeTerminal(taskEntry.id, taskEntry.terminal.cols, taskEntry.terminal.rows);
      } else {
        var sub = taskEntry.subTerminals.find(function (s) { return s.subId === subId; });
        if (sub) {
          sub.fitAddon.fit();
          sub.terminal.focus();
          window.klaus.resizeTerminal(taskEntry.id, sub.terminal.cols, sub.terminal.rows, subId);
        }
      }
    }, 50);
  }

  // ---- rewireTerminal ----

  function rewireTerminal(id) {
    var task = tasks.get(id);
    if (!task) return;
    if (task.cleanup) {
      task.cleanup.forEach(function (fn) { fn(); });
    }
    task.cleanup = [];
    var removeDataListener = window.klaus.onTerminalData(id, function (data) {
      task.terminal.write(data);
      if (AppState.activeTaskId !== id) {
        Sidebar.showUnreadBadge(id);
      }
    });
    task.cleanup.push(removeDataListener);
    var removeExitListener = window.klaus.onTerminalExit(id, function () {
      var t = tasks.get(id);
      if (!t) return;
      t.alive = false;
      Sidebar.updateItem(id);
    });
    task.cleanup.push(removeExitListener);
  }

  // ---- removeTaskFromUI ----

  function removeTaskFromUI(id) {
    var task = tasks.get(id);
    if (!task) return;
    task.cleanup.forEach(function (fn) { fn(); });
    task.terminal.dispose();
    task.container.remove();
    var item = taskList.querySelector('.task-item[data-id="' + id + '"]');
    if (item) item.remove();
    tasks.delete(id);
    if (AppState.activeTaskId === id) {
      AppState.activeTaskId = null;
      var remaining = Array.from(tasks.keys());
      if (remaining.length > 0) {
        switchToTask(remaining[0]);
      } else {
        emptyState.style.display = 'flex';
      }
    }
  }

  // ---- switchToTask ----

  function switchToTask(id) {
    AppState.activeTaskId = id;
    AppState.focusedTaskId = id;
    Sidebar.hideUnreadBadge(id);

    taskList.querySelectorAll('.task-item').forEach(function (el) {
      el.classList.toggle('active', Number(el.dataset.id) === id);
    });

    terminalsEl.querySelectorAll('.terminal-container').forEach(function (el) {
      el.classList.toggle('active', Number(el.dataset.id) === id);
    });

    var task = tasks.get(id);
    if (task) {
      setTimeout(function () {
        if (task.activeSubId !== null && task.activeSubId !== undefined) {
          var sub = task.subTerminals.find(function (s) { return s.subId === task.activeSubId; });
          if (sub) {
            sub.fitAddon.fit();
            sub.terminal.focus();
            window.klaus.resizeTerminal(id, sub.terminal.cols, sub.terminal.rows, task.activeSubId);
          }
        } else {
          task.fitAddon.fit();
          task.terminal.scrollToBottom();
          window.klaus.resizeTerminal(id, task.terminal.cols, task.terminal.rows);
          task.terminal.focus();
        }
      }, 50);

      if (DiffPanel.isVisible()) {
        DiffPanel.updateWorktree(task.worktreePath);
        PRPanel.setWorktree(task.worktreePath);
      }
    }
  }

  // ---- Layout cycling ----

  function currentLayout() {
    return layouts[AppState.layoutIndex];
  }

  function applyLayout() {
    var layout = currentLayout();
    terminalsEl.classList.remove('columns-view', 'grid-view');
    btnLayout.classList.toggle('active', layout !== 'single');
    btnLayout.textContent = layoutIcons[layout];
    btnLayout.title = 'Layout: ' + layout + ' (click to cycle)';

    if (layout === 'single') {
      if (AppState.activeTaskId != null) {
        switchToTask(AppState.activeTaskId);
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
    AppState.layoutIndex = (AppState.layoutIndex + 1) % layouts.length;
    applyLayout();
  }

  function fitAllTerminals() {
    setTimeout(function () {
      tasks.forEach(function (task, id) {
        if (task.activeSubId !== null && task.activeSubId !== undefined) {
          var sub = task.subTerminals.find(function (s) { return s.subId === task.activeSubId; });
          if (sub) {
            sub.fitAddon.fit();
            window.klaus.resizeTerminal(id, sub.terminal.cols, sub.terminal.rows, task.activeSubId);
          }
        } else {
          task.fitAddon.fit();
          task.terminal.scrollToBottom();
          window.klaus.resizeTerminal(id, task.terminal.cols, task.terminal.rows);
        }
      });
    }, 50);
  }

  btnLayout.addEventListener('click', cycleLayout);

  // ---- Font zoom ----
  var MIN_FONT = 8;
  var MAX_FONT = 28;

  function setFontSize(size) {
    AppState.currentFontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, size));
    tasks.forEach(function (task, id) {
      task.terminal.options.fontSize = AppState.currentFontSize;
      task.fitAddon.fit();
      task.terminal.scrollToBottom();
      window.klaus.resizeTerminal(id, task.terminal.cols, task.terminal.rows);
    });
  }

  function zoomIn() { setFontSize(AppState.currentFontSize + 1); }
  function zoomOut() { setFontSize(AppState.currentFontSize - 1); }
  function zoomReset() { setFontSize(13); }

  // ---- Window resize ----
  window.addEventListener('resize', function () {
    if (currentLayout() !== 'single') {
      fitAllTerminals();
    } else if (AppState.activeTaskId != null) {
      var task = tasks.get(AppState.activeTaskId);
      if (task) {
        task.fitAddon.fit();
        window.klaus.resizeTerminal(AppState.activeTaskId, task.terminal.cols, task.terminal.rows);
      }
    }
  });

  return {
    addTaskToUI: addTaskToUI,
    removeTaskFromUI: removeTaskFromUI,
    switchToTask: switchToTask,
    rewireTerminal: rewireTerminal,
    cycleLayout: cycleLayout,
    applyLayout: applyLayout,
    currentLayout: currentLayout,
    fitAllTerminals: fitAllTerminals,
    zoomIn: zoomIn,
    zoomOut: zoomOut,
    zoomReset: zoomReset,
  };
})();
