// Global Agents panel — surfaces every backgrounded Claude request the
// main process is tracking. Hidden in the typical flow: the trigger
// button (#btn-agents) only appears when there's at least one active
// agent or unread completion. Cmd+Shift+A toggles the dropdown.
//
// State here is a thin mirror of the main-process registry; the registry
// fans out `agents-changed` on every mutation, and we re-render from the
// snapshot. No local mutation — all commands round-trip through IPC.
//
// Click an entry's "Open" to route back to the source surface (PR review,
// diff hunk, etc.); click "Cancel" to SIGTERM the proc.

window.AgentsPanel = (function () {
  var escHtml = AppUtils.escHtml;

  var bar = document.getElementById('agents-bar');
  var btn = document.getElementById('btn-agents');
  var badge = document.getElementById('btn-agents-badge');
  var label = document.querySelector('.agents-bar-label');
  var panel = document.getElementById('agents-panel');
  var listEl = document.getElementById('agents-panel-list');
  var emptyEl = document.getElementById('agents-panel-empty');
  var clearBtn = document.getElementById('btn-agents-clear');
  var closeBtn = document.getElementById('btn-agents-close');

  var current = []; // last snapshot

  function isRunning(a) { return a.status === 'running'; }
  function isUnreadDone(a) { return a.status !== 'running' && !a.read; }

  function refreshButtonVisibility() {
    var running = current.filter(isRunning).length;
    var unread = current.filter(isUnreadDone).length;

    // Bar is always visible. Label reflects the most informative state:
    // running count, then unread count, history total, or empty state.
    bar.style.display = '';
    btn.classList.toggle('has-running', running > 0);
    btn.classList.toggle('is-empty', current.length === 0);

    if (running > 0) {
      label.textContent = running === 1 ? '1 agent running' : running + ' agents running';
    } else if (unread > 0) {
      label.textContent = unread === 1 ? '1 result ready' : unread + ' results ready';
    } else if (current.length > 0) {
      label.textContent = 'Agents';
    } else {
      label.textContent = 'No active agents';
    }

    var badgeCount = running + unread;
    if (badgeCount > 0) {
      badge.textContent = String(badgeCount);
      badge.classList.add('visible');
    } else {
      badge.classList.remove('visible');
    }
  }

  function ageString(ms) {
    var d = Date.now() - ms;
    if (d < 1000) return 'just now';
    if (d < 60 * 1000) return Math.floor(d / 1000) + 's ago';
    if (d < 60 * 60 * 1000) return Math.floor(d / 60000) + 'm ago';
    if (d < 24 * 60 * 60 * 1000) return Math.floor(d / 3600000) + 'h ago';
    return Math.floor(d / 86400000) + 'd ago';
  }

  // Human-readable title pulled from sourceContext, scoped per-kind so the
  // panel stays scannable even with a dozen entries.
  function titleFor(agent) {
    var ctx = agent.sourceContext || {};
    switch (agent.kind) {
      case 'explain-diff':
        return 'Explain ' + (ctx.file || 'code');
      case 'pr-debug-check':
        return 'Debug ' + (ctx.checkName || 'check') + ' on PR #' + (ctx.prNumber || '?');
      case 'pr-review-ai':
        return 'AI review PR #' + (ctx.prNumber || '?');
      case 'pr-ai-review':
        return 'AI review (' + (ctx.baseBranch || 'main') + ')';
      case 'pr-review-implement':
        return (ctx.mode === 'all' ? 'Implement all findings' : 'Implement finding') + ' on PR #' + (ctx.prNumber || '?');
      case 'pr-review-investigate':
        return 'Investigate finding on PR #' + (ctx.prNumber || '?');
      default:
        return agent.kind;
    }
  }

  function metaFor(agent) {
    var ctx = agent.sourceContext || {};
    var bits = [agent.status, ageString(agent.startedAt)];
    if (agent.status === 'error' && agent.error) bits.push(String(agent.error).slice(0, 60));
    if (ctx.bodyPreview) bits.push(ctx.bodyPreview.slice(0, 60));
    if (ctx.hunkPreview) bits.push(ctx.hunkPreview.replace(/\s+/g, ' ').slice(0, 60));
    return bits.join(' · ');
  }

  function render(agents) {
    current = Array.isArray(agents) ? agents : [];
    refreshButtonVisibility();

    if (panel.style.display === 'none') return;

    // Newest first so a long-running review doesn't push fresh activity
    // off-screen.
    var sorted = current.slice().sort(function (a, b) {
      // Running first, then by start time descending.
      if (isRunning(a) && !isRunning(b)) return -1;
      if (!isRunning(a) && isRunning(b)) return 1;
      return b.startedAt - a.startedAt;
    });

    if (sorted.length === 0) {
      listEl.innerHTML = '';
      emptyEl.style.display = '';
      return;
    }
    emptyEl.style.display = 'none';

    listEl.innerHTML = sorted.map(function (a) {
      var unread = isUnreadDone(a);
      return (
        '<div class="agent-item' + (unread ? ' unread' : '') + '" data-id="' + escHtml(a.id) + '">' +
          '<div class="agent-item-row">' +
            '<span class="agent-item-status ' + escHtml(a.status) + '"></span>' +
            '<span class="agent-item-title">' + escHtml(titleFor(a)) + '</span>' +
            '<div class="agent-item-actions">' +
              '<button data-action="open" data-id="' + escHtml(a.id) + '">Open</button>' +
              (a.status === 'running'
                ? '<button data-action="cancel" data-id="' + escHtml(a.id) + '">Cancel</button>'
                : '') +
            '</div>' +
          '</div>' +
          '<div class="agent-item-meta">' + escHtml(metaFor(a)) + '</div>' +
        '</div>'
      );
    }).join('');
  }

  // Action delegation — one listener for the whole list.
  listEl.addEventListener('click', function (e) {
    var actionEl = e.target.closest('button[data-action]');
    if (actionEl) {
      e.stopPropagation();
      var id = actionEl.dataset.id;
      var action = actionEl.dataset.action;
      if (action === 'cancel') {
        window.klaus.agents.cancel(id);
      } else if (action === 'open') {
        openAgent(id);
      }
      return;
    }
    // Click on the row itself = open.
    var rowEl = e.target.closest('.agent-item');
    if (rowEl) openAgent(rowEl.dataset.id);
  });

  function openAgent(id) {
    var agent = current.find(function (a) { return a.id === id; });
    if (!agent) return;
    window.klaus.agents.markRead(id);
    if (window.AgentRouter && typeof window.AgentRouter.open === 'function') {
      window.AgentRouter.open(agent);
    }
    hide();
  }

  function show() {
    panel.style.display = '';
    // Anchor the panel directly below the bar so it visually points at
    // its trigger regardless of sidebar layout / collapsed state.
    var rect = bar.getBoundingClientRect();
    panel.style.top = (rect.bottom + 4) + 'px';
    panel.style.left = (rect.left) + 'px';
    panel.style.width = Math.max(rect.width, 320) + 'px';
    render(current);
  }

  function hide() {
    panel.style.display = 'none';
  }

  function toggle() {
    if (panel.style.display === 'none') show(); else hide();
  }

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    toggle();
  });

  closeBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    hide();
  });

  clearBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    window.klaus.agents.clearCompleted();
  });

  // Click outside closes.
  document.addEventListener('click', function (e) {
    if (panel.style.display === 'none') return;
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    hide();
  });

  // Cmd/Ctrl+Shift+A toggles the panel. Only fires when the button is
  // actually visible (i.e. there's something to show) so the shortcut
  // doesn't pop an empty UI.
  document.addEventListener('keydown', function (e) {
    var mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
      if (btn.style.display === 'none') return;
      e.preventDefault();
      toggle();
    }
  });

  // Subscribe to registry mutations + initial load.
  window.klaus.agents.onChanged(render);
  window.klaus.agents.list().then(render);

  // Re-render every 30s so the relative ages stay reasonably fresh while
  // the panel is open. Cheap — render() short-circuits when hidden.
  setInterval(function () { if (panel.style.display !== 'none') render(current); }, 30000);

  return { show: show, hide: hide, toggle: toggle };
})();
