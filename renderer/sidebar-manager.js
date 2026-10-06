window.Sidebar = (function () {
  var escHtml = AppUtils.escHtml;
  var tasks = AppState.tasks;
  var taskList = document.getElementById('task-list');

  // ---- Sidebar item rendering ----

  var collapsedSessions = new Set();

  function selectSession(sessionName) {
    taskList.querySelectorAll('.task-item, .session-group-header').forEach(function(el) {
      el.classList.remove('active');
    });
    var groupEl = taskList.querySelector('.session-group[data-session="' + sessionName + '"]');
    var header = groupEl && groupEl.querySelector('.session-group-header');
    taskList.querySelectorAll('[aria-current]').forEach(function (el) { el.removeAttribute('aria-current'); });
    if (header) {
      header.classList.add('active');
      var select = header.querySelector('.session-group-select');
      if (select) select.setAttribute('aria-current', 'true');
    }
    AppState.activeSessionName = sessionName;
    AppState.activeTaskId = null;
    document.title = 'Klaussy \u2014 ' + sessionName;
    taskList.querySelectorAll('.task-item').forEach(function(item) {
      item.classList.remove('active');
    });
    if (window.BroadcastBar) window.BroadcastBar.update();
    if (window.DiffPanel) {
      window.DiffPanel.updateSession(sessionName);
      window.DiffPanel.show();
    }
  }

  function getSessionName(taskOrWt) {
    if (!taskOrWt) return null;
    var pathVal = taskOrWt.worktreePath || taskOrWt.path;
    if (!pathVal) return null;
    var segments = pathVal.split(/[\\/]/);
    var sessionsIdx = segments.indexOf('sessions');
    if (sessionsIdx !== -1 && sessionsIdx < segments.length - 1) {
      if (sessionsIdx > 0 && segments[sessionsIdx - 1].toLowerCase() === 'klaussy') {
        return segments[sessionsIdx + 1];
      }
    }
    return null;
  }

  function renderItem(task) {
    startDirtyWatch(task);
    rebuild();
  }

  function createTaskDOM(task) {
    var item = document.createElement('div');
    item.className = 'task-item';
    item.dataset.id = task.id;
    item.dataset.repo = task.repoPath || '';
    item.dataset.branch = task.branch || '';

    var modeLabel = AppUtils.modeShortLabel(task.mode);
    var tIconColor = AppUtils.iconColor(task.name);
    var tIconLetter = (task.name || '?').charAt(0).toUpperCase();
    item.innerHTML =
      '<button type="button" class="task-main" title="' + escHtml(task.worktreePath) + '" aria-labelledby="task-name-' + task.id + '" aria-describedby="task-status-' + task.id + '">' +
        '<span class="status-dot ' + (task.alive ? 'alive' : 'exited') + '" aria-hidden="true"></span>' +
        '<span class="collapsed-icon" style="background:' + tIconColor + '" title="' + escHtml(task.name) + '" aria-hidden="true">' + tIconLetter + '</span>' +
        '<span class="task-mode" title="' + escHtml(AppUtils.modeDisplayName(task.mode)) + '">' + modeLabel + '</span>' +
        '<span class="task-name" id="task-name-' + task.id + '">' + escHtml(task.name) + '</span>' +
      '</button>' +
      '<span class="sr-only" id="task-status-' + task.id + '"></span>' +
      '<span class="ci-status-icon" title="CI status"></span>' +
      '<span class="dirty-indicator" aria-hidden="true"></span>' +
      '<span class="unread-badge" aria-hidden="true"></span>' +
      '<button class="task-notify-btn" title="Slack/Discord notifications" aria-label="Slack/Discord notifications for ' + escHtml(task.name) + '" aria-pressed="false">&#128276;</button>' +
      '<button class="task-note-btn" title="Notes" aria-label="Notes for ' + escHtml(task.name) + '">&#9998;</button>' +
      '<button class="task-close" title="Remove" aria-label="Remove ' + escHtml(task.name) + '">&times;</button>';

    item.addEventListener('click', function (e) {
      if (e.target.classList.contains('task-close') || e.target.classList.contains('task-note-btn')
          || e.target.classList.contains('task-notify-btn')) return;
      if (e.target.classList.contains('ci-status-icon')) {
        var url = e.target.dataset.url;
        if (url) window.klaus.gh.openExternal(url);
        return;
      }
      TerminalManager.switchToTask(task.id);
    });

    item.querySelector('.task-close').addEventListener('click', async function (e) {
      e.stopPropagation();
      var wt = {
        path: task.worktreePath,
        name: task.name,
        branch: task.branch || '',
        repoPath: task.repoPath || '',
      };
      stopDirtyWatch(task);
      await window.klaus.task.kill(task.id);
      TerminalManager.removeTaskFromUI(task.id);

      if (wt.branch) window._addWorktreeToSidebar(wt);
      rebuild();
    });

    var notifyBtn = item.querySelector('.task-notify-btn');
    function paintBell(on) {
      notifyBtn.classList.toggle('notifying', !!on);
      notifyBtn.innerHTML = on ? '&#128276;' : '&#128277;';
      notifyBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      notifyBtn.title = on
        ? 'Posting this session to Slack/Discord — click to stop'
        : 'Not posting this session — click to send it to Slack/Discord';
    }
    window.klaus.ui.getPreferences().then(function (p) {
      var ng = (p && p.notificationGateway) || {};
      // Mirror getNotificationConfig's `enabled`: a bot token + channel is a
      // complete setup on its own, so gating on a webhook URL would hide the bell.
      if (!ng.enabled) {
        notifyBtn.style.display = 'none';
        return;
      }
      return window.klaus.task.getNotifyEnabled(task.id).then(function (state) {
        paintBell(state && state.webhook);
      });
    }).catch(function () {
      notifyBtn.style.display = 'none'; // can't tell: don't show a bell that may do nothing
    });
    notifyBtn.addEventListener('click', async function (e) {
      e.stopPropagation();
      var turningOn = !notifyBtn.classList.contains('notifying');
      paintBell(turningOn); // optimistic; reverted below if the main side refuses
      try {
        var res = await window.klaus.task.setNotifyEnabled(task.id, turningOn, 'webhook');
        if (!res || res.error) {
          paintBell(!turningOn);
          if (res && res.error && window.toast) window.toast.error(res.error);
        }
      } catch (err) {
        paintBell(!turningOn);
        if (window.toast) window.toast.error('Could not change notifications: ' + (err && err.message));
      }
    });

    // Task notes
    var noteBtn = item.querySelector('.task-note-btn');
    window.klaus.task.getNote(task.name).then(function (result) {
      if (result.note) noteBtn.classList.add('has-note');
    });
    noteBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      showNotePopover(noteBtn, task.name);
    });

    describeTask(item);
    return item;
  }

  function createWorktreeDOM(wt) {
    var item = document.createElement('div');
    item.className = 'task-item ' + (wt.isSavedSession ? 'saved-session' : 'worktree-item');
    item.dataset.path = wt.path;
    item.dataset.repo = wt.repoPath || '';
    item.dataset.branch = wt.branch || '';

    // Label by repo name from repoPath; wt.name is the worktree dir, which for
    // branch-checkout sessions duplicates the branch already shown in the detail.
    var repoName = wt.repoPath ? wt.repoPath.split(/[\\/]/).filter(Boolean).pop() : (wt.name || '');
    var iconColor = AppUtils.iconColor(repoName);
    var iconLetter = (repoName || '?').charAt(0).toUpperCase();

    if (wt.isSavedSession) {
      var age = window.App && window.App.formatAge ? window.App.formatAge(wt.savedAt) : '';
      var pathShort = wt.path ? wt.path.split('/').slice(-2).join('/') : '';
      var agents = wt.savedAgents || [];
      var modeLabel = wt.mode === 'shell' ? 'SH' : AppUtils.modeShortLabel(wt.mode);
      var modeTitle = wt.mode === 'shell' ? 'Previous shell session' : 'Previous ' + AppUtils.modeDisplayName(wt.mode) + ' session';
      // A row stands for every agent the worktree had, so say so rather than
      // naming only the first and bringing back more than the label promised.
      if (agents.length > 1) {
        modeLabel = agents.length + '×';
        modeTitle = 'Previous session: ' + agents.map(function (a) {
          return a.mode === 'shell' ? 'Shell' : AppUtils.modeDisplayName(a.mode);
        }).join(' + ');
      }
      
      item.innerHTML =
        '<span class="status-dot saved" aria-hidden="true"></span>' +
        '<button type="button" class="collapsed-icon" style="background:' + iconColor + '" title="' + escHtml(repoName) + '" aria-label="Resume ' + escHtml(repoName) + '">' + iconLetter + '</button>' +
        '<span class="task-mode" title="' + modeTitle + '">' + modeLabel + '</span>' +
        '<div class="saved-session-info">' +
          '<span class="task-name" title="' + escHtml(wt.path || '') + '">' + escHtml(repoName) + '</span>' +
          '<span class="saved-session-detail">' + escHtml(wt.branch || pathShort) + ' &middot; ' + escHtml(age) + '</span>' +
        '</div>' +
        '<div class="saved-session-actions">' +
          (wt.mode === 'shell'
            ? '<button class="saved-session-resume" title="Open shell">Open</button>'
            : '<button class="saved-session-resume" title="Resume conversation">Resume</button>' +
              '<button class="saved-session-new" title="New session on this worktree">New</button>') +
        '</div>' +
        '<button class="saved-session-dismiss" title="Dismiss" aria-label="Dismiss saved session ' + escHtml(repoName) + '">&times;</button>';

      item.querySelector('.saved-session-resume').addEventListener('click', async function (e) {
        e.stopPropagation();
        var btn = e.target;
        btn.disabled = true;
        btn.textContent = '...';
        var result;
        var extraTasks = [];
        try {
          if (wt.savedAgents && wt.savedAgents.length > 1) {
            result = await window.App.resumeAllSavedAgents(wt, function (t) { extraTasks.push(t); });
          } else if (wt.mode === 'shell') {
            result = await window.klaus.task.attachWorktree(wt.path, 'shell', wt.repoPath, wt.branch);
          } else {
            result = await window.klaus.session.resume(wt);
          }
        } catch (err) {
          window.toast.error('Resume failed: ' + (err && err.message || err));
          btn.disabled = false;
          btn.textContent = wt.mode === 'shell' ? 'Open' : 'Resume';
          return;
        }
        if (result && result.cancelled) {
          btn.disabled = false;
          btn.textContent = wt.mode === 'shell' ? 'Open' : 'Resume';
          return;
        }
        if (!result || result.error) {
          window.toast.error('Resume failed: ' + ((result && result.error) || 'no response from main process'));
          btn.textContent = 'Err';
          setTimeout(function () { btn.textContent = wt.mode === 'shell' ? 'Open' : 'Resume'; btn.disabled = false; }, 2000);
          return;
        }
        AppState.inactiveWorktrees = (AppState.inactiveWorktrees || []).filter(function(x) { return x.path !== wt.path; });
        var extras = (wt.savedAgents && wt.savedAgents[0] && wt.savedAgents[0].subAgents) || wt.subAgents;
        if (!result.subAgentsToReopen && extras && extras.length) result.subAgentsToReopen = extras;
        window.App.addTaskToUI(result);
        window.App.switchToTask(result.id);
        window.App.restoreUIState(result);
        extraTasks.forEach(function (t) { window.App.addTaskToUI(t); });
        // In single layout the extra agents would run with nothing on screen.
        if (extraTasks.length && window.TerminalManager && TerminalManager.currentLayout() === 'single') {
          TerminalManager.setLayout(extraTasks.length >= 2 ? 'grid' : 'columns');
        }
      });

      var newBtn = item.querySelector('.saved-session-new');
      if (newBtn) {
        newBtn.addEventListener('click', async function (e) {
          e.stopPropagation();
          var btn = e.target;
          btn.disabled = true;
          btn.textContent = '...';
          var result;
          try { result = await window.klaus.task.attachWorktree(wt.path, 'claude', wt.repoPath, wt.branch); }
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
          AppState.inactiveWorktrees = (AppState.inactiveWorktrees || []).filter(function(x) { return x.path !== wt.path; });
          window.App.addTaskToUI(result);
          window.App.switchToTask(result.id);
        });
      }

      item.querySelector('.saved-session-dismiss').addEventListener('click', async function (e) {
        e.stopPropagation();
        await window.klaus.session.dismissSaved(wt);
        AppState.inactiveWorktrees = (AppState.inactiveWorktrees || []).filter(function(x) { return x.path !== wt.path; });
        rebuild();
      });

    } else {
      item.innerHTML =
        '<span class="status-dot idle" aria-hidden="true"></span>' +
        '<button type="button" class="collapsed-icon" style="background:' + iconColor + '" title="' + escHtml(repoName) + '" aria-label="Open ' + escHtml(repoName) + '">' + iconLetter + '</button>' +
        '<div class="saved-session-info">' +
          '<span class="task-name" title="' + escHtml(wt.path) + '">' + escHtml(repoName) + '</span>' +
          '<span class="saved-session-detail">' + escHtml(wt.branch) + '</span>' +
        '</div>' +
        '<div class="saved-session-actions">' +
          '<button class="worktree-open-claude" title="Open with ' + escHtml(AppUtils.modeDisplayName(window.App.defaultAgent())) + '" aria-label="Open ' + escHtml(repoName) + ' with ' + escHtml(AppUtils.modeDisplayName(window.App.defaultAgent())) + '">' + escHtml(AppUtils.modeShortLabel(window.App.defaultAgent())) + '</button>' +
          '<button class="worktree-open-shell" title="Open shell" aria-label="Open shell in ' + escHtml(repoName) + '">sh</button>' +
          '<button class="worktree-remove" title="Remove worktree" aria-label="Remove worktree ' + escHtml(repoName) + '">\u00d7</button>' +
        '</div>';

      item.querySelector('.worktree-open-claude').addEventListener('click', async function (e) {
        e.stopPropagation();
        var result;
        try { result = await window.klaus.task.attachWorktree(wt.path, window.App.defaultAgent(), wt.repoPath, wt.branch); }
        catch (err) { window.toast.error('Open failed: ' + (err && err.message || err)); return; }
        if (result && result.error) { window.toast.error('Open failed: ' + result.error); return; }
        if (!result) { window.toast.error('Open failed: no response from main process'); return; }
        window.App.addTaskToUI(result);
        window.App.switchToTask(result.id);
      });

      item.querySelector('.worktree-open-shell').addEventListener('click', async function (e) {
        e.stopPropagation();
        var result;
        try { result = await window.klaus.task.attachWorktree(wt.path, 'shell', wt.repoPath, wt.branch); }
        catch (err) { window.toast.error('Open failed: ' + (err && err.message || err)); return; }
        if (result && result.error) { window.toast.error('Open failed: ' + result.error); return; }
        if (!result) { window.toast.error('Open failed: no response from main process'); return; }
        window.App.addTaskToUI(result);
        window.App.switchToTask(result.id);
      });

      item.querySelector('.worktree-remove').addEventListener('click', async function (e) {
        e.stopPropagation();
        await window.klaus.repo.hideWorktree(wt.path);
        AppState.inactiveWorktrees = (AppState.inactiveWorktrees || []).filter(function(x) { return x.path !== wt.path; });
        rebuild();
      });
    }

    item.addEventListener('click', function () {
      if (AppState.sidebarCollapsed) {
        var btn = item.querySelector('.saved-session-resume') || item.querySelector('.worktree-open-claude');
        if (btn) btn.click();
      }
    });

    return item;
  }

  function createSessionGroupDOM(sessionName, activeList, inactiveList) {
    var groupEl = document.createElement('div');
    groupEl.className = 'session-group';
    groupEl.dataset.session = sessionName;

    var header = document.createElement('div');
    header.className = 'session-group-header';
    
    var isCollapsed = collapsedSessions.has(sessionName);
    if (isCollapsed) header.classList.add('collapsed');

    var totalCount = activeList.length + inactiveList.length;

    var resumeBtnHtml = '';
    if (inactiveList.length > 0) {
      resumeBtnHtml = '<button class="session-group-resume-btn" title="Resume All Repos in Session" aria-label="Resume all repos in session ' + escHtml(sessionName) + '"><span aria-hidden="true">&#9654;</span> Resume All</button>';
    }

    header.innerHTML = 
      '<button type="button" class="session-group-toggle" aria-expanded="' + !isCollapsed + '" aria-label="Session ' + escHtml(sessionName) + '">' +
        '<span class="session-group-chevron" aria-hidden="true">' + (isCollapsed ? '&#9656;' : '&#9662;') + '</span>' +
      '</button>' +
      '<button type="button" class="session-group-select" title="Show this session\'s changes">' +
        '<span class="session-group-icon" aria-hidden="true">&#128193;</span>' +
        '<span class="session-group-name">' + escHtml(sessionName) + '</span>' +
        '<span class="session-group-badge" aria-hidden="true">' + totalCount + '</span>' +
        '<span class="sr-only">, ' + totalCount + (totalCount === 1 ? ' repo' : ' repos') + '</span>' +
      '</button>' +
      resumeBtnHtml +
      '<button class="session-group-close" title="Close Session" aria-label="Close session ' + escHtml(sessionName) + '">&times;</button>';

    var itemsContainer = document.createElement('div');
    itemsContainer.className = 'session-group-items';
    if (isCollapsed) itemsContainer.classList.add('collapsed');

    header.addEventListener('click', function (e) {
      if (e.target.closest('.session-group-close') || e.target.closest('.session-group-resume-btn')) return;
      if (e.target.closest('.session-group-select')) {
        e.stopPropagation();
        selectSession(sessionName);
        return;
      }
      var collapsed = itemsContainer.classList.toggle('collapsed');
      header.classList.toggle('collapsed', collapsed);
      var chevron = header.querySelector('.session-group-chevron');
      if (chevron) chevron.innerHTML = collapsed ? '&#9656;' : '&#9662;';
      header.querySelector('.session-group-toggle').setAttribute('aria-expanded', String(!collapsed));
      if (collapsed) {
        collapsedSessions.add(sessionName);
      } else {
        collapsedSessions.delete(sessionName);
      }
    });

    header.querySelector('.session-group-close').addEventListener('click', function (e) {
      e.stopPropagation();
      var activeCloses = itemsContainer.querySelectorAll('.task-close');
      activeCloses.forEach(function (c) { c.click(); });
      var inactiveRemoves = itemsContainer.querySelectorAll('.worktree-remove');
      inactiveRemoves.forEach(function (c) { c.click(); });
    });

    var resumeBtn = header.querySelector('.session-group-resume-btn');
    if (resumeBtn) {
      resumeBtn.addEventListener('click', async function (e) {
        e.stopPropagation();
        resumeBtn.disabled = true;
        resumeBtn.textContent = 'Opening...';
        
        for (var i = 0; i < inactiveList.length; i++) {
          var wt = inactiveList[i];
          var opened = [];
          try {
            var result;
            if (wt.isSavedSession && wt.savedAgents && wt.savedAgents.length) {
              // A plain attach would replace every agent the session had with a
              // single default-agent terminal.
              result = await window.App.resumeAllSavedAgents(wt, function (t) { opened.push(t); });
            } else {
              result = await window.klaus.task.attachWorktree(wt.path, window.App.defaultAgent(), wt.repoPath, wt.branch);
            }
            if (result && !result.error) {
              window.App.addTaskToUI(result);
              opened.forEach(function (t) { window.App.addTaskToUI(t); });
              if (i === 0) window.App.switchToTask(result.id);
            }
          } catch (err) {
            console.error('Failed to resume worktree:', err);
          }
        }
        rebuild();
      });
    }

    activeList.forEach(function(task) {
      var itemEl = createTaskDOM(task);
      itemsContainer.appendChild(itemEl);
    });

    inactiveList.forEach(function(wt) {
      var itemEl = createWorktreeDOM(wt);
      itemsContainer.appendChild(itemEl);
    });

    groupEl.appendChild(header);
    groupEl.appendChild(itemsContainer);
    return groupEl;
  }

  function expandSession(sessionName) {
    collapsedSessions.delete(sessionName);
  }

  // rebuild() replaces every row, so focus is carried over by row key and control class.
  function focusedRowKey() {
    var active = document.activeElement;
    if (!active || !taskList.contains(active)) return null;
    var row = active.closest('.task-item, .session-group');
    if (!row) return null;
    var attr = row.dataset.id ? 'data-id' : row.dataset.path ? 'data-path' : 'data-session';
    return {
      row: '.' + row.classList[0] + '[' + attr + '="' + CSS.escape(row.getAttribute(attr) || '') + '"]',
      control: active === row ? null : '.' + active.classList[0],
    };
  }

  function restoreRowFocus(key) {
    if (!key) return;
    var row = taskList.querySelector(key.row);
    var target = row && (key.control ? row.querySelector(key.control) : row);
    if (target) target.focus();
  }

  function rebuild() {
    var focusKey = focusedRowKey();
    taskList.innerHTML = '';

    var activeTasks = Array.from(AppState.tasks.values());
    var activePaths = activeTasks.map(function(t) { return t.worktreePath; });

    var inactive = (AppState.inactiveWorktrees || []).filter(function(wt) {
      return activePaths.indexOf(wt.path) === -1;
    });

    var sessions = {};

    activeTasks.forEach(function(task) {
      var sName = getSessionName(task);
      if (sName) {
        if (!sessions[sName]) sessions[sName] = { active: [], inactive: [] };
        sessions[sName].active.push(task);
      }
    });

    inactive.forEach(function(wt) {
      var sName = getSessionName(wt);
      if (sName) {
        if (!sessions[sName]) sessions[sName] = { active: [], inactive: [] };
        sessions[sName].inactive.push(wt);
      }
    });

    var standaloneActive = activeTasks.filter(function(t) { return !getSessionName(t); });
    var standaloneInactive = inactive.filter(function(wt) { return !getSessionName(wt); });

    var activeSessionNames = [];
    var inactiveSessionNames = [];

    Object.keys(sessions).forEach(function(sName) {
      if (sessions[sName].active.length > 0) {
        activeSessionNames.push(sName);
      } else {
        inactiveSessionNames.push(sName);
      }
    });

    // 1. Render Active Section
    if (activeSessionNames.length > 0 || standaloneActive.length > 0) {
      var activeHeader = document.createElement('div');
      activeHeader.className = 'sidebar-section-header';
      activeHeader.setAttribute('role', 'heading');
      activeHeader.setAttribute('aria-level', '2');
      activeHeader.textContent = 'Active';
      taskList.appendChild(activeHeader);

      activeSessionNames.forEach(function(sName) {
        var groupEl = createSessionGroupDOM(sName, sessions[sName].active, sessions[sName].inactive);
        taskList.appendChild(groupEl);
      });

      standaloneActive.forEach(function(task) {
        var itemEl = createTaskDOM(task);
        taskList.appendChild(itemEl);
      });
    }

    // 2. Render Inactive Section
    if (inactiveSessionNames.length > 0 || standaloneInactive.length > 0) {
      var inactiveHeader = document.createElement('div');
      inactiveHeader.className = 'sidebar-section-header';
      inactiveHeader.setAttribute('role', 'heading');
      inactiveHeader.setAttribute('aria-level', '2');
      inactiveHeader.textContent = 'Inactive';
      taskList.appendChild(inactiveHeader);

      inactiveSessionNames.forEach(function(sName) {
        var groupEl = createSessionGroupDOM(sName, [], sessions[sName].inactive);
        taskList.appendChild(groupEl);
      });

      standaloneInactive.forEach(function(wt) {
        var itemEl = createWorktreeDOM(wt);
        taskList.appendChild(itemEl);
      });
    }
    restoreRowFocus(focusKey);
  }

  // ---- H2: Cross-task dirty indicators ----
  //
  // Each item shows staged/unstaged/untracked counts + ahead/behind arrows.
  // A single `worktree-changed` subscription refreshes only the affected row.

  function startDirtyWatch(task) {
    if (!task || !task.worktreePath) return;
    window.klaus.fs.watchWorktree(task.worktreePath);
    refreshDirty(task.id);
  }

  function stopDirtyWatch(task) {
    if (!task || !task.worktreePath) return;
    window.klaus.fs.unwatchWorktree(task.worktreePath);
  }

  async function refreshDirty(taskId) {
    var state = await window.klaus.task.getWorktreeState(taskId);
    if (!state) return;
    applyDirtyIndicator(taskId, state);
  }

  function applyDirtyIndicator(taskId, state) {
    var item = taskList.querySelector('.task-item[data-id="' + taskId + '"]');
    if (!item) return;
    var el = item.querySelector('.dirty-indicator');
    if (!el) return;

    var parts = [];
    // git-status-style prefixes so the counts don't rely on colour alone (WCAG 1.4.1).
    if (state.staged > 0)    parts.push('<span class="dirty-staged"    title="' + state.staged + ' staged">+' + state.staged + '</span>');
    if (state.unstaged > 0)  parts.push('<span class="dirty-unstaged"  title="' + state.unstaged + ' unstaged">~' + state.unstaged + '</span>');
    if (state.untracked > 0) parts.push('<span class="dirty-untracked" title="' + state.untracked + ' untracked">?' + state.untracked + '</span>');
    if (state.ahead > 0)     parts.push('<span class="dirty-ahead"     title="' + state.ahead + ' ahead">&uarr;' + state.ahead + '</span>');
    if (state.behind > 0)    parts.push('<span class="dirty-behind"    title="' + state.behind + ' behind">&darr;' + state.behind + '</span>');
    el.innerHTML = parts.join('');
    describeTask(item);

    var hasLocalChanges = state.staged > 0 || state.unstaged > 0 || state.untracked > 0;
    // has-dirty gates the "dirty only" filter. Ahead/behind alone don't qualify —
    // pushed/pulled branches aren't waiting on the user.
    item.classList.toggle('has-dirty', hasLocalChanges);
  }

  function findTaskIdByWorktree(worktreePath) {
    for (var entry of tasks) {
      if (entry[1] && entry[1].worktreePath === worktreePath) return entry[0];
    }
    return null;
  }

  window.klaus.fs.onWorktreeChanged(function (data) {
    var taskId = findTaskIdByWorktree(data.worktreePath);
    if (taskId !== null) refreshDirty(taskId);
  });

  // ---- Task Notes Popover ----

  var activeNotePopover = null;

  function showNotePopover(anchorEl, taskName) {
    if (activeNotePopover) {
      activeNotePopover.remove();
      activeNotePopover = null;
    }

    var popover = document.createElement('div');
    popover.className = 'note-popover';
    popover.innerHTML = '<textarea class="note-textarea" placeholder="Add a note for this task..." rows="4"></textarea>';
    var textarea = popover.querySelector('textarea');
    textarea.setAttribute('aria-label', 'Note for ' + taskName);

    var rect = anchorEl.getBoundingClientRect();
    popover.style.position = 'fixed';
    popover.style.top = rect.bottom + 4 + 'px';
    popover.style.left = rect.left + 'px';
    popover.style.zIndex = '9999';

    document.body.appendChild(popover);
    activeNotePopover = popover;

    window.klaus.task.getNote(taskName).then(function (result) {
      textarea.value = result.note || '';
      textarea.focus();
    });

    textarea.addEventListener('blur', function () {
      var note = textarea.value.trim();
      window.klaus.task.setNote(taskName, note);
      anchorEl.classList.toggle('has-note', note.length > 0);
      setTimeout(function () {
        if (activeNotePopover === popover) {
          popover.remove();
          activeNotePopover = null;
        }
      }, 100);
    });

    textarea.addEventListener('keydown', function (e) {
      // The popover lives at the end of <body>, so keyboard exits go back to the Notes button rather than off the sidebar.
      if (((e.metaKey || e.ctrlKey) && e.key === 'Enter') || e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        if (anchorEl.isConnected) anchorEl.focus();
        if (document.activeElement === textarea) textarea.blur();
      }
    });

    function onOutsideClick(e) {
      if (!popover.contains(e.target) && e.target !== anchorEl) {
        textarea.blur();
        document.removeEventListener('mousedown', onOutsideClick);
      }
    }
    setTimeout(function () {
      document.addEventListener('mousedown', onOutsideClick);
    }, 0);
  }

  // ---- Sidebar updates ----

  function updateItem(id) {
    var task = tasks.get(id);
    if (!task) return;
    var item = taskList.querySelector('.task-item[data-id="' + id + '"]');
    if (item) {
      var dot = item.querySelector('.status-dot');
      var wasAlive = dot.classList.contains('alive');
      dot.className = 'status-dot ' + (task.alive ? 'alive' : 'exited');
      if (wasAlive && !task.alive) A11y.announce(task.name + ' exited');
      describeTask(item);
    }
    var gridDot = task.container.querySelector('.grid-dot');
    if (gridDot) {
      gridDot.className = 'grid-dot ' + (task.alive ? 'alive' : 'exited');
    }
  }

  function updateMode(id, mode) {
    var item = taskList.querySelector('.task-item[data-id="' + id + '"]');
    if (!item) return;
    var modeEl = item.querySelector('.task-mode');
    if (modeEl) {
      modeEl.textContent = AppUtils.modeShortLabel(mode);
      modeEl.title = AppUtils.modeDisplayName(mode);
    }
    describeTask(item);
  }

  function showResumeButton(id, task) {
    var item = taskList.querySelector('.task-item[data-id="' + id + '"]');
    if (!item) return;
    var existing = item.querySelector('.sidebar-resume-btn');
    if (existing) existing.remove();

    // Resume the agent that actually exited (captured on conversion), falling
    // back to the global default — never hardcoded to Claude.
    var agent = (task.resumeAgent && task.resumeAgent !== 'shell')
      ? task.resumeAgent
      : ((AppState.savedPrefs && (AppState.savedPrefs.defaultProvider || AppState.savedPrefs.defaultMode)) || 'claude');

    var btn = document.createElement('button');
    btn.className = 'sidebar-resume-btn';
    btn.textContent = 'Resume';
    btn.title = 'Resume ' + AppUtils.modeDisplayName(agent) + ' session';
    var closeBtn = item.querySelector('.task-close');
    if (closeBtn) {
      item.insertBefore(btn, closeBtn);
    } else {
      item.appendChild(btn);
    }
    btn.addEventListener('click', async function (e) {
      e.stopPropagation();
      var cmd;
      if (agent === 'claude') {
        // Claude tracks a per-worktree session id, so we can resume the exact
        // conversation.
        var sessionId = await window.klaus.session.getLatest(task.worktreePath);
        cmd = sessionId ? 'claude --resume ' + sessionId : 'claude';
      } else {
        // Other agents resume their latest session in-dir via their own CLI;
        // launch the agent's binary (custom paths still resolve via PATH).
        var providers = (window.klaus.ui && window.klaus.ui.providers) || [];
        var p = providers.find(function (x) { return x.id === agent; });
        cmd = (p && p.defaultBin) || agent;
      }
      window.klaus.terminal.write(id, cmd + '\n');
      task.mode = agent;
      updateMode(id, agent);
      if (window.TerminalManager && TerminalManager.refreshAgentChip) TerminalManager.refreshAgentChip(id);
      btn.remove();
    });
  }

  // ---- Unread badge ----

  function showUnreadBadge(id) {
    var item = taskList.querySelector('.task-item[data-id="' + id + '"]');
    if (!item) return;
    var badge = item.querySelector('.unread-badge');
    if (!badge || badge.classList.contains('visible')) return;
    badge.classList.add('visible');
    var task = tasks.get(id);
    if (task) A11y.announce('New output in ' + task.name);
    describeTask(item);
  }

  function hideUnreadBadge(id) {
    var item = taskList.querySelector('.task-item[data-id="' + id + '"]');
    if (!item) return;
    var badge = item.querySelector('.unread-badge');
    if (badge) badge.classList.remove('visible');
    describeTask(item);
  }

  // The row's indicators are visual-only, so their meaning is mirrored into the button's description.
  function describeTask(item) {
    var out = item && item.querySelector('[id^="task-status-"]');
    if (!out) return;
    var parts = [];
    var dot = item.querySelector('.status-dot');
    if (dot) parts.push(dot.classList.contains('alive') ? 'running' : 'exited');
    var mode = item.querySelector('.task-mode');
    if (mode && mode.title) parts.push(mode.title);
    var badge = item.querySelector('.unread-badge');
    if (badge && badge.classList.contains('visible')) parts.push('unread output');
    item.querySelectorAll('.dirty-indicator [title]').forEach(function (el) { parts.push(el.title); });
    var ci = item.querySelector('.ci-status-icon');
    if (ci && /^CI (running|passed|failed)/.test(ci.title)) parts.push(ci.title);
    out.textContent = parts.join(', ');
  }

  // ---- Task Rename ----

  function startRename(item) {
    var main = item.querySelector('.task-main');
    var nameEl = item.querySelector('.task-name');
    if (!main || !nameEl) return;
    var id = parseInt(item.dataset.id, 10);
    var task = tasks.get(id);
    if (!task) return;

    // Beside the button, not inside it: inputs nested in a <button> can't be typed into reliably.
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-rename';
    input.value = task.name;
    input.setAttribute('aria-label', 'Rename task');
    input.style.cssText = 'font-size:13px;background:var(--input-bg);border:1px solid var(--accent);border-radius:4px;color:var(--text);padding:1px 4px;flex:1;min-width:0;';

    var original = nameEl.textContent;
    main.hidden = true;
    main.after(input);
    input.focus();
    input.select();

    var done = false;
    function finish(save, refocus) {
      if (done) return;
      done = true;
      var newName = save ? (input.value.trim() || original) : original;
      input.remove();
      main.hidden = false;
      if (newName !== original) {
        nameEl.textContent = newName;
        task.name = newName;
        window.klaus.task.rename(id, newName);
      }
      if (refocus) main.focus();
    }

    // A blur commit must not refocus: Chromium would cancel the focus move that caused the blur.
    input.addEventListener('blur', function () { finish(true, false); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true, true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false, true); }
    });
  }

  taskList.addEventListener('dblclick', function (e) {
    var item = e.target.closest('.task-item[data-id]');
    if (item) startRename(item);
  });

  taskList.addEventListener('keydown', function (e) {
    var main = e.target.closest && e.target.closest('.task-main');
    if (!main) return;
    var item = main.closest('.task-item[data-id]');
    if (e.key === 'F2') {
      e.preventDefault();
      startRename(item);
      return;
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      var sibling = e.key === 'ArrowUp' ? item.previousElementSibling : item.nextElementSibling;
      if (!sibling || !sibling.matches('.task-item[data-id]')) return;
      e.preventDefault();
      if (e.key === 'ArrowUp') sibling.before(item); else sibling.after(item);
      main.focus();
      if (window.A11y) A11y.announce('Moved ' + item.querySelector('.task-name').textContent + (e.key === 'ArrowUp' ? ' up' : ' down'));
    }
  });

  // ---- Task Reorder ----

  var dragItem = null;

  taskList.addEventListener('dragstart', function (e) {
    var item = e.target.closest('.task-item[data-id]');
    if (!item) return;
    dragItem = item;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  taskList.addEventListener('dragover', function (e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    var target = e.target.closest('.task-item');
    if (!target || target === dragItem) return;
    if (dragItem.parentNode !== target.parentNode) return;
    var rect = target.getBoundingClientRect();
    var mid = rect.top + rect.height / 2;
    if (e.clientY < mid) {
      target.parentNode.insertBefore(dragItem, target);
    } else {
      target.parentNode.insertBefore(dragItem, target.nextSibling);
    }
  });

  taskList.addEventListener('dragend', function () {
    if (dragItem) {
      dragItem.classList.remove('dragging');
      dragItem = null;
    }
  });

  var observer = new MutationObserver(function () {
    taskList.querySelectorAll('.task-item[data-id]').forEach(function (item) {
      if (!item.getAttribute('draggable')) {
        item.setAttribute('draggable', 'true');
      }
    });
  });
  observer.observe(taskList, { childList: true });

  return {
    renderItem: renderItem,
    updateItem: updateItem,
    updateMode: updateMode,
    showResumeButton: showResumeButton,
    showUnreadBadge: showUnreadBadge,
    hideUnreadBadge: hideUnreadBadge,
    describeTask: describeTask,
    getSessionName: getSessionName,
    expandSession: expandSession,
    rebuild: rebuild,
    selectSession: selectSession,
  };
})();
