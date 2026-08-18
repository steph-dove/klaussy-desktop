window.SessionNotesPanel = (function () {
  var escHtml = AppUtils.escHtml;

  var notesList = document.getElementById('session-notes-list');
  var notesDirLabel = document.getElementById('session-notes-dir');
  var btnRefresh = document.getElementById('btn-session-notes-refresh');
  var btnClear = document.getElementById('btn-session-notes-clear');
  var btnCapture = document.getElementById('btn-session-notes-capture');

  // Notes arrive from other agents' processes, not this window, so nothing
  // pushes an update here.
  var POLL_MS = 10000;
  var pollTimer = null;

  window.addEventListener('load-session-notes', function () { loadNotes(); startPolling(); });
  window.addEventListener('leave-session-notes', stopPolling);

  function activeWorktree() {
    var task = AppState.activeTaskId ? AppState.tasks.get(AppState.activeTaskId) : null;
    return task ? task.worktreePath : null;
  }

  function isVisible() {
    var el = document.getElementById('notes-tab-content');
    return el && el.style.display !== 'none';
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      if (!isVisible()) { stopPolling(); return; }
      loadNotes();
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function timeAgo(ms) {
    if (!ms) return '';
    var secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.round(secs / 60) + 'm ago';
    if (secs < 86400) return Math.round(secs / 3600) + 'h ago';
    return Math.round(secs / 86400) + 'd ago';
  }

  function noteTime(note) {
    var stamped = note.metadata && note.metadata.timestamp
      ? new Date(note.metadata.timestamp).getTime() : 0;
    return stamped || note.writtenAt || 0;
  }

  // A note's fields are whatever an agent typed, so a list may arrive as a
  // bare string.
  function asList(value) {
    if (Array.isArray(value)) return value;
    return value ? [String(value)] : [];
  }

  function render(notes) {
    if (!notes.length) {
      notesList.innerHTML = '<div class="file-tree-empty">'
        + 'No active session notes.<br><br>'
        + 'Agents in this session write notes here when they change a port or schema, '
        + 'hit a breaking change, or find something the next agent would trip over. '
        + 'Notes are shared by every repo in the session and live outside the repository. '
        + 'They are kept indefinitely, but only ones from the last few days are '
        + 'passed on to agents as current.'
        + '</div>';
      return;
    }
    notesList.innerHTML = '';
    notes.forEach(function (note) {
      var meta = note.metadata || {};
      var files = asList(meta.affected_files);
      var tags = asList(meta.tags);
      var who = meta.agent || 'unknown';
      var provider = meta.provider && meta.provider !== 'unknown' ? ' (' + meta.provider + ')' : '';

      var item = document.createElement('div');
      item.className = 'session-note-item';
      item.innerHTML =
        '<div class="session-note-head">'
          + '<span class="session-note-agent">' + escHtml(who + provider) + '</span>'
          + '<span class="session-note-time">' + escHtml(timeAgo(noteTime(note))) + '</span>'
        + '</div>'
        + '<div class="session-note-body">' + escHtml(note.body || '') + '</div>'
        + (files.length
          ? '<div class="session-note-files">' + escHtml(files.join(', ')) + '</div>' : '')
        + (tags.length
          ? '<div class="session-note-tags">'
            + tags.map(function (t) {
              return '<span class="session-note-tag">' + escHtml(String(t)) + '</span>';
            }).join('')
            + '</div>'
          : '');
      notesList.appendChild(item);
    });
  }

  async function loadNotes() {
    var wt = activeWorktree();
    if (!wt) {
      notesList.innerHTML = '<div class="file-tree-empty">No active task</div>';
      notesDirLabel.textContent = '';
      return;
    }
    var notes = await window.klaus.task.sessionContext.listNotes(wt);
    if (notes && notes.error) {
      notesList.innerHTML = '<div class="file-tree-empty">Error: ' + escHtml(notes.error) + '</div>';
      return;
    }
    notes = notes || [];
    render(notes);
    notesDirLabel.textContent = notes.length && notes[0].filePath
      ? notes[0].filePath.replace(/\/[^/]*$/, '') : '';
    btnClear.disabled = !notes.length;
  }

  btnRefresh.addEventListener('click', loadNotes);

  btnCapture.addEventListener('click', async function () {
    // Each eligible agent costs a headless summarizer call, so this can take seconds.
    btnCapture.disabled = true;
    btnCapture.textContent = 'Capturing...';
    var res;
    try {
      res = await window.klaus.task.sessionContext.captureNow(activeWorktree());
    } catch (err) {
      res = { error: (err && err.message) || String(err) };
    } finally {
      btnCapture.disabled = false;
      btnCapture.textContent = 'Capture now';
    }
    if (res && res.error) {
      window.toast.error('Capture failed: ' + res.error);
    } else if (res && res.written) {
      window.toast.success('Captured ' + res.written + ' note' + (res.written === 1 ? '' : 's'));
    } else if (res && !res.inSession) {
      window.toast.info(res.elsewhere
        ? 'No agent is running in this session. ' + res.elsewhere
          + ' running elsewhere — notes are shared per session, not across them.'
        : 'No agent is running in this session.');
    } else {
      window.toast.info('Nothing new to capture — the '
        + res.inSession + ' agent' + (res.inSession === 1 ? '' : 's')
        + ' here have said nothing since the last pass.');
    }
    loadNotes();
  });

  btnClear.addEventListener('click', async function () {
    var wt = activeWorktree();
    if (!wt) return;
    if (!confirm('Clear all session notes for this repo? Other agents in this session will lose them too.')) return;
    var ok = await window.klaus.task.sessionContext.clearNotes(wt);
    if (ok && ok.error) window.toast.error('Clear failed: ' + ok.error);
    loadNotes();
  });

  return {
    loadNotes: loadNotes,
    stopPolling: stopPolling,
  };
})();
