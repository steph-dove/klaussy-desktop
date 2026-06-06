window.Sidebar = (function () {
  var escHtml = AppUtils.escHtml;
  var tasks = AppState.tasks;
  var taskList = document.getElementById('task-list');

  // ---- Sidebar item rendering ----

  function renderItem(task) {
    var item = document.createElement('div');
    item.className = 'task-item';
    item.dataset.id = task.id;
    item.dataset.repo = task.repoPath || '';

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
      // Plain-folder tasks have no branch — re-attaching requires a git repo,
      // so don't offer the reopen row; the user can re-launch via Open Folder.
      if (wt.branch) window._addWorktreeToSidebar(wt);
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

    taskList.appendChild(item);
    startDirtyWatch(task);
  }

  // ---- H2: Cross-task dirty indicators ----
  //
  // Each task item shows a compact summary of its worktree state: staged /
  // unstaged / untracked counts plus ahead/behind arrows. We subscribe to H3's
  // `worktree-changed` event once at module init and refresh only the affected
  // row (granular, not a full re-render) so a save in one worktree doesn't
  // restat every sibling.

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

    var btn = document.createElement('button');
    btn.className = 'sidebar-resume-btn';
    btn.textContent = 'Resume';
    btn.title = 'Resume Claude session';
    var closeBtn = item.querySelector('.task-close');
    if (closeBtn) {
      item.insertBefore(btn, closeBtn);
    } else {
      item.appendChild(btn);
    }
    btn.addEventListener('click', async function (e) {
      e.stopPropagation();
      var sessionId = await window.klaus.session.getLatest(task.worktreePath);
      var cmd = sessionId ? 'claude --resume ' + sessionId : 'claude';
      window.klaus.terminal.write(id, cmd + '\n');
      task.mode = 'claude';
      updateMode(id, 'claude');
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
      var gridLabel = task.container.querySelector('.grid-label');
      if (gridLabel) {
        var dot = gridLabel.querySelector('.grid-dot');
        gridLabel.textContent = '';
        if (dot) gridLabel.appendChild(dot);
        gridLabel.appendChild(document.createTextNode(newName));
      }
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
    var rect = target.getBoundingClientRect();
    var mid = rect.top + rect.height / 2;
    if (e.clientY < mid) {
      taskList.insertBefore(dragItem, target);
    } else {
      taskList.insertBefore(dragItem, target.nextSibling);
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
  };
})();
