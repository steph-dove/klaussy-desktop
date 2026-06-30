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
    if (header) {
      header.classList.add('active');
    }
    AppState.activeSessionName = sessionName;
    AppState.activeTaskId = null;
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

  function getOrCreateSessionGroup(sessionName) {
    var groupEl = taskList.querySelector('.session-group[data-session="' + sessionName + '"]');
    if (!groupEl) {
      groupEl = document.createElement('div');
      groupEl.className = 'session-group';
      groupEl.dataset.session = sessionName;

      var header = document.createElement('div');
      header.className = 'session-group-header';
      
      var isCollapsed = collapsedSessions.has(sessionName);
      if (isCollapsed) header.classList.add('collapsed');

      header.innerHTML = 
        '<span class="session-group-chevron">' + (isCollapsed ? '&#9656;' : '&#9662;') + '</span>' +
        '<span class="session-group-icon">&#128193;</span>' +
        '<span class="session-group-name">' + escHtml(sessionName) + '</span>' +
        '<span class="session-group-badge">0</span>' +
        '<button class="session-group-close" title="Close Session">&times;</button>';

      var itemsContainer = document.createElement('div');
      itemsContainer.className = 'session-group-items';
      if (isCollapsed) itemsContainer.classList.add('collapsed');

      header.addEventListener('click', function (e) {
        if (e.target.classList.contains('session-group-close')) return;
        var collapsed = itemsContainer.classList.toggle('collapsed');
        header.classList.toggle('collapsed', collapsed);
        var chevron = header.querySelector('.session-group-chevron');
        if (chevron) chevron.innerHTML = collapsed ? '&#9656;' : '&#9662;';
        if (collapsed) {
          collapsedSessions.add(sessionName);
        } else {
          collapsedSessions.delete(sessionName);
        }
      });

      header.querySelector('.session-group-close').addEventListener('click', function (e) {
        e.stopPropagation();
        var closes = itemsContainer.querySelectorAll('.task-close, .worktree-remove');
        closes.forEach(function (c) { c.click(); });
      });

      groupEl.appendChild(header);
      groupEl.appendChild(itemsContainer);
      taskList.appendChild(groupEl);
    }
    return groupEl;
  }

  function updateSessionGroupBadge(groupEl) {
    var badge = groupEl.querySelector('.session-group-badge');
    var itemsContainer = groupEl.querySelector('.session-group-items');
    if (badge && itemsContainer) {
      badge.textContent = itemsContainer.querySelectorAll('.task-item').length;
    }
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
      '<span class="status-dot ' + (task.alive ? 'alive' : 'exited') + '"></span>' +
      '<span class="collapsed-icon" style="background:' + tIconColor + '" title="' + escHtml(task.name) + '">' + tIconLetter + '</span>' +
      '<span class="task-mode" title="' + escHtml(AppUtils.modeDisplayName(task.mode)) + '">' + modeLabel + '</span>' +
      '<span class="task-name" title="' + escHtml(task.worktreePath) + '">' + escHtml(task.name) + '</span>' +
      '<span class="ci-status-icon" title="CI status"></span>' +
      '<span class="dirty-indicator"></span>' +
      '<span class="unread-badge"></span>' +
      '<button class="task-note-btn" title="Notes">&#9998;</button>' +
      '<button class="task-close" title="Remove">&times;</button>';

    item.addEventListener('click', function (e) {
      if (e.target.classList.contains('task-close') || e.target.classList.contains('task-note-btn')) return;
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

    // Task notes
    var noteBtn = item.querySelector('.task-note-btn');
    window.klaus.task.getNote(task.name).then(function (result) {
      if (result.note) noteBtn.classList.add('has-note');
    });
    noteBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      showNotePopover(noteBtn, task.name);
    });

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
      var modeLabel = wt.mode === 'shell' ? 'SH' : AppUtils.modeShortLabel(wt.mode);
      var modeTitle = wt.mode === 'shell' ? 'Previous shell session' : 'Previous ' + AppUtils.modeDisplayName(wt.mode) + ' session';
      
      item.innerHTML =
        '<span class="status-dot saved"></span>' +
        '<span class="collapsed-icon" style="background:' + iconColor + '" title="' + escHtml(repoName) + '">' + iconLetter + '</span>' +
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
          '<button class="saved-session-dismiss" title="Dismiss">&times;</button>' +
        '</div>';

      item.querySelector('.saved-session-resume').addEventListener('click', async function (e) {
        e.stopPropagation();
        var btn = e.target;
        btn.disabled = true;
        btn.textContent = '...';
        var result;
        try {
          if (wt.mode === 'shell') {
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
        window.App.addTaskToUI(result);
        window.App.switchToTask(result.id);
        window.App.restoreUIState(result);
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
        '<span class="status-dot idle"></span>' +
        '<span class="collapsed-icon" style="background:' + iconColor + '" title="' + escHtml(repoName) + '">' + iconLetter + '</span>' +
        '<div class="saved-session-info">' +
          '<span class="task-name" title="' + escHtml(wt.path) + '">' + escHtml(repoName) + '</span>' +
          '<span class="saved-session-detail">' + escHtml(wt.branch) + '</span>' +
        '</div>' +
        '<div class="saved-session-actions">' +
          '<button class="worktree-open-claude" title="Open with ' + escHtml(AppUtils.modeDisplayName(window.App.defaultAgent())) + '">' + escHtml(AppUtils.modeShortLabel(window.App.defaultAgent())) + '</button>' +
          '<button class="worktree-open-shell" title="Open shell">sh</button>' +
          '<button class="worktree-remove" title="Remove worktree">\u00d7</button>' +
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
      resumeBtnHtml = '<button class="session-group-resume-btn" title="Resume All Repos in Session">&#9654; Resume All</button>';
    }

    header.innerHTML = 
      '<span class="session-group-chevron">' + (isCollapsed ? '&#9656;' : '&#9662;') + '</span>' +
      '<span class="session-group-icon">&#128193;</span>' +
      '<span class="session-group-name">' + escHtml(sessionName) + '</span>' +
      '<span class="session-group-badge">' + totalCount + '</span>' +
      resumeBtnHtml +
      '<button class="session-group-close" title="Close Session">&times;</button>';

    var itemsContainer = document.createElement('div');
    itemsContainer.className = 'session-group-items';
    if (isCollapsed) itemsContainer.classList.add('collapsed');

    header.addEventListener('click', function (e) {
      if (e.target.closest('.session-group-close') || e.target.closest('.session-group-resume-btn')) return;
      if (e.target.closest('.session-group-name') || e.target.closest('.session-group-icon') || e.target.closest('.session-group-badge')) {
        e.stopPropagation();
        selectSession(sessionName);
        return;
      }
      var collapsed = itemsContainer.classList.toggle('collapsed');
      header.classList.toggle('collapsed', collapsed);
      var chevron = header.querySelector('.session-group-chevron');
      if (chevron) chevron.innerHTML = collapsed ? '&#9656;' : '&#9662;';
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
          try {
            var result = await window.klaus.task.attachWorktree(wt.path, window.App.defaultAgent(), wt.repoPath, wt.branch);
            if (result && !result.error) {
              window.App.addTaskToUI(result);
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

  function rebuild() {
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
    if (state.staged > 0)    parts.push('<span class="dirty-staged"    title="' + state.staged + ' staged">' + state.staged + '</span>');
    if (state.unstaged > 0)  parts.push('<span class="dirty-unstaged"  title="' + state.unstaged + ' unstaged">' + state.unstaged + '</span>');
    if (state.untracked > 0) parts.push('<span class="dirty-untracked" title="' + state.untracked + ' untracked">' + state.untracked + '</span>');
    if (state.ahead > 0)     parts.push('<span class="dirty-ahead"     title="' + state.ahead + ' ahead">&uarr;' + state.ahead + '</span>');
    if (state.behind > 0)    parts.push('<span class="dirty-behind"    title="' + state.behind + ' behind">&darr;' + state.behind + '</span>');
    el.innerHTML = parts.join('');

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
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') textarea.blur();
      if (e.key === 'Escape') textarea.blur();
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
      dot.className = 'status-dot ' + (task.alive ? 'alive' : 'exited');
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
    if (badge) badge.classList.add('visible');
  }

  function hideUnreadBadge(id) {
    var item = taskList.querySelector('.task-item[data-id="' + id + '"]');
    if (!item) return;
    var badge = item.querySelector('.unread-badge');
    if (badge) badge.classList.remove('visible');
  }

  // ---- Task Rename ----

  taskList.addEventListener('dblclick', function (e) {
    var item = e.target.closest('.task-item[data-id]');
    if (!item) return;
    var nameEl = item.querySelector('.task-name');
    if (!nameEl) return;
    var id = parseInt(item.dataset.id, 10);
    var task = tasks.get(id);
    if (!task) return;

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-rename';
    input.value = task.name;
    input.style.cssText = 'font-size:13px;background:var(--input-bg);border:1px solid var(--accent);border-radius:4px;color:var(--text);padding:1px 4px;width:100%;outline:none;';

    var original = nameEl.textContent;
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();

    function commit() {
      var newName = input.value.trim() || original;
      nameEl.textContent = newName;
      task.name = newName;
      window.klaus.task.rename(id, newName);
      // Only the sidebar name needs updating on rename. (The old wholesale
      // .grid-label rewrite here destroyed the name/actions span structure
      // and with it the actions dropdown.)
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = original; input.blur(); }
    });
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
    getSessionName: getSessionName,
    getOrCreateSessionGroup: getOrCreateSessionGroup,
    updateSessionGroupBadge: updateSessionGroupBadge,
    expandSession: expandSession,
    rebuild: rebuild,
    selectSession: selectSession,
  };
})();
