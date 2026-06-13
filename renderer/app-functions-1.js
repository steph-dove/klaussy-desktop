// Function definitions (1/2) for the app entry module (window.App). Loaded
// BEFORE app.js so every App.fn exists when app.js runs its bootstrap. Pure
// definitions (no load-time execution); they read App state and other App.fns
// at call time, all of which the core sets up before invoking them.

window.App = window.App || {};

(function (App) {

  App.updateCIStatusIcon = function(taskId, runs) {
    var item = App.taskList.querySelector('.task-item[data-id="' + taskId + '"]');
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
  };

  App.forceFilesTab = function() {
    if (App.filesTabBtn && !App.filesTabBtn.classList.contains('active')) App.filesTabBtn.click();
  };

  App.showThemePicker = function() {
    var presets = ThemeManager.getPresetList();
    var current = ThemeManager.getCurrent();
    App.themeList.innerHTML = '';

    presets.forEach(function (p) {
      var btn = document.createElement('button');
      btn.className = 'theme-option' + (p.id === current ? ' active' : '');
      btn.innerHTML = '<span class="theme-swatch" data-preset="' + p.id + '"></span>' + p.name;
      btn.addEventListener('click', function () {
        ThemeManager.apply(p.id);
        App.themeList.querySelectorAll('.theme-option').forEach(function (el) { el.classList.remove('active'); });
        btn.classList.add('active');
      });
      App.themeList.appendChild(btn);
    });

    App.themeOverlay.style.display = 'flex';
  };

  App.refitTerminals = function() {
    setTimeout(function () {
      if (App.currentLayout() !== 'single') {
        App.fitAllTerminals();
      } else if (AppState.activeTaskId != null) {
        var task = App.tasks.get(AppState.activeTaskId);
        if (task) {
          task.fitAddon.fit();
          window.klaus.terminal.resize(AppState.activeTaskId, task.terminal.cols, task.terminal.rows);
        }
      }
    }, 250);
  };

  App.toggleSidebar = function() {
    AppState.sidebarCollapsed = !AppState.sidebarCollapsed;
    App.sidebar.style.width = '';
    App.sidebar.style.minWidth = '';
    App.sidebar.classList.toggle('collapsed', AppState.sidebarCollapsed);
    App.sidebar.classList.remove('expanded');
    App.sidebarToggleIcon.textContent = AppState.sidebarCollapsed ? '\u25B6' : '\u25C0';
    App.sidebarToggleLabel.textContent = AppState.sidebarCollapsed ? 'Show' : 'Hide';
    App.refitTerminals();
  };

  // Swap the empty-state copy based on whether the user has a project yet.
  // Helps first-runs — without a project, "Click + to create a new task"
  // is a dead end since task creation needs a repo.
  App.updateEmptyState = function() {
    var defaultEl = document.getElementById('empty-state-default');
    var noProjEl = document.getElementById('empty-state-no-project');
    if (!defaultEl || !noProjEl) return;
    var noProject = !AppState.repoPath;
    defaultEl.style.display = noProject ? 'none' : '';
    noProjEl.style.display = noProject ? '' : 'none';
  };

  App.showApp = async function() {
    App.appEl.style.display = 'flex';
    await App.loadProjects();
    App.updateEmptyState();
    if (App.isSecondaryWindow) {
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
              App.addTaskToUI(t);
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
      await App.loadWorktreeList(adoptedPaths);
    } else {
      App.loadExistingTasks();
    }
    // Commercial licence gate — dismissable, shows only on unactivated
    // packaged builds. Dev (`electron .`) is bypassed by main/state/license.
    if (window.LicenseActivation && typeof window.LicenseActivation.openIfNeeded === 'function') {
      window.LicenseActivation.openIfNeeded();
    }
  };

  App.loadExistingTasks = async function() {
    var existing = await window.klaus.task.list();
    for (var i = 0; i < existing.length; i++) {
      App.addTaskToUI(existing[i]);
    }

    // Show saved sessions that don't overlap with running tasks
    await App.loadSavedSessions(existing);

    // Also load worktrees that don't have active terminals
    var worktrees = await window.klaus.repo.listWorktrees();
    var activePaths = existing.map(function (t) { return t.worktreePath; });
    worktrees.forEach(function (wt) {
      if (activePaths.indexOf(wt.path) === -1) {
        App.addWorktreeToSidebar(wt);
      }
    });
  };

  App.loadWorktreeList = async function(skipPaths) {
    var skip = skipPaths || [];
    var worktrees = await window.klaus.repo.listWorktrees();
    worktrees.forEach(function (wt) {
      if (skip.indexOf(wt.path) !== -1) return;
      App.addWorktreeToSidebar(wt);
    });
  };

  App.addWorktreeToSidebar = function(wt) {
    // Don't add if already in sidebar (as a worktree item or active task)
    var existing = App.taskList.querySelector('.worktree-item[data-path="' + CSS.escape(wt.path) + '"]');
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
      '<span class="collapsed-icon" style="background:' + iconColor + '" title="' + App.escHtml(wt.name) + '">' + iconLetter + '</span>' +
      '<div class="saved-session-info">' +
        '<span class="task-name" title="' + App.escHtml(wt.path) + '">' + App.escHtml(wt.name) + '</span>' +
        '<span class="saved-session-detail">' + App.escHtml(wt.branch) + '</span>' +
      '</div>' +
      '<div class="saved-session-actions">' +
        '<button class="worktree-open-claude" title="Open with ' + App.escHtml(AppUtils.modeDisplayName(App.defaultAgent())) + '">' + App.escHtml(AppUtils.modeShortLabel(App.defaultAgent())) + '</button>' +
        '<button class="worktree-open-shell" title="Open shell">sh</button>' +
        '<button class="worktree-remove" title="Remove worktree">\u00d7</button>' +
      '</div>';

    item.querySelector('.worktree-open-claude').addEventListener('click', async function (e) {
      e.stopPropagation();
      var result;
      try { result = await window.klaus.task.attachWorktree(wt.path, App.defaultAgent()); }
      catch (err) { window.toast.error('Open failed: ' + (err && err.message || err)); return; }
      if (result && result.error) { window.toast.error('Open failed: ' + result.error); return; }
      if (!result) { window.toast.error('Open failed: no response from main process'); return; }
      App.addTaskToUI(result);
      App.switchToTask(result.id);
    });

    item.querySelector('.worktree-open-shell').addEventListener('click', async function (e) {
      e.stopPropagation();
      var result;
      try { result = await window.klaus.task.attachWorktree(wt.path, 'shell'); }
      catch (err) { window.toast.error('Open failed: ' + (err && err.message || err)); return; }
      if (result && result.error) { window.toast.error('Open failed: ' + result.error); return; }
      if (!result) { window.toast.error('Open failed: no response from main process'); return; }
      App.addTaskToUI(result);
      App.switchToTask(result.id);
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

    App.taskList.appendChild(item);
  };

  // Worktree rows render their quick-open button's label/title from the default
  // agent at creation time; when the default changes in Preferences, refresh
  // them in place so the button reflects the new agent (the click handler
  // already reads defaultAgent() live).
  App.refreshWorktreeAgentButtons = function() {
    var agent = App.defaultAgent();
    var label = AppUtils.modeShortLabel(agent);
    var title = 'Open with ' + AppUtils.modeDisplayName(agent);
    App.taskList.querySelectorAll('.worktree-item .worktree-open-claude').forEach(function (btn) {
      btn.textContent = label;
      btn.title = title;
    });
  };

  App.loadSavedSessions = async function(runningTasks) {
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

      var age = App.formatAge(s.savedAt);
      var pathShort = s.worktreePath ? s.worktreePath.split('/').slice(-2).join('/') : '';

      var modeLabel = s.mode === 'shell' ? 'SH' : AppUtils.modeShortLabel(s.mode);
      var modeTitle = s.mode === 'shell'
        ? 'Previous shell session'
        : 'Previous ' + AppUtils.modeDisplayName(s.mode) + ' session';
      var sIconColor = AppUtils.iconColor(s.name);
      var sIconLetter = (s.name || '?').charAt(0).toUpperCase();
      item.innerHTML =
        '<span class="status-dot saved"></span>' +
        '<span class="collapsed-icon" style="background:' + sIconColor + '" title="' + App.escHtml(s.name) + '">' + sIconLetter + '</span>' +
        '<span class="task-mode" title="' + modeTitle + '">' + modeLabel + '</span>' +
        '<div class="saved-session-info">' +
          '<span class="task-name" title="' + App.escHtml(s.worktreePath || '') + '">' + App.escHtml(s.name) + '</span>' +
          '<span class="saved-session-detail">' + App.escHtml(s.branch || pathShort) + ' &middot; ' + App.escHtml(age) + '</span>' +
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
        App.addTaskToUI(result);
        App.switchToTask(result.id);
        App.restoreUIState(result);
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
        App.addTaskToUI(result);
        App.switchToTask(result.id);
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

      App.taskList.appendChild(item);
    });
  };

  App.restoreUIState = async function(task) {
    var uiState = await window.klaus.session.getUIState();

    // Scroll terminal to bottom after data loads
    var t = App.tasks.get(task.id);
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

      App.btnDiff.classList.add('active');

      // Restore selected file after the file list loads
      if (uiState.selectedFile) {
        setTimeout(async function () {
          await DiffPanel.showFile(uiState.selectedFile);
        }, 1000);
      }
    }
  };

  // The action button reads "Resume" on the Existing Session tab — nothing
  // is being created there.
  App.syncCreateButtonLabel = function() {
    App.modalCreate.textContent = App.activeTab === 'existing' ? 'Resume' : 'Create';
  };

  App.renderBaseBranchSelect = function() {
    if (!App.modalBaseSelect) return;
    if (!App.baseBranchData.length) {
      App.modalBaseSelect.hidden = true;
      App.modalBaseSelect.innerHTML = '';
      return;
    }
    App.modalBaseSelect.innerHTML = App.baseBranchData.map(function (b) {
      var isDef = b.localName === App.baseBranchDefault;
      var sel = b.localName === App.selectedBaseBranch ? ' selected' : '';
      return '<option value="' + App.escHtml(b.localName) + '"' + sel + '>'
        + App.escHtml(b.localName) + (isDef ? ' (default)' : '')
        + '</option>';
    }).join('');
    App.modalBaseSelect.hidden = false;
  };

  // Optimistic populate from cached refs; then `git fetch` in the background
  // and re-render so remote branches stay fresh without blocking the modal.
  App.populateBaseBranchSelect = async function() {
    if (!App.modalBaseSelect) return;
    if (!AppState.repoPath) {
      App.baseBranchData = [];
      App.baseBranchDefault = '';
      App.renderBaseBranchSelect();
      return;
    }
    await App.loadBaseBranchData();
    try { await window.klaus.git.fetch(AppState.repoPath); } catch (_) {}
    await App.loadBaseBranchData();
  };

  App.loadBaseBranchData = async function() {
    var result = await window.klaus.task.listBranches(AppState.repoPath);
    if (result.error || !result.branches) {
      App.baseBranchData = [];
      App.baseBranchDefault = '';
      return;
    }

    // Preferred default order — pick the first branch that exists.
    var preferred = ['dev', 'main', 'master'];
    var localNames = result.branches.map(function (b) { return b.localName; });
    App.baseBranchDefault = preferred.find(function (p) { return localNames.indexOf(p) !== -1; })
      || result.defaultBranch
      || (result.branches[0] && result.branches[0].localName)
      || '';

    // Pin the default to the top of the list, then everything else alphabetically.
    var sorted = result.branches.slice().sort(function (a, b) {
      if (a.localName === App.baseBranchDefault) return -1;
      if (b.localName === App.baseBranchDefault) return 1;
      return a.localName.localeCompare(b.localName);
    });
    App.baseBranchData = sorted;

    // Initial selection = default. Preserve user's prior pick across re-renders,
    // including custom (free-text) names that aren't in localNames — those are
    // resolved at submit time by the main process.
    if (!App.selectedBaseBranch) {
      App.selectedBaseBranch = App.baseBranchDefault;
    }
    App.renderBaseBranchSelect();
  };

  // Recents dropdown helper. items = [{ label, path }]. Wires the ▾ button
  // to toggle a list of paths next to its input. Each item has a × that
  // calls onRemove and re-opens the list with the updated set.
  App.bindRecentsDropdown = function(button, list, opts) {
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
      var sub = subText ? '<span class="modal-recents-sub">' + App.escHtml(subText) + '</span>' : '';
      var main = label ? App.escHtml(label) : App.escHtml(p);
      var tag = it.tag ? '<span class="modal-recents-tag">' + App.escHtml(it.tag) + '</span>' : '';
      var rm = it.removable === false ? ''
        : '<button type="button" class="modal-recents-remove" title="Remove from recents" data-path="' + App.escHtml(p) + '">×</button>';
      return '<div class="modal-recents-item" data-path="' + App.escHtml(p) + '" data-kind="' + App.escHtml(it.kind || '') + '">'
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
          list.innerHTML = '<div class="modal-recents-empty">' + App.escHtml(opts.emptyText || 'No recent paths') + '</div>';
        } else {
          list.innerHTML = sections.filter(function (s) { return s.items && s.items.length; }).map(function (s) {
            var head = s.header ? '<div class="modal-recents-section">' + App.escHtml(s.header) + '</div>' : '';
            return head + s.items.map(renderItem).join('');
          }).join('');
        }
        list.hidden = false;
        button.setAttribute('aria-expanded', 'true');
      }).catch(function (err) {
        // A discovery call rejected (rare — handlers normally return []). Degrade
        // to the empty state and still open, rather than leaving a dead button.
        console.error('[recents-dropdown] loadItems failed:', err);
        list.innerHTML = '<div class="modal-recents-empty">' + App.escHtml(opts.emptyText || 'Could not load') + '</div>';
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
  };

  // Cache the promise, but drop it on rejection so the next open retries
  // instead of re-serving a permanently-rejected promise for the modal session.
  App.getDiscoveredRepos = function() {
    if (!App.discoverReposCache) {
      App.discoverReposCache = window.klaus.repo.discoverRepos().catch(function (e) {
        App.discoverReposCache = null;
        throw e;
      });
    }
    return App.discoverReposCache;
  };

  App.getDiscoveredWorktrees = function() {
    if (!App.discoverWorktreesCache) {
      App.discoverWorktreesCache = window.klaus.repo.discoverWorktrees().catch(function (e) {
        App.discoverWorktreesCache = null;
        throw e;
      });
    }
    return App.discoverWorktreesCache;
  };

  App.getRecentGithubRepos = function() {
    if (!App.recentGhReposCache) {
      App.recentGhReposCache = window.klaus.gh.listRecentRepos().then(function (res) {
        if (!res || res.error) {
          if (res && res.error) console.warn('[gh-recent-repos]', res.error);
          // Transient failure (gh offline/unauthed): drop the cache so the
          // next dropdown open retries, same as the rejection path below.
          App.recentGhReposCache = null;
          return [];
        }
        return res.repos || [];
      }).catch(function (e) {
        console.warn('[gh-recent-repos]', e);
        App.recentGhReposCache = null;
        return [];
      });
    }
    return App.recentGhReposCache;
  };

  // Shared by the Existing Session dropdown and the Manage Sessions modal:
  // worktrees under ~/klaussy/sessions/<name>/ group by that folder name,
  // everything else groups by branch ("legacy").
  App.groupWorktreesIntoSessions = function(groups) {
    var sessions = {}; // name -> worktrees (session-folder layout)
    var legacy = {};   // branch -> worktrees (everything else)
    (groups || []).forEach(function (g) {
      (g.worktrees || []).forEach(function (w) {
        if (!w.branch) return;
        var entry = { path: w.path, branch: w.branch, repoName: g.repoName, active: !!w.active };
        var m = w.path.match(App.SESSION_DIR_RE);
        if (m) {
          (sessions[m[1]] = sessions[m[1]] || []).push(entry);
        } else {
          (legacy[w.branch] = legacy[w.branch] || []).push(entry);
        }
      });
    });
    return { sessions: sessions, legacy: legacy };
  };

  App.populateExistingSessions = function() {
    var session = App.modalSession;
    App.existingSessionSelect.innerHTML = '<option value="">Loading sessions…</option>';
    App.getDiscoveredWorktrees().then(function (groups) {
      // A slow discovery from a previous modal open must not overwrite the
      // current open's data (stale `active` flags → double-resume).
      if (session !== App.modalSession) return;
      App.existingSessionsMap = {};
      var grouped = App.groupWorktreesIntoSessions(groups);
      var sessions = grouped.sessions;
      var legacy = grouped.legacy;

      var optionFor = function (value, label, wts) {
        App.existingSessionsMap[value] = wts;
        var repos = wts.map(function (w) { return w.repoName; }).join(', ');
        return '<option value="' + App.escHtml(value) + '" title="' + App.escHtml(repos) + '">'
          + App.escHtml(label) + ' — ' + wts.length + (wts.length === 1 ? ' repo (' : ' repos (') + App.escHtml(repos) + ')'
          + '</option>';
      };

      var sessionNames = Object.keys(sessions).sort();
      var legacyNames = Object.keys(legacy).sort();
      if (!sessionNames.length && !legacyNames.length) {
        App.existingSessionSelect.innerHTML = '<option value="">No sessions found</option>';
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
      App.existingSessionSelect.innerHTML = html;
    }).catch(function (e) {
      console.warn('[existing-sessions]', e);
      if (session === App.modalSession) {
        App.existingSessionSelect.innerHTML = '<option value="">Could not load sessions</option>';
      }
    });
  };

  // Resume one worktree of a session: prefer the saved session entry (carries
  // the agent + exact session id), else the worktree's latest Claude session,
  // else a fresh spawn — resume-session handles a null sessionId gracefully.
  App.resumeSessionWorktree = async function(wt, sessionName, savedList, mode) {
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
  };

  App.closeTasksOnPaths = function(paths) {
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
  };

  App.deleteSessionFlow = async function(name, wts) {
    var ok = await App.confirmDeleteSession(name, wts);
    if (!ok) return false;
    var paths = wts.map(function (w) { return w.path; });
    try {
      await App.closeTasksOnPaths(paths);
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
        var row = App.taskList.querySelector('.worktree-item[data-path="' + CSS.escape(p) + '"]');
        if (row) row.remove();
      });
      App.discoverWorktreesCache = null;
    } catch (e) {
      console.error('[delete-session]', e);
      window.toast.error('Delete failed: ' + ((e && e.message) || e));
    }
    return true;
  };

  App.renderSessionsModalList = function() {
    App.sessionsModalList.innerHTML = '<div class="sessions-modal-empty">Loading…</div>';
    App.discoverWorktreesCache = null;
    App.getDiscoveredWorktrees().then(function (groups) {
      var grouped = App.groupWorktreesIntoSessions(groups);
      var section = function (title, map) {
        var names = Object.keys(map).sort();
        if (!names.length) return '';
        return '<div class="sessions-modal-section">' + App.escHtml(title) + '</div>' + names.map(function (n) {
          var wts = map[n];
          var repos = wts.map(function (w) { return w.repoName; }).join(', ');
          var open = wts.some(function (w) { return w.active; });
          return '<div class="sessions-modal-row" data-name="' + App.escHtml(n) + '">'
            + '<div class="sessions-modal-info">'
            +   '<span class="sessions-modal-name">' + App.escHtml(n) + (open ? ' <span class="sessions-modal-open">open</span>' : '') + '</span>'
            +   '<span class="sessions-modal-sub">' + wts.length + (wts.length === 1 ? ' repo: ' : ' repos: ') + App.escHtml(repos) + '</span>'
            + '</div>'
            + '<button type="button" class="sessions-modal-delete" data-name="' + App.escHtml(n) + '">Delete</button>'
            + '</div>';
        }).join('');
      };
      var html = section('Sessions', grouped.sessions) + section('Other worktrees', grouped.legacy);
      App.sessionsModalList.innerHTML = html || '<div class="sessions-modal-empty">No sessions found</div>';

      App.sessionsModalList.querySelectorAll('.sessions-modal-delete').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var n = btn.dataset.name;
          var wts = grouped.sessions[n] || grouped.legacy[n] || [];
          if (!wts.length) return;
          btn.disabled = true;
          var acted = await App.deleteSessionFlow(n, wts);
          btn.disabled = false;
          if (acted) App.renderSessionsModalList();
        });
      });
    }).catch(function (e) {
      console.warn('[manage-sessions]', e);
      App.sessionsModalList.innerHTML = '<div class="sessions-modal-empty">Could not load sessions</div>';
    });
  };

  // Switch the active repo (used by the source-repo Browse button, the
  // recents dropdown, and the drag-and-drop handler). Re-syncs the path
  // display and branch dropdown.
  App.applyRepoSwitch = function(dir) {
    AppState.repoPath = dir;
    // A repo can't be both the source and an extra-row target — the fan-out
    // would hit "worktree already exists" on the duplicate.
    App.additionalRepoRows.filter(function (r) { return r.path === dir; }).forEach(App.removeRepoRow);
    if (App.modalRepoRow) App.modalRepoRow.classList.remove('modal-field-invalid');
    if (App.modalError) App.modalError.textContent = '';
    if (App.modalRepoPathEl) { App.modalRepoPathEl.textContent = dir; App.modalRepoPathEl.title = dir; }
    App.selectedBaseBranch = '';
    App.baseBranchUserPicked = false;
    App.populateBaseBranchSelect();
  };

  // Source-repo dropdown: two sections. "Open repos" = base repos of worktrees
  // currently in the sidebar (auto-derived, not a user-managed list).
  // "Discovered" = git repos found on disk, excluding the open ones. Picking
  // either just makes it the active source repo.
  // Sections for both repo dropdowns (source repo + "Also create in"):
  // Open repos / GitHub recently-pushed / Discovered. `excludePaths` hides
  // repos already chosen elsewhere (the primary repo, existing chips).
  App.buildRepoPickerSections = function(excludePaths) {
    var exclude = excludePaths || {};
    return Promise.all([
      App.getDiscoveredRepos(),
      App.getRecentGithubRepos(),
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
  };

  // Clone a gh:-pseudo-path pick, then hand the local path to `onCloned`.
  // Shared by the source-repo picker (switches to it) and the multi-repo
  // picker (adds a chip).
  App.cloneGithubPick = function(pseudoPath, onCloned, onFail) {
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
      App.discoverReposCache = null;
      App.recentGhReposCache = null;
      window.toast.success('Cloned ' + nameWithOwner);
      onCloned(res.path);
    }).catch(function (e) {
      console.error('[gh-clone-repo]', e);
      if (onFail) onFail();
      window.toast.error('Clone failed: ' + ((e && e.message) || e));
    });
  };

  // Rows with a repo picked, primary-repo collisions and duplicates dropped.
  // Empty rows (added but never filled) are simply ignored.
  App.selectedAdditionalRepos = function() {
    var seen = {};
    var out = [];
    App.additionalRepoRows.forEach(function (r) {
      if (!r.path || r.path === AppState.repoPath || seen[r.path]) return;
      seen[r.path] = true;
      out.push({ name: r.name, path: r.path, baseBranch: r.baseBranch || '' });
    });
    return out;
  };

  App.setRepoRowPath = function(row, p) {
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
      var def = (App.selectedBaseBranch && branches.some(function (b) { return b.localName === App.selectedBaseBranch; }))
        ? App.selectedBaseBranch
        : (res.defaultBranch || branches[0].localName);
      row.baseEl.innerHTML = branches.map(function (b) {
        return '<option value="' + App.escHtml(b.localName) + '"' + (b.localName === def ? ' selected' : '') + '>'
          + App.escHtml(b.localName) + '</option>';
      }).join('');
      row.baseBranch = def;
      row.baseEl.hidden = false;
    }).catch(function (e) {
      console.warn('[multirepo list-branches]', e);
    });
  };

})(window.App);
