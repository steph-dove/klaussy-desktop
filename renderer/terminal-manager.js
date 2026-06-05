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
      window.klaus.gh.openExternal(uri);
    });
    terminal.loadAddon(webLinksAddon);

    var container = document.createElement('div');
    container.className = 'terminal-container';
    container.dataset.id = id;
    if (!branch) container.classList.add('branchless');

    var label = document.createElement('div');
    label.className = 'grid-label';

    // The name span carries the drag/click behaviors; the actions span holds
    // the dropdown. Splitting them avoids the dropdown trigger accidentally
    // starting a drag or switching tasks as a side-effect of clicking.
    var nameSpan = document.createElement('span');
    nameSpan.className = 'grid-label-name';
    nameSpan.innerHTML = '<span class="grid-dot ' + (task.alive !== false ? 'alive' : 'exited') + '"></span>' + escHtml(name);

    var actionsSpan = document.createElement('span');
    actionsSpan.className = 'grid-label-actions';

    label.appendChild(nameSpan);
    label.appendChild(actionsSpan);

    // Branchless (Open Folder) tasks get a persistent warning banner inside
    // their own terminal container so it only covers that pane — never the
    // neighboring worktree terminals in grid/columns view.
    if (!branch) {
      var warning = document.createElement('div');
      warning.className = 'terminal-warning';
      warning.innerHTML =
        '<span class="terminal-warning-icon" aria-hidden="true">&#9888;</span>' +
        '<span class="terminal-warning-text">Not in a git worktree — ' +
          '<a href="#" class="terminal-warning-link">Open as worktree</a>' +
          ' to enable diff &amp; PR features.' +
        '</span>';
      warning.querySelector('.terminal-warning-link').addEventListener('click', function (e) {
        e.preventDefault();
        // Reuse the sidebar + button's existing modal — the "New Worktree"
        // and "Existing Worktree" tabs cover both the "promote this folder"
        // and "attach a sibling" cases.
        var btn = document.getElementById('btn-new-task');
        if (btn) btn.click();
      });
      container.appendChild(warning);
    }

    nameSpan.addEventListener('click', function () {
      if (currentLayout() === 'single') {
        switchToTask(id);
      } else {
        AppState.focusedTaskId = id;
        AppState.activeTaskId = id;
        Events.emit('task:switched', { task: tasks.get(id) || null });
      }
    });

    // Grid drag-and-drop reordering
    nameSpan.draggable = true;
    nameSpan.addEventListener('dragstart', function (e) {
      if (currentLayout() === 'single') { e.preventDefault(); return; }
      container.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id.toString());
    });
    nameSpan.addEventListener('dragend', function () {
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

    // Worktree-header actions dropdown. Opens a small menu with Plan/Debug/
    // Review — each dispatches to a helper that spawns a new Claude sub-tab
    // on this task's worktree and kicks off the appropriate command.
    buildActionsDropdown(actionsSpan, id);

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
        Events.emit('task:switched', { task: tasks.get(id) || null });
      }
    });

    // Custom key handling
    terminal.attachCustomKeyEventHandler(function (e) {
      if (e.type !== 'keydown') return true;
      var meta = e.metaKey;
      if (e.key === 'Enter' && e.shiftKey) {
        // Known limitation: Claude Code's Ink input layer inside our
        // xterm.js PTY doesn't reliably distinguish Shift+Enter from Enter.
        // None of `\r`, `\n`, `\x1b\r` (Meta+Enter), `\x1b[13;2u` (CSI-u
        // Shift+Enter), or bracketed-paste `\x1b[200~\n\x1b[201~` caused a
        // newline insertion in testing — all submitted. The only thing that
        // reliably triggers Claude's multi-line mode is the backslash-
        // escape (`\<Enter>`), which works on an empty prompt and leaves
        // a trailing `\` on non-empty prompts. We ship that as the best
        // partial behavior — users can always type `\<Enter>` manually.
        window.klaus.terminal.write(id, '\\\r');
        return false;
      }
      if (meta && e.key === 'c') {
        var sel = terminal.getSelection();
        if (sel) { navigator.clipboard.writeText(sel); return false; }
        return true;
      }
      if (meta && e.key === 'v') {
        // preventDefault is critical — returning false from xterm's custom
        // key handler only stops xterm from processing the keystroke, but
        // the browser's native paste event still fires on xterm's helper
        // textarea and xterm pastes a second time. Preventing the default
        // kills that second path.
        e.preventDefault();
        navigator.clipboard.readText().then(function (text) {
          if (text) window.klaus.terminal.write(id, text);
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
      if (files.length === 0) return;
      // getPathForFile returns '' (or can throw) for files with no backing OS
      // path — drop those rather than writing a blank/half-formed argument.
      var paths = files.map(function (f) {
        var p = '';
        try { p = window.klaus.fs.getPathForFile(f) || ''; } catch (_err) { p = ''; }
        return /\s/.test(p) ? '"' + p + '"' : p;
      }).filter(Boolean).join(' ');
      if (!paths) return;
      // Route to whichever shell tab is active for this task, not always the
      // primary. Sub-terminal wrappers have no drop handler of their own, so
      // the drop bubbles up to `container` and fires here; without the
      // activeSubId the path lands in the primary (Claude) terminal even when
      // the user is typing in a Shell sub-tab. Fall back to the primary if the
      // active sub isn't live — the main handler silently discards writes to a
      // dead/missing sub, so we must not route there.
      var entry = tasks.get(id);
      var activeSubId = entry ? entry.activeSubId : null;
      if (activeSubId != null && entry) {
        var sub = entry.subTerminals.find(function (s) { return s.subId === activeSubId; });
        if (!sub || !sub.alive) activeSubId = null;
      }
      window.klaus.terminal.write(id, paths, activeSubId);
    });

    // Wire up I/O
    var cleanup = [];
    var removeDataListener = window.klaus.terminal.onData(id, function (data) {
      terminal.write(data);
      if (AppState.activeTaskId !== id) {
        Sidebar.showUnreadBadge(id);
      }
    });
    cleanup.push(removeDataListener);

    var removeExitListener = window.klaus.terminal.onExit(id, function () {
      var t = tasks.get(id);
      if (!t) return;
      t.alive = false;
      Sidebar.updateItem(id);
    });
    cleanup.push(removeExitListener);

    terminal.onData(function (data) {
      window.klaus.terminal.write(id, data);
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
      '<span class="sub-tab-add-wrap"><button class="sub-tab-add" title="Add a tab (pick an agent or shell)">+</button></span>';
    container.insertBefore(subTabBar, label.nextSibling);

    subTabBar.addEventListener('click', function (e) {
      e.stopPropagation();
      // Only emit when the task actually changed (e.g., user clicked a
      // sub-tab on a different task in grid layout). Re-emitting on every
      // tap of an already-active task's tab bar caused subscribers like
      // closeFileViewerOnTaskSwitch and DiffPanel.refresh to wipe the
      // file viewer / refetch git state for no reason.
      var changed = AppState.activeTaskId !== id;
      AppState.focusedTaskId = id;
      AppState.activeTaskId = id;
      if (changed) {
        Events.emit('task:switched', { task: tasks.get(id) || null, refreshDiff: true });
      }
    });

    subTabBar.querySelector('.sub-tab[data-sub-id="0"]').addEventListener('click', function () {
      switchSubTerminal(taskEntry, null);
    });

    // The "+" opens a small picker so the user can start a new tab on this
    // worktree with any AI agent (or a plain shell) — e.g. run the same task
    // in Codex alongside the Claude primary tab.
    var addBtn = subTabBar.querySelector('.sub-tab-add');
    var addWrap = subTabBar.querySelector('.sub-tab-add-wrap');
    var addMenu = document.createElement('div');
    addMenu.className = 'actions-dropdown-menu sub-tab-add-menu';
    addMenu.style.display = 'none';
    var agentItems = ((window.klaus.ui && window.klaus.ui.providers) || []).map(function (p) {
      return '<button class="actions-dropdown-item" data-mode="' + p.id + '">' + escHtml(p.displayName) + '</button>';
    }).join('');
    addMenu.innerHTML = agentItems
      + '<div class="actions-dropdown-divider"></div>'
      + '<button class="actions-dropdown-item" data-mode="shell">Shell</button>';
    addWrap.appendChild(addMenu);

    addBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = addMenu.style.display !== 'none';
      if (openMenuEl && openMenuEl !== addMenu) openMenuEl.style.display = 'none';
      addMenu.style.display = isOpen ? 'none' : 'flex';
      openMenuEl = isOpen ? null : addMenu;
    });

    addMenu.addEventListener('click', async function (e) {
      e.stopPropagation();
      var item = e.target.closest('.actions-dropdown-item');
      if (!item) return;
      addMenu.style.display = 'none';
      openMenuEl = null;
      var mode = item.dataset.mode;
      var label = mode === 'shell' ? 'Shell'
        : (window.AppUtils ? AppUtils.modeDisplayName(mode) : mode);
      try {
        var result = await window.klaus.terminal.addSub(id, label, mode);
        if (!result || result.cancelled) return; // user declined the trust prompt
        if (result.error) {
          if (window.toast && window.toast.error) window.toast.error('New tab failed: ' + result.error);
          return;
        }
        addSubTerminalTab(taskEntry, result.subId, result.label);
        // Switch to the freshly-created tab so the user immediately sees the
        // agent start (the "+" used to add a hidden tab and never switch).
        switchSubTerminal(taskEntry, result.subId);
      } catch (err) {
        if (window.toast && window.toast.error) window.toast.error('New tab error: ' + (err && err.message || err));
      }
    });

    window.klaus.task.getNotifyEnabled(id).then(function (val) {
      // Returns {idle, ci}; keep notifyEnabled mirroring idle for legacy callers.
      var idle = (val && typeof val === 'object') ? val.idle : val;
      var ci = (val && typeof val === 'object') ? val.ci : true;
      taskEntry.notifyEnabled = idle !== false;
      taskEntry.notifyCIEnabled = ci !== false;
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
    // Insert before the "+" group. The button lives inside .sub-tab-add-wrap,
    // so reference the wrap (a direct child of the bar) — passing the button
    // itself would throw, since it's not a direct child of subTabBar.
    var addAnchor = subTabBar.querySelector('.sub-tab-add-wrap') || subTabBar.querySelector('.sub-tab-add');

    var tab = document.createElement('button');
    tab.className = 'sub-tab';
    tab.dataset.subId = subId;
    tab.innerHTML = escHtml(label) + ' <span class="sub-tab-close">&times;</span>';
    subTabBar.insertBefore(tab, addAnchor);

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

    // Same focus tracker the primary terminal has (line ~172): clicking
    // into a sub-terminal in a different task should switch the active
    // task so the diff/file panels track that worktree. Without this,
    // grid layout looks like the panels are "stuck" on whichever task's
    // primary terminal you focused last.
    subTerminal.textarea.addEventListener('focus', function () {
      if (AppState.focusedTaskId !== id) {
        AppState.focusedTaskId = id;
        AppState.activeTaskId = id;
        Events.emit('task:switched', { task: tasks.get(id) || null, refreshDiff: true });
      }
    });

    var subCleanup = [];
    var removeData = window.klaus.terminal.onSubData(id, subId, function (data) {
      subTerminal.write(data);
    });
    subCleanup.push(removeData);

    var removeExit = window.klaus.terminal.onSubExit(id, subId, function () {
      var sub = taskEntry.subTerminals.find(function (s) { return s.subId === subId; });
      if (sub) sub.alive = false;
    });
    subCleanup.push(removeExit);

    subTerminal.onData(function (data) {
      window.klaus.terminal.write(id, data, subId);
    });

    subTerminal.attachCustomKeyEventHandler(function (e) {
      if (e.type !== 'keydown') return true;
      var meta = e.metaKey;
      if (e.key === 'Enter' && e.shiftKey) {
        // Sub-terminals run a plain shell, not Claude/Ink — a real newline
        // is the correct translation. The main terminal sends the CSI-u
        // encoding because Ink wants it; that doesn't apply here.
        window.klaus.terminal.write(id, '\n', subId);
        return false;
      }
      if (meta && e.key === 'c') {
        var sel = subTerminal.getSelection();
        if (sel) { navigator.clipboard.writeText(sel); return false; }
        return true;
      }
      if (meta && e.key === 'v') {
        // See the main-terminal paste handler for why preventDefault is
        // required in addition to returning false.
        e.preventDefault();
        navigator.clipboard.readText().then(function (text) {
          if (text) window.klaus.terminal.write(id, text, subId);
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
      await window.klaus.terminal.killSub(id, subId);
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
        window.klaus.terminal.resize(taskEntry.id, taskEntry.terminal.cols, taskEntry.terminal.rows);
      } else {
        var sub = taskEntry.subTerminals.find(function (s) { return s.subId === subId; });
        if (sub) {
          sub.fitAddon.fit();
          sub.terminal.focus();
          window.klaus.terminal.resize(taskEntry.id, sub.terminal.cols, sub.terminal.rows, subId);
        }
      }
    }, 50);
  }

  // ---- runInSubTerminal (Run buttons) ----

  // Find-or-create a sub-terminal with `label` on the active task, focus it,
  // and type `command` + Enter. Reuses an existing terminal with the same
  // label to avoid piling up one per invocation; clears it first so output
  // starts fresh. The boot delay before typing is longer when creating a new
  // shell because the login shell needs time to print its prompt.
  async function runInSubTerminal(taskId, label, command) {
    var taskEntry = tasks.get(taskId);
    if (!taskEntry) return { error: 'No active task' };

    var existing = taskEntry.subTerminals.find(function (s) {
      return s.label === label && s.alive;
    });
    var subEntry;
    var isNew = false;
    if (existing) {
      existing.terminal.clear();
      subEntry = existing;
    } else {
      var result = await window.klaus.terminal.addSub(taskId, label);
      if (result.error) return { error: result.error };
      addSubTerminalTab(taskEntry, result.subId, result.label);
      subEntry = taskEntry.subTerminals[taskEntry.subTerminals.length - 1];
      isNew = true;
    }

    switchSubTerminal(taskEntry, subEntry.subId);

    setTimeout(function () {
      if (!subEntry.alive) return;
      window.klaus.terminal.write(taskId, command + '\r', subEntry.subId);
    }, isNew ? 400 : 50);

    return { ok: true };
  }

  // ---- openClaudeSubTerminal (Actions dropdown) ----

  // Spawn a new agent sub-tab on the given task's worktree, seeded with the
  // Plan/Debug/Review prompt. The prompt is handed to the agent as its initial
  // positional argument at spawn (see add-sub-terminal in main/ipc/tasks.js) —
  // NOT typed in after boot. Typing raced the agent's TUI startup (a fixed
  // delay is fragile across agents and machines) and mangled multi-line prompts
  // by submitting them line-by-line; passing the prompt at spawn fixes both.
  // `label` becomes the tab's visible label.
  async function openClaudeSubTerminal(taskId, label, command) {
    var taskEntry = tasks.get(taskId);
    if (!taskEntry) return { error: 'No active task' };

    // Spawn the action sub-terminal with the PARENT task's agent so a Codex /
    // Gemini / Copilot task's Plan/Debug/Review opens that same agent. A
    // shell-only task falls back to the default agent. (NOTE: the Plan/Debug/
    // Review prompt bodies are still Claude-flavored slash commands — see
    // plan-modal.js; tuning them per-agent is a follow-up.)
    var defaultAgent = (AppState.savedPrefs && (AppState.savedPrefs.defaultProvider || AppState.savedPrefs.defaultMode)) || 'claude';
    var agentMode = (taskEntry.mode && taskEntry.mode !== 'shell') ? taskEntry.mode : defaultAgent;
    var result = await window.klaus.terminal.addSub(taskId, label, agentMode, command);
    if (result.error) return { error: result.error };
    if (result.cancelled) return { cancelled: true };
    addSubTerminalTab(taskEntry, result.subId, result.label);
    var subEntry = taskEntry.subTerminals[taskEntry.subTerminals.length - 1];
    switchSubTerminal(taskEntry, subEntry.subId);

    return { ok: true };
  }

  // ---- buildActionsDropdown (worktree header) ----

  // Open menus are tracked globally so the outside-click handler can close
  // whichever is open when you click anywhere else.
  var openMenuEl = null;
  document.addEventListener('click', function () {
    if (openMenuEl) {
      openMenuEl.style.display = 'none';
      openMenuEl = null;
    }
  });

  function buildActionsDropdown(host, taskId) {
    var btn = document.createElement('button');
    btn.className = 'actions-dropdown-btn';
    btn.title = 'Actions';
    btn.innerHTML = 'Actions <span class="actions-chevron">&#9662;</span>';

    var menu = document.createElement('div');
    menu.className = 'actions-dropdown-menu';
    menu.style.display = 'none';
    // "Run in <Agent>" spawns a sibling task in THIS worktree with another CLI,
    // so you can run the same work in two agents side by side.
    var providers = (window.klaus.ui && window.klaus.ui.providers) || [];
    var runInItems = providers.map(function (p) {
      return '<button class="actions-dropdown-item" data-run-in="' + p.id + '">Run in ' + escHtml(p.displayName) + '</button>';
    }).join('');
    menu.innerHTML =
      '<button class="actions-dropdown-item" data-action="plan">Plan</button>' +
      '<button class="actions-dropdown-item" data-action="debug">Debug</button>' +
      '<button class="actions-dropdown-item" data-action="review">Review</button>' +
      '<div class="actions-dropdown-divider"></div>' +
      runInItems;

    host.appendChild(btn);
    host.appendChild(menu);

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = menu.style.display !== 'none';
      if (openMenuEl && openMenuEl !== menu) openMenuEl.style.display = 'none';
      // Must be 'flex' (not 'block') — the menu's flex-column layout is how
      // the items stack vertically. Setting 'block' would let buttons flow
      // inline and sit side-by-side.
      menu.style.display = isOpen ? 'none' : 'flex';
      openMenuEl = isOpen ? null : menu;
    });

    menu.addEventListener('click', function (e) {
      e.stopPropagation();
      var target = e.target.closest('.actions-dropdown-item');
      if (!target) return;
      menu.style.display = 'none';
      openMenuEl = null;

      // "Run in <Agent>": spawn a sibling task in the same worktree with the
      // chosen provider, so the user can compare/parallelize agents.
      var runIn = target.dataset.runIn;
      if (runIn) {
        runInAnotherAgent(taskId, runIn);
        return;
      }

      var action = target.dataset.action;
      if (window.ActionModal && typeof window.ActionModal.run === 'function') {
        window.ActionModal.run(taskId, action);
      }
    });
  }

  // Spawn a new task on the same worktree using a different AI CLI. Mirrors the
  // attach-worktree flow the New Task dialog uses for an existing directory.
  async function runInAnotherAgent(taskId, providerId) {
    var src = tasks.get(taskId);
    if (!src || !src.worktreePath) {
      window.toast.error('Cannot determine worktree for this task');
      return;
    }
    // A file-only (branchless) source isn't a git worktree, so attach-worktree
    // would reject it ("not a git repository"). Open it as a plain folder
    // instead so the sibling agent starts in the same directory.
    var result;
    try {
      result = src.branch
        ? await window.klaus.task.attachWorktree(src.worktreePath, providerId)
        : await window.klaus.task.openFolder(src.worktreePath, providerId);
    } catch (err) {
      window.toast.error('Failed to start ' + providerId + ': ' + (err && err.message || err));
      return;
    }
    if (!result || result.cancelled) return; // user declined the trust prompt
    if (result.error) {
      window.toast.error('Failed to start ' + providerId + ': ' + result.error);
      return;
    }
    addTaskToUI(result);
    switchToTask(result.id);
  }

  // ---- rewireTerminal ----

  function rewireTerminal(id) {
    var task = tasks.get(id);
    if (!task) return;
    if (task.cleanup) {
      task.cleanup.forEach(function (fn) { fn(); });
    }
    task.cleanup = [];
    var removeDataListener = window.klaus.terminal.onData(id, function (data) {
      task.terminal.write(data);
      if (AppState.activeTaskId !== id) {
        Sidebar.showUnreadBadge(id);
      }
    });
    task.cleanup.push(removeDataListener);
    var removeExitListener = window.klaus.terminal.onExit(id, function () {
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
        if (window.BranchlessUI) window.BranchlessUI.apply(null);
        if (window.closeFileViewerOnTaskSwitch) window.closeFileViewerOnTaskSwitch(null);
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
    Events.emit('task:switched', { task: task || null });
    if (task) {
      // Terminal focus/resize is the one thing that's intrinsically owned by
      // terminal-manager — not an event subscriber, since only this module
      // knows the xterm instance handle.
      setTimeout(function () {
        if (task.activeSubId !== null && task.activeSubId !== undefined) {
          var sub = task.subTerminals.find(function (s) { return s.subId === task.activeSubId; });
          if (sub) {
            sub.fitAddon.fit();
            sub.terminal.focus();
            window.klaus.terminal.resize(id, sub.terminal.cols, sub.terminal.rows, task.activeSubId);
          }
        } else {
          task.fitAddon.fit();
          task.terminal.scrollToBottom();
          window.klaus.terminal.resize(id, task.terminal.cols, task.terminal.rows);
          task.terminal.focus();
        }
      }, 50);
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
            window.klaus.terminal.resize(id, sub.terminal.cols, sub.terminal.rows, task.activeSubId);
          }
        } else {
          task.fitAddon.fit();
          task.terminal.scrollToBottom();
          window.klaus.terminal.resize(id, task.terminal.cols, task.terminal.rows);
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
      window.klaus.terminal.resize(id, task.terminal.cols, task.terminal.rows);
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
        window.klaus.terminal.resize(AppState.activeTaskId, task.terminal.cols, task.terminal.rows);
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
    runInSubTerminal: runInSubTerminal,
    openClaudeSubTerminal: openClaudeSubTerminal,
  };
})();
