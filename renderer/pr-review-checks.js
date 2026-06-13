// Part of the PrReview surface (window.PrReview); see pr-review.js for the
// core. Checks/CI tab UI, debug/fix panels, merge controls.
// All cross-references go through the shared `PR` object, so load order
// only needs core (pr-review.js) first; siblings may load in any order.

(function (PR) {

  // Swap only the .pr-review-checks-tab innerHTML and rebind. Leaves the
  // rest of the PR-review surface untouched so action-driven refreshes
  // (rerun, cancel, periodic poll) don't flash the whole tab.
  // Build a stable signature of the data that drives renderChecksTab(). Used
  // by repaintChecksTab to skip no-op repaints. Excludes derived-from-clock
  // bits (in-progress duration ticks) — those will catch up the next time
  // the underlying state actually changes, which is fine for a value rounded
  // to the minute.
  PR.checksSignature = function() {
    var parts = [];
    if (PR.currentChecks && PR.currentChecks.error) parts.push('ERR:' + PR.currentChecks.error);
    var checks = (PR.currentChecks && PR.currentChecks.checks) || [];
    checks.forEach(function (c) {
      parts.push([
        c.id, c.name, c.workflow, c.description,
        c.state, c.conclusion, c.startedAt, c.completedAt,
        c.runId, c.link
      ].join('|'));
    });
    parts.push('REQ:' + (PR.currentRequiredChecks || []).join(','));
    parts.push('REQERR:' + (PR.currentRequiredChecksError || ''));
    return parts.join('\n');
  };

  PR.repaintChecksTab = function(opts) {
    var slot = PR.hostEl.querySelector('.pr-review-checks-tab');
    if (!slot) return;
    var force = opts && opts.force;
    var sig = PR.checksSignature();
    // No-op when polling lands the same data we already painted. Without
    // this, the 15s tick would tear down and rebuild the tab even when
    // nothing's changed.
    if (!force && sig === PR.lastChecksSignature && slot.firstChild) return;
    PR.lastChecksSignature = sig;

    // Detach any live Fix panels so we can re-attach them after the wipe.
    // Detached DOM keeps its event listeners and IPC subscriptions alive,
    // so the stream keeps flowing into the same panel without restart.
    var liveFixPanels = [];
    slot.querySelectorAll('.pr-check-fix-panel').forEach(function (p) {
      if (p.dataset.checkId) {
        p.parentNode.removeChild(p);
        liveFixPanels.push(p);
      }
    });

    slot.innerHTML = PR.renderChecksTab();
    PR.bindChecksTab(); // bindChecksTab now also restores annotations + debug panels

    liveFixPanels.forEach(function (p) {
      var btn = slot.querySelector('.pr-check-fix-btn[data-check-id="' + p.dataset.checkId + '"]');
      if (!btn) return; // row no longer in the rendered set (check passed/disappeared)
      var row = btn.closest('.pr-check-row');
      if (row) row.insertAdjacentElement('afterend', p);
    });
  };

  // Periodic refresh while Checks is the active tab. Idempotent — calling
  // start while already running just resets the interval. Stops on tab
  // switch (bindTabs hook) and on PR change (clearChecksPolling at the top
  // of render() when isNewPr).
  PR.startChecksPolling = function() {
    PR.clearChecksPolling();
    // Kick off an immediate refresh on tab activation so the user sees fresh
    // data without clicking Refresh. Skip if the PR isn't loaded yet.
    if (PR.lastState && PR.lastState.number && !PR.checksFetchInFlight) {
      PR.checksFetchInFlight = true;
      PR.fetchAndRenderChecks(PR.lastState.number).then(function () {
        PR.checksFetchInFlight = false;
        PR.repaintChecksTab();
      }, function () { PR.checksFetchInFlight = false; });
    }
    PR.checksPollTimer = setInterval(function () {
      if (!PR.lastState || !PR.lastState.number) { PR.clearChecksPolling(); return; }
      // Skip if the previous poll hasn't returned yet — avoids fetch storms
      // when the user's network is slow.
      if (PR.checksFetchInFlight) return;
      PR.checksFetchInFlight = true;
      PR.fetchAndRenderChecks(PR.lastState.number).then(function () {
        PR.checksFetchInFlight = false;
        PR.repaintChecksTab();
      }, function () { PR.checksFetchInFlight = false; });
    }, 15000);
  };

  PR.clearChecksPolling = function() {
    if (PR.checksPollTimer) { clearInterval(PR.checksPollTimer); PR.checksPollTimer = null; }
  };

  // Hand-built modal for manually dispatching a workflow. Inputs are accepted
  // as a raw JSON object since parsing the workflow YAML's `on.workflow_dispatch.inputs`
  // would require pulling in a YAML lib for a niche feature. Most workflows
  // either have no inputs or simple key/value inputs the user already knows.
  PR.openWorkflowDispatchModal = function() {
    var existing = document.querySelector('.pr-workflow-dispatch-modal-backdrop');
    if (existing) { existing.remove(); return; }

    var defaultRef = (PR.lastState && PR.lastState.headRefName) || '';
    var backdrop = document.createElement('div');
    backdrop.className = 'pr-workflow-dispatch-modal-backdrop';
    backdrop.innerHTML = '<div class="pr-workflow-dispatch-modal">'
        + '<div class="pr-workflow-dispatch-head">Dispatch workflow</div>'
        + '<div class="pr-workflow-dispatch-body">'
          + '<label>Workflow</label>'
          + '<select class="pr-workflow-select"><option value="">Loading…</option></select>'
          + '<label>Ref (branch or tag)</label>'
          + '<input class="pr-workflow-ref" type="text" value="' + PR.escHtml(defaultRef) + '" />'
          + '<label>Inputs (JSON object, optional)</label>'
          + '<textarea class="pr-workflow-inputs" placeholder=\'{"environment": "staging"}\'></textarea>'
          + '<div class="pr-workflow-dispatch-error" hidden></div>'
        + '</div>'
        + '<div class="pr-workflow-dispatch-actions">'
          + '<button type="button" class="pr-workflow-dispatch-cancel">Cancel</button>'
          + '<button type="button" class="pr-workflow-dispatch-go">Dispatch</button>'
        + '</div>'
      + '</div>';
    document.body.appendChild(backdrop);

    var selectEl = backdrop.querySelector('.pr-workflow-select');
    var refEl = backdrop.querySelector('.pr-workflow-ref');
    var inputsEl = backdrop.querySelector('.pr-workflow-inputs');
    var errorEl = backdrop.querySelector('.pr-workflow-dispatch-error');
    var goBtn = backdrop.querySelector('.pr-workflow-dispatch-go');

    function close() { backdrop.remove(); }
    backdrop.querySelector('.pr-workflow-dispatch-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });

    window.klaus.pr.reviewWorkflowsList().then(function (res) {
      if (res && res.error) {
        selectEl.innerHTML = '<option value="">— failed to load —</option>';
        errorEl.textContent = res.error;
        errorEl.hidden = false;
        return;
      }
      var ws = (res && res.workflows) || [];
      if (ws.length === 0) {
        selectEl.innerHTML = '<option value="">— no active workflows —</option>';
        return;
      }
      selectEl.innerHTML = ws.map(function (w) {
        return '<option value="' + PR.escHtml(String(w.id)) + '">' + PR.escHtml(w.name) + ' (' + PR.escHtml(w.path) + ')</option>';
      }).join('');
    });

    goBtn.addEventListener('click', function () {
      var workflowId = selectEl.value;
      if (!workflowId) { errorEl.textContent = 'Choose a workflow.'; errorEl.hidden = false; return; }
      var ref = refEl.value.trim();
      if (!ref) { errorEl.textContent = 'Ref is required.'; errorEl.hidden = false; return; }
      var inputs = {};
      var raw = inputsEl.value.trim();
      if (raw) {
        try { inputs = JSON.parse(raw); }
        catch (err) { errorEl.textContent = 'Inputs must be valid JSON: ' + err.message; errorEl.hidden = false; return; }
        if (typeof inputs !== 'object' || Array.isArray(inputs) || inputs === null) {
          errorEl.textContent = 'Inputs must be a JSON object.';
          errorEl.hidden = false;
          return;
        }
      }
      goBtn.disabled = true;
      goBtn.textContent = 'Dispatching…';
      errorEl.hidden = true;
      window.klaus.pr.reviewWorkflowDispatch(workflowId, ref, inputs).then(function (res) {
        if (res && res.error) {
          goBtn.disabled = false;
          goBtn.textContent = 'Dispatch';
          errorEl.textContent = res.error;
          errorEl.hidden = false;
          return;
        }
        // Successful dispatch. Refresh checks so the new run shows up promptly.
        close();
        if (PR.lastState) {
          PR.fetchAndRenderChecks(PR.lastState.number).then(function () { PR.render(PR.lastState); });
        }
      });
    });
  };

  PR.annotationsPanelHtml = function(state) {
    if (!state || (state.data == null && !state.error)) {
      return '<div class="pr-check-annotations-body">Loading annotations…</div>';
    }
    if (state.error) {
      return '<div class="pr-check-annotations-body diff-error">Failed to load annotations: '
        + PR.escHtml(state.error) + '</div>';
    }
    var ann = state.data || [];
    if (ann.length === 0) {
      return '<div class="pr-check-annotations-body pr-check-annotations-empty">No annotations from this check.</div>';
    }
    return '<div class="pr-check-annotations-body">' + ann.map(function (a) {
      var levelClass = 'pr-annotation-' + (a.level || 'notice').replace(/[^a-z]/gi, '');
      var loc = a.path ? PR.escHtml(a.path) + (a.startLine ? ':' + a.startLine : '') : '';
      return '<div class="pr-annotation ' + levelClass + '">'
        + '<div class="pr-annotation-head">'
          + '<span class="pr-annotation-level">' + PR.escHtml(a.level || 'notice') + '</span>'
          + (loc ? '<span class="pr-annotation-loc">' + loc + '</span>' : '')
          + (a.title ? '<span class="pr-annotation-title">' + PR.escHtml(a.title) + '</span>' : '')
        + '</div>'
        + '<div class="pr-annotation-msg">' + PR.escHtml(a.message || '') + '</div>'
        + (a.rawDetails ? '<pre class="pr-annotation-raw">' + PR.escHtml(a.rawDetails) + '</pre>' : '')
      + '</div>';
    }).join('') + '</div>';
  };

  // Insert (or replace) the annotations panel for this checkId. Looks up
  // existing panels by data-check-id rather than row.nextElementSibling so
  // multiple action panels under the same row (Debug + Annotations) don't
  // confuse the duplicate-detection and end up stacking.
  PR.mountAnnotationsPanel = function(row, checkId) {
    var existing = PR.hostEl.querySelector('.pr-check-annotations-panel[data-check-id="' + checkId + '"]');
    var panel = existing || document.createElement('div');
    panel.className = 'pr-check-annotations-panel';
    panel.dataset.checkId = checkId;
    panel.innerHTML = PR.annotationsPanelHtml(PR.openAnnotations[checkId]);
    if (!existing) row.insertAdjacentElement('afterend', panel);
    return panel;
  };

  PR.fetchAnnotations = function(checkId) {
    window.klaus.pr.reviewCheckAnnotations(checkId).then(function (res) {
      if (!PR.openAnnotations[checkId]) return; // user collapsed before fetch returned
      if (res && res.error) {
        PR.openAnnotations[checkId] = { data: null, error: res.error };
      } else {
        PR.openAnnotations[checkId] = { data: (res && res.annotations) || [], error: null };
      }
      PR.restoreOpenAnnotations();
    }).catch(function (err) {
      if (!PR.openAnnotations[checkId]) return;
      PR.openAnnotations[checkId] = { data: null, error: (err && err.message) || 'unknown error' };
      PR.restoreOpenAnnotations();
    });
  };

  // Re-mount any annotations panels the user had expanded. Called after
  // repaintChecksTab() blows away the tab DOM.
  PR.restoreOpenAnnotations = function() {
    Object.keys(PR.openAnnotations).forEach(function (checkId) {
      var btn = PR.hostEl.querySelector('.pr-check-annotations-btn[data-check-id="' + checkId + '"]');
      if (!btn) return; // row no longer in the rendered set (e.g., check passed after rerun)
      var row = btn.closest('.pr-check-row');
      if (row) PR.mountAnnotationsPanel(row, checkId);
    });
  };

  // Click handler: toggle the panel for this row. Fetches lazily on first
  // expand; subsequent expands reuse the cached annotations so polling
  // repaints don't refetch. Lookup is by data-check-id, not nextElementSibling,
  // so an in-the-way Debug panel doesn't confuse the close path.
  PR.toggleAnnotations = function(btn) {
    var row = btn.closest('.pr-check-row');
    if (!row) return;
    var checkId = btn.dataset.checkId;
    if (!checkId) return;
    if (PR.openAnnotations[checkId]) {
      delete PR.openAnnotations[checkId];
      var existing = PR.hostEl.querySelector('.pr-check-annotations-panel[data-check-id="' + checkId + '"]');
      if (existing) existing.remove();
      return;
    }
    PR.openAnnotations[checkId] = { data: null, error: null };
    PR.mountAnnotationsPanel(row, checkId);
    PR.fetchAnnotations(checkId);
  };

  PR.DEBUG_STATUS_MESSAGES = [
    'Fetching failing job log\u2026',
    'Reading PR diff\u2026',
    'Looking for the failing line\u2026',
    'Comparing failure to the change\u2026',
    'Drafting analysis\u2026',
  ];

  // Re-paint whichever panel DOM is currently mounted for this checkId from
  // the cached entry. Streaming subscriptions call this on every chunk/done
  // — so the same stream keeps updating the panel even if it gets remounted
  // (full re-render, polling repaint) underneath.
  PR.paintDebugPanel = function(checkId) {
    var entry = PR.openDebugChecks[checkId];
    if (!entry) return;
    var panel = PR.hostEl.querySelector('.pr-check-debug-panel[data-check-id="' + checkId + '"]');
    if (!panel) return;
    var bodyEl = panel.querySelector('.pr-check-debug-body');
    if (!bodyEl) return;

    if (entry.state === 'error') {
      bodyEl.classList.remove('status-pulse');
      bodyEl.classList.add('diff-error');
      bodyEl.textContent = entry.error || 'Failed';
    } else if (entry.state === 'cancelled') {
      bodyEl.classList.remove('status-pulse');
      bodyEl.textContent = entry.accumulated || 'Cancelled.';
    } else if (entry.accumulated) {
      bodyEl.classList.remove('status-pulse');
      bodyEl.textContent = entry.accumulated;
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }

    // Chat affordance — only meaningful once the analysis is done. Lives
    // between the analysis body and the action footer. The log is rebuilt
    // every paint (cheap, includes the in-flight assistant bubble); the
    // composer is built once per mount so the textarea keeps its focus and
    // mid-typed value while the assistant streams.
    if (entry.state === 'done') {
      var chatEl = panel.querySelector('.pr-check-debug-chat');
      if (!chatEl) {
        chatEl = document.createElement('div');
        chatEl.className = 'pr-check-debug-chat';
        chatEl.innerHTML =
          '<div class="pr-check-debug-chat-log"></div>'
          + '<form class="pr-check-debug-chat-composer">'
            + '<textarea class="pr-check-debug-chat-input" rows="2" placeholder="Ask the agent about this analysis…"></textarea>'
            + '<button class="pr-check-debug-chat-send" type="submit">Send</button>'
          + '</form>';
        // Insert before the footer if it exists, otherwise at the end.
        var existingFooter = panel.querySelector('.pr-check-debug-footer');
        if (existingFooter) panel.insertBefore(chatEl, existingFooter);
        else panel.appendChild(chatEl);

        var formEl = chatEl.querySelector('.pr-check-debug-chat-composer');
        var inputEl = chatEl.querySelector('.pr-check-debug-chat-input');
        formEl.addEventListener('submit', function (e) {
          e.preventDefault();
          var text = (inputEl.value || '').trim();
          if (!text) return;
          inputEl.value = '';
          PR.sendDebugChatTurn(checkId, text);
        });
        // Cmd/Ctrl+Enter to send; bare Enter inserts a newline (matches the
        // AI Review chat composer).
        inputEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            formEl.requestSubmit();
          }
        });
      }

      var logEl = chatEl.querySelector('.pr-check-debug-chat-log');
      var turns = (entry.chatMessages || []).map(function (m) {
        var cls = m.role === 'assistant' ? 'pr-check-debug-chat-assistant' : 'pr-check-debug-chat-user';
        return '<div class="' + cls + '">' + PR.escHtml(m.content) + '</div>';
      });
      if (entry.chatStreaming) {
        turns.push('<div class="pr-check-debug-chat-assistant pr-check-debug-chat-streaming">' + PR.escHtml(entry.chatStreaming) + '</div>');
      } else if (entry.chatRequestId) {
        turns.push('<div class="pr-check-debug-chat-assistant pr-check-debug-chat-streaming">…</div>');
      }
      if (entry.chatError) {
        turns.push('<div class="pr-check-debug-chat-error">' + PR.escHtml(entry.chatError) + '</div>');
      }
      logEl.innerHTML = turns.join('');
      logEl.scrollTop = logEl.scrollHeight;

      var sendBtn = chatEl.querySelector('.pr-check-debug-chat-send');
      var inputBtn = chatEl.querySelector('.pr-check-debug-chat-input');
      var streaming = !!entry.chatRequestId;
      sendBtn.disabled = streaming;
      sendBtn.textContent = streaming ? 'Sending…' : 'Send';
      inputBtn.disabled = streaming;
    }

    var footerEl = panel.querySelector('.pr-check-debug-footer');
    if (entry.state === 'done') {
      if (!footerEl) {
        footerEl = document.createElement('div');
        footerEl.className = 'pr-check-debug-footer';
        panel.appendChild(footerEl);
      }
      var openLabel = entry.openTaskState === 'opened' ? 'Opened ✓'
        : entry.openTaskState === 'opening' ? 'Opening…'
        : entry.openTaskState === 'failed' ? 'Failed'
        : 'Open as task';
      footerEl.innerHTML =
        '<div class="pr-check-debug-usage">Ran in ' + PR.escHtml(String(entry.durationSec || 0)) + 's on your Anthropic account</div>'
        + '<div class="pr-check-debug-actions">'
          + '<button class="pr-check-debug-fix pr-check-action-primary" type="button" title="Apply this analysis as a code fix in the PR worktree">Fix this</button>'
          + '<button class="pr-check-debug-open-task" type="button"' + (entry.openTaskState === 'opening' ? ' disabled' : '') + ' title="Spawn an interactive agent task seeded with this analysis">' + PR.escHtml(openLabel) + '</button>'
        + '</div>';

      footerEl.querySelector('.pr-check-debug-fix').addEventListener('click', function () {
        var fixBtn = PR.hostEl.querySelector('.pr-check-fix-btn[data-check-id="' + checkId + '"]');
        if (fixBtn) PR.startFixCheck(fixBtn);
      });

      footerEl.querySelector('.pr-check-debug-open-task').addEventListener('click', function () {
        var e = PR.openDebugChecks[checkId];
        if (!e || e.openTaskState === 'opening') return;
        e.openTaskState = 'opening';
        PR.paintDebugPanel(checkId);
        var prNumber = PR.lastState && PR.lastState.number;
        window.klaus.pr.debugCheckOpenAsTask(e.accumulated, e.checkName || '', prNumber).then(function (res) {
          if (!PR.openDebugChecks[checkId]) return;
          if (res && res.error) {
            PR.openDebugChecks[checkId].openTaskState = 'failed';
            PR.openDebugChecks[checkId].openTaskError = res.error;
            PR.paintDebugPanel(checkId);
            setTimeout(function () {
              if (PR.openDebugChecks[checkId] && PR.openDebugChecks[checkId].openTaskState === 'failed') {
                PR.openDebugChecks[checkId].openTaskState = 'idle';
                PR.paintDebugPanel(checkId);
              }
            }, 4000);
            return;
          }
          PR.openDebugChecks[checkId].openTaskState = 'opened';
          PR.paintDebugPanel(checkId);
        }).catch(function (err) {
          if (!PR.openDebugChecks[checkId]) return;
          PR.openDebugChecks[checkId].openTaskState = 'failed';
          PR.openDebugChecks[checkId].openTaskError = (err && err.message) || 'unknown error';
          PR.paintDebugPanel(checkId);
        });
      });
    }
  };

  // Send one turn in the debug-panel chat. Reuses the existing pr-review-chat
  // IPC (read-only: Claude can grep/read, can't edit) since "discuss this
  // analysis" is shape-identical to "discuss this finding".
  PR.sendDebugChatTurn = function(checkId, text) {
    var entry = PR.openDebugChecks[checkId];
    if (!entry || entry.state !== 'done' || entry.chatRequestId) return;

    entry.chatMessages.push({ role: 'user', content: text });
    entry.chatError = null;
    entry.chatStreaming = '';
    var requestId = 'dbgchat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    entry.chatRequestId = requestId;
    PR.paintDebugPanel(checkId);

    var buffered = '';
    var unsubData = window.klaus.pr.onReviewChatData(requestId, function (chunk) {
      var e = PR.openDebugChecks[checkId];
      if (!e || e.chatRequestId !== requestId) return;
      buffered += chunk;
      var idx;
      while ((idx = buffered.indexOf('\n')) !== -1) {
        var line = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          var ev = JSON.parse(line);
          if (ev.type === 'assistant' && ev.message && ev.message.content) {
            ev.message.content.forEach(function (block) {
              if (block.type === 'text' && block.text) e.chatStreaming = block.text;
            });
          } else if (ev.type === 'result' && ev.result) {
            e.chatStreaming = ev.result;
          }
        } catch (_) {}
      }
      PR.paintDebugPanel(checkId);
    });
    window.klaus.pr.onReviewChatDone(requestId, function (result) {
      if (unsubData) unsubData();
      var e = PR.openDebugChecks[checkId];
      if (!e || e.chatRequestId !== requestId) return;
      e.chatRequestId = null;
      if (result && result.error) {
        e.chatError = result.error;
      } else if (result && result.cancelled) {
        // Commit any partial reply so the user keeps the streamed context.
        if (e.chatStreaming) e.chatMessages.push({ role: 'assistant', content: e.chatStreaming });
      } else {
        e.chatMessages.push({ role: 'assistant', content: e.chatStreaming || '' });
      }
      e.chatStreaming = '';
      PR.paintDebugPanel(checkId);
    });

    // findingId-style dedupe key — stable per check so an in-flight chat
    // agent survives render/PR-load round-trips. The findingBody we send is
    // the analysis text itself, scoped with a small header so Claude knows
    // what kind of context this is.
    var findingBody =
      'Failing CI check: ' + (entry.checkName || '(unnamed)') + '\n'
      + 'Run link: ' + (entry.checkLink || '') + '\n\n'
      + '## Prior analysis\n' + (entry.accumulated || '');
    var findingId = 'debug-chat:' + checkId;
    window.klaus.pr.reviewChatStart(requestId, findingBody, entry.chatMessages, findingId).then(function (r) {
      if (r && r.error) {
        if (unsubData) unsubData();
        var e = PR.openDebugChecks[checkId];
        if (!e || e.chatRequestId !== requestId) return;
        e.chatRequestId = null;
        e.chatError = r.error;
        // Roll back the optimistic user message so the user can retry without
        // duplicating it.
        if (e.chatMessages.length && e.chatMessages[e.chatMessages.length - 1].role === 'user'
            && e.chatMessages[e.chatMessages.length - 1].content === text) {
          e.chatMessages.pop();
        }
        PR.paintDebugPanel(checkId);
      }
    });
  };

  PR.mountDebugPanel = function(row, checkId) {
    var entry = PR.openDebugChecks[checkId];
    if (!entry) return null;
    // Look up existing panel by checkId rather than nextElementSibling — when
    // both Annotations and Debug are open, panels stack under the row and
    // sibling-based lookup misses, causing duplicates on each remount.
    var existing = PR.hostEl.querySelector('.pr-check-debug-panel[data-check-id="' + checkId + '"]');
    if (existing) return existing;

    var panel = document.createElement('div');
    panel.className = 'pr-check-debug-panel';
    panel.dataset.checkId = checkId;
    panel.dataset.requestId = entry.requestId;
    panel.innerHTML =
      '<div class="pr-check-debug-head">'
        + '<span>' + (entry.state === 'running' ? 'Debugging' : 'Debug') + ' — ' + PR.escHtml(entry.checkName || '') + '</span>'
        + '<button class="pr-check-debug-close" type="button" title="Cancel / close">&times;</button>'
      + '</div>'
      + '<div class="pr-check-debug-body' + (entry.state === 'running' && !entry.accumulated ? ' status-pulse' : '') + '">'
        + (entry.state === 'running' && !entry.accumulated ? PR.escHtml(PR.DEBUG_STATUS_MESSAGES[0]) : '')
      + '</div>';
    row.insertAdjacentElement('afterend', panel);

    panel.querySelector('.pr-check-debug-close').addEventListener('click', function () {
      var e = PR.openDebugChecks[checkId];
      if (e && e.state === 'running' && e.requestId) {
        try { window.klaus.pr.debugCheckCancel(e.requestId); } catch (_) {}
      }
      if (e && e.statusTimer) clearInterval(e.statusTimer);
      delete PR.openDebugChecks[checkId];
      panel.remove();
    });

    PR.paintDebugPanel(checkId);
    return panel;
  };

  PR.restoreOpenDebugChecks = function() {
    Object.keys(PR.openDebugChecks).forEach(function (checkId) {
      var btn = PR.hostEl.querySelector('.pr-check-debug-btn[data-check-id="' + checkId + '"]');
      if (!btn) return;
      var row = btn.closest('.pr-check-row');
      if (!row) return;
      PR.mountDebugPanel(row, checkId);
    });
  };

  PR.startDebugCheck = function(btn) {
    var row = btn.closest('.pr-check-row');
    if (!row) return;
    var checkId = btn.dataset.checkId;
    if (!checkId) return;

    // Toggle: re-clicking on an existing entry closes it (and cancels if
    // still running). Single source of truth is the cache, not the DOM.
    if (PR.openDebugChecks[checkId]) {
      var prev = PR.openDebugChecks[checkId];
      if (prev.state === 'running' && prev.requestId) {
        try { window.klaus.pr.debugCheckCancel(prev.requestId); } catch (_) {}
      }
      if (prev.statusTimer) clearInterval(prev.statusTimer);
      delete PR.openDebugChecks[checkId];
      var existingPanel = PR.hostEl.querySelector('.pr-check-debug-panel[data-check-id="' + checkId + '"]');
      if (existingPanel) existingPanel.remove();
      return;
    }

    var requestId = 'dbg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    PR.openDebugChecks[checkId] = {
      requestId: requestId,
      checkName: btn.dataset.name || '',
      checkLink: btn.dataset.link || '',
      startedAt: Date.now(),
      accumulated: '',
      state: 'running',
      error: null,
      durationSec: null,
      statusTimer: null,
      openTaskState: 'idle',
      openTaskError: null,
      // Follow-up chat about the analysis. Conversation is preserved across
      // renders since it lives in this cache. Reuses the read-only chat IPC
      // (pr-review-chat-start) so Claude can grep/read but won't edit files.
      chatMessages: [],
      chatStreaming: '',     // assistant response in-flight (string)
      chatRequestId: null,   // set while a turn is streaming
      chatError: null,
    };

    PR.mountDebugPanel(row, checkId);

    // Rotating "Fetching..." pulse until the first chunk lands. Reads bodyEl
    // fresh each tick so a remount-during-warmup keeps the pulse animated.
    var statusIdx = 0;
    PR.openDebugChecks[checkId].statusTimer = setInterval(function () {
      var entry = PR.openDebugChecks[checkId];
      if (!entry) return;
      if (entry.accumulated || entry.state !== 'running') {
        if (entry.statusTimer) { clearInterval(entry.statusTimer); entry.statusTimer = null; }
        return;
      }
      var bodyEl = PR.hostEl.querySelector('.pr-check-debug-panel[data-check-id="' + checkId + '"] .pr-check-debug-body');
      if (!bodyEl) return;
      statusIdx = (statusIdx + 1) % PR.DEBUG_STATUS_MESSAGES.length;
      bodyEl.textContent = PR.DEBUG_STATUS_MESSAGES[statusIdx];
    }, 1800);

    // Subscriptions write into the cache; paintDebugPanel updates whichever
    // panel DOM is currently mounted (or none, if the panel was closed but
    // the entry kept). Cleanup happens via the close button or PR change,
    // which deletes the cache entry.
    var unsubChunk = window.klaus.pr.onDebugCheckChunk(requestId, function (chunk) {
      var entry = PR.openDebugChecks[checkId];
      if (!entry || entry.requestId !== requestId) return;
      entry.accumulated += chunk;
      PR.paintDebugPanel(checkId);
    });
    window.klaus.pr.onDebugCheckDone(requestId, function (result) {
      if (unsubChunk) unsubChunk();
      var entry = PR.openDebugChecks[checkId];
      if (!entry || entry.requestId !== requestId) return;
      if (entry.statusTimer) { clearInterval(entry.statusTimer); entry.statusTimer = null; }
      if (result && result.error) {
        entry.state = 'error';
        entry.error = result.error;
      } else if (result && result.cancelled) {
        entry.state = 'cancelled';
      } else {
        entry.state = 'done';
        entry.durationSec = +((Date.now() - entry.startedAt) / 1000).toFixed(1);
      }
      PR.paintDebugPanel(checkId);
    });

    btn.disabled = true;
    var origText = btn.textContent;
    btn.textContent = 'Debugging…';
    setTimeout(function () { btn.disabled = false; btn.textContent = origText; }, 200);

    window.klaus.pr.debugCheckStart(requestId, btn.dataset.link, btn.dataset.name, checkId).then(function (r) {
      if (r && r.error) {
        var entry = PR.openDebugChecks[checkId];
        if (!entry || entry.requestId !== requestId) return;
        if (entry.statusTimer) { clearInterval(entry.statusTimer); entry.statusTimer = null; }
        entry.state = 'error';
        entry.error = r.error;
        PR.paintDebugPanel(checkId);
      }
    });
  };

  // Legacy stub head — body deleted just below.
  // Autonomous-fix flow: spawn Claude in the PR worktree with edit tools,
  // stream tool-use progress, and on done show the resulting diff with a
  // "Push" button that commits + pushes to the PR branch. Confirm-before-push
  // is deliberate — see AskUserQuestion in commit history; the alternative
  // (full auto) would push bad fixes before the user ever sees them.
  PR.startFixCheck = function(btn) {
    var row = btn.closest('.pr-check-row');
    if (!row) return;

    // One panel per checkId. Lookup is by data-check-id so a stacked Debug
    // or Annotations panel under the same row doesn't break the toggle.
    var checkIdForToggle = btn.dataset.checkId || '';
    var existing = checkIdForToggle
      ? PR.hostEl.querySelector('.pr-check-fix-panel[data-check-id="' + checkIdForToggle + '"]')
      : null;
    if (existing) {
      var existingId = existing.dataset.requestId;
      if (existingId && existing.dataset.state === 'running') {
        window.klaus.pr.fixCheckCancel(existingId);
      }
      existing.remove();
      return;
    }

    var requestId = 'fix-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    var checkName = btn.dataset.name || '';
    var panel = document.createElement('div');
    panel.className = 'pr-check-fix-panel';
    panel.dataset.requestId = requestId;
    panel.dataset.state = 'running';
    // Stash checkId so repaintChecksTab can match this panel back to the
    // freshly-rendered row after a forced refresh.
    panel.dataset.checkId = btn.dataset.checkId || '';
    panel.innerHTML =
      '<div class="pr-check-fix-head">'
        + '<span>Fixing — ' + PR.escHtml(checkName) + '</span>'
        + '<button class="pr-check-fix-close" type="button" title="Cancel / close">&times;</button>'
      + '</div>'
      + '<div class="pr-check-fix-progress"><div class="pr-check-fix-progress-list"></div></div>'
      + '<div class="pr-check-fix-summary"></div>'
      + '<div class="pr-check-fix-diff"></div>'
      + '<div class="pr-check-fix-footer"></div>';
    row.insertAdjacentElement('afterend', panel);

    var progressEl = panel.querySelector('.pr-check-fix-progress-list');
    var summaryEl = panel.querySelector('.pr-check-fix-summary');
    var footerEl = panel.querySelector('.pr-check-fix-footer');
    var progressItems = [{ kind: 'system', label: 'Materializing worktree…' }];
    function paintProgress() {
      progressEl.innerHTML = progressItems.slice(-12).map(function (p) {
        var cls = p.kind === 'tool' ? 'pr-check-fix-progress-tool'
          : p.kind === 'error' ? 'pr-check-fix-progress-error'
          : 'pr-check-fix-progress-system';
        return '<div class="' + cls + '">' + PR.escHtml(p.label) + '</div>';
      }).join('');
      progressEl.scrollTop = progressEl.scrollHeight;
    }
    paintProgress();

    var buffered = '';
    var finalText = '';
    var worktreePath = null;
    var startedAt = Date.now();

    var unsubData = window.klaus.pr.onFixCheckData(requestId, function (chunk) {
      buffered += chunk;
      var idx;
      while ((idx = buffered.indexOf('\n')) !== -1) {
        var line = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          var ev = JSON.parse(line);
          if (ev.type === 'assistant' && ev.message && ev.message.content) {
            ev.message.content.forEach(function (block) {
              if (block.type === 'text' && block.text) finalText = block.text;
              else if (block.type === 'tool_use' && block.name) {
                var hint = (block.input && (block.input.file_path || block.input.command || block.input.pattern)) || '';
                if (typeof hint === 'string') hint = hint.split('/').pop().slice(0, 50);
                progressItems.push({ kind: 'tool', label: block.name + (hint ? ': ' + hint : '') });
              }
            });
            paintProgress();
          } else if (ev.type === 'result') {
            if (ev.result) finalText = ev.result;
          }
        } catch (_) { /* incomplete json line — wait for more */ }
      }
    });

    window.klaus.pr.onFixCheckDone(requestId, function (result) {
      if (unsubData) unsubData();
      if (!panel.isConnected) return;
      panel.dataset.state = 'done';

      if (result && result.error) {
        progressItems.push({ kind: 'error', label: 'Failed: ' + result.error });
        paintProgress();
        return;
      }
      if (result && result.cancelled) {
        progressItems.push({ kind: 'system', label: 'Cancelled.' });
        paintProgress();
        return;
      }

      worktreePath = (result && result.worktreePath) || worktreePath;
      var seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      progressItems.push({ kind: 'system', label: 'Agent finished in ' + seconds + 's. Loading diff…' });
      paintProgress();

      if (finalText) {
        summaryEl.innerHTML = '<div class="pr-check-fix-summary-body">' + PR.renderMarkdownLite(finalText) + '</div>';
      }

      // Pull the worktree's diff so the user can review what Claude actually
      // changed before consenting to the push.
      window.klaus.pr.localState(worktreePath).then(function (state) {
        if (!panel.isConnected) return;
        PR.renderFixDiffAndActions(panel, state, checkName, worktreePath);
      }).catch(function (err) {
        progressItems.push({ kind: 'error', label: 'Failed to load diff: ' + ((err && err.message) || 'unknown error') });
        paintProgress();
      });
    });

    panel.querySelector('.pr-check-fix-close').addEventListener('click', function () {
      if (panel.dataset.state === 'running') window.klaus.pr.fixCheckCancel(requestId);
      if (unsubData) unsubData();
      panel.remove();
    });

    btn.disabled = true;
    var origText = btn.textContent;
    btn.textContent = 'Fixing…';
    setTimeout(function () { btn.disabled = false; btn.textContent = origText; }, 200);

    window.klaus.pr.fixCheckStart(requestId, btn.dataset.link, btn.dataset.name, btn.dataset.checkId || null).then(function (r) {
      if (r && r.error) {
        progressItems.push({ kind: 'error', label: r.error });
        paintProgress();
        panel.dataset.state = 'done';
        return;
      }
      if (r && r.worktreePath) worktreePath = r.worktreePath;
    });
  };

  // Render the diff + Push/Discard footer once Claude is done. Diff is shown
  // raw (monospace block); a syntax-highlighted view would be nicer but adds
  // a chunk of code for a confirmation surface — keep simple.
  PR.renderFixDiffAndActions = function(panel, state, checkName, worktreePath) {
    var summaryEl = panel.querySelector('.pr-check-fix-summary');
    var diffEl = panel.querySelector('.pr-check-fix-diff');
    var footerEl = panel.querySelector('.pr-check-fix-footer');
    var progressEl = panel.querySelector('.pr-check-fix-progress-list');

    if (state && state.error) {
      diffEl.innerHTML = '<div class="diff-error">Could not read worktree state: ' + PR.escHtml(state.error) + '</div>';
      return;
    }
    var files = (state && state.files) || [];
    if (files.length === 0) {
      diffEl.innerHTML = '<div class="pr-check-fix-empty">The agent didn’t make any file changes. Read the summary above for context.</div>';
      return;
    }

    diffEl.innerHTML =
      '<div class="pr-check-fix-files-head">'
        + PR.escHtml(String(files.length)) + ' file' + (files.length === 1 ? '' : 's') + ' changed'
      + '</div>'
      + '<pre class="pr-check-fix-diff-pre">' + PR.escHtml(state.diff || '(no diff content)') + '</pre>';

    var commitMsg = 'Fix CI: ' + (checkName || 'failing check');
    footerEl.innerHTML =
      '<label class="pr-check-fix-msg-label">Commit message'
        + '<input class="pr-check-fix-msg" type="text" value="' + PR.escHtml(commitMsg) + '" />'
      + '</label>'
      + '<div class="pr-check-fix-actions">'
        + '<button class="pr-check-fix-discard" type="button">Discard</button>'
        + '<button class="pr-check-fix-push pr-check-action-primary" type="button">Commit &amp; push</button>'
      + '</div>'
      + '<div class="pr-check-fix-status"></div>';

    var pushBtn = footerEl.querySelector('.pr-check-fix-push');
    var discardBtn = footerEl.querySelector('.pr-check-fix-discard');
    var msgInput = footerEl.querySelector('.pr-check-fix-msg');
    var statusEl = footerEl.querySelector('.pr-check-fix-status');

    pushBtn.addEventListener('click', function () {
      var message = (msgInput.value || '').trim() || commitMsg;
      pushBtn.disabled = true;
      discardBtn.disabled = true;
      statusEl.textContent = 'Committing…';
      window.klaus.pr.commitLocal(message, worktreePath).then(function (r) {
        if (r && r.error) {
          statusEl.textContent = 'Commit failed: ' + r.error;
          statusEl.classList.add('diff-error');
          pushBtn.disabled = false;
          discardBtn.disabled = false;
          return;
        }
        statusEl.textContent = 'Pushing…';
        return window.klaus.pr.pushLocal(worktreePath).then(function (pr) {
          if (pr && pr.error) {
            statusEl.textContent = 'Push failed: ' + pr.error
              + ' (commit is staged locally — fix the conflict and run Push again from the Review tab)';
            statusEl.classList.add('diff-error');
            pushBtn.disabled = false;
            discardBtn.disabled = false;
            return;
          }
          statusEl.classList.remove('diff-error');
          statusEl.classList.add('pr-check-fix-status-ok');
          statusEl.textContent = 'Pushed to ' + (pr && pr.target ? pr.target : 'PR branch') + '. CI will rerun shortly.';
          // Force a refresh so the new run shows up as pending.
          PR.fetchAndRenderChecks(PR.lastState && PR.lastState.number)
            .then(function () { PR.repaintChecksTab({ force: true }); });
        });
      }).catch(function (err) {
        statusEl.textContent = 'Failed: ' + ((err && err.message) || 'unknown error');
        statusEl.classList.add('diff-error');
        pushBtn.disabled = false;
        discardBtn.disabled = false;
      });
    });

    discardBtn.addEventListener('click', function () {
      panel.remove();
    });
  };

  // Tiny markdown -> HTML for the fix summary. Just enough for headings,
  // bold, code spans, and lists — anything more is overkill for the 3-bullet
  // structure we ask Claude to emit.
  PR.renderMarkdownLite = function(text) {
    var safe = PR.escHtml(text);
    return safe
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br/>');
  };

  PR.renderChecksIntoSlot = function() {
    var slot = PR.hostEl.querySelector('.pr-review-checks-slot');
    if (!slot) return;
    if (!PR.currentChecks) { slot.innerHTML = ''; return; }
    if (PR.currentChecks.error) {
      slot.innerHTML = '<span class="pr-check-pill fail" title="' + PR.escHtml(PR.currentChecks.error) + '">checks: error</span>';
      return;
    }
    var checks = PR.currentChecks.checks || [];
    if (checks.length === 0) {
      slot.innerHTML = '<span class="pr-check-pill pending">no checks</span>';
      return;
    }
    var counts = { pass: 0, fail: 0, pending: 0, cancel: 0, skipping: 0 };
    checks.forEach(function (c) {
      var b = c.bucket;
      if (!b) {
        var s = (c.state || '').toLowerCase();
        if (s === 'success' || s === 'neutral') b = 'pass';
        else if (s === 'failure' || s === 'timed_out' || s === 'action_required' || s === 'error') b = 'fail';
        else if (s === 'cancelled') b = 'cancel';
        else if (s === 'skipped') b = 'skipping';
        else b = 'pending';
      }
      counts[b] = (counts[b] || 0) + 1;
    });
    var bits = [];
    if (counts.pass)     bits.push('<span class="pr-check-pill pass" title="Passing">\u2713 ' + counts.pass + '</span>');
    if (counts.fail)     bits.push('<span class="pr-check-pill fail" title="Failing">\u2717 ' + counts.fail + '</span>');
    if (counts.pending)  bits.push('<span class="pr-check-pill pending" title="Pending">\u25CB ' + counts.pending + '</span>');
    if (counts.cancel)   bits.push('<span class="pr-check-pill cancel" title="Cancelled">\u2296 ' + counts.cancel + '</span>');
    if (counts.skipping) bits.push('<span class="pr-check-pill skipping" title="Skipped">\u2298 ' + counts.skipping + '</span>');
    slot.innerHTML = bits.join(' ');
  };

  PR.renderMergeControl = function(state) {
    var meta = state.meta || {};
    // Only show for open, non-draft PRs. Merged/closed PRs get a badge.
    var openState = (meta.state || '').toUpperCase() === 'OPEN';
    if (!openState) return '';
    return '<span class="pr-merge-wrap">'
      + '<button class="pr-review-btn pr-merge-btn" type="button" disabled title="Checking mergeability\u2026">Merge \u25BE</button>'
      + '<div class="pr-merge-menu" hidden>'
        + '<button type="button" data-strategy="merge">Create a merge commit</button>'
        + '<button type="button" data-strategy="squash">Squash and merge</button>'
        + '<button type="button" data-strategy="rebase">Rebase and merge</button>'
      + '</div>'
    + '</span>';
  };

  PR.bindMergeControl = function(state) {
    var wrap = PR.hostEl.querySelector('.pr-merge-wrap');
    if (!wrap) return;
    var btn = wrap.querySelector('.pr-merge-btn');
    var menu = wrap.querySelector('.pr-merge-menu');

    PR.updateMergeGate(wrap, state);

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (btn.disabled) return;
      menu.hidden = !menu.hidden;
    });

    menu.addEventListener('click', async function (e) {
      var target = e.target.closest('[data-strategy]');
      if (!target) return;
      menu.hidden = true;
      var strategy = target.dataset.strategy;
      var label = target.textContent;
      if (!confirm('Merge with "' + label + '"?')) return;
      btn.disabled = true;
      btn.textContent = 'Merging\u2026';
      var result = await window.klaus.pr.reviewMerge(strategy);
      if (result && result.error) {
        window.toast.error('Merge failed:\n' + result.error);
        btn.textContent = 'Merge \u25BE';
        PR.updateMergeGate(wrap, PR.lastState);
        return;
      }
      // State reload is triggered on the main side; the resulting broadcast
      // re-renders the header with the updated state pill.
    });

    // Click-outside dismiss.
    document.addEventListener('click', function onDoc(ev) {
      if (!wrap.contains(ev.target)) {
        menu.hidden = true;
      }
    });
  };

  PR.updateMergeGate = function(wrap, state) {
    var btn = wrap.querySelector('.pr-merge-btn');
    if (!btn) return;
    var reason = PR.mergeGateReason(state);
    if (reason) {
      btn.disabled = true;
      btn.title = reason;
      btn.classList.remove('ready');
    } else {
      btn.disabled = false;
      btn.title = 'Merge this PR';
      btn.classList.add('ready');
    }
  };

  // Mirrors the subset of pr-panel.js's mergeGateReason that applies to
  // someone else's PR. We don't have commit-sign branch-protection nuance
  // here — GitHub itself will reject if the PR isn't mergeable.
  PR.mergeGateReason = function(state) {
    var meta = (state && state.meta) || {};
    if ((meta.state || '').toUpperCase() !== 'OPEN') return 'Only open PRs can be merged';
    if (meta.isDraft) return 'PR is a draft';
    if (meta.mergeable === 'CONFLICTING') return 'Has conflicts';
    if (PR.currentChecks && PR.currentChecks.checks) {
      var failing = PR.currentChecks.checks.some(function (c) {
        var b = c.bucket || '';
        var s = (c.state || '').toLowerCase();
        return b === 'fail' || s === 'failure' || s === 'error' || s === 'timed_out';
      });
      if (failing) return 'Failing checks';
    }
    if (meta.mergeStateStatus === 'BEHIND') return 'Branch is behind base';
    if (meta.mergeable === 'UNKNOWN' && !meta.mergeStateStatus) return 'Mergeability still computing\u2026';
    if (!PR.currentChecks) return 'Checking mergeability\u2026';
    return null;
  };

  PR.renderThreadsStatusBadge = function(state) {
    var actions = PR.hostEl.querySelector('.pr-review-actions');
    if (!actions) return;
    // Remove any previous badge before re-adding.
    var prev = actions.querySelector('.pr-threads-status');
    if (prev) prev.remove();
    if (state.threadsError) {
      var err = document.createElement('span');
      err.className = 'pr-threads-status error';
      err.title = state.threadsError;
      err.textContent = 'threads: error';
      actions.insertBefore(err, actions.firstChild);
    } else if (!state.threads) {
      var pend = document.createElement('span');
      pend.className = 'pr-threads-status pending';
      pend.textContent = 'loading threads\u2026';
      actions.insertBefore(pend, actions.firstChild);
    }
  };

  // refresh: re-run render() against the current state. Used by AgentRouter
  // when a navigation intent lands while the PR is already mounted so
  // applyPendingNav gets a chance to consume it.
  PR.refresh = function() { if (PR.lastState) PR.render(PR.lastState); };


})(window.PrReview);
