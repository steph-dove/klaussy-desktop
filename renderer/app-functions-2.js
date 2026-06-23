// Function definitions (2/2) for the app entry module (window.App). Loaded
// BEFORE app.js so every App.fn exists when app.js runs its bootstrap. Pure
// definitions (no load-time execution); they read App state and other App.fns
// at call time, all of which the core sets up before invoking them.

window.App = window.App || {};

(function (App) {

  App.removeRepoRow = function(row) {
    App.additionalRepoRows = App.additionalRepoRows.filter(function (r) { return r !== row; });
    row.el.remove();
  };

  App.addRepoRow = function() {
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
      App.setRepoRowPath(row, added.path);
    });

    el.querySelector('.mr-remove').addEventListener('click', function () {
      App.removeRepoRow(row);
    });

    App.bindRecentsDropdown(el.querySelector('.mr-recents'), el.querySelector('.modal-recents-list'), {
      loadItems: function () {
        var exclude = {};
        if (AppState.repoPath) exclude[AppState.repoPath] = true;
        App.additionalRepoRows.forEach(function (r) {
          if (r !== row && r.path) exclude[r.path] = true;
        });
        return App.buildRepoPickerSections(exclude);
      },
      onPick: function (p, info) {
        if (info && info.kind === 'github-clone') {
          var session = App.modalSession;
          var nameWithOwner = p.replace(/^gh:/, '');
          App.pendingRepoClones++;
          row.pathEl.textContent = 'Cloning ' + nameWithOwner + '…';
          App.cloneGithubPick(p, function (localPath) {
            App.pendingRepoClones = Math.max(0, App.pendingRepoClones - 1);
            if (session !== App.modalSession || !row.el.isConnected) return;
            App.setRepoRowPath(row, localPath);
          }, function () {
            App.pendingRepoClones = Math.max(0, App.pendingRepoClones - 1);
            if (session === App.modalSession && row.el.isConnected) App.setRepoRowPath(row, row.path);
          });
          return;
        }
        App.setRepoRowPath(row, p);
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
      App.setRepoRowPath(row, added.path);
    });

    App.additionalRepoRows.push(row);
    App.multiRepoRowsEl.appendChild(el);
  };

  App.showModal = function() {
    App.modalOverlay.style.display = 'flex';
    // Fresh discovery each time the modal opens so adopted repos / new
    // worktrees show up; cached within a single open across dropdown toggles.
    App.discoverReposCache = null;
    App.discoverWorktreesCache = null;
    App.recentGhReposCache = null;
    App.additionalRepoRows.slice().forEach(App.removeRepoRow);
    App.modalSession++;
    App.pendingRepoClones = 0;
    App.modalInput.value = '';
    App.modalError.textContent = '';
    App.clearFieldFlags();
    App.modalCreate.disabled = false;
    App.populateExistingSessions();
    // Default to this window; pre-check "new window" once it's crowded
    // (3+ open tasks).
    var openTaskCount = AppState.tasks ? AppState.tasks.size : 0;
    App.windowSelector.style.display = '';
    App.openNewWindowCheck.checked = openTaskCount >= 3;
    App.activeTab = 'new';
    App.selectedMode = AppState.savedPrefs.defaultProvider || AppState.savedPrefs.defaultMode || 'claude';
    App.shellUserPicked = false; // reset: a fresh open hasn't deliberately picked an agent yet
    App.modalTabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === 'new'); });
    App.tabContents.forEach(function (c) { c.classList.toggle('active', c.id === 'tab-new'); });
    App.shellOptions.forEach(function (b) { b.classList.toggle('active', b.dataset.shell === App.selectedMode); });
    App.syncCreateButtonLabel();
    App.selectedBaseBranch = '';
    App.baseBranchUserPicked = false;
    App.populateBaseBranchSelect();
    // Sync the source-repo display to whatever AppState says — buttons
    // and drag handlers were wired once at IIFE init.
    if (App.modalRepoPathEl) { App.modalRepoPathEl.textContent = AppState.repoPath || 'No repo selected'; App.modalRepoPathEl.title = AppState.repoPath || ''; }
    setTimeout(function () { App.modalInput.focus(); }, 50);
  };

  App.hideModal = function() {
    App.modalOverlay.style.display = 'none';
    App.modalInput.value = '';
    App.modalError.textContent = '';
  };


  // ---- Right-click context menu ----

  App.showContextMenu = function(x, y, id) {
    var task = App.tasks.get(id);
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
      { label: 'Search', shortcut: '\u2318F', action: function () { SearchBar.open(id); }},
      { label: 'Clear', shortcut: '\u2318K', action: function () { task.terminal.clear(); }},
      { sep: true },
      { label: 'Zoom In', shortcut: '\u2318+', action: App.zoomIn },
      { label: 'Zoom Out', shortcut: '\u2318\u2212', action: App.zoomOut },
      { label: 'Reset Zoom', shortcut: '\u23180', action: App.zoomReset },
      { sep: true },
      { label: 'Show Changes', action: function () {
        DiffPanel.show(task.worktreePath);
        PRPanel.setWorktree(task.worktreePath);
        App.btnDiff.classList.add('active');
      }},
      { label: 'Pop Out', action: async function () {
        await window.klaus.task.popOut(id);
      }},
      { label: 'Duplicate', action: async function () {
        var result = await window.klaus.task.duplicate(id);
        if (result && !result.error) {
          App.addTaskToUI(result);
          App.switchToTask(result.id);
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
      var restartAgent = (task.mode && task.mode !== 'shell') ? task.mode : App.defaultAgent();
      items.push({ label: 'Restart ' + AppUtils.modeDisplayName(restartAgent), action: async function () {
        // restart-task respawns the task's original agent (consent/model/guard
        // handled in main) — not hardcoded to Claude.
        await window.klaus.task.restart(id);
        task.mode = restartAgent;
        App.updateSidebarMode(id, restartAgent);
        var resumeBtn = App.taskList.querySelector('.task-item[data-id="' + id + '"] .sidebar-resume-btn');
        if (resumeBtn) resumeBtn.remove();
      }});
    }

    ContextMenu.show(x, y, items);
  };

  // ---- Command Palette (A3) ----

  App.defaultAgent = function() {
    return (AppState.savedPrefs && (AppState.savedPrefs.defaultProvider || AppState.savedPrefs.defaultMode)) || 'claude';
  };

  App.openFolderAsTask = async function(mode) {
    mode = mode || App.defaultAgent();
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
    App.addTaskToUI(result);
    App.switchToTask(result.id);
  };

  App.buildPaletteCommands = function() {
    var commands = [
      { label: 'New Task', action: function () { App.showModal(); } },
      { label: 'Open Folder…', action: function () { App.openFolderAsTask(App.defaultAgent()); } },
    ];
    // One "Open Folder in <Agent>…" entry per supported AI CLI, plus Shell.
    ((window.klaus.ui && window.klaus.ui.providers) || []).forEach(function (p) {
      commands.push({ label: 'Open Folder in ' + p.displayName + '…', action: function () { App.openFolderAsTask(p.id); } });
    });
    commands.push({ label: 'Open Folder in Shell…', action: function () { App.openFolderAsTask('shell'); } });
    commands.push.apply(commands, [
      { label: 'Toggle Diff Panel', action: function () { App.btnDiff.click(); } },
      { label: 'Change Theme', action: function () { App.showThemePicker(); } },
      { label: 'Preferences', action: function () { window.klaus.ui.openPreferences(); } },
      { label: 'New Window', action: function () { window.klaus.ui.newWindow(); } },
      { label: 'Zoom In', action: App.zoomIn },
      { label: 'Zoom Out', action: App.zoomOut },
      { label: 'Reset Zoom', action: App.zoomReset },
    ]);

    if (AppState.activeTaskId) {
      var task = App.tasks.get(AppState.activeTaskId);
      if (task) {
        commands.push({ label: 'Search in Terminal', action: function () { SearchBar.open(AppState.activeTaskId); } });
        commands.push({ label: 'Clear Terminal', action: function () { task.terminal.clear(); } });
        commands.push({ label: 'Show Changes', action: function () { DiffPanel.show(task.worktreePath); App.btnDiff.classList.add('active'); } });
        commands.push({ label: 'Pop Out', action: function () { window.klaus.task.popOut(AppState.activeTaskId); } });
        commands.push({ label: 'Kill Task', action: function () { window.klaus.task.kill(AppState.activeTaskId).then(function () { App.removeTaskFromUI(AppState.activeTaskId); }); } });
        if (!task.alive) {
          var paletteAgent = (task.mode && task.mode !== 'shell') ? task.mode : App.defaultAgent();
          commands.push({ label: 'Restart ' + AppUtils.modeDisplayName(paletteAgent), action: function () {
            // Respawn the task's original agent via main (not hardcoded Claude).
            window.klaus.task.restart(AppState.activeTaskId).then(function () {
              task.mode = paletteAgent;
              App.updateSidebarMode(AppState.activeTaskId, paletteAgent);
            });
          }});
        }
      }
    }

    App.tasks.forEach(function (t, id) {
      if (id !== AppState.activeTaskId) {
        commands.push({ label: 'Switch to: ' + t.name, action: function () { App.switchToTask(id); } });
      }
    });

    commands.push({ label: 'Review Pull Request\u2026', action: function () { App.showPrPicker(); } });
    commands.push({ label: 'How to use Klaussy', action: function () { Dialogs.showHowToUse(); } });
    commands.push({ label: 'Keyboard shortcuts', action: function () { Dialogs.showShortcuts(); } });
    commands.push({ label: 'Run Slash Command…', action: function () { Dialogs.showSlashLauncher(); } });
    commands.push({ label: 'Skills & Commands', action: function () { Dialogs.showSkills(); } });
    commands.push({ label: 'Memory (CLAUDE.md)', action: function () { Dialogs.showMemory(); } });
    commands.push({ label: 'MCP Servers', action: function () { Dialogs.showMcpServers(); } });
    commands.push({ label: 'Plugins', action: function () { Dialogs.showPlugins(); } });
    commands.push({ label: 'GitHub accounts', action: function () { Dialogs.showGhAccounts(); } });
    commands.push({ label: 'Check dependencies\u2026', action: function () { Dialogs.checkAndPromptDeps({ force: true }); } });
    commands.push({ label: 'View Logs', action: App.showLogViewer });
    commands.push({ label: 'Send feedback\u2026', action: function () { Dialogs.openFeedback(); } });
    commands.push({ label: 'About Klaussy', action: App.showAboutDialog });

    return commands;
  };

  App.showCommandPalette = function() {
    CommandPalette.show(App.buildPaletteCommands());
  };

  // Cmd+K is overloaded: globally it opens the command palette, but inside a
  // Monaco editor it starts inline-edit (K3). Monaco's addCommand requires
  // the editor to have text focus; if the user clicked the tab bar or anywhere
  // in the file viewer that isn't the text area, focus is lost and pressing
  // Cmd+K here would hijack to the palette. So we route directly to inline-edit
  // whenever the Monaco editor exists — via its hasTextFocus() (best signal)
  // OR by inspecting the target/active element for a .monaco-editor ancestor.
  App.shouldInlineEdit = function(e) {
    var target = e && e.target;
    if (target && target.closest && target.closest('.monaco-editor')) return true;
    var active = document.activeElement;
    if (active && active.closest && active.closest('.monaco-editor')) return true;
    var ed = window.FileBrowser && window.FileBrowser.getActiveEditor
      && window.FileBrowser.getActiveEditor();
    if (ed && ed.hasTextFocus && ed.hasTextFocus()) return true;
    return false;
  };

  App.enterPrReviewMode = function() {
    if (App.prReviewMounted) return;
    // Hide the worktree-centric layout. Diff panel gets set aside too — the
    // review has its own diff view and shouldn't compete for the right rail.
    App.terminalArea.style.display = 'none';
    if (App.diffPanelEl) App.diffPanelEl.dataset.prevDisplay = App.diffPanelEl.style.display || '';
    if (App.diffPanelEl) App.diffPanelEl.style.display = 'none';
    App.prReviewRoot.style.display = '';
    window.PrReview.mount({ host: App.prReviewRoot, isPopout: false });
    App.prReviewMounted = true;
  };

  App.exitPrReviewMode = function() {
    if (!App.prReviewMounted) return;
    window.PrReview.unmount();
    App.prReviewRoot.style.display = 'none';
    App.terminalArea.style.display = '';
    if (App.diffPanelEl) App.diffPanelEl.style.display = App.diffPanelEl.dataset.prevDisplay || '';
    App.prReviewMounted = false;
  };

  App.showPrPicker = async function() {
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
        + '<div class="pr-picker-search-row">'
          + '<input type="text" class="pr-picker-search" placeholder="Search loaded PRs by title, number, author or repo\u2026" autocomplete="off" spellcheck="false" />'
        + '</div>'
        + '<div class="pr-picker-recent"></div>'
        + '<div class="pr-picker-list"><div class="pr-picker-loading">Loading open PRs\u2026</div></div>'
        + '<div class="pr-picker-authored"></div>'
        + '<div class="pr-picker-no-matches" hidden>No loaded PRs match your search.</div>'
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
    var authoredEl = overlay.querySelector('.pr-picker-authored');
    var searchEl = overlay.querySelector('.pr-picker-search');
    var noMatchesEl = overlay.querySelector('.pr-picker-no-matches');

    // Client-side filter over whatever PRs are currently rendered across the
    // three sections. Each row's textContent already carries number, title,
    // author and (for the grouped list) repo, so a substring test covers them.
    // Group/section headers hide when nothing under them survives.
    function applyPrFilter() {
      var q = (searchEl.value || '').trim().toLowerCase();
      var anyVisible = false;
      [recentEl, listEl, authoredEl].forEach(function (container) {
        if (!container) return;
        container.querySelectorAll('.pr-picker-item').forEach(function (item) {
          var match = !q || item.textContent.toLowerCase().indexOf(q) !== -1;
          item.style.display = match ? '' : 'none';
          if (match) anyVisible = true;
        });
        // Per-repo subheadings inside the grouped list.
        container.querySelectorAll('.pr-picker-repo').forEach(function (label) {
          var n = label.nextElementSibling, vis = false;
          while (n && !n.classList.contains('pr-picker-repo') && !n.classList.contains('pr-picker-section-head')) {
            if (n.classList.contains('pr-picker-item') && n.style.display !== 'none') { vis = true; break; }
            n = n.nextElementSibling;
          }
          label.style.display = vis ? '' : 'none';
        });
        // Section heading ("Recently reviewed" etc.) hides when its section has
        // no surviving rows.
        var head = container.querySelector('.pr-picker-section-head');
        if (head) {
          var hasVisible = Array.prototype.some.call(
            container.querySelectorAll('.pr-picker-item'),
            function (it) { return it.style.display !== 'none'; });
          head.style.display = (!q || hasVisible) ? '' : 'none';
        }
      });
      // Only call out "no matches" once the user has actually typed something.
      noMatchesEl.hidden = !q || anyVisible;
    }

    searchEl.addEventListener('input', applyPrFilter);
    // Sections fill in asynchronously and re-render on account switch; re-apply
    // the active filter whenever their contents change. Watching childList only
    // (not attributes) means our own display toggles don't retrigger this.
    var filterObserver = new MutationObserver(applyPrFilter);
    [recentEl, listEl, authoredEl].forEach(function (el) {
      filterObserver.observe(el, { childList: true, subtree: true });
    });
    // The account the picker is browsing as. Lists run under this account's
    // token (no global switch); only opening a review (pr.load) switches the
    // global active account. Defaults to whatever gh account is active.
    var selectedAccount = null;

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

    // Pick the gh account to open a pasted URL under: if a different logged-in
    // account can see the repo, target that one. Does NOT switch the global
    // account \u2014 pr.load switches (and restores on close).
    async function ensureAccountCanSeeUrl(url) {
      var parsed = parsePrUrl(url);
      if (!parsed) return;
      var det = await window.klaus.gh.detectAccountForRepo(parsed.owner, parsed.repo, parsed.number);
      if (!det || det.error || !det.username) return;
      selectedAccount = det.username;
      accountHint.textContent = 'Will use ' + det.username;
      accountHint.classList.remove('pr-picker-account-hint-error');
      if (accountSelect) accountSelect.value = det.username;
    }

    async function startFromUrl() {
      var url = urlInput.value.trim();
      if (!url) return;
      try { await ensureAccountCanSeeUrl(url); } catch (_) {}
      urlInput.disabled = true;
      startBtn.disabled = true;
      startBtn.textContent = 'Loading\u2026';
      var result = await window.klaus.pr.load({ url: url, account: selectedAccount });
      if (result.error) {
        urlInput.disabled = false;
        startBtn.textContent = 'Start review';
        updateStartEnabled();
        if (result.errorSummary) {
          // Account/auth failure (e.g. wrong gh account for a work-org repo).
          // Surface it next to the account switcher so the fix is right there.
          accountHint.textContent = result.errorSummary;
          accountHint.classList.add('pr-picker-account-hint-error');
          window.toast.error(result.errorSummary + (result.errorFix ? '\n\n' + result.errorFix : ''));
        } else {
          window.toast.error('Failed to load PR:\n' + result.error);
        }
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
      // Keep the user's chosen account selected across re-populates (e.g. after
      // a sign-in); otherwise default to whichever account gh has active.
      var active = accounts.find(function (a) { return a.active; });
      if (!selectedAccount || !accounts.some(function (a) { return a.username === selectedAccount; })) {
        selectedAccount = active ? active.username : (accounts[0] && accounts[0].username) || null;
      }
      accountSelect.innerHTML = accounts.map(function (a) {
        var sel = a.username === selectedAccount ? ' selected' : '';
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
            var loadResult = await window.klaus.pr.load({ url: row.dataset.url, account: selectedAccount });
            if (loadResult.error) {
              window.toast.error('Failed to load PR:\n' + loadResult.error);
              row.style.opacity = '1';
              return;
            }
            close();
          });
        });
      });

      // "Opened by you" — the active account's own open PRs across all repos,
      // most recently opened first. Fire-and-forget; hidden when there are none.
      authoredEl.innerHTML = '';
      window.klaus.pr.authored(selectedAccount).then(function (r) {
        var prs = (r && r.prs) || [];
        if (!prs.length) { authoredEl.style.display = 'none'; return; }
        authoredEl.style.display = '';
        authoredEl.innerHTML = '<div class="pr-picker-section-head">Opened by you</div>'
          + prs.map(function (pr) {
            var stateLabel = pr.isDraft ? 'draft' : (pr.state || 'open').toLowerCase();
            var repo = (pr.repository && pr.repository.nameWithOwner) || '';
            return '<div class="pr-picker-item" data-url="' + AppUtils.escAttr(pr.url || '') + '">'
              + '<span class="pr-picker-num">#' + AppUtils.escHtml(pr.number) + '</span>'
              + '<span class="pr-picker-title">' + AppUtils.escHtml(pr.title || '') + '</span>'
              + '<span class="pr-picker-author">' + AppUtils.escHtml(repo) + '</span>'
              + '<span class="pr-picker-state pr-state-' + AppUtils.escAttr(stateLabel) + '">' + AppUtils.escHtml(stateLabel) + '</span>'
            + '</div>';
          }).join('');
        authoredEl.querySelectorAll('.pr-picker-item[data-url]').forEach(function (row) {
          row.addEventListener('click', async function () {
            row.style.opacity = '0.5';
            var loadResult = await window.klaus.pr.load({ url: row.dataset.url, account: selectedAccount });
            if (loadResult.error) {
              window.toast.error('Failed to load PR:\n' + (loadResult.errorSummary || loadResult.error));
              row.style.opacity = '1';
              return;
            }
            close();
          });
        });
      });

      // Account-scoped: the active account's most recently active repos and
      // their recent open PRs — not the single "current project" (which fails
      // whenever the active account can't see that repo).
      var result = await window.klaus.pr.recentRepos(selectedAccount);
      if (result.error) {
        var isAccess = /^(not-found|auth|sso|scope)$/.test(result.errorKind || '');
        var text = isAccess
          ? (result.errorSummary || result.error) + ' Switch accounts above, or paste a URL.'
          : (result.error || '');
        listEl.innerHTML = '<div class="pr-picker-section-head">Recent pull requests</div>'
          + '<div class="' + (isAccess ? 'pr-picker-empty' : 'pr-picker-error') + '">' + AppUtils.escHtml(text) + '</div>';
        // Let the account-switch handler know the active account couldn't list
        // for access reasons, so it can offer to (re)sign in to that account.
        return { listErrorKind: isAccess ? (result.errorKind || 'unknown') : null };
      }
      var repos = result.repos || [];
      if (repos.length === 0) {
        listEl.innerHTML = '<div class="pr-picker-section-head">Recent pull requests</div>'
          + '<div class="pr-picker-empty">No open PRs in your recently active repos. Paste a URL above to review any PR.</div>';
        return {};
      }
      listEl.innerHTML = '<div class="pr-picker-section-head">Recent pull requests</div>'
        + repos.map(function (r) {
          return '<div class="pr-picker-repo">' + AppUtils.escHtml(r.repo) + '</div>'
            + r.prs.map(function (pr) {
              var author = (pr.author && (pr.author.login || pr.author.name)) || '';
              var stateLabel = pr.isDraft ? 'draft' : (pr.state || 'open').toLowerCase();
              return '<div class="pr-picker-item" data-url="' + AppUtils.escAttr(pr.url || '') + '">'
                + '<span class="pr-picker-num">#' + AppUtils.escHtml(pr.number) + '</span>'
                + '<span class="pr-picker-title">' + AppUtils.escHtml(pr.title || '') + '</span>'
                + '<span class="pr-picker-author">' + AppUtils.escHtml(author) + '</span>'
                + '<span class="pr-picker-state pr-state-' + AppUtils.escAttr(stateLabel) + '">' + AppUtils.escHtml(stateLabel) + '</span>'
              + '</div>';
            }).join('');
        }).join('');
      listEl.querySelectorAll('.pr-picker-item[data-url]').forEach(function (row) {
        row.addEventListener('click', async function () {
          row.style.opacity = '0.5';
          var loadResult = await window.klaus.pr.load({ url: row.dataset.url, account: selectedAccount });
          if (loadResult.error) {
            window.toast.error('Failed to load PR:\n' + (loadResult.errorSummary || loadResult.error));
            row.style.opacity = '1';
            return;
          }
          close();
        });
      });
      return {};
    }

    accountSelect.addEventListener('change', async function () {
      var target = accountSelect.value;
      if (!target) return;
      selectedAccount = target;
      accountHint.textContent = '';
      accountHint.classList.remove('pr-picker-account-hint-error');
      // Browsing only — do NOT switch gh's global active account. We list as
      // `target` via its token (recentRepos/authored accept the account). The
      // global switch happens later, only when a review is actually opened.
      var opt = accountSelect.options[accountSelect.selectedIndex];
      var needsSignIn = opt && opt.dataset.valid === 'false';
      if (needsSignIn) {
        // No usable token for this account → can't list as it; sign in first.
        accountHint.textContent = 'Signing in to ' + target + '…';
        Dialogs.showGhLogin({
          onSuccess: async function () {
            accountHint.textContent = 'Signed in';
            await populateAccountSelect();
            await refreshLists();
          },
          onCancel: async function () { accountHint.textContent = ''; await populateAccountSelect(); },
        });
        return;
      }
      var listed = (await refreshLists()) || {};
      // Token looked valid to gh but the API rejected it (expired) — offer a
      // re-sign-in. onSuccess re-lists directly, so a still-failing account just
      // leaves the soft hint (no loop).
      if (listed.listErrorKind === 'auth') {
        accountHint.textContent = 'Signing in to ' + target + '…';
        Dialogs.showGhLogin({
          onSuccess: async function () {
            accountHint.textContent = 'Signed in';
            await populateAccountSelect();
            await refreshLists();
          },
          onCancel: async function () { accountHint.textContent = ''; await populateAccountSelect(); },
        });
      }
    });

    await populateAccountSelect();
    await refreshLists();
  };

  // Clear the red "required" ring from every field that can carry it.
  App.clearFieldFlags = function() {
    [App.modalRepoRow, App.multiRepoRow, App.modalInput, App.modalBaseSelect, App.existingSessionSelect].forEach(function (el) {
      if (el) el.classList.remove('modal-field-invalid');
    });
  };

  // Abort a submit: re-enable Create, show the message, ring + focus the field.
  App.failValidation = function(message, fieldEl) {
    App.modalCreate.disabled = false;
    App.syncCreateButtonLabel();
    App.modalError.textContent = message;
    if (fieldEl) {
      fieldEl.classList.add('modal-field-invalid');
      var focusEl = fieldEl.tagName === 'INPUT' ? fieldEl : fieldEl.querySelector('input, button');
      if (focusEl && focusEl.focus) setTimeout(function () { focusEl.focus(); }, 0);
    }
  };

  // Wrapper: an IPC rejection anywhere in the submit flow must not leave the
  // modal stuck on a disabled "Creating..." button with the error only in
  // DevTools.
  App.submitModal = async function() {
    try {
      await App.submitModalInner();
    } catch (e) {
      console.error('[submitModal]', e);
      App.failValidation('Something went wrong: ' + ((e && e.message) || e), null);
    }
  };

  App.submitModalInner = async function() {
    App.modalCreate.disabled = true;
    App.modalCreate.textContent = App.activeTab === 'existing' ? 'Resuming...' : 'Creating...';
    App.modalError.textContent = '';
    App.clearFieldFlags();

    // Snapshot everything the fan-out needs BEFORE the first await. The
    // primary create can take seconds (consent prompt, origin fetch) and the
    // inputs aren't locked meanwhile — live reads after the await could hand
    // secondary repos a different name/base/agent than the primary task got.
    var fanoutRepos = App.activeTab === 'new' ? App.selectedAdditionalRepos() : [];
    // Every repo in this session (primary + "also create in"), so each agent can
    // be seeded with awareness of its siblings (same branch, own worktrees).
    var sessionRepoPaths = [AppState.repoPath].concat(fanoutRepos.map(function (r) { return r.path; })).filter(Boolean);
    // Existing-session resume: filled in by the 'existing' branch below.
    var fanoutResume = [];
    var fanoutSavedList = [];
    var fanoutSessionName = '';
    var fanoutName = App.modalInput.value.trim();
    var fanoutBase = App.selectedBaseBranch;
    // Sessions live in the default ~/klaussy/sessions/<session>/<repo> layout
    // (resolved by the main process when no basePath is passed).
    var fanoutBasePath = null;
    var fanoutMode = App.selectedMode;
    var openInNewWindow = App.openNewWindowCheck.checked;

    var result;

    if (App.activeTab === 'new') {
      // A source repo is required for both create and checkout paths.
      if (!AppState.repoPath) {
        return App.failValidation('Select a source repo first.', App.modalRepoRow);
      }
      // A repo picked in an extra row is still cloning — submitting now
      // would silently drop it from the fan-out.
      if (App.pendingRepoClones > 0) {
        return App.failValidation('Still cloning a repo — give it a moment and try again.', App.multiRepoRow);
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
        return App.failValidation('Two repos in this session share the folder name "' + nameCollision + '" — they would collide in the session folder. Rename one clone or create them as separate sessions.', App.multiRepoRow);
      }
      var name = App.modalInput.value.trim();
      if (name) {
        // The branch name is sanitized to [a-zA-Z0-9_-]; a name with no
        // letters/digits would collapse to an empty branch and fail in git.
        if (!/[a-zA-Z0-9]/.test(name)) {
          return App.failValidation('Name must include at least one letter or number.', App.modalInput);
        }
        // Name typed: create a new branch with that name, based on the
        // selected branch (or the default if none picked).
        result = await window.klaus.task.create(
          name,
          AppState.repoPath,
          App.selectedMode,
          null,
          undefined,
          App.selectedBaseBranch || null,
          undefined,
          sessionRepoPaths,
        );
      } else if (App.baseBranchUserPicked && App.selectedBaseBranch) {
        // No name, but the user *deliberately* picked a branch: check it out
        // directly so they can continue work on it in a fresh worktree. We
        // require an explicit pick (not the auto-default) so an unnamed submit
        // with the default branch still asks for a name instead of trying to
        // re-check-out the primary worktree's branch.
        // A branch can only live in one worktree — if it's already checked out,
        // tell the user to name a new branch off it rather than failing in git.
        var picked = App.baseBranchData.find(function (b) { return b.localName === App.selectedBaseBranch; });
        if (picked && picked.inWorktree) {
          return App.failValidation('"' + App.selectedBaseBranch + '" is already checked out in another worktree. Enter a name to branch off it instead.', App.modalBaseSelect);
        }
        result = await window.klaus.task.checkoutBranch(
          AppState.repoPath,
          App.selectedBaseBranch,
          App.selectedMode,
          null,
        );
      } else {
        return App.failValidation('Name the session, or pick an existing branch in the repo row to continue it.', App.modalInput);
      }
    } else {
      // Existing Session: resume every worktree in the picked session (one
      // unit across repos), each with its saved agent + session id where
      // known. Option values carry an "s:" / "b:" prefix (session folder vs
      // legacy branch group) — strip it for display/task naming.
      var sessKey = App.existingSessionSelect.value;
      if (!sessKey) {
        return App.failValidation('Pick a session to resume.', App.existingSessionSelect);
      }
      var sessName = sessKey.slice(2);
      var sessWts = (App.existingSessionsMap[sessKey] || []).filter(function (w) { return !w.active; });
      if (!sessWts.length) {
        return App.failValidation('Every worktree in this session is already open.', App.existingSessionSelect);
      }
      try {
        fanoutSavedList = (await window.klaus.session.listSaved()) || [];
      } catch (e) {
        fanoutSavedList = [];
      }
      fanoutSessionName = sessName;
      result = await App.resumeSessionWorktree(sessWts[0], sessName, fanoutSavedList, App.selectedMode);
      fanoutResume = sessWts.slice(1);
    }

    App.modalCreate.disabled = false;
    App.syncCreateButtonLabel();

    // The worktree already exists on disk (commonly a session we created but
    // never persisted). Rather than dead-ending, ask whether to open it, then
    // resume it in place.
    if (result && result.exists) {
      var openExisting = window.confirm(
        'A session named "' + name + '" already exists:\n\n' + result.worktreePath +
        '\n\nOpen the existing session instead?'
      );
      if (!openExisting) {
        App.modalError.textContent = 'Session "' + name + '" already exists. Pick a different name, or open it from the Existing Session tab.';
        return;
      }
      result = await window.klaus.session.resume({
        sessionId: result.sessionId || null,
        name: result.name || name,
        worktreePath: result.worktreePath,
        branch: result.branch,
        mode: App.selectedMode,
        repoPath: result.repoPath,
      });
    }

    // User declined the agent's worktree-trust prompt — close quietly.
    if (result && result.cancelled) { App.hideModal(); return; }
    if (!result || result.error) {
      App.modalError.textContent = (result && result.error) || 'Failed to start the session.';
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
            App.addTaskToUI(info);
            added++;
            if (firstId === null) firstId = tid;
          });
          if (added > 1 && TerminalManager.currentLayout() === 'single') {
            TerminalManager.setLayout(added >= 3 ? 'grid' : 'columns');
          }
          if (firstId !== null) App.switchToTask(firstId);
          window.toast.error('Could not open a new window — session opened here instead.');
        }).catch(function (e2) {
          console.error('[new-window fallback]', e2);
          window.toast.error('Could not open a new window or render the session here — its agents are still running; restart the app to reattach.');
        });
      });
    };

    App.hideModal();
    if (!newWindowIds) {
      App.addTaskToUI(result);
      App.switchToTask(result.id);
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
            ? window.klaus.task.create(fanoutName, repo.path, fanoutMode, fanoutBasePath, undefined, repoBase, true, sessionRepoPaths)
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
              if (newWindowIds) newWindowIds.push(res.id); else App.addTaskToUI(res);
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
          return App.resumeSessionWorktree(wt, fanoutSessionName, fanoutSavedList, fanoutMode).then(function (res) {
            try {
              if (!res || res.error) {
                rsFailures.push(wt.repoName + ': ' + ((res && res.error) || 'failed'));
                return;
              }
              if (res.cancelled) { rsSkipped.push(wt.repoName); return; }
              if (newWindowIds) newWindowIds.push(res.id); else App.addTaskToUI(res);
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
  };

})(window.App);
