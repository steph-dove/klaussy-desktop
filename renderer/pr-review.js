// Phase G: PR review surface. Shared renderer module, mounted in two hosts:
//   - main window: host = #pr-review-root, coexists with the rest of app.js
//   - pop-out:     host = document.body inside pr-review.html (see init call
//                  at the bottom of that file)
//
// State lives in the main process (activePrReview). We pull initial state on
// mount and subscribe to pr-review-state broadcasts so both hosts stay in sync
// without duplicating fetches.

window.PrReview = (function () {
  var escHtml = (window.AppUtils && window.AppUtils.escHtml) || function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  var hostEl = null;
  var isPopout = false;
  var unsubState = null;
  var lastState = null;
  var selectedFile = null;
  var activeTab = 'files'; // 'files' | 'conversation' | 'checks' | 'ai-review' | 'terminal'
  // Per-render IPC subscriptions for rehydrated explain agents. render() blows
  // away hostEl.innerHTML, which orphans these listeners — we clear them each
  // time so chunks don't pile up onto detached DOM.
  var rehydrateUnsubs = [];
  // Current gh user login — used to gate the edit pencil on comments. Fetched
  // once per review session; stays null if gh api fails (which just means
  // the edit UI never appears, not an error state).
  var currentUserLogin = null;
  // In-flight edit: which comment is in edit mode, and what kind (for PATCH
  // endpoint selection). Kind: 'issue' | 'review'.
  var editingCommentId = null;
  var editingCommentKind = null;
  // When a comment has been locally edited (PATCH succeeded), we stash the
  // new body here until the next refresh overwrites the nodes, so the UI
  // doesn't flicker back to the old text.
  var editedCommentOverrides = {}; // { [commentDatabaseId]: newBody }
  var selectionFab = null;
  var onSelectionChange = null;
  // G4: draft review comments accumulated client-side until the user submits
  // a review. Structure: { id, path, line, side, startLine?, startSide?, body }
  var pendingComments = [];
  // Per-conversation-comment Claude state, keyed by comment databaseId.
  // Comments in the Conversation tab get Claude-investigate and
  // Claude-implement buttons that share the same IPC plumbing as the
  // Review-tab findings. Stored here (not on the comment itself) because
  // threads rerender on every refresh and would clobber inline state.
  // Shape per entry: { investigateId, investigateStreaming, investigateResult, investigateError,
  //                    implementId, implementOut, implementError, implementDraft, implementDraftStatus }
  var convClaudeState = {};
  // G6: latest checks result for the active PR. null = not yet fetched.
  var currentChecks = null;
  // Required-status-checks for the PR's base branch (from branch protection).
  // Loaded lazily alongside currentChecks.
  //   []                  → no protection rules (or branch not protected)
  //   ['name', 'name', …] → required contexts
  // currentRequiredChecksError carries a string when the fetch parsed garbage
  // or hit auth issues — the gate must render as "unknown" in that case so we
  // don't falsely green-light merges.
  var currentRequiredChecks = [];
  var currentRequiredChecksError = '';
  // Periodic refresh while the Checks tab is the active tab. Cleared on tab
  // switch and on PR change. 15s cadence is the same ballpark as the per-task
  // CI poll (30s) but more responsive when the user is actively watching.
  var checksPollTimer = null;
  var checksFetchInFlight = false;
  // Signature of the last data we painted into the Checks tab. Lets the 15s
  // poll skip the DOM rebuild when nothing changed — keeps any open
  // annotations panels stable and avoids unnecessary reflow. Reset on PR
  // change so a freshly-loaded PR always paints.
  var lastChecksSignature = '';
  // Annotations-panel open state, keyed by checkId. Survives repaintChecksTab
  // AND full render() rebuilds so the user's expanded panels persist. Value:
  //   { data: Array|null, error: string|null }
  // data === null means "fetch in flight"; on repaint we re-render synchronously
  // from the cached value so there's no flash and no refetch.
  var openAnnotations = Object.create(null);
  // Debug-panel state, keyed by checkId. Same idea as openAnnotations: survives
  // any DOM rebuild so the 30-90s analysis the user just paid for doesn't get
  // lost on the next poll/rerender. Value shape:
  //   {
  //     requestId, checkName, checkLink, startedAt,
  //     accumulated: string,                 // streaming text so far
  //     state: 'running'|'done'|'error'|'cancelled',
  //     error: string|null,
  //     durationSec: number|null,
  //     statusTimer: intervalId|null,        // for the rotating "Fetching..." pulse
  //     openTaskState: 'idle'|'opening'|'opened'|'failed',
  //     openTaskError: string|null,
  //   }
  // Subscriptions write into this map and then call paintDebugPanel(checkId)
  // which finds whichever DOM panel is currently mounted (if any) and updates
  // it in place — letting the same stream survive across panel remounts.
  var openDebugChecks = Object.create(null);
  // Local-changes panel state (Review tab). Refreshed on tab show and after
  // each implement/commit/push. Stays null until the first fetch completes.
  // Shape: { worktreePath, branch, files:[{status,file}], diff, unpushed:[{hash,short,subject}], headRefOid }
  // or { error } when the lookup itself failed (rare — usually just empty).
  var localChanges = null;
  var localCommitMsg = 'Apply review feedback';
  var localBusy = null; // 'committing' | 'pushing' | null
  var localBanner = null; // { kind: 'ok'|'error', text }

  // G7: in-flight AI review state. requestId is set while streaming; the
  // panel persists across re-renders until the user closes it.
  var aiReview = {
    requestId: null,           // streaming review-generation IPC
    finalText: '',              // accumulated review markdown
    progress: [],               // chips while streaming
    error: null,
    cancelled: false,
    worktreePath: null,         // where the implement IPCs will run
    findings: [],               // [{ id, text, severity, status, ignored, implementId, implementOut, implementError, usage }]
    implementAllId: null,
    implementAllProgress: [],
    implementAllError: null,
    implementAllSummary: null,
    implementAllUsage: null,
    usage: null,                // { cost, inputTokens, outputTokens, durationMs }
  };

  // PTY-backed Implement flow. Only one run can be in flight at a time
  // (matches the existing implementAllId guard). The xterm lives in
  // reviewTerminal (below), separate from implRun, so multiple successive
  // runs append to the same scrollback instead of disposing/recreating.
  //
  // Shape when active: see startImplementRun.
  var implRun = null;

  // The Terminal-tab xterm. Persists across implement runs so a "Rerun"
  // (or a fresh Implement after a previous run finished) appends a new
  // banner + output to the same scrollback. Disposed only on explicit
  // user dismissal (Hide terminal), PR navigation, or unmount.
  //
  // Shape when present: { terminal, fitAddon, hasContent }
  //   - hasContent flips true once the first byte has been written, so we
  //     can suppress the leading separator on the first-ever run.
  var reviewTerminal = null;

  // Re-attach bookkeeping: which PR we've already checked for a backgrounded
  // implement run (so we ask main at most once per PR per mount), and the
  // window focus/visibility handler that re-fits the xterm after the OS
  // un-occludes it (belt-and-suspenders for a blank repaint on refocus).
  var implReattachCheckedPr = null;
  var implFocusRefitHandler = null;
  var implVisibilityRefitHandler = null;

  function mount(options) {
    hostEl = options.host;
    isPopout = !!options.isPopout;
    hostEl.classList.add('pr-review-host');
    renderLoading();
    initSelectionExplain();
    setupImplementFocusRefit();

    // Fetch the current gh user once per mount. Drives whether the edit
    // pencil shows on a comment. If this fails we simply don't show the
    // pencil anywhere — no error state needed.
    if (!currentUserLogin) {
      window.klaus.pr.currentUser().then(function (r) {
        if (r && r.login) {
          currentUserLogin = r.login;
          if (lastState) render(lastState);
        }
      });
    }

    unsubState = window.klaus.pr.onReviewState(function (state) {
      if (!state) {
        // In the pop-out, no state = the review was closed elsewhere, so the
        // window has nothing left to show. In the main window, app.js owns
        // mount/unmount and will call unmount() on us — do nothing here.
        if (isPopout) window.close();
        return;
      }
      render(state);
    });

    window.klaus.pr.reviewState().then(function (state) {
      if (!state) {
        renderEmpty();
        return;
      }
      render(state);
    });
  }

  function unmount() {
    if (unsubState) { try { unsubState(); } catch (_) {} unsubState = null; }
    teardownSelectionExplain();
    teardownImplementFocusRefit();
    implReattachCheckedPr = null;
    // DETACH the in-flight implement run — do NOT cancel it. The PTY lives in
    // the main process and stays running in the background; re-opening this PR
    // (here or in a pop-out) re-attaches and repaints from the buffer. This is
    // what stopped runs from vanishing on pop-out / space-switch / navigate.
    if (implRun) {
      try { window.klaus.pr.reviewImplementDetach(implRun.requestId); } catch (_) {}
      cleanupImplementRun();
      implRun = null;
    }
    disposeReviewTerminal();
    if (hostEl) {
      hostEl.innerHTML = '';
      hostEl.classList.remove('pr-review-host');
    }
    lastState = null;
    selectedFile = null;
  }

  function renderLoading() {
    hostEl.innerHTML = '<div class="pr-review-loading">Loading PR\u2026</div>';
  }

  function renderEmpty() {
    hostEl.innerHTML = '<div class="pr-review-loading">No active PR review.</div>';
  }

  function render(state) {
    // Preserve selection across updates unless the PR number changed, and
    // fire a one-shot checks fetch when a new PR comes into view (also
    // covers first-load since lastState is null then).
    var isNewPr = !lastState || lastState.number !== state.number;
    if (isNewPr) {
      selectedFile = null;
      currentChecks = null;
      // Cancel any in-flight debug streams from the previous PR so they don't
      // keep filling the cache after we drop it. Annotations are read-only so
      // we just clear the map.
      Object.keys(openDebugChecks).forEach(function (k) {
        var e = openDebugChecks[k];
        if (e && e.state === 'running' && e.requestId) {
          try { window.klaus.pr.debugCheckCancel(e.requestId); } catch (_) {}
        }
        if (e && e.statusTimer) clearInterval(e.statusTimer);
      });
      openDebugChecks = Object.create(null);
      openAnnotations = Object.create(null);
      lastChecksSignature = '';
      // Stop any in-flight checks polling so it doesn't repaint with the
      // previous PR's data after the new PR's render lands.
      clearChecksPolling();
      // DETACH (don't cancel) the previous PR's implement run — it keeps
      // running in the background and can be re-attached by re-opening that
      // PR. Drop our local subscriptions + xterm; the main process owns the
      // PTY and its output buffer.
      if (implRun) {
        try { window.klaus.pr.reviewImplementDetach(implRun.requestId); } catch (_) {}
        cleanupImplementRun();
        implRun = null;
      }
      disposeReviewTerminal();
      implReattachCheckedPr = null;
      // Don't cancel in-flight AI work for the previous PR — those agents
      // are now backgroundable and the user can monitor / re-attach via the
      // Agents panel. Just drop the local subscriptions by stashing the old
      // requestIds (chunk callbacks bail when aiReview.requestId no longer
      // matches) and reset our own state for the new PR.
      aiReview = {
        requestId: null, finalText: '', progress: [], error: null, cancelled: false,
        worktreePath: null, findings: [],
        implementAllId: null, implementAllProgress: [], implementAllError: null, implementAllSummary: null,
        implementAllUsage: null, usage: null,
      };
      // Drop the previous PR's local-changes snapshot so the panel doesn't
      // briefly show stale file names while the new PR's state is fetched.
      localChanges = null;
      localCommitMsg = 'Apply review feedback';
      localBusy = null;
      localBanner = null;
      // Fire-and-forget. Pass the PR number explicitly — lastState isn't
      // assigned until below, and the async handler would otherwise compare
      // against a null on first load and drop its own result.
      fetchAndRenderChecks(state.number);
      // Restore cached AI review (text + per-finding ignore/implement state)
      // for this PR if we have one. Async; the tab repaints when it lands.
      if (state.baseOwner && state.baseRepo) {
        // After the cache settles, check the agent registry for a backgrounded
        // pr-review-ai run for this PR. The cache only updates from the
        // renderer's done handler, so an agent that completed while the
        // renderer was unmounted leaves the cache stale — adopt from the
        // agent record so the review tab auto-loads the fresh result.
        var baseOwner = state.baseOwner;
        var baseRepo = state.baseRepo;
        var prNumber = state.number;
        loadAiReviewCache(baseOwner, baseRepo, prNumber)
          .then(function () { adoptBackgroundedReviewAgent(baseOwner, baseRepo, prNumber); });
      }
    }
    lastState = state;

    var files = parseDiffFiles(state.diff || '');
    if (!selectedFile && files.length > 0) selectedFile = files[0].path;

    var threadsByPath = groupThreadsByPath(state.threads || []);

    var meta = state.meta || {};
    var author = (meta.author && (meta.author.login || meta.author.name)) || 'unknown';
    var stateBadge = meta.isDraft ? 'DRAFT' : (meta.state || '').toUpperCase();
    var reviewDecision = meta.reviewDecision || '';

    hostEl.innerHTML =
      '<div class="pr-review-header">'
        + '<div class="pr-review-title">'
          + '<span class="pr-review-num">#' + escHtml(state.number) + '</span> '
          + '<span class="pr-review-title-text">' + escHtml(meta.title || '') + '</span>'
        + '</div>'
        + '<div class="pr-review-meta">'
          + '<span class="pr-review-state pr-state-' + escHtml((stateBadge || 'open').toLowerCase()) + '">' + escHtml(stateBadge || 'OPEN') + '</span>'
          + (reviewDecision ? '<span class="pr-review-decision pr-decision-' + escHtml(reviewDecision.toLowerCase()) + '">' + escHtml(reviewDecision.replace('_', ' ')) + '</span>' : '')
          + '<span class="pr-review-author">' + escHtml(author) + '</span>'
          + '<span class="pr-review-branch">' + escHtml(meta.headRefName || '') + ' \u2192 ' + escHtml(meta.baseRefName || '') + '</span>'
          + '<span class="pr-review-checks-slot"></span>'
        + '</div>'
        + '<div class="pr-review-actions">'
          + '<a href="#" class="pr-review-external" data-url="' + escHtml(meta.url || '') + '">Open on GitHub</a>'
          + '<button class="pr-review-btn js-pull-updates" title="Re-fetch PR data + advance the local worktree to the PR’s latest commit">Pull updates</button>'
          + '<button class="pr-review-btn js-ai-review" title="Run an AI code review against this PR">Review</button>'
          + '<button class="pr-review-btn js-checkout-local" title="Fetch this PR into a new worktree and spawn a task">Check out locally</button>'
          + renderMergeControl(state)
          + (isPopout
              ? '<button class="pr-review-btn js-pop-in" title="Return to main window">\u21B2 Pop back in</button>'
              : '<button class="pr-review-btn js-pop-out" title="Open in a separate window">Pop out \u2197</button>')
          + (isPopout
              ? ''
              : '<button class="pr-review-btn js-close" title="Close review">\u2190 Back to tasks</button>')
        + '</div>'
      + '</div>'
      + '<div class="pr-review-tabs">'
        + '<button class="pr-review-tab' + (activeTab === 'files' ? ' active' : '') + '" data-tab="files">Files <span class="pr-tab-count">' + files.length + '</span></button>'
        + '<button class="pr-review-tab' + (activeTab === 'conversation' ? ' active' : '') + '" data-tab="conversation">Conversation' + renderConversationCount(state) + '</button>'
        + '<button class="pr-review-tab' + (activeTab === 'checks' ? ' active' : '') + '" data-tab="checks">Checks' + renderChecksTabCount() + '</button>'
        + '<button class="pr-review-tab' + (activeTab === 'ai-review' ? ' active' : '') + '" data-tab="ai-review">Review' + renderAiReviewTabCount() + '</button>'
        + '<button class="pr-review-tab' + (activeTab === 'terminal' ? ' active' : '') + '" data-tab="terminal">Terminal' + renderTerminalTabBadge() + '</button>'
      + '</div>'
      + '<div class="pr-review-body' + (activeTab !== 'files' ? ' one-col' : '') + '">'
        + (activeTab === 'files'
            ? '<div class="pr-review-file-list">' + renderFileList(files, threadsByPath) + '</div>'
              + '<div class="pr-review-diff">' + renderSelectedFileDiff(files) + '</div>'
            : activeTab === 'conversation'
              ? '<div class="pr-review-conversation">' + renderConversation(state) + '</div>'
              : activeTab === 'checks'
                ? '<div class="pr-review-checks-tab">' + renderChecksTab() + '</div>'
                : activeTab === 'terminal'
                  ? '<div class="pr-review-terminal-tab">' + renderTerminalTab() + '</div>'
                  : '<div class="pr-review-ai-tab">' + renderAiReviewTab() + '</div>'
          )
      + '</div>';

    bindHeader(state);
    bindMergeControl(state);
    renderChecksIntoSlot();
    bindTabs();
    if (activeTab === 'files') {
      bindFileList();
      injectInlineThreads(threadsByPath);
      injectPendingComments();
      rehydrateExplanations();
    } else if (activeTab === 'conversation') {
      bindConversationComposer();
      bindReplyButtons();
      bindEditCommentButtons();
    } else if (activeTab === 'checks') {
      bindChecksTab();
    } else if (activeTab === 'ai-review') {
      bindAiReviewTab();
      // Pull worktree state once per tab activation so a returning user sees
      // any uncommitted edits or unpushed commits without clicking refresh.
      refreshLocalChanges();
    } else if (activeTab === 'terminal') {
      bindTerminalTab();
      mountImplementTerminalIfActive();
    }
    renderThreadsStatusBadge(state);
    renderPendingReviewBar(state);

    // Re-attach to a backgrounded implement run for this PR, if any (pop-out,
    // navigate-back, or a teardown that dropped the local run while the PTY
    // kept going). Cheap: asks main at most once per PR per mount.
    maybeReattachImplement(state.number);

    // If a navigation intent is pending for this PR (set by AgentRouter when
    // the user clicks "Open" on an explain agent), apply it now: switch to
    // Files, select the right file, re-render, then scroll the explanation
    // into view once rehydration has injected it.
    applyPendingNav(state);
  }

  function applyPendingNav(state) {
    var nav = window._pendingAgentNav;
    if (!nav || !state || nav.prNumber !== state.number) return;
    var targetTab = nav.tab || 'files';
    var needsRerender = false;
    if (activeTab !== targetTab) { activeTab = targetTab; needsRerender = true; }
    if (nav.file && selectedFile !== nav.file) { selectedFile = nav.file; needsRerender = true; }
    var agentId = nav.agentId;
    var kind = nav.kind || (targetTab === 'ai-review' ? 'pr-review-ai' : 'explain-diff');
    window._pendingAgentNav = null;

    if (needsRerender) {
      render(state);
    }

    // Tab-specific rehydration — explain agents anchor under their hunk in
    // the diff; AI review reattaches to the streaming JSONL.
    if (kind === 'pr-review-ai' && agentId) {
      rehydrateAiReview(agentId);
      return;
    }

    if (agentId) {
      requestAnimationFrame(function () {
        var el = hostEl.querySelector('.diff-explanation[data-request-id="' + agentId + '"]');
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }

  // Reattach the renderer to a backgrounded AI review: re-parse the JSONL
  // the agent has already produced, populate aiReview state, then subscribe
  // to future chunks/done so the live stream continues to land here.
  function rehydrateAiReview(agentId) {
    if (!window.klaus || !window.klaus.agents) return;
    if (aiReview.requestId === agentId) return; // already attached
    window.klaus.agents.get(agentId).then(function (agent) {
      if (!agent || agent.kind !== 'pr-review-ai') return;
      aiReview.requestId = agent.status === 'running' ? agentId : null;
      aiReview.finalText = '';
      aiReview.progress = [];
      aiReview.error = agent.status === 'error' ? agent.error : null;
      aiReview.cancelled = agent.status === 'cancelled';
      aiReview.findings = [];
      aiReview.usage = null;
      aiReview.worktreePath = (agent.sourceContext && agent.sourceContext.worktreePath) || aiReview.worktreePath;

      // Re-parse the JSONL events the agent has already written.
      var lines = (agent.text || '').split('\n');
      lines.forEach(function (line) {
        if (!line.trim()) return;
        try { handleAiEvent(JSON.parse(line)); } catch (_) {}
      });
      reconcileFindings(parseReviewFindings(aiReview.finalText).findings);
      repaintAiReviewTab();
      rehydrateChatAgents();

      // For a still-running agent, attach to future chunks. Same handlers
      // as startAiReview's so the streaming UX continues seamlessly.
      if (agent.status === 'running') {
        var buffered = '';
        var unsubData = window.klaus.pr.onReviewAiData(agentId, function (chunk) {
          if (aiReview.requestId !== agentId) return;
          buffered += chunk;
          var idx;
          while ((idx = buffered.indexOf('\n')) !== -1) {
            var line = buffered.slice(0, idx);
            buffered = buffered.slice(idx + 1);
            if (!line.trim()) continue;
            try { handleAiEvent(JSON.parse(line)); } catch (_) {}
          }
          reconcileFindings(parseReviewFindings(aiReview.finalText).findings);
          repaintAiReviewTab();
        });
        window.klaus.pr.onReviewAiDone(agentId, function (result) {
          if (unsubData) unsubData();
          if (aiReview.requestId !== agentId) return;
          aiReview.requestId = null;
          if (result && result.error) aiReview.error = result.error;
          if (result && result.cancelled) aiReview.cancelled = true;
          reconcileFindings(parseReviewFindings(aiReview.finalText).findings);
          repaintAiReviewTab();
          if (aiReview.finalText) saveAiReviewCache();
        });
      }
    });
  }

  // On PR open / re-mount, see if there's a backgrounded pr-review-ai
  // agent for this PR whose result the renderer missed (because the cache
  // is only written by the renderer's done handler — an agent that
  // completed while we were unmounted leaves the cache stale). Unlike
  // rehydrateAiReview (which wipes findings to [] before reconciling),
  // this preserves per-finding state already loaded from cache because
  // reconcileFindings merges by key.
  function adoptBackgroundedReviewAgent(baseOwner, baseRepo, prNumber) {
    if (!window.klaus || !window.klaus.agents) return;
    if (aiReview.requestId) return; // already attached to a live stream
    window.klaus.agents.list().then(function (agents) {
      if (!agents || !agents.length) return;
      // Match all three: PR numbers are repo-scoped, so the user could
      // have running review agents for the same number under different
      // accounts/repos. Older agents (pre-disambiguation) lack baseOwner/
      // baseRepo in sourceContext and are skipped — safer than a wrong
      // adoption across accounts.
      var matching = agents.filter(function (a) {
        return a.kind === 'pr-review-ai'
            && a.sourceContext
            && a.sourceContext.prNumber === prNumber
            && a.sourceContext.baseOwner === baseOwner
            && a.sourceContext.baseRepo === baseRepo;
      });
      if (!matching.length) return;
      // Newest first — pick the most recent run for this PR.
      matching.sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); });
      var agent = matching[0];
      if (!agent || !agent.text) return;
      // Bail if we navigated away while listing agents.
      if (!lastState || lastState.number !== prNumber || lastState.baseOwner !== baseOwner || lastState.baseRepo !== baseRepo) return;

      // Re-parse the JSONL events the agent has written. handleAiEvent
      // updates aiReview.finalText / progress / usage in-place.
      var lines = agent.text.split('\n');
      lines.forEach(function (line) {
        if (!line.trim()) return;
        try { handleAiEvent(JSON.parse(line)); } catch (_) {}
      });
      reconcileFindings(parseReviewFindings(aiReview.finalText).findings);
      aiReview.worktreePath = (agent.sourceContext && agent.sourceContext.worktreePath) || aiReview.worktreePath;

      if (agent.status === 'running') {
        // Still streaming — attach to live updates so chunks land here.
        aiReview.requestId = agent.id;
        var buffered = '';
        var unsubData = window.klaus.pr.onReviewAiData(agent.id, function (chunk) {
          if (aiReview.requestId !== agent.id) return;
          buffered += chunk;
          var idx;
          while ((idx = buffered.indexOf('\n')) !== -1) {
            var line = buffered.slice(0, idx);
            buffered = buffered.slice(idx + 1);
            if (!line.trim()) continue;
            try { handleAiEvent(JSON.parse(line)); } catch (_) {}
          }
          reconcileFindings(parseReviewFindings(aiReview.finalText).findings);
          repaintAiReviewTab();
        });
        window.klaus.pr.onReviewAiDone(agent.id, function (result) {
          if (unsubData) unsubData();
          if (aiReview.requestId !== agent.id) return;
          aiReview.requestId = null;
          if (result && result.error) aiReview.error = result.error;
          if (result && result.cancelled) aiReview.cancelled = true;
          reconcileFindings(parseReviewFindings(aiReview.finalText).findings);
          repaintAiReviewTab();
          if (aiReview.finalText) saveAiReviewCache();
        });
      } else if (aiReview.finalText) {
        // Completed — persist what we just adopted so future loads hit
        // the cache without re-scanning the agent registry.
        saveAiReviewCache();
      }
      repaintAiReviewTab();
    });
  }

  // When the diff comes back into focus (file switch, tab switch, mount),
  // re-inject any explain-diff agents already in the registry so the user
  // doesn't lose their results just because the DOM was rebuilt.
  function rehydrateExplanations() {
    // Clear any previous rehydrated subscriptions — those listeners point at
    // detached DOM after the innerHTML swap.
    rehydrateUnsubs.forEach(function (fn) { try { fn(); } catch (_) {} });
    rehydrateUnsubs = [];

    var diffPre = hostEl.querySelector('.pr-review-diff-pre');
    if (!diffPre || !selectedFile) return;

    window.klaus.agents.list().then(function (agents) {
      if (!agents || !agents.length) return;
      var matching = agents.filter(function (a) {
        return a.kind === 'explain-diff'
            && a.sourceContext
            && a.sourceContext.file === selectedFile;
      });
      // Newest first so the most recent explanation lands closest to the diff.
      matching.sort(function (a, b) { return b.startedAt - a.startedAt; });
      matching.forEach(function (agent) { injectRehydratedExplanation(agent, diffPre); });
    });
  }

  // Strip the leading diff marker (+/-/space) from a diff-line's textContent
  // so we can compare against a user selection that grabbed only the code.
  function stripDiffPrefix(s) {
    if (!s) return '';
    var first = s.charAt(0);
    if (first === '+' || first === '-' || first === ' ') return s.slice(1);
    return s;
  }

  // Find a contiguous run of code-bearing .diff-line elements whose content
  // matches the hunk lines. Returns the LAST element of the matching range
  // so the explanation can be inserted directly after it.
  //
  // Matching is done on the diff-line's content with the leading +/-/space
  // marker stripped (the user's selection naturally excludes the marker),
  // then trimmed to absorb whitespace drift. Meta/hunk-header lines are
  // skipped — they can't match a code selection. Returns null on miss
  // (caller falls back to bottom render).
  function findHunkAnchor(diffPre, hunkText) {
    if (!hunkText) return null;
    var hunkLines = hunkText.split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 0; });
    if (!hunkLines.length) return null;

    // Only consider code-bearing lines — skip @@ headers, --- /+++ headers,
    // and the diff/index/file headers. Selections never span those.
    var codeLines = Array.from(diffPre.querySelectorAll('.diff-line.diff-add, .diff-line.diff-del, .diff-line.diff-context'));
    if (codeLines.length < hunkLines.length) return null;

    var normCode = codeLines.map(function (el) { return stripDiffPrefix(el.textContent).trim(); });

    for (var i = 0; i <= normCode.length - hunkLines.length; i++) {
      var ok = true;
      for (var j = 0; j < hunkLines.length; j++) {
        if (normCode[i + j] !== hunkLines[j]) { ok = false; break; }
      }
      if (ok) return codeLines[i + hunkLines.length - 1];
    }
    return null;
  }

  function injectRehydratedExplanation(agent, diffPre) {
    // Skip if the inline-click flow already has an element for this agent
    // (avoids double-rendering when render() fires shortly after a click).
    if (hostEl.querySelector('.diff-explanation[data-request-id="' + agent.id + '"]')) return;

    var el = document.createElement('div');
    el.className = 'diff-explanation diff-explanation-rehydrated';
    el.dataset.requestId = agent.id;
    var hunkPreview = (agent.sourceContext && agent.sourceContext.hunkPreview) || '';
    var headerLabel = hunkPreview
      ? hunkPreview.replace(/\s+/g, ' ').slice(0, 80)
      : 'Previous explanation';
    el.innerHTML =
      '<div class="diff-explanation-header">'
        + '<span title="' + escHtml(hunkPreview) + '">' + escHtml(headerLabel) + '</span>'
        + '<button class="diff-explanation-close" title="Hide">&times;</button>'
      + '</div>'
      + '<div class="diff-explanation-body"></div>';

    // Try to anchor under the original hunk; if the diff has drifted, fall
    // back to appending at the bottom of the diff container.
    var fullHunk = agent.sourceContext && agent.sourceContext.hunk;
    var anchor = fullHunk ? findHunkAnchor(diffPre, fullHunk) : null;
    if (anchor) {
      anchor.after(el);
    } else {
      diffPre.parentElement.appendChild(el);
    }

    var bodyEl = el.querySelector('.diff-explanation-body');
    el.querySelector('.diff-explanation-close').addEventListener('click', function () {
      el.remove();
    });

    if (agent.status === 'error') {
      bodyEl.className = 'diff-explanation-body diff-error';
      bodyEl.textContent = agent.error || 'Explain failed';
      return;
    }

    bodyEl.textContent = agent.text || '';

    if (agent.status === 'running') {
      // Catch up + subscribe to future chunks so the user watches the rest
      // of the stream land in real time.
      bodyEl.classList.add('status-pulse');
      if (!agent.text) bodyEl.textContent = 'Resuming…';
      var accumulated = agent.text || '';
      var unsubChunk = window.klaus.ai.onExplainDiffChunk(agent.id, function (chunk) {
        if (!accumulated) { bodyEl.classList.remove('status-pulse'); bodyEl.textContent = ''; }
        accumulated += chunk;
        bodyEl.textContent = accumulated;
        bodyEl.scrollTop = bodyEl.scrollHeight;
      });
      var unsubDone = window.klaus.ai.onExplainDiffDone(agent.id, function (result) {
        if (unsubChunk) unsubChunk();
        if (!bodyEl.isConnected) return;
        bodyEl.classList.remove('status-pulse');
        if (result.error) {
          bodyEl.className = 'diff-explanation-body diff-error';
          bodyEl.textContent = result.error;
        }
      });
      rehydrateUnsubs.push(unsubChunk, unsubDone);
    }
  }

  function bindConversationComposer() {
    var composer = hostEl.querySelector('.pr-conv-new-comment');
    if (composer) {
      var ta = composer.querySelector('.pr-conv-new-body');
      var btn = composer.querySelector('.pr-conv-new-post');

      async function post() {
        var body = ta.value.trim();
        if (!body) return;
        btn.disabled = true;
        btn.textContent = 'Posting\u2026';
        var result = await window.klaus.pr.addIssueComment(body);
        if (result.error) {
          btn.disabled = false;
          btn.textContent = 'Comment';
          window.toast.error('Post failed: ' + result.error);
          return;
        }
        ta.value = '';
        await window.klaus.pr.refreshThreads();
        // render is re-triggered by the pr-review-state broadcast.
      }

      btn.addEventListener('click', post);
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); }
      });
    }
    bindConvClaudeButtons();
  }

  // Per-comment Claude actions: investigate / implement / draft approve /
  // dismiss / clear. Wired with explicit per-button listeners on each
  // repaint \u2014 simple, low-risk, mirrors the rest of this file's style
  // (most other binders also re-attach on every render).
  function bindConvClaudeButtons() {
    hostEl.querySelectorAll('.pr-conv-claude-investigate').forEach(function (b) {
      b.addEventListener('click', function () { startConvInvestigate(b.dataset.dbid); });
    });
    hostEl.querySelectorAll('.pr-conv-claude-investigate-cancel').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = convClaudeState[b.dataset.dbid];
        if (s && s.investigateId) window.klaus.pr.reviewInvestigateCancel(s.investigateId);
      });
    });
    hostEl.querySelectorAll('.pr-conv-claude-investigate-clear').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = convClaudeState[b.dataset.dbid];
        if (!s) return;
        s.investigateResult = '';
        s.investigateError = null;
        repaintConversationTab();
      });
    });
    hostEl.querySelectorAll('.pr-conv-claude-implement').forEach(function (b) {
      b.addEventListener('click', function () { startConvImplement(b.dataset.dbid); });
    });
    hostEl.querySelectorAll('.pr-conv-claude-implement-cancel').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = convClaudeState[b.dataset.dbid];
        if (!s || !s.implementId) return;
        if (implRun && implRun.requestId === s.implementId) {
          cancelImplementRun();
        } else {
          window.klaus.pr.reviewImplementCancel(s.implementId);
        }
      });
    });
    hostEl.querySelectorAll('.pr-conv-claude-draft-approve').forEach(function (b) {
      b.addEventListener('click', function () { approveConvImplementDraft(b.dataset.dbid, b); });
    });
    hostEl.querySelectorAll('.pr-conv-claude-draft-dismiss').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = convClaudeState[b.dataset.dbid];
        if (!s) return;
        s.implementDraftStatus = 'dismissed';
        repaintConversationTab();
      });
    });
  }

  // Repaint the conversation tab in place. Mirrors repaintAiReviewTab so
  // streaming chunks don't trigger a full app render.
  function repaintConversationTab() {
    if (activeTab !== 'conversation') return;
    var tab = hostEl.querySelector('.pr-review-conversation');
    if (!tab || !lastState) return;
    tab.innerHTML = renderConversation(lastState);
    bindConversationComposer();
    bindReplyButtons();
    bindEditCommentButtons();
  }

  function bindReplyButtons() {
    hostEl.querySelectorAll('.pr-conv-reply-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openReplyComposer(btn);
      });
    });
  }

  function bindEditCommentButtons() {
    // Enter edit mode — swap the body for a textarea on the next render.
    hostEl.querySelectorAll('.pr-conv-edit-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        editingCommentId = parseInt(btn.dataset.id, 10);
        editingCommentKind = btn.dataset.kind;
        if (lastState) render(lastState);
      });
    });
    // Cancel / Save handlers for any currently-open composer.
    hostEl.querySelectorAll('.pr-conv-edit-wrap').forEach(function (wrap) {
      var dbid = parseInt(wrap.dataset.id, 10);
      var kind = wrap.dataset.kind;
      var ta = wrap.querySelector('.pr-conv-edit-input');
      var saveBtn = wrap.querySelector('.pr-conv-edit-save');
      var cancelBtn = wrap.querySelector('.pr-conv-edit-cancel');
      var errEl = wrap.querySelector('.pr-conv-edit-error');
      if (ta) ta.focus();
      if (cancelBtn) cancelBtn.addEventListener('click', function () {
        editingCommentId = null;
        editingCommentKind = null;
        if (lastState) render(lastState);
      });
      if (saveBtn) saveBtn.addEventListener('click', async function () {
        var body = ta ? ta.value : '';
        if (!body.trim()) {
          if (errEl) errEl.textContent = 'Comment body cannot be empty.';
          return;
        }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        if (errEl) errEl.textContent = '';
        var fn = kind === 'review' ? window.klaus.pr.editReviewComment : window.klaus.pr.editIssueComment;
        var result = await fn(dbid, body);
        if (result && result.error) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
          if (errEl) errEl.textContent = 'Save failed: ' + result.error;
          return;
        }
        editedCommentOverrides[dbid] = body;
        editingCommentId = null;
        editingCommentKind = null;
        // Ask the main process for fresh threads so our state reflects the
        // canonical server view — the override is there for the brief gap.
        window.klaus.pr.refreshThreads();
        if (lastState) render(lastState);
      });
    });
  }

  function openReplyComposer(btn) {
    var parentId = btn.dataset.replyTo;
    if (!parentId) return;
    var inlineEl = btn.closest('.pr-conv-inline');
    if (!inlineEl) return;
    // One composer per comment at a time.
    var existing = inlineEl.querySelector('.pr-conv-reply-composer');
    if (existing) { existing.remove(); return; }

    var composer = document.createElement('div');
    composer.className = 'pr-conv-reply-composer';
    composer.innerHTML =
      '<textarea class="pr-conv-reply-body" placeholder="Reply (\u2318\u23CE to post)" rows="2"></textarea>'
      + '<div class="pr-conv-reply-actions">'
        + '<button class="pr-conv-reply-cancel" type="button">Cancel</button>'
        + '<button class="pr-conv-reply-send" type="button">Reply</button>'
      + '</div>';
    inlineEl.appendChild(composer);

    var ta = composer.querySelector('textarea');
    var sendBtn = composer.querySelector('.pr-conv-reply-send');
    ta.focus();

    composer.querySelector('.pr-conv-reply-cancel').addEventListener('click', function () {
      composer.remove();
    });

    async function send() {
      var body = ta.value.trim();
      if (!body) return;
      sendBtn.disabled = true;
      sendBtn.textContent = 'Posting\u2026';
      var result = await window.klaus.pr.replyToReviewComment(parentId, body);
      if (result.error) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Reply';
        window.toast.error('Reply failed: ' + result.error);
        return;
      }
      composer.remove();
      await window.klaus.pr.refreshThreads();
    }

    sendBtn.addEventListener('click', send);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
      if (e.key === 'Escape') composer.remove();
    });
  }

  function renderPendingReviewBar(state) {
    var actions = hostEl.querySelector('.pr-review-actions');
    if (!actions) return;
    var prev = actions.querySelector('.pr-pending-review-bar');
    if (prev) prev.remove();
    if (pendingComments.length === 0) return;

    var bar = document.createElement('span');
    bar.className = 'pr-pending-review-bar';
    bar.innerHTML = '<span class="pr-pending-count">' + pendingComments.length + ' pending</span>'
      + '<button class="pr-review-btn pr-pending-submit" type="button">Finish review\u2026</button>';
    actions.insertBefore(bar, actions.firstChild);
    bar.querySelector('.pr-pending-submit').addEventListener('click', openSubmitReviewDialog);
  }

  // Floating action bar that appears when the user selects text inside the
  // review diff — mirrors the Changes tab's selection FAB but adds a Comment
  // button so reviewers can leave line comments (G4). Lives on document.body
  // so it can float outside the scroll container.
  function initSelectionExplain() {
    if (selectionFab) return;
    selectionFab = document.createElement('div');
    selectionFab.id = 'pr-review-selection-fab';
    selectionFab.style.display = 'none';
    selectionFab.innerHTML =
      '<button type="button" data-action="explain" title="Explain selection">Explain</button>'
      + '<button type="button" data-action="comment" title="Leave a review comment">Comment</button>';
    document.body.appendChild(selectionFab);

    // Prevent the click from collapsing the selection before we read it.
    selectionFab.addEventListener('mousedown', function (e) { e.preventDefault(); });
    selectionFab.querySelector('[data-action="explain"]').addEventListener('click', function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      var text = sel.toString().trim();
      if (!text) return;
      selectionFab.style.display = 'none';
      explainSelection(text);
    });
    selectionFab.querySelector('[data-action="comment"]').addEventListener('click', function () {
      var range = computeCommentRange();
      selectionFab.style.display = 'none';
      if (!range) {
        window.toast.error('Select one or more diff lines (add / delete / context) to comment on.');
        return;
      }
      openCommentComposer(range);
    });

    onSelectionChange = function () {
      if (!selectionFab) return;
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        selectionFab.style.display = 'none';
        return;
      }
      var diffArea = hostEl.querySelector('.pr-review-diff');
      if (!diffArea) { selectionFab.style.display = 'none'; return; }
      if (!diffArea.contains(sel.anchorNode) && !diffArea.contains(sel.focusNode)) {
        selectionFab.style.display = 'none';
        return;
      }
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      selectionFab.style.display = 'flex';
      selectionFab.style.top = (rect.top - 32 + window.scrollY) + 'px';
      selectionFab.style.left = Math.max(4, rect.right - selectionFab.offsetWidth) + 'px';
    };
    document.addEventListener('selectionchange', onSelectionChange);
  }

  function teardownSelectionExplain() {
    if (onSelectionChange) {
      document.removeEventListener('selectionchange', onSelectionChange);
      onSelectionChange = null;
    }
    if (selectionFab) {
      selectionFab.remove();
      selectionFab = null;
    }
  }

  // Rotating status messages shown before the first streamed chunk arrives.
  // Honest about what's happening at each stage — not fake tool steps.
  var EXPLAIN_STATUS_MESSAGES = [
    'Sending to the agent\u2026',
    'Reading the change\u2026',
    'Considering intent\u2026',
    'Looking at surrounding context\u2026',
    'Drafting explanation\u2026',
  ];

  async function explainSelection(text) {
    // Anchor the explanation panel to the last diff-line the selection touches
    // so it lands under the selected block rather than at the top of the diff.
    var sel = window.getSelection();
    var anchor = sel && sel.focusNode;
    var lineEl = anchor;
    while (lineEl && !lineEl.classList) lineEl = lineEl.parentElement;
    while (lineEl && !lineEl.classList.contains('diff-line')) lineEl = lineEl.parentElement;
    var diffPre = hostEl.querySelector('.pr-review-diff-pre');
    var insertAfter = lineEl || (diffPre && diffPre.lastElementChild);
    if (!insertAfter) return;

    // Only one explanation at a time.
    var existing = hostEl.querySelector('.diff-explanation');
    if (existing) {
      var prevId = existing.dataset.requestId;
      // Don't cancel the proc — the agent may have been started by another
      // surface (or by us moments ago) and the user might still want it
      // running in the background. Just unmount the inline UI.
      existing.remove();
    }

    // Same key formula as main/ipc/claude-stream-ipc.js explain-diff handler.
    // If the renderer formula drifts from main's, dedupe silently breaks —
    // keep these in sync.
    var fileLabel = selectedFile || 'unknown';
    var dedupeKey = 'explain-diff::' + fileLabel + '::' + text;
    var existingAgent = await window.klaus.agents.findByDedupeKey(dedupeKey);

    var requestId = (existingAgent && existingAgent.status === 'running')
      ? existingAgent.id
      : 'exp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    var explanationEl = document.createElement('div');
    explanationEl.className = 'diff-explanation';
    explanationEl.dataset.requestId = requestId;
    explanationEl.innerHTML = '<div class="diff-explanation-header">'
        + '<span>Explanation</span>'
        + '<button class="diff-explanation-close" title="Close">&times;</button>'
      + '</div>'
      + '<div class="diff-explanation-body status-pulse">' + escHtml(EXPLAIN_STATUS_MESSAGES[0]) + '</div>';
    insertAfter.after(explanationEl);

    var bodyEl = explanationEl.querySelector('.diff-explanation-body');
    var accumulated = (existingAgent && existingAgent.text) || '';

    // If we re-hydrated from a finished agent, paint the result and bail —
    // no need to subscribe to a stream that's already over.
    if (existingAgent && existingAgent.status !== 'running') {
      bodyEl.classList.remove('status-pulse');
      if (existingAgent.status === 'error') {
        bodyEl.className = 'diff-explanation-body diff-error';
        bodyEl.textContent = existingAgent.error || 'Explain failed';
      } else {
        bodyEl.textContent = accumulated || '(no output)';
      }
      // Don't auto-mark-read here — let the user keep the badge until they
      // open the entry from the Agents panel explicitly. Inline rendering
      // doesn't count as "viewed in the panel".
      explanationEl.querySelector('.diff-explanation-close').addEventListener('click', function () {
        explanationEl.remove();
      });
      if (sel) sel.removeAllRanges();
      return;
    }

    // Catch-up: paint whatever the agent has already streamed.
    if (accumulated) {
      bodyEl.classList.remove('status-pulse');
      bodyEl.textContent = accumulated;
    }

    // Cycle through status labels until the first chunk arrives (or the user
    // cancels). Stops itself as soon as `accumulated` is non-empty.
    var statusIdx = 0;
    var statusTimer = setInterval(function () {
      if (!bodyEl.isConnected) { clearInterval(statusTimer); return; }
      if (accumulated) { clearInterval(statusTimer); return; }
      statusIdx = (statusIdx + 1) % EXPLAIN_STATUS_MESSAGES.length;
      bodyEl.textContent = EXPLAIN_STATUS_MESSAGES[statusIdx];
    }, 1800);

    var unsubChunk = window.klaus.ai.onExplainDiffChunk(requestId, function (chunk) {
      if (!accumulated) {
        bodyEl.classList.remove('status-pulse');
        bodyEl.textContent = '';
      }
      accumulated += chunk;
      bodyEl.textContent = accumulated;
      // Keep the body scrolled to the end so long explanations stay visible.
      bodyEl.scrollTop = bodyEl.scrollHeight;
    });

    var unsubDone = window.klaus.ai.onExplainDiffDone(requestId, function (result) {
      clearInterval(statusTimer);
      if (unsubChunk) unsubChunk();
      if (!bodyEl.isConnected) return;
      if (result.error) {
        bodyEl.classList.remove('status-pulse');
        bodyEl.className = 'diff-explanation-body diff-error';
        bodyEl.textContent = result.error;
      } else if (result.cancelled) {
        // Leave whatever we managed to stream visible.
      }
      // Success path: stream already populated bodyEl; nothing more to do.
      // Intentionally not marking read — see note above.
    });

    explanationEl.querySelector('.diff-explanation-close').addEventListener('click', function () {
      // Closing the inline UI no longer cancels the agent — it keeps running
      // in the background and the user can re-attach via the Agents panel.
      clearInterval(statusTimer);
      if (unsubChunk) unsubChunk();
      if (unsubDone) unsubDone();
      explanationEl.remove();
    });

    if (sel) sel.removeAllRanges();
    // Only fire start if we're not attaching to an existing run.
    if (!existingAgent || existingAgent.status !== 'running') {
      var prNumber = (lastState && lastState.number) || null;
      window.klaus.ai.explainDiffStreamStart(requestId, null, fileLabel, text, prNumber);
    }
  }

  function renderConversationCount(state) {
    var n = ((state.issueComments && state.issueComments.length) || 0)
          + ((state.reviews && state.reviews.length) || 0);
    if (!n) return '';
    return ' <span class="pr-tab-count">' + n + '</span>';
  }

  function bindTabs() {
    hostEl.querySelectorAll('.pr-review-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.dataset.tab;
        if (activeTab === tab) return;
        // Leaving the Checks tab: stop the periodic poll. Re-entering it
        // re-binds and bindChecksTab() restarts the poll.
        if (activeTab === 'checks' && tab !== 'checks') clearChecksPolling();
        activeTab = tab;
        if (lastState) render(lastState);
      });
    });
  }

  function groupThreadsByPath(threads) {
    var map = {};
    threads.forEach(function (t) {
      if (!map[t.path]) map[t.path] = [];
      map[t.path].push(t);
    });
    return map;
  }

  function renderFileList(files, threadsByPath) {
    if (files.length === 0) return '<div class="pr-review-empty">No files.</div>';
    return files.map(function (f) {
      var isSelected = f.path === selectedFile ? ' selected' : '';
      var threads = (threadsByPath && threadsByPath[f.path]) || [];
      var openThreads = threads.filter(function (t) { return !t.isResolved; }).length;
      var threadBadge = openThreads > 0
        ? '<span class="pr-file-threads" title="' + openThreads + ' open thread' + (openThreads === 1 ? '' : 's') + '">\u{1F4AC}' + openThreads + '</span>'
        : '';
      return '<div class="pr-review-file' + isSelected + '" data-file="' + escHtml(f.path) + '">'
        + '<span class="pr-review-file-path">' + escHtml(f.path) + '</span>'
        + '<span class="pr-review-file-stats">'
          + threadBadge
          + (f.adds ? '<span class="pr-file-add">+' + f.adds + '</span>' : '')
          + (f.dels ? '<span class="pr-file-del">\u2212' + f.dels + '</span>' : '')
        + '</span>'
      + '</div>';
    }).join('');
  }

  function renderSelectedFileDiff(files) {
    var file = files.find(function (f) { return f.path === selectedFile; });
    if (!file) return '<div class="pr-review-empty">Select a file.</div>';
    return '<pre class="pr-review-diff-pre">' + renderUnifiedDiff(file.raw) + '</pre>';
  }

  // Parse a `gh pr diff` unified diff into per-file blocks.
  function parseDiffFiles(diffText) {
    if (!diffText) return [];
    var lines = diffText.split('\n');
    var files = [];
    var current = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.startsWith('diff --git ')) {
        if (current) files.push(current);
        // "diff --git a/foo b/foo" — take the b/ side.
        var m = line.match(/^diff --git a\/.* b\/(.*)$/);
        current = { path: m ? m[1] : line, raw: line + '\n', adds: 0, dels: 0 };
      } else if (current) {
        current.raw += line + '\n';
        if (line.startsWith('+') && !line.startsWith('+++')) current.adds++;
        else if (line.startsWith('-') && !line.startsWith('---')) current.dels++;
      }
    }
    if (current) files.push(current);
    return files;
  }

  // Unified-diff renderer that tags each add/del/context line with (side,
  // line) so G3 can anchor review threads by GitHub's position model
  // (LEFT=old_ln, RIGHT=new_ln). Explain lives in a floating action button
  // triggered by text selection (see initSelectionExplain), not inline.
  function renderUnifiedDiff(diffText) {
    var lines = diffText.split('\n');
    var out = '';
    var oldLn = 0, newLn = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.startsWith('+++') || line.startsWith('---')) {
        out += '<div class="diff-line diff-meta">' + escHtml(line) + '</div>';
      } else if (line.startsWith('@@')) {
        var hm = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hm) { oldLn = parseInt(hm[1], 10) - 1; newLn = parseInt(hm[2], 10) - 1; }
        out += '<div class="diff-line diff-hunk">' + escHtml(line) + '</div>';
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        newLn++;
        out += '<div class="diff-line diff-add" data-side="RIGHT" data-line="' + newLn + '">' + escHtml(line) + '</div>';
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        oldLn++;
        out += '<div class="diff-line diff-del" data-side="LEFT" data-line="' + oldLn + '">' + escHtml(line) + '</div>';
      } else if (line.startsWith('diff ')) {
        out += '<div class="diff-line diff-header">' + escHtml(line) + '</div>';
      } else if (line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
        out += '<div class="diff-line diff-meta">' + escHtml(line) + '</div>';
      } else {
        oldLn++; newLn++;
        out += '<div class="diff-line diff-context" data-side="RIGHT" data-line="' + newLn + '">' + escHtml(line) + '</div>';
      }
    }
    return out;
  }

  function bindHeader(state) {
    var extBtn = hostEl.querySelector('.pr-review-external');
    if (extBtn) extBtn.addEventListener('click', function (e) {
      e.preventDefault();
      var url = extBtn.dataset.url;
      if (url) window.klaus.gh.openExternal(url);
    });
    var popOut = hostEl.querySelector('.js-pop-out');
    if (popOut) popOut.addEventListener('click', function () { window.klaus.pr.popOut(); });
    var popIn = hostEl.querySelector('.js-pop-in');
    if (popIn) popIn.addEventListener('click', function () { window.klaus.pr.popIn(); });
    var closeBtn = hostEl.querySelector('.js-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { window.klaus.pr.reviewClose(); });
    var pullBtn = hostEl.querySelector('.js-pull-updates');
    if (pullBtn) pullBtn.addEventListener('click', async function () {
      pullBtn.disabled = true;
      var prev = pullBtn.textContent;
      pullBtn.textContent = 'Pulling…';
      try {
        var r = await window.klaus.pr.pullUpdates();
        if (r && r.error) {
          window.toast.error('Pull failed:\n' + r.error);
          return;
        }
        var bits = ['PR data refreshed.'];
        if (r.worktreeRefreshed === 'updated') bits.push('Worktree updated to latest commit.');
        else if (r.worktreeRefreshed === 'up-to-date') bits.push('Worktree already at latest commit.');
        else if (r.worktreeRefreshed === 'kept-local') bits.push('Worktree has local changes — left alone.');
        else if (r.worktreeRefreshed === 'fetch-failed') bits.push('Worktree fetch failed.');
        // 'no-worktree' → silent, no need to mention.
        if (r.worktreeRefreshed === 'kept-local' || r.worktreeRefreshed === 'fetch-failed') {
          window.toast.warn(bits.join(' '));
        } else {
          window.toast.info(bits.join(' '));
        }
      } finally {
        pullBtn.disabled = false;
        pullBtn.textContent = prev;
      }
    });
    var checkoutBtn = hostEl.querySelector('.js-checkout-local');
    if (checkoutBtn) checkoutBtn.addEventListener('click', async function () {
      checkoutBtn.disabled = true;
      var prev = checkoutBtn.textContent;
      checkoutBtn.textContent = 'Fetching\u2026';
      var result = await window.klaus.pr.checkoutLocally();
      if (result && result.error) {
        window.toast.error('Check out failed:\n' + result.error);
        checkoutBtn.disabled = false;
        checkoutBtn.textContent = prev;
      } else if (result && result.reused) {
        // Reused an existing worktree — surface whether we managed to pull
        // the PR's latest commits in. 'updated': fast-forwarded successfully.
        // 'kept-local': user has local changes, worktree left as-is. Other
        // values are quiet (no toast for already-up-to-date or fetch errors).
        if (result.refreshed === 'updated') {
          window.toast.info('Worktree updated to PR’s latest commit.');
        } else if (result.refreshed === 'kept-local') {
          window.toast.warn('Worktree has local changes — not updated. Stash or commit, then re-open.');
        }
      }
      // Success path: main clears state and broadcasts pr-checkout-ready;
      // the main-window listener in app.js takes over from here.
    });
    var aiBtn = hostEl.querySelector('.js-ai-review');
    if (aiBtn && window.AgentSplit && AgentSplit.createToolbar) {
      // Replace the static review button with a global Agent + Version toolbar.
      // The selection here is the one default agent (and its model) that every
      // PR action uses — review, implement, CI debug, ask.
      var toolbar = AgentSplit.createToolbar({
        runLabel: 'Run Review',
        onRun: function (agent) {
          activeTab = 'ai-review';
          startAiReview(agent); // no-ops if a run is already in flight
        },
      });
      toolbar.classList.add('js-ai-review');
      aiBtn.replaceWith(toolbar);
    } else if (aiBtn) {
      aiBtn.addEventListener('click', function () {
        activeTab = 'ai-review';
        if (!aiReview.requestId && !aiReview.finalText) startAiReview();
        else if (lastState) render(lastState);
      });
    }
  }

  // ---- G7: AI review cache ----

  async function loadAiReviewCache(owner, repo, number) {
    var result = await window.klaus.pr.cacheGetByPr(owner, repo, number);
    if (!result || !result.cached) return;
    // Bail if the user navigated to a different PR while we were loading.
    if (!lastState || lastState.number !== number) return;
    var cached = result.cached;

    aiReview.finalText = cached.finalText || '';
    reconcileFindings(parseReviewFindings(aiReview.finalText).findings);
    if (cached.findingState) {
      aiReview.findings.forEach(function (f) {
        var saved = cached.findingState[f.key];
        if (!saved) return;
        f.ignored = !!saved.ignored;
        f.status = saved.status || 'open';
        if (saved.implementOut) f.implementOut = saved.implementOut;
        if (saved.implementError) f.implementError = saved.implementError;
        if (saved.commentStatus) f.commentStatus = saved.commentStatus;
        if (saved.commentError) f.commentError = saved.commentError;
        // Restore user-edited review text. Legacy caches stored an edited
        // body under `commentBody`; migrate that into `f.text` so old
        // reviews still show user edits after upgrade.
        if (saved.text != null) f.text = saved.text;
        else if (saved.commentBody != null && saved.commentBody.trim() !== '') f.text = saved.commentBody;
        if (saved.originalText != null) f.originalText = saved.originalText;
        if (Array.isArray(saved.chatMessages)) f.chatMessages = saved.chatMessages;
        if (saved.usage) f.usage = saved.usage;
        if (saved.investigateResult) f.investigateResult = saved.investigateResult;
        if (saved.investigateError) f.investigateError = saved.investigateError;
        if (saved.implementDraftComment) f.implementDraftComment = saved.implementDraftComment;
        if (saved.implementDraftStatus) f.implementDraftStatus = saved.implementDraftStatus;
        // Restore previously-verified location so the chip renders
        // immediately — verifyFindingLocations will re-confirm against the
        // current worktree but we don't want to flash "?" in the meantime.
        if (saved.line) f.line = saved.line;
        if (saved.path) f.path = saved.path;
        if (saved.locationVerified) f.locationVerified = true;
        if (saved.postMode) f.postMode = saved.postMode;
      });
    }
    if (cached.implementAllSummary) aiReview.implementAllSummary = cached.implementAllSummary;
    if (cached.implementAllUsage) aiReview.implementAllUsage = cached.implementAllUsage;
    if (cached.usage) aiReview.usage = cached.usage;
    repaintAiReviewTab();
    // Tab badge was set to 0 in the new-PR reset; rerender meta to update it.
    var tabBtn = hostEl.querySelector('.pr-review-tab[data-tab="ai-review"]');
    if (tabBtn) tabBtn.innerHTML = 'Review' + renderAiReviewTabCount();
    // After cached findings settle, rebind any chat agents still running
    // for those findings (user sent a chat message, navigated away, came back).
    rehydrateChatAgents();
  }

  function saveAiReviewCache() {
    if (!lastState || !lastState.baseOwner || !lastState.baseRepo) return;
    if (!aiReview.finalText && aiReview.findings.length === 0) return;
    var findingState = {};
    aiReview.findings.forEach(function (f) {
      findingState[f.key] = {
        ignored: !!f.ignored,
        status: f.status,
        implementOut: f.implementOut || '',
        implementError: f.implementError || null,
        commentStatus: f.commentStatus || 'idle',
        commentError: f.commentError || null,
        text: f.text || '',
        originalText: f.originalText != null ? f.originalText : null,
        chatMessages: Array.isArray(f.chatMessages) ? f.chatMessages : [],
        usage: f.usage || null,
        path: f.path || null,
        line: f.line || null,
        locationVerified: !!f.locationVerified,
        postMode: f.postMode || null,
        investigateResult: f.investigateResult || '',
        investigateError: f.investigateError || null,
        implementDraftComment: f.implementDraftComment || '',
        implementDraftStatus: f.implementDraftStatus || null,
      };
    });
    window.klaus.pr.cacheSaveByPr(
      lastState.baseOwner, lastState.baseRepo, lastState.number,
      {
        savedAt: new Date().toISOString(),
        finalText: aiReview.finalText,
        findingState: findingState,
        implementAllSummary: aiReview.implementAllSummary || null,
        implementAllUsage: aiReview.implementAllUsage || null,
        usage: aiReview.usage || null,
      }
    );
  }

  // ---- G7: AI review tab ----

  // Shared with pr-panel.js via renderer/finding-parser.js — the single
  // source of truth for splitting review text into preamble / finding cards /
  // postamble (delimited <FINDINGS> contract first, legacy [Severity:]
  // anchors second, whole-text fallback card last). Defensive fallback: if
  // the shared script ever fails to load, the surface must degrade to
  // whole-text cards, not die at module eval.
  var _FP = window.FindingParser || {
    sanitizeAiTone: function (t) { return t; },
    parseReviewFindings: function (t) { return { preamble: t || '', findings: [], postamble: '' }; },
    severityOf: function () { return ''; },
  };
  var sanitizeAiTone = _FP.sanitizeAiTone;
  var parseReviewFindings = _FP.parseReviewFindings;
  var severityOf = _FP.severityOf;

  // Extract `[Location: path/to/file.ts:42 …]` into structured fields.
  // Returns { path, line, snippet } or null. Accepts 0–2 bold asterisks
  // like the severity matcher, and is lenient about trailing "and code…"
  // text after the line number.
  function parseLocation(text) {
    if (!text) return null;
    var m = text.match(/\*{0,2}\[Location:\s*([^\]]+?)\]\*{0,2}/i);
    if (!m) return null;
    var inner = m[1].trim();
    // Find a `path:line` anchor. Require the path to include a `/` or `.`
    // so we don't accidentally match English like "line: 42". Line must
    // come right after a colon. Optional `-N` after captures a range end
    // (e.g. `reframe.html:1041-1085`).
    var pm = inner.match(/([^\s,;]*[\/.][^\s,;:]*):(\d+)(?:-(\d+))?/);
    if (!pm) return null;
    var snippet = '';
    // Everything after the matched "path:line[-end]" is treated as the
    // snippet hint — the template says "and code_snippet" so strip that
    // prefix.
    var tail = inner.slice(pm.index + pm[0].length).replace(/^\s*(and\s+)?/i, '').trim();
    if (tail) snippet = tail;
    var endLine = pm[3] ? parseInt(pm[3], 10) : null;
    return { path: pm[1], line: parseInt(pm[2], 10), endLine: endLine, snippet: snippet };
  }

  // Pull the first fenced-code block out of a finding — a more reliable
  // snippet for line-verification than the short inline location hint,
  // because the template tells Claude to quote up to 10 lines of the code.
  function firstCodeBlock(text) {
    if (!text) return '';
    var m = text.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
    return m ? m[1] : '';
  }

  // Reconcile parsed-finding text with our state's findings list. Parsing
  // happens on every chunk during streaming, so we want to preserve any
  // per-card status (ignored, implementing, implemented) when the same
  // finding text reappears. Keying on the first-line snippet survives
  // chunk boundaries better than full-text equality.
  function reconcileFindings(parsedFindings) {
    var byKey = {};
    aiReview.findings.forEach(function (f) { byKey[f.key] = f; });
    var next = parsedFindings.map(function (text, idx) {
      var key = findingKey(text, idx);
      var loc = parseLocation(text);
      var prev = byKey[key];
      if (prev) {
        // Preserve user edits across streaming re-parses: once the user has
        // modified the review block via ✎, don't clobber their text with
        // fresh AI output.
        //
        // `userEdited` = the visible text diverged from the pristine AI text.
        // While the AI is still streaming, its text GROWS each re-parse, so we
        // must keep `originalText` in sync with it — otherwise the first parse
        // freezes the body (originalText) and every later (longer) parse looks
        // like a user edit, leaving a truncated finding. Agents that stream in
        // many small deltas (Gemini) hit this; only a real ✎ edit, which
        // changes `text` WITHOUT touching `originalText`, should diverge them.
        var userEdited = prev.originalText != null && prev.text !== prev.originalText;
        if (!userEdited) {
          prev.text = text;
          prev.originalText = text;
          prev.severity = severityOf(text);
          if (loc && !prev.locationVerified) {
            prev.path = loc.path;
            prev.line = loc.line;
            prev.locationRaw = loc;
          }
        } else if (prev.originalText == null) {
          prev.originalText = text;
        }
        return prev;
      }
      return {
        id: 'f-' + Date.now() + '-' + idx + '-' + Math.random().toString(36).slice(2, 6),
        key: key,
        text: text,
        // Pristine copy of the AI's output so the ✎ "Reset to AI text" can
        // restore the original, and so we know whether the user edited.
        originalText: text,
        textEditing: false,
        severity: severityOf(text),
        status: 'open',
        implementId: null,
        implementOut: '',
        implementError: null,
        commentStatus: 'idle', // 'idle' | 'posting' | 'posted' | 'failed'
        commentError: null,
        // Structured location from `[Location: path:line]`. `locationVerified`
        // is true after we confirmed the snippet actually lives at that line
        // (or found the real one nearby). RIGHT-side inline comments are the
        // only mode we support for AI findings — LEFT would only make sense
        // for comments about deleted code, rare for a review.
        path: loc ? loc.path : null,
        line: loc ? loc.line : null,
        side: 'RIGHT',
        locationRaw: loc,
        locationVerified: false,
        // Post mode: 'inline' if we have a verified file+line (draft review
        // comment), 'issue' if we fall back to a general issue comment.
        // Set by verification; drives the Add-to-PR button behavior.
        postMode: loc ? 'inline' : 'issue',
        // Ask-Claude chat state. Stateless on the backend: each turn sends
        // the full conversation. `chatMessages` is [{role, content}].
        chatOpen: false,
        chatMessages: [],
        chatRequestId: null,
        chatStreaming: '',
        chatError: null,
        // Claude-investigate state. One-shot read-only validation of the
        // finding. `investigateResult` is the final markdown verdict;
        // `investigateStreaming` holds in-flight text.
        investigateId: null,
        investigateStreaming: '',
        investigateResult: '',
        investigateError: null,
        // Draft PR comment produced by Claude implement. Status transitions
        // null → 'pending' (awaiting approval) → 'approved' (pushed onto
        // pendingComments) or 'dismissed'. Approve/Dismiss is per-finding.
        implementDraftComment: '',
        implementDraftStatus: null,
      };
    });
    aiReview.findings = next;
    // Kick off verification asynchronously; it'll repaint when it lands.
    verifyFindingLocations();
  }

  function findingKey(text, idx) {
    // First non-empty line tends to be unique (it's the title); fall back to
    // the index so keys are still stable for unparseable findings.
    var firstLine = (text || '').split('\n').find(function (l) { return l.trim(); }) || '';
    return idx + '|' + firstLine.slice(0, 80);
  }

  // Normalize a line for fuzzy matching. The snippet in a finding often
  // differs from the file by whitespace/quoting; collapse spaces and drop
  // surrounding markers so we match on the meaningful tokens.
  function normalizeLine(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  // Best line match across ALL candidate snippets. Searches around the hinted
  // line first (±50). When the [Location] hint is given (which it always is
  // in the AI-review flow), we never accept a "far" match: a confident match
  // must be near the hint OR exactly at the hint line. Otherwise the picker
  // can snap to a tangentially-related snippet that Claude pasted alongside
  // the real code (e.g. a finding about lines 1041-1085 that pastes a call
  // site at line 747 — without this constraint, a unique match at 747 would
  // override the hint and post the comment on the wrong line).
  //
  // Returns { line } if a confident match is found, null otherwise.
  function findSnippetLineAcrossCandidates(fileContent, hintLine, candidates) {
    var lines = fileContent.split('\n');
    var validCandidates = candidates
      .map(function (s) { return normalizeLine(s); })
      .filter(function (s) { return s && s.length >= 4; });
    if (validCandidates.length === 0) return null;

    // Direct hit: any candidate's text appears on the hint line itself.
    if (hintLine && lines[hintLine - 1] != null) {
      var hintLineContent = normalizeLine(lines[hintLine - 1]);
      for (var c = 0; c < validCandidates.length; c++) {
        if (hintLineContent.indexOf(validCandidates[c]) !== -1) {
          return { line: hintLine };
        }
      }
    }

    // Collect every near match (±50 of hint) across every candidate, then
    // pick the closest. We intentionally do NOT collect far matches when a
    // hint is given — a far match means Claude's [Location] is wrong AND
    // we can recover, but the recovery is too easy to fool when a finding
    // pastes context from multiple parts of the file.
    var near = [];
    for (var ci = 0; ci < validCandidates.length; ci++) {
      var t = validCandidates[ci];
      for (var i = 0; i < lines.length; i++) {
        if (normalizeLine(lines[i]).indexOf(t) === -1) continue;
        var ln = i + 1;
        if (!hintLine) { near.push(ln); continue; }
        if (Math.abs(ln - hintLine) <= 50) near.push(ln);
      }
    }
    if (near.length === 0) return null;
    if (!hintLine) return { line: near[0] };
    near.sort(function (a, b) { return Math.abs(a - hintLine) - Math.abs(b - hintLine); });
    return { line: near[0] };
  }

  // Verify each finding's line number by reading the file inside the
  // review's worktree and checking that the snippet lives at the cited
  // line (or finding the true one nearby). Fire-and-forget: updates the
  // finding state and repaints on completion.
  function verifyFindingLocations() {
    if (!aiReview.worktreePath) return;
    aiReview.findings.forEach(function (f) {
      if (!f.path || !f.line) return;
      // Re-verify cached findings missing the file snippet — happens for
      // findings cached from a Klaussy version that didn't capture the file
      // content. Skip only when fully verified.
      if (f.locationVerified && f.verifiedSnippet) return;
      if (f._verifyInFlight) return;
      f._verifyInFlight = true;
      window.klaus.pr.readWorktreeFile(aiReview.worktreePath, f.path).then(function (r) {
        f._verifyInFlight = false;
        if (!r || r.error || !r.content) {
          // File missing / unreadable → we can't verify. Leave postMode
          // at 'inline' if the AI gave us a location — submitReview will
          // surface a server-side error if the path is truly bad, which
          // is more diagnostic than a silent fallback.
          f.locationVerifyError = r && r.error ? r.error : 'unreadable';
          repaintAiReviewTab();
          return;
        }
        var snippet = firstCodeBlock(f.text) || (f.locationRaw && f.locationRaw.snippet) || '';
        // Build candidate list from the fenced code block lines + the
        // location-hint snippet. Considered together (not in priority order)
        // so a tangential first-line match doesn't pre-empt a more relevant
        // later candidate that would have matched near the hint.
        var candidates = snippet.split('\n').map(function (s) { return s.trim(); }).filter(function (s) {
          return s && s.length >= 4 && !/^[\/*#\-]+$/.test(s);
        });
        if (f.locationRaw && f.locationRaw.snippet) candidates.push(f.locationRaw.snippet);
        var match = findSnippetLineAcrossCandidates(r.content, f.line, candidates);
        if (match) {
          f.line = match.line;
          f.locationVerified = true;
          f.postMode = 'inline';
          // Capture file content at the verified location so the card can
          // render the original code in a fixed position (between headers
          // and Comment). End-line preference: locationRaw range like
          // 1041-1085 → keep some of that context; otherwise a small
          // window around the matched line. Capped at ~12 lines so the
          // card stays compact.
          var endLine = (f.locationRaw && f.locationRaw.endLine) || (match.line + 4);
          var startLine = Math.max(1, match.line - 2);
          if (endLine - startLine > 11) endLine = startLine + 11;
          var allLines = r.content.split('\n');
          var snippetLines = allLines.slice(startLine - 1, endLine);
          f.verifiedSnippet = {
            path: f.path,
            startLine: startLine,
            endLine: startLine + snippetLines.length - 1,
            text: snippetLines.join('\n'),
          };
        } else {
          // No match anywhere in the file — Claude probably hallucinated
          // the location. Fall back to issue-comment mode so "Add to PR"
          // still posts *something* useful rather than a broken inline.
          f.locationVerified = false;
          f.postMode = 'issue';
          f.verifiedSnippet = null;
        }
        repaintAiReviewTab();
        saveAiReviewCache();
      }).catch(function (err) {
        f._verifyInFlight = false;
        f.locationVerifyError = err && err.message ? err.message : String(err);
        repaintAiReviewTab();
      });
    });
  }

  // Whether repo-intel (conventions + import graph from conventions-cli) is
  // cached for this PR's repo — surfaced as a chip so the user knows the
  // review prompt is conventions-aware. null = unknown / no worktree yet.
  var repoIntelState = { path: null, available: null };
  function checkRepoIntel(worktreePath) {
    if (!worktreePath) {
      // No worktree (PR switched / not checked out) — don't keep showing the
      // previous repo's chip.
      repoIntelState = { path: null, available: null };
      return;
    }
    if (repoIntelState.path === worktreePath) return;
    repoIntelState.path = worktreePath;
    repoIntelState.available = null;
    window.klaus.task.getRepoIntel(worktreePath).then(function (res) {
      if (repoIntelState.path !== worktreePath) return; // PR switched meanwhile
      var avail = !!(res && res.block);
      if (repoIntelState.available !== avail) {
        repoIntelState.available = avail;
        repaintAiReviewTab();
      }
    }).catch(function (e) {
      console.warn('[pr-review repo-intel]', e);
    });
  }
  function repoIntelChip() {
    return repoIntelState.available
      ? '<span class="pr-ai-conventions-chip" title="This repo’s conventions, rules, and import graph (conventions-cli) are injected into the review prompt">conventions-aware</span>'
      : '';
  }

  function renderAiReviewTabCount() {
    var openFindings = aiReview.findings.filter(function (f) { return !f.ignored && f.status !== 'implemented'; }).length;
    if (!openFindings && !aiReview.requestId && !aiReview.finalText) return '';
    if (!openFindings) return '';
    return ' <span class="pr-tab-count">' + openFindings + '</span>';
  }

  function renderAiReviewTab() {
    var localBlock = renderLocalChanges();
    checkRepoIntel((localChanges && localChanges.worktreePath) || aiReview.worktreePath);
    if (!aiReview.requestId && !aiReview.finalText && !aiReview.error && !aiReview.cancelled) {
      return localBlock
        + '<div class="pr-ai-empty">'
          + '<button class="pr-review-btn pr-ai-run" type="button">Run review</button>'
          + repoIntelChip()
          + '<div class="pr-ai-empty-hint">Spawns the selected agent in a worktree to review the PR end to end. ~1\u20133 min for an average PR.</div>'
        + '</div>';
    }

    var status = aiReview.requestId ? 'streaming' : aiReview.error ? 'error' : aiReview.cancelled ? 'cancelled' : 'done';
    var openFindings = aiReview.findings.filter(function (f) { return !f.ignored; });
    var unimplementedOpen = openFindings.filter(function (f) { return f.status !== 'implemented' && f.status !== 'implementing'; });

    var usageStr = aiReview.usage ? formatUsage(aiReview.usage) : '';
    var head = '<div class="pr-ai-head">'
      + '<span class="pr-ai-title">'
        + (aiReview.requestId ? 'Reviewing\u2026'
            : aiReview.error ? 'Failed'
            : aiReview.cancelled && !aiReview.finalText ? 'Cancelled'
            : aiReview.findings.length + ' finding' + (aiReview.findings.length === 1 ? '' : 's'))
      + '</span>'
      + repoIntelChip()
      + (usageStr ? '<span class="pr-ai-usage" title="Reported by the agent for this review run">' + escHtml(usageStr) + '</span>' : '')
      + (aiReview.requestId
          ? '<button class="pr-ai-cancel pr-review-btn" type="button">Cancel</button>'
          : '')
      + (!aiReview.requestId && unimplementedOpen.length > 1
          ? '<button class="pr-ai-implement-all pr-review-btn" type="button"' + (aiReview.implementAllId ? ' disabled' : '') + '>'
              + (aiReview.implementAllId ? 'Implementing all\u2026' : 'Implement all (' + unimplementedOpen.length + ')')
            + '</button>'
          : '')
      + (!aiReview.requestId
          ? '<button class="pr-ai-rerun pr-review-btn" type="button" title="Run a fresh review">Rerun</button>'
          : '')
    + '</div>';

    var progress = (aiReview.requestId || aiReview.implementAllId) && (aiReview.progress.length || aiReview.implementAllProgress.length)
      ? '<div class="pr-ai-progress">'
        + (aiReview.progress.slice(-6).concat(aiReview.implementAllProgress.slice(-6))).map(function (p) {
            return '<span class="pr-ai-progress-chip' + (p.kind === 'system' ? ' system' : '') + '">' + escHtml(p.label) + '</span>';
          }).join('')
      + '</div>'
      : '';

    var implementAllUsageStr = aiReview.implementAllUsage ? formatUsage(aiReview.implementAllUsage) : '';
    var implementAllSummary = aiReview.implementAllSummary
      ? '<div class="pr-ai-implement-all-summary">'
          + escHtml(aiReview.implementAllSummary)
          + (implementAllUsageStr ? '<div class="pr-ai-implement-usage">' + escHtml(implementAllUsageStr) + '</div>' : '')
        + '</div>'
      : '';
    var implementAllError = aiReview.implementAllError
      ? '<div class="pr-ai-implement-all-error">' + escHtml(aiReview.implementAllError) + '</div>'
      : '';

    var body;
    if (aiReview.error) {
      body = '<div class="pr-ai-body error">' + escHtml(aiReview.error) + '</div>';
    } else if (!aiReview.finalText && aiReview.requestId) {
      body = '<div class="pr-ai-body status-pulse">Working\u2026</div>';
    } else if (aiReview.findings.length === 0) {
      // Parser found nothing — show the raw text as one fallback card so the
      // user still sees the review even when the structured shape is off.
      body = '<div class="pr-ai-fallback-card">'
        + '<div class="pr-ai-fallback-head">Review (unparsed)</div>'
        + '<pre class="pr-ai-fallback-body">' + escHtml(sanitizeAiTone(aiReview.finalText || '')) + '</pre>'
      + '</div>';
    } else {
      body = '<div class="pr-ai-findings">'
        + aiReview.findings.map(renderFindingCard).join('')
      + '</div>';
    }

    return '<div class="pr-ai-tab pr-ai-' + status + '">'
      + localBlock + head + progress + implementAllSummary + implementAllError + body
    + '</div>';
  }

  function renderImplementTerminalChrome() {
    var statusLabel;
    var statusClass = '';
    if (!implRun) { statusLabel = 'Idle — no run in progress'; statusClass = ''; }
    else if (implRun.status === 'done') { statusLabel = 'Done'; statusClass = 'done'; }
    else if (implRun.status === 'error') { statusLabel = 'Error'; statusClass = 'error'; }
    else if (implRun.status === 'cancelled') { statusLabel = 'Cancelled'; statusClass = ''; }
    else { statusLabel = 'Running…'; }
    var ctaButtons = '';
    if (implRunIsLive()) {
      ctaButtons += '<button class="pr-implement-cancel pr-review-btn" type="button">Cancel</button>';
    }
    // Hide terminal: always available while no run is live, so the user
    // can clear the persistent scrollback between or after runs.
    if (!implRunIsLive()) {
      ctaButtons += '<button class="pr-implement-dismiss pr-review-btn" type="button">Hide terminal</button>';
    }
    return '<div class="pr-implement-terminal" id="pr-implement-terminal-host">'
      + '<div class="pr-implement-terminal-head">'
        + '<span class="pr-implement-status ' + statusClass + '">' + escHtml(statusLabel) + '</span>'
        + ctaButtons
      + '</div>'
      + '<div class="pr-implement-terminal-body"></div>'
    + '</div>';
  }

  // Body of the Terminal tab. The xterm persists across implement runs
  // (reviewTerminal); the chrome row shows the status of the most recent
  // run. Empty-state only when no run has ever been started — the
  // tab is always present so users can navigate to it predictably.
  function renderTerminalTab() {
    if (reviewTerminal) return renderImplementTerminalChrome();
    return '<div class="pr-terminal-empty">'
      + '<div class="pr-terminal-empty-title">No agent run in progress</div>'
      + '<div class="pr-terminal-empty-hint">Click <b>Implement</b> on a finding in the Review tab to start an agent session here.</div>'
    + '</div>';
  }

  // Tiny badge next to the "Terminal" tab label while a run is in flight.
  // Mirrors how renderAiReviewTabCount uses the .pr-tab-count chip.
  function renderTerminalTabBadge() {
    if (!implRun) return '';
    var label;
    if (implRun.status === 'running') label = '●';
    else if (implRun.status === 'done') label = '✓';
    else if (implRun.status === 'error') label = '!';
    else if (implRun.status === 'cancelled') label = '×';
    else label = '●';
    return ' <span class="pr-tab-count pr-tab-count-' + implRun.status + '">' + label + '</span>';
  }

  function bindTerminalTab() {
    // The xterm itself is mounted by mountImplementTerminalIfActive after
    // this runs; the chrome buttons get re-bound there too (same pattern as
    // the old inline-on-Review-tab flow).
  }

  // Local-changes block: shows uncommitted edits + unpushed commits in the
  // PR's worktree, with controls to commit (stage all + commit) and push to
  // the PR's head fork branch. Hidden when nothing is local.
  //
  // Renders empty string in three cases:
  //   - localChanges hasn't been fetched yet (no flicker on first render)
  //   - no worktree exists for this PR (user hasn't checked out / implemented)
  //   - worktree exists but is clean and in sync with the PR head SHA
  function renderLocalChanges() {
    var files = (localChanges && localChanges.files) || [];
    var unpushed = (localChanges && localChanges.unpushed) || [];
    var diverged = !!(localChanges && localChanges.diverged);
    var hasWt = !!(localChanges && localChanges.worktreePath);
    var ipcMissing = !(window.klaus && window.klaus.pr && window.klaus.pr.localState);

    // Always render at least a one-line stub so a silent empty render isn't
    // indistinguishable from "feature is broken". The stub also tells the
    // user when the IPC bridge is stale (preload didn't reload) or when no
    // worktree exists yet.
    if (ipcMissing) {
      return '<div class="pr-local-changes pr-local-empty">'
        + '<span class="pr-local-title">Local changes</span>'
        + '<span class="pr-local-counts"> — IPC unavailable. Restart the app (preload didn’t reload).</span>'
      + '</div>';
    }
    if (!localChanges) {
      return '<div class="pr-local-changes pr-local-empty">'
        + '<span class="pr-local-title">Local changes</span>'
        + '<span class="pr-local-counts"> — loading…</span>'
      + '</div>';
    }
    if (localChanges.error) {
      return '<div class="pr-local-changes pr-local-empty">'
        + '<span class="pr-local-title">Local changes</span>'
        + '<span class="pr-local-counts"> — ' + escHtml(localChanges.error) + '</span>'
        + '<button class="pr-local-refresh" type="button" title="Refresh">↻</button>'
      + '</div>';
    }
    if (!hasWt) {
      return '<div class="pr-local-changes pr-local-empty">'
        + '<span class="pr-local-title">Local changes</span>'
        + '<span class="pr-local-counts"> — no worktree found for this PR. Click Implement on a finding (or Check out locally) to set one up.</span>'
        + '<button class="pr-local-refresh" type="button" title="Refresh">↻</button>'
      + '</div>';
    }
    // Worktree exists but nothing's local: show a "clean" stub so the user
    // sees the panel is wired up but quiet.
    if (files.length === 0 && unpushed.length === 0 && !diverged && !localBanner) {
      return '<div class="pr-local-changes pr-local-empty">'
        + '<span class="pr-local-title">Local changes</span>'
        + '<span class="pr-local-counts"> — none. Worktree in sync with PR head.</span>'
        + '<button class="pr-local-refresh" type="button" title="Refresh">↻</button>'
      + '</div>';
    }

    var bannerHtml = '';
    if (localBanner) {
      bannerHtml = '<div class="pr-local-banner ' + localBanner.kind + '">'
        + escHtml(localBanner.text)
      + '</div>';
    }

    var fileListHtml = files.length
      ? '<ul class="pr-local-file-list">'
          + files.map(function (f) {
              return '<li><code class="pr-local-file-status">' + escHtml(f.status) + '</code> '
                + escHtml(f.file) + '</li>';
            }).join('')
        + '</ul>'
      : '';

    var diffHtml = (files.length && localChanges.diff)
      ? '<details class="pr-local-diff"><summary>View diff</summary>'
          + '<pre class="pr-local-diff-body">' + escHtml(localChanges.diff) + '</pre>'
        + '</details>'
      : '';

    var commitHtml = files.length
      ? '<div class="pr-local-commit">'
          + '<input type="text" class="pr-local-commit-msg" placeholder="Commit message"'
            + ' value="' + escHtml(localCommitMsg || '') + '"'
            + (localBusy ? ' disabled' : '') + '>'
          + '<button class="pr-review-btn pr-local-commit-btn" type="button"'
            + (localBusy ? ' disabled' : '') + '>'
            + (localBusy === 'committing' ? 'Committing…' : 'Commit')
          + '</button>'
        + '</div>'
      : '';

    var unpushedHtml = unpushed.length
      ? '<div class="pr-local-unpushed">'
          + '<div class="pr-local-unpushed-head">Unpushed commits ('
            + unpushed.length + ')</div>'
          + '<ul class="pr-local-commit-list">'
            + unpushed.map(function (c) {
                return '<li><code>' + escHtml(c.short) + '</code> ' + escHtml(c.subject || '') + '</li>';
              }).join('')
          + '</ul>'
        + '</div>'
      : (diverged
          ? '<div class="pr-local-unpushed">'
              + '<div class="pr-local-unpushed-head">Local commits diverge from the PR head — push will attempt fast-forward.</div>'
            + '</div>'
          : '');

    var pushBtnHtml = (unpushed.length || diverged)
      ? '<button class="pr-review-btn pr-local-push-btn" type="button"'
          + (localBusy ? ' disabled' : '') + '>'
          + (localBusy === 'pushing' ? 'Pushing…' : 'Push to PR branch')
        + '</button>'
      : '';

    return '<div class="pr-local-changes">'
      + '<div class="pr-local-head">'
        + '<span class="pr-local-title">Local changes</span>'
        + '<span class="pr-local-counts">'
          + (files.length ? files.length + ' uncommitted file' + (files.length === 1 ? '' : 's') : '')
          + (files.length && (unpushed.length || diverged) ? ' · ' : '')
          + (unpushed.length
              ? unpushed.length + ' unpushed commit' + (unpushed.length === 1 ? '' : 's')
              : (diverged ? 'diverged from PR' : ''))
        + '</span>'
        + '<button class="pr-local-refresh" type="button" title="Refresh">↻</button>'
      + '</div>'
      + bannerHtml
      + fileListHtml + diffHtml + commitHtml
      + unpushedHtml + pushBtnHtml
    + '</div>';
  }

  function bindLocalChanges() {
    var section = hostEl.querySelector('.pr-local-changes');
    if (!section) return;

    var msgInput = section.querySelector('.pr-local-commit-msg');
    if (msgInput) {
      msgInput.addEventListener('input', function () {
        // Capture the typed value so a repaint (triggered by an unrelated
        // implement-done callback, etc.) doesn't blow it away.
        localCommitMsg = msgInput.value;
      });
    }

    var refreshBtn = section.querySelector('.pr-local-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () {
      localBanner = null;
      refreshLocalChanges();
    });

    var commitBtn = section.querySelector('.pr-local-commit-btn');
    if (commitBtn) commitBtn.addEventListener('click', function () {
      var msg = msgInput ? msgInput.value.trim() : (localCommitMsg || '').trim();
      if (!msg) {
        localBanner = { kind: 'error', text: 'Commit message required.' };
        repaintAiReviewTab();
        return;
      }
      localCommitMsg = msg;
      localBusy = 'committing';
      localBanner = null;
      repaintAiReviewTab();
      window.klaus.pr.commitLocal(msg, aiReview.worktreePath || null).then(function (r) {
        localBusy = null;
        if (r && r.error) {
          localBanner = { kind: 'error', text: r.error };
          repaintAiReviewTab();
        } else {
          localBanner = { kind: 'ok', text: 'Committed.' };
          // Clear the message field on success so the next commit starts
          // with the default again.
          localCommitMsg = 'Apply review feedback';
          refreshLocalChanges();
        }
      });
    });

    var pushBtn = section.querySelector('.pr-local-push-btn');
    if (pushBtn) pushBtn.addEventListener('click', function () {
      localBusy = 'pushing';
      localBanner = null;
      repaintAiReviewTab();
      window.klaus.pr.pushLocal(aiReview.worktreePath || null).then(function (r) {
        localBusy = null;
        if (r && r.error) {
          localBanner = { kind: 'error', text: r.error };
          repaintAiReviewTab();
        } else {
          localBanner = { kind: 'ok', text: 'Pushed to ' + (r && r.target ? r.target : 'PR branch') + '.' };
          refreshLocalChanges();
        }
      });
    });
  }

  // Fetch the worktree's local-state and repaint. Safe to call repeatedly —
  // the IPC is cheap (a few git commands) and refresh is the right tool both
  // after Claude implements something and after manual commit/push.
  //
  // Pass aiReview.worktreePath as a hint when we have it: the cross-clone
  // lookup in main can miss when the user's local clone has its origin set
  // to the head fork (a self-PR), since that doesn't match the PR's base
  // repo. The hint short-circuits that lookup.
  function refreshLocalChanges() {
    if (!window.klaus || !window.klaus.pr || !window.klaus.pr.localState) return;
    window.klaus.pr.localState(aiReview.worktreePath || null).then(function (r) {
      localChanges = r || null;
      repaintAiReviewTab();
    }).catch(function () {
      // IPC threw — leave localChanges as-is rather than wiping the panel.
    });
  }

  function renderFindingCard(f) {
    var sevCls = f.severity ? ' pr-ai-finding-sev-' + f.severity.replace(/\s+/g, '-') : '';
    var statusCls = f.ignored ? ' ignored'
      : f.status === 'implementing' ? ' implementing'
      : f.status === 'implemented' ? ' implemented'
      : f.status === 'failed' ? ' failed'
      : '';

    // Comment status renders as a small badge that's independent of the
    // implement/ignore lifecycle — a reviewer can both post a comment AND
    // implement the same finding.
    var commentBadge = '';
    var commentBtn = '';
    var editCommentBtn = '';
    // "Edited" = user has modified the review block via the ✎ button. Drives
    // the badge and whether the PR post gets the "AI-generated" attribution
    // prefix (skipped once the user has rewritten the content).
    var customized = f.originalText != null && f.text !== f.originalText;
    var editedBadge = customized
      ? '<span class="pr-ai-finding-comment-edited" title="You edited this review block">✎ edited</span>'
      : '';

    // Add-to-PR behavior depends on whether we have a verified file+line.
    //   - verified → push onto pendingComments (G4 draft review list); the
    //     existing Submit-review UI batches them into a single review.
    //   - unverified → post as a general issue comment (legacy behavior).
    var inDraft = f.postMode === 'inline' && f.locationVerified && pendingCommentExistsForFinding(f.id);
    var addBtnTitle = (f.postMode === 'inline' && f.locationVerified)
      ? (inDraft
          ? 'Draft review comment — click to remove from the pending review'
          : 'Add as draft inline comment at ' + f.path + ':' + f.line)
      : 'No verified file/line — will post as a general PR comment';

    if (f.commentStatus === 'posted') {
      commentBadge = '<span class="pr-ai-finding-comment-status posted" title="Posted to the PR">\u2713 Commented</span>';
    } else if (f.commentStatus === 'posting') {
      commentBadge = '<span class="pr-ai-finding-comment-status posting">Posting\u2026</span>';
    } else if (f.commentStatus === 'failed') {
      commentBadge = '<span class="pr-ai-finding-comment-status failed">! Failed</span>';
      commentBtn = '<button class="pr-ai-finding-comment" type="button" title="Try again">Add to PR</button>';
      editCommentBtn = '<button class="pr-ai-finding-edit-comment" type="button" title="Edit the review block">✎</button>';
    } else if (inDraft) {
      commentBadge = '<span class="pr-ai-finding-comment-status drafted" title="Queued as an inline review comment — submit the review to post it">✎ Drafted</span>';
      commentBtn = '<button class="pr-ai-finding-comment" type="button" title="' + escHtml(addBtnTitle) + '">Remove draft</button>';
      editCommentBtn = '<button class="pr-ai-finding-edit-comment" type="button" title="Edit the review block">✎</button>';
    } else {
      commentBtn = '<button class="pr-ai-finding-comment" type="button" title="' + escHtml(addBtnTitle) + '">Add to PR</button>';
      editCommentBtn = '<button class="pr-ai-finding-edit-comment" type="button" title="Edit the review block">✎</button>';
    }

    // Location chip — shows where the finding will anchor, and whether we
    // Copy-as-markdown button. Copies whatever is currently in the review
    // block — same bytes Add-to-PR would post.
    var copyBtn = '<button class="pr-ai-finding-copy" type="button" title="Copy this finding as markdown">'
      + (f.copyStatus === 'copied' ? '✓ Copied' : 'Copy')
    + '</button>';

    // Ask-Claude button. Toggles the inline chat panel so reviewers can
    // discuss the finding without leaving the card (e.g., "is this
    // actually a bug?", "what's the simplest fix?").
    var discussLabel = (f.chatMessages && f.chatMessages.length)
      ? 'Chat (' + f.chatMessages.filter(function (m) { return m.role === 'user'; }).length + ')'
      : 'Ask';
    var discussBtn = '<button class="pr-ai-finding-discuss' + (f.chatOpen ? ' open' : '') + '" type="button" title="Discuss this finding with the agent">'
      + escHtml(discussLabel)
    + '</button>';

    // Claude-investigate button. One-shot read-only validation: claude reads
    // the relevant files and returns a Verdict/Reasoning/Recommendation block.
    // While streaming, the button flips to Cancel.
    var investigateBtn = f.investigateId
      ? '<button class="pr-ai-finding-investigate-cancel" type="button" title="Cancel investigation">Cancel investigate</button>'
      : '<button class="pr-ai-finding-investigate" type="button" title="Ask the agent if this finding is actually valid">'
        + (f.investigateResult ? 'Investigate again' : 'Investigate')
        + '</button>';

    // Inline error block — shown below actions when Add-to-PR failed.
    // Previously the error lived only in a hover-title on a small badge,
    // which made failures feel silent. Now it’s visible in the card.
    var errorBlock = (f.commentStatus === 'failed' && f.commentError)
      ? '<div class="pr-ai-finding-comment-error">'
          + '<div class="pr-ai-finding-comment-error-head">Add-to-PR failed</div>'
          + '<div class="pr-ai-finding-comment-error-body">' + escHtml(f.commentError) + '</div>'
        + '</div>'
      : '';

    var actions;
    if (f.ignored) {
      actions = commentBadge + copyBtn + '<button class="pr-ai-finding-undo" type="button">Restore</button>';
    } else if (f.status === 'implementing') {
      actions = commentBadge + copyBtn + '<button class="pr-ai-finding-cancel" type="button">Cancel</button>';
    } else if (f.status === 'implemented') {
      actions = '<span class="pr-ai-finding-status">\u2713 Implemented</span>'
        + commentBadge + editedBadge + copyBtn + investigateBtn + discussBtn + editCommentBtn
        + commentBtn
        + '<button class="pr-ai-finding-redo" type="button" title="Run implement again">Implement again</button>';
    } else {
      actions = commentBadge + editedBadge + copyBtn + investigateBtn + discussBtn + editCommentBtn
        + '<button class="pr-ai-finding-ignore" type="button">Ignore</button>'
        + commentBtn
        + '<button class="pr-ai-finding-implement" type="button" title="The agent updates the file and drafts a follow-up PR comment for your approval">Implement</button>';
    }

    var implementOutTxt = f.implementError || f.implementOut || '';
    var implementUsage = f.usage ? formatUsage(f.usage) : '';
    var implementOut = (f.status === 'implementing' || f.status === 'implemented' || f.status === 'failed')
      && (implementOutTxt || implementUsage)
      ? '<div class="pr-ai-finding-implement-out' + (f.implementError ? ' error' : '') + '">'
          + (implementOutTxt ? escHtml(implementOutTxt) : '')
          + (implementUsage ? '<div class="pr-ai-implement-usage">' + escHtml(implementUsage) + '</div>' : '')
        + '</div>'
      : '';

    // When editing, the review body *becomes* the textarea — the ✎ button
    // edits the review block in place rather than opening a separate comment
    // composer. On save we re-run location verification since moving or
    // reshaping the quoted snippet can invalidate the matched line.
    var bodyHtml;
    if (f.textEditing) {
      bodyHtml =
        '<div class="pr-ai-finding-body editing">'
          + '<textarea class="pr-ai-finding-body-input" rows="8">' + escHtml(f.text) + '</textarea>'
          + '<div class="pr-ai-finding-body-actions">'
            + (f.originalText != null && f.text !== f.originalText
                ? '<button class="pr-ai-finding-body-reset" type="button" title="Restore the original AI text">Reset to AI text</button>'
                : '')
            + '<button class="pr-ai-finding-body-cancel" type="button">Cancel</button>'
            + '<button class="pr-ai-finding-body-save" type="button">Save</button>'
          + '</div>'
        + '</div>';
    } else {
      // Render in three parts so the original-code block lands at a fixed
      // position regardless of what Claude wrote:
      //   [Severity / Location / Category]
      //   <verified original code from the file>
      //   [Comment + prose + Suggested change]
      // Splits f.text on the first "Comment:" marker (case-insensitive,
      // tolerant of 0-2 leading asterisks like `**Comment:**`). When
      // verifiedSnippet is set, also strip any fenced code block from the
      // pre-Comment chunk so we don't duplicate Claude's pasted original
      // code with our own. The full f.text (including the pasted block) is
      // still posted to GitHub when the user submits — this stripping only
      // affects the in-card render.
      var displayText = f.text || '';
      var commentMatch = displayText.match(/^\s*\*{0,2}Comment\*{0,2}\s*:/im);
      var preText, postText;
      if (commentMatch) {
        preText = displayText.slice(0, commentMatch.index).trim();
        postText = displayText.slice(commentMatch.index);
      } else {
        preText = '';
        postText = displayText;
      }

      var originalSnippetHtml = '';
      if (f.verifiedSnippet && f.verifiedSnippet.text) {
        var vs = f.verifiedSnippet;
        var label = escHtml(vs.path)
          + ':' + vs.startLine
          + (vs.endLine && vs.endLine !== vs.startLine ? '-' + vs.endLine : '');
        originalSnippetHtml = '<div class="pr-ai-finding-original">'
          + '<div class="pr-ai-finding-original-head">Original code at ' + label + '</div>'
          + '<pre class="pr-ai-finding-original-code"><code>' + escHtml(vs.text) + '</code></pre>'
        + '</div>';
        // Drop redundant fenced code block(s) from pre-Comment text — those
        // are Claude's pasted "original code" which we now show verbatim
        // from the file. Don't touch postText: a Suggested change block
        // there is intentional.
        preText = preText.replace(/```[a-zA-Z0-9_-]*\n[\s\S]*?```\n?/g, '').trim();
      }

      bodyHtml = '<div class="pr-ai-finding-body">'
        + (preText ? renderMarkdown(preText) : '')
        + originalSnippetHtml
        + (postText ? renderMarkdown(postText) : '')
      + '</div>';
    }

    return '<div class="pr-ai-finding' + sevCls + statusCls + '" data-finding-id="' + f.id + '">'
      + bodyHtml
      + '<div class="pr-ai-finding-actions">' + actions + '</div>'
      + errorBlock
      + renderInvestigatePanel(f)
      + renderChatPanel(f)
      + implementOut
      + renderDraftCommentBlock(f)
    + '</div>';
  }

  // Investigate panel — shown when a claude-investigate run is streaming or
  // has produced a result. Single-shot (no composer); user can re-run via
  // the Investigate button, which fires startInvestigate again.
  function renderInvestigatePanel(f) {
    if (!f.investigateId && !f.investigateResult && !f.investigateError) return '';
    var body;
    if (f.investigateId) {
      var stream = (f.investigateStreaming || '').trim();
      body = stream
        ? '<div class="pr-ai-finding-investigate-body streaming">' + renderMarkdown(f.investigateStreaming) + '</div>'
        : '<div class="pr-ai-finding-investigate-body streaming status-pulse">Investigating…</div>';
    } else if (f.investigateError) {
      body = '<div class="pr-ai-finding-investigate-error">' + escHtml(f.investigateError) + '</div>';
    } else {
      body = '<div class="pr-ai-finding-investigate-body">' + renderMarkdown(f.investigateResult) + '</div>';
    }
    var header = '<div class="pr-ai-finding-investigate-head">'
      + '<span class="pr-ai-finding-investigate-label">Agent verdict</span>'
      + (!f.investigateId && (f.investigateResult || f.investigateError)
          ? '<button class="pr-ai-finding-investigate-clear" type="button" title="Clear this verdict">Clear</button>'
          : '')
    + '</div>';
    return '<div class="pr-ai-finding-investigate-panel">' + header + body + '</div>';
  }

  // Draft-comment block — shown when Claude implement has produced a
  // follow-up PR comment awaiting approval. Editable textarea + Approve /
  // Dismiss buttons. Approved drafts are pushed onto pendingComments and
  // post with the next Submit review.
  function renderDraftCommentBlock(f) {
    if (!f.implementDraftComment) return '';
    if (f.implementDraftStatus === 'dismissed') return '';
    if (f.implementDraftStatus === 'approved') {
      return '<div class="pr-ai-finding-draft-comment approved">'
        + '<span class="pr-ai-finding-draft-badge">✓ Draft comment added</span>'
        + '<button class="pr-ai-finding-draft-unapprove" type="button" title="Pull this draft back out of the review">Remove</button>'
      + '</div>';
    }
    var anchorHint = (f.locationVerified && f.path && f.line)
      ? 'Inline at ' + escHtml(f.path) + ':' + f.line
      : 'General PR comment (no verified location)';
    return '<div class="pr-ai-finding-draft-comment pending">'
      + '<div class="pr-ai-finding-draft-head">'
        + '<span class="pr-ai-finding-draft-label">Draft PR comment</span>'
        + '<span class="pr-ai-finding-draft-anchor">' + anchorHint + '</span>'
      + '</div>'
      + '<textarea class="pr-ai-finding-draft-input" rows="3">' + escHtml(f.implementDraftComment) + '</textarea>'
      + '<div class="pr-ai-finding-draft-actions">'
        + '<button class="pr-ai-finding-draft-dismiss" type="button">Dismiss</button>'
        + '<button class="pr-ai-finding-draft-approve" type="button">Approve &amp; add to draft</button>'
      + '</div>'
    + '</div>';
  }

  // Chat panel — rendered below the finding actions when f.chatOpen is true.
  // Messages are shown as bubbles; streaming assistant output appears as a
  // growing assistant bubble. Cancel button sits next to Send while a
  // response is in flight.
  function renderChatPanel(f) {
    if (!f.chatOpen) return '';
    var streaming = !!f.chatRequestId;
    var msgs = (f.chatMessages || []).map(function (m) {
      var cls = 'pr-ai-finding-chat-msg ' + (m.role === 'assistant' ? 'assistant' : 'user');
      return '<div class="' + cls + '">' + renderMarkdown(m.content || '') + '</div>';
    }).join('');
    var streamingBubble = (streaming && (f.chatStreaming || '').trim())
      ? '<div class="pr-ai-finding-chat-msg assistant streaming">' + renderMarkdown(f.chatStreaming) + '</div>'
      : streaming
        ? '<div class="pr-ai-finding-chat-msg assistant streaming status-pulse">Thinking…</div>'
        : '';
    var errorBar = f.chatError
      ? '<div class="pr-ai-finding-chat-error">' + escHtml(f.chatError) + '</div>'
      : '';
    return '<div class="pr-ai-finding-chat">'
      + (msgs || streamingBubble
          ? '<div class="pr-ai-finding-chat-messages">' + msgs + streamingBubble + '</div>'
          : '<div class="pr-ai-finding-chat-hint">Ask the agent anything about this finding — is it really a bug? what’s the simplest fix? etc.</div>')
      + errorBar
      + '<div class="pr-ai-finding-chat-composer">'
        + '<textarea class="pr-ai-finding-chat-input" rows="2" placeholder="Message the agent (⌘⏎ to send)"' + (streaming ? ' disabled' : '') + '></textarea>'
        + (streaming
            ? '<button class="pr-ai-finding-chat-cancel" type="button">Cancel</button>'
            : '<button class="pr-ai-finding-chat-send" type="button">Send</button>')
      + '</div>'
    + '</div>';
  }

  // Minimal markdown renderer: bold + inline code + line breaks + fenced
  // code blocks. Enough for review text without pulling in a real markdown
  // library.
  function renderMarkdown(text) {
    var src = (text || '').toString();
    // Pull out fenced code blocks first so their inner content isn't escaped twice.
    var blocks = [];
    src = src.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, function (_, lang, code) {
      var idx = blocks.length;
      blocks.push('<pre class="pr-ai-code"><code>' + escHtml(code) + '</code></pre>');
      return '\u0000CODEBLOCK' + idx + '\u0000';
    });
    src = escHtml(src)
      .replace(/`([^`]+)`/g, '<code class="pr-ai-inline-code">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    src = src.replace(/\u0000CODEBLOCK(\d+)\u0000/g, function (_, i) { return blocks[parseInt(i, 10)]; });
    return src;
  }

  function bindAiReviewTab() {
    bindLocalChanges();

    var runBtn = hostEl.querySelector('.pr-ai-run');
    if (runBtn) runBtn.addEventListener('click', function () { startAiReview(); });

    var rerunBtn = hostEl.querySelector('.pr-ai-rerun');
    if (rerunBtn) rerunBtn.addEventListener('click', function () {
      // Cancel any in-flight implement run so its PTY exits, but KEEP the
      // persistent reviewTerminal — the user wants new Implement runs to
      // append to the same scrollback, not start fresh in a blank xterm.
      if (implRunIsLive()) cancelImplementRun();
      writeRunSeparator('Review rerun');
      // Clear the disk cache so Rerun gives a clean slate.
      if (lastState && lastState.baseOwner && lastState.baseRepo) {
        window.klaus.pr.cacheClearByPr(lastState.baseOwner, lastState.baseRepo, lastState.number);
      }
      aiReview = {
        requestId: null, finalText: '', progress: [], error: null, cancelled: false,
        worktreePath: aiReview.worktreePath, findings: [],
        implementAllId: null, implementAllProgress: [], implementAllError: null, implementAllSummary: null,
        implementAllUsage: null, usage: null,
      };
      startAiReview();
    });

    var cancelBtn = hostEl.querySelector('.pr-ai-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function () {
      if (aiReview.requestId) window.klaus.pr.reviewAiCancel(aiReview.requestId);
    });

    var implementAllBtn = hostEl.querySelector('.pr-ai-implement-all');
    if (implementAllBtn) implementAllBtn.addEventListener('click', function () { startImplementAll(); });

    hostEl.querySelectorAll('.pr-ai-finding').forEach(function (card) {
      var fid = card.dataset.findingId;
      var f = aiReview.findings.find(function (x) { return x.id === fid; });
      if (!f) return;
      var ignore = card.querySelector('.pr-ai-finding-ignore');
      var implementBtn = card.querySelector('.pr-ai-finding-implement');
      var redoBtn = card.querySelector('.pr-ai-finding-redo');
      var undoBtn = card.querySelector('.pr-ai-finding-undo');
      var cancelImpl = card.querySelector('.pr-ai-finding-cancel');
      var commentBtn = card.querySelector('.pr-ai-finding-comment');
      if (ignore) ignore.addEventListener('click', function () { f.ignored = true; repaintAiReviewTab(); saveAiReviewCache(); });
      if (undoBtn) undoBtn.addEventListener('click', function () { f.ignored = false; repaintAiReviewTab(); saveAiReviewCache(); });
      if (implementBtn) implementBtn.addEventListener('click', function () { startImplement(f); });
      if (redoBtn) redoBtn.addEventListener('click', function () { startImplement(f); });
      if (cancelImpl) cancelImpl.addEventListener('click', function () {
        // Route through cancelImplementRun when the active run is this
        // finding's so the inline terminal flips to 'cancelled' immediately.
        if (implRun && implRun.requestId === f.implementId) {
          cancelImplementRun();
        } else if (f.implementId) {
          window.klaus.pr.reviewImplementCancel(f.implementId);
        }
      });
      if (commentBtn) commentBtn.addEventListener('click', function () { postFindingAsComment(f); });

      var copyBtnEl = card.querySelector('.pr-ai-finding-copy');
      if (copyBtnEl) copyBtnEl.addEventListener('click', function () { copyFindingAsMarkdown(f); });

      // "Ask Claude" button toggles the inline chat panel.
      var discussBtnEl = card.querySelector('.pr-ai-finding-discuss');
      if (discussBtnEl) discussBtnEl.addEventListener('click', function () {
        f.chatOpen = !f.chatOpen;
        repaintAiReviewTab();
        if (f.chatOpen) {
          var ta = hostEl.querySelector('.pr-ai-finding[data-finding-id="' + f.id + '"] .pr-ai-finding-chat-input');
          if (ta) ta.focus();
        }
      });

      var chatSendBtn = card.querySelector('.pr-ai-finding-chat-send');
      var chatCancelBtn = card.querySelector('.pr-ai-finding-chat-cancel');
      var chatInputEl = card.querySelector('.pr-ai-finding-chat-input');
      if (chatSendBtn && chatInputEl) chatSendBtn.addEventListener('click', function () {
        var val = chatInputEl.value.trim();
        if (!val) return;
        startChat(f, val);
      });
      if (chatCancelBtn) chatCancelBtn.addEventListener('click', function () {
        if (f.chatRequestId) window.klaus.pr.reviewChatCancel(f.chatRequestId);
      });
      // Cmd/Ctrl-Enter in the textarea sends. Plain Enter keeps the newline
      // (chat messages often need line breaks for code snippets).
      if (chatInputEl) chatInputEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          if (chatSendBtn) chatSendBtn.click();
        }
      });

      // Claude investigate — single-click read-only validation. Cancel button
      // appears in the same slot while streaming.
      var investigateBtnEl = card.querySelector('.pr-ai-finding-investigate');
      if (investigateBtnEl) investigateBtnEl.addEventListener('click', function () { startInvestigate(f); });
      var investigateCancelEl = card.querySelector('.pr-ai-finding-investigate-cancel');
      if (investigateCancelEl) investigateCancelEl.addEventListener('click', function () {
        if (f.investigateId) window.klaus.pr.reviewInvestigateCancel(f.investigateId);
      });
      var investigateClearEl = card.querySelector('.pr-ai-finding-investigate-clear');
      if (investigateClearEl) investigateClearEl.addEventListener('click', function () {
        f.investigateResult = '';
        f.investigateError = null;
        repaintAiReviewTab();
        saveAiReviewCache();
      });

      // Draft-comment block (produced by Claude implement). Approve pushes
      // the current textarea value onto pendingComments as a follow-up
      // reply; Dismiss hides the block; Remove pulls the draft back.
      var draftInputEl = card.querySelector('.pr-ai-finding-draft-input');
      var draftApproveEl = card.querySelector('.pr-ai-finding-draft-approve');
      var draftDismissEl = card.querySelector('.pr-ai-finding-draft-dismiss');
      var draftUnapproveEl = card.querySelector('.pr-ai-finding-draft-unapprove');
      if (draftApproveEl) draftApproveEl.addEventListener('click', function () {
        var val = draftInputEl ? draftInputEl.value.trim() : (f.implementDraftComment || '').trim();
        if (!val) return;
        f.implementDraftComment = val;
        approveImplementDraft(f);
      });
      if (draftDismissEl) draftDismissEl.addEventListener('click', function () {
        f.implementDraftStatus = 'dismissed';
        repaintAiReviewTab();
        saveAiReviewCache();
      });
      if (draftUnapproveEl) draftUnapproveEl.addEventListener('click', function () {
        removeImplementDraft(f);
      });

      // ✎ now edits the review block itself (f.text), not a separate comment
      // composer. The body area swaps to a textarea on the next repaint.
      var editReviewBtn = card.querySelector('.pr-ai-finding-edit-comment');
      if (editReviewBtn) editReviewBtn.addEventListener('click', function () {
        f.textEditing = true;
        repaintAiReviewTab();
        var ta = hostEl.querySelector('.pr-ai-finding[data-finding-id="' + f.id + '"] .pr-ai-finding-body-input');
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      });
      var bodySave = card.querySelector('.pr-ai-finding-body-save');
      var bodyCancel = card.querySelector('.pr-ai-finding-body-cancel');
      var bodyReset = card.querySelector('.pr-ai-finding-body-reset');
      if (bodySave) bodySave.addEventListener('click', function () {
        var ta = card.querySelector('.pr-ai-finding-body-input');
        if (!ta) return;
        var val = ta.value;
        if (val.trim() === '') return; // refuse to save an empty review
        f.text = val;
        f.textEditing = false;
        // Re-parse severity/location from the edited text — the user may
        // have changed the snippet or location line — then re-verify the
        // line against the worktree file.
        f.severity = severityOf(f.text);
        var loc = parseLocation(f.text);
        if (loc) {
          f.path = loc.path;
          f.line = loc.line;
          f.locationRaw = loc;
        }
        f.locationVerified = false;
        f.postMode = (f.path && f.line) ? 'inline' : 'issue';
        repaintAiReviewTab();
        saveAiReviewCache();
        verifyFindingLocations();
      });
      if (bodyCancel) bodyCancel.addEventListener('click', function () {
        f.textEditing = false;
        repaintAiReviewTab();
      });
      if (bodyReset) bodyReset.addEventListener('click', function () {
        if (f.originalText != null) {
          f.text = f.originalText;
          f.severity = severityOf(f.text);
          var loc = parseLocation(f.text);
          f.path = loc ? loc.path : null;
          f.line = loc ? loc.line : null;
          f.locationRaw = loc;
          f.locationVerified = false;
          f.postMode = loc ? 'inline' : 'issue';
        }
        f.textEditing = false;
        repaintAiReviewTab();
        saveAiReviewCache();
        verifyFindingLocations();
      });
    });
  }

  function repaintAiReviewTab() {
    repaintTerminalTabBadge();
    if (activeTab !== 'ai-review') return;
    var tab = hostEl.querySelector('.pr-review-ai-tab');
    if (!tab) return;
    tab.innerHTML = renderAiReviewTab();
    bindAiReviewTab();
    // Update tab count badge as findings change.
    var tabBtn = hostEl.querySelector('.pr-review-tab[data-tab="ai-review"]');
    if (tabBtn) tabBtn.innerHTML = 'Review' + renderAiReviewTabCount();
  }

  // Repaint just the Terminal tab body — used while the implement run's
  // status transitions (running → done/error/cancelled). Cheap because
  // the xterm element is moved back into the new chrome rather than
  // re-instantiated.
  function repaintTerminalTab() {
    repaintTerminalTabBadge();
    if (activeTab !== 'terminal') return;
    var tab = hostEl.querySelector('.pr-review-terminal-tab');
    if (!tab) return;
    tab.innerHTML = renderTerminalTab();
    mountImplementTerminalIfActive();
  }

  function repaintTerminalTabBadge() {
    if (!hostEl) return;
    var tabBtn = hostEl.querySelector('.pr-review-tab[data-tab="terminal"]');
    if (tabBtn) tabBtn.innerHTML = 'Terminal' + renderTerminalTabBadge();
  }

  // Called by implement-run lifecycle callbacks. Keeps Review tab cards
  // in sync (status, draft, usage) AND the Terminal tab chrome.
  function repaintForImplRun() {
    repaintAiReviewTab();
    repaintTerminalTab();
  }

  // Lazy-create the persistent Terminal-tab xterm. Returns the existing
  // instance on subsequent calls so multiple implement runs share the
  // same scrollback. onData/onResize proxy to the *current* implRun,
  // looked up at send time — so the reused terminal works across runs.
  function ensureReviewTerminal() {
    if (reviewTerminal) return reviewTerminal;
    var theme = (window.ThemeManager && ThemeManager.getTerminalTheme)
      ? ThemeManager.getTerminalTheme() : undefined;
    var fontSize = (window.AppState && AppState.currentFontSize) || 13;
    var fontFamily = (window.AppState && AppState.savedPrefs && AppState.savedPrefs.fontFamily)
      || "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace";
    var terminal = new window.Terminal({
      cursorBlink: true,
      fontSize: fontSize,
      fontFamily: fontFamily,
      scrollback: 10000,
      theme: theme,
      allowProposedApi: true,
    });
    var fitAddon = new window.FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    // Always-current proxy: typed input goes to whichever run is active.
    // When no run is in flight, keystrokes are dropped (the user is just
    // scrolling through the log of a finished run).
    terminal.onData(function (data) {
      if (!implRun) return;
      window.klaus.pr.reviewImplementInput(implRun.requestId, data);
    });
    terminal.onResize(function (size) {
      if (!implRun) return;
      window.klaus.pr.reviewImplementResize(implRun.requestId, size.cols, size.rows);
    });
    reviewTerminal = { terminal: terminal, fitAddon: fitAddon, hasContent: false };
    return reviewTerminal;
  }

  function disposeReviewTerminal() {
    if (!reviewTerminal) return;
    try { reviewTerminal.terminal.dispose(); } catch (_) {}
    reviewTerminal = null;
  }

  // ANSI-bold cyan banner between runs so the scrollback is scannable.
  function writeRunSeparator(label) {
    if (!reviewTerminal) return;
    var prefix = reviewTerminal.hasContent ? '\r\n' : '';
    var line = prefix + '\x1b[1;36m── ' + label + ' ──\x1b[0m\r\n';
    try { reviewTerminal.terminal.write(line); } catch (_) {}
    reviewTerminal.hasContent = true;
  }

  // Re-parent the live xterm element back into the host. The xterm
  // instance outlives innerHTML rewrites because we hold the JS
  // reference in reviewTerminal; we just need to move its DOM back.
  function mountImplementTerminalIfActive() {
    if (!reviewTerminal) return;
    var host = hostEl.querySelector('#pr-implement-terminal-host .pr-implement-terminal-body');
    if (!host) return;
    var term = reviewTerminal.terminal;
    if (term.element && term.element.parentElement === host) return;
    if (term.element) {
      host.appendChild(term.element);
    } else {
      // First mount — xterm.open creates the element under the host.
      term.open(host);
    }
    try { reviewTerminal.fitAddon.fit(); } catch (_) {}
    // The cancel/dismiss/mark-done buttons live in the chrome row which
    // gets re-rendered every repaint, so re-bind here.
    var hostRow = hostEl.querySelector('#pr-implement-terminal-host .pr-implement-terminal-head');
    if (hostRow) {
      var cancelBtn = hostRow.querySelector('.pr-implement-cancel');
      if (cancelBtn) cancelBtn.addEventListener('click', cancelImplementRun);
      var dismissBtn = hostRow.querySelector('.pr-implement-dismiss');
      if (dismissBtn) dismissBtn.addEventListener('click', dismissImplementRun);
    }
  }

  // After the OS un-occludes the window (Space-switch back, app refocus), the
  // xterm can paint blank until it's nudged. Re-fit + force a full refresh so
  // a backgrounded-then-foregrounded run's output reappears immediately.
  function setupImplementFocusRefit() {
    if (implFocusRefitHandler) return;
    var refit = function () {
      if (!reviewTerminal || activeTab !== 'terminal') return;
      try {
        reviewTerminal.fitAddon.fit();
        reviewTerminal.terminal.refresh(0, reviewTerminal.terminal.rows - 1);
      } catch (_) {}
    };
    implFocusRefitHandler = refit;
    implVisibilityRefitHandler = function () { if (!document.hidden) refit(); };
    window.addEventListener('focus', implFocusRefitHandler);
    document.addEventListener('visibilitychange', implVisibilityRefitHandler);
  }

  function teardownImplementFocusRefit() {
    if (implFocusRefitHandler) {
      window.removeEventListener('focus', implFocusRefitHandler);
      implFocusRefitHandler = null;
    }
    if (implVisibilityRefitHandler) {
      document.removeEventListener('visibilitychange', implVisibilityRefitHandler);
      implVisibilityRefitHandler = null;
    }
  }

  // Ask the main process whether a backgrounded implement run exists for the
  // PR now on screen; if so, re-attach to it. Covers pop-out (fresh window),
  // navigate-away-and-back, and any teardown that dropped the local run while
  // the PTY kept going. Runs at most once per PR per mount.
  function maybeReattachImplement(prNumber) {
    if (implRun) return;
    if (implReattachCheckedPr === prNumber) return;
    implReattachCheckedPr = prNumber;
    window.klaus.pr.reviewImplementActive().then(function (res) {
      var active = res && res.active;
      if (!active || !active.requestId) return;
      if (implRun) return; // a fresh run started while we were asking
      attachToExistingRun(active.requestId, active.status);
    }).catch(function () {});
  }

  // Re-bind a surface to an already-running (or just-finished) PTY: subscribe
  // to its live streams, replay its buffered output into the xterm, and adopt
  // its status. Used by maybeReattachImplement — not the start path.
  function attachToExistingRun(requestId, snapStatus) {
    if (implRun && implRun.requestId === requestId) return;
    if (implRun) { cleanupImplementRun(); implRun = null; }
    var rt = ensureReviewTerminal();
    implRun = {
      requestId: requestId,
      mode: requestId.indexOf('impla-') === 0 ? 'all' : 'one',
      status: snapStatus === 'running' ? 'running' : snapStatus,
      finalized: snapStatus !== 'running',
      repaint: repaintForImplRun,
      onAssistantText: null, onUsage: null, onTool: null,
      onDone: function () { refreshLocalChanges(); },
      onError: null, onCancelled: null,
      unsubData: null, unsubEvent: null, unsubDone: null,
      reattached: true,
    };
    implRun.unsubData = window.klaus.pr.onReviewImplementData(requestId, function (chunk) {
      if (!implRun || implRun.requestId !== requestId) return;
      try { rt.terminal.write(chunk); rt.hasContent = true; } catch (_) {}
    });
    implRun.unsubEvent = window.klaus.pr.onReviewImplementEvent(requestId, function (ev) {
      if (!implRun || implRun.requestId !== requestId) return;
      if (ev.kind === 'tool' || ev.kind === 'text' || ev.kind === 'usage') {
        if (implRun.repaint) implRun.repaint();
      } else if (ev.kind === 'end_turn') {
        finalizeImplementRun('done');
      }
    });
    implRun.unsubDone = window.klaus.pr.onReviewImplementDone(requestId, function (data) {
      if (!implRun || implRun.requestId !== requestId) return;
      if (implRun.finalized) { cleanupImplementRun(); return; }
      var signal = data && data.signal;
      if (implRun.status === 'cancelled' || signal === 'SIGTERM' || signal === 'SIGKILL') {
        finalizeImplementRun('cancelled');
      } else {
        finalizeImplementRun((data && data.status) || 'done');
      }
    });
    // Pull the buffered output + authoritative status and repaint.
    window.klaus.pr.reviewImplementAttach(requestId).then(function (r) {
      if (!r || !r.found || !implRun || implRun.requestId !== requestId) return;
      if (r.buffer) { try { rt.terminal.write(r.buffer); rt.hasContent = true; } catch (_) {} }
      if (r.status && r.status !== 'running') { implRun.status = r.status; implRun.finalized = true; }
      if (activeTab === 'terminal') {
        mountImplementTerminalIfActive();
        try { rt.fitAddon.fit(); } catch (_) {}
      }
      if (implRun.repaint) implRun.repaint();
    }).catch(function () {});
  }

  // Switch the PR review to the Terminal tab and re-render so the xterm
  // chrome is on screen before the implement IPC starts streaming.
  function switchToTerminalTab() {
    if (activeTab === 'terminal') return;
    activeTab = 'terminal';
    if (lastState) render(lastState);
  }

  function startAiReview(provider) {
    if (aiReview.requestId) return;
    provider = provider || (window.AgentSplit && AgentSplit.getAgent('review'));
    var requestId = 'air-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    aiReview.requestId = requestId;
    aiReview.finalText = '';
    aiReview.progress = [{ kind: 'system', label: 'Preparing worktree\u2026' }];
    aiReview.error = null;
    aiReview.cancelled = false;
    aiReview.findings = [];
    aiReview.usage = null;
    repaintAiReviewTab();

    var buffered = '';
    var unsubData = window.klaus.pr.onReviewAiData(requestId, function (chunk) {
      // Agent kept running after the user navigated to a different PR. Drop
      // chunks that aren't for the AI review currently being tracked here.
      if (aiReview.requestId !== requestId) return;
      buffered += chunk;
      var idx;
      while ((idx = buffered.indexOf('\n')) !== -1) {
        var line = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 1);
        if (!line.trim()) continue;
        try { handleAiEvent(JSON.parse(line)); } catch (_) {}
      }
      reconcileFindings(parseReviewFindings(aiReview.finalText).findings);
      repaintAiReviewTab();
    });
    window.klaus.pr.onReviewAiDone(requestId, function (result) {
      if (unsubData) unsubData();
      if (aiReview.requestId !== requestId) return;
      aiReview.requestId = null;
      if (result && result.error) aiReview.error = result.error;
      if (result && result.cancelled) aiReview.cancelled = true;
      reconcileFindings(parseReviewFindings(aiReview.finalText).findings);
      repaintAiReviewTab();
      // Persist as soon as we have any content (even partial / cancelled —
      // user may still want to revisit the partial findings).
      if (aiReview.finalText) saveAiReviewCache();
    });

    window.klaus.pr.reviewAiStart(requestId, provider).then(function (r) {
      if (r && r.error) {
        if (unsubData) unsubData();
        aiReview.requestId = null;
        aiReview.error = r.error;
        repaintAiReviewTab();
      } else if (r && r.worktreePath) {
        aiReview.worktreePath = r.worktreePath;
      }
    });
  }

  function handleAiEvent(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === 'assistant' && ev.message && ev.message.content) {
      ev.message.content.forEach(function (block) {
        if (block.type === 'text' && block.text) {
          aiReview.finalText = block.text;
        } else if (block.type === 'tool_use' && block.name) {
          var hint = '';
          if (block.input) {
            if (block.input.command) hint = String(block.input.command).slice(0, 50);
            else if (block.input.file_path) hint = String(block.input.file_path).split('/').pop();
            else if (block.input.pattern) hint = String(block.input.pattern).slice(0, 30);
            else if (block.input.description) hint = String(block.input.description).slice(0, 40);
          }
          aiReview.progress.push({ kind: 'tool', label: block.name + (hint ? ': ' + hint : '') });
        }
      });
    } else if (ev.type === 'result') {
      if (ev.result) aiReview.finalText = ev.result;
      // Capture usage so we can show the user what this run cost on their
      // own Anthropic account. Klaussy doesn't bill — we just surface what
      // claude already reports.
      aiReview.usage = extractUsage(ev);
    } else if (ev.type === 'system' && ev.subtype) {
      aiReview.progress.push({ kind: 'system', label: ev.subtype });
    }
  }

  // Pull usage + cost out of a stream-json `result` event into a small,
  // renderer-friendly shape. Returns null if the event doesn't carry it.
  function extractUsage(ev) {
    if (!ev) return null;
    var u = ev.usage || {};
    var input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    var output = u.output_tokens || 0;
    if (!input && !output && typeof ev.total_cost_usd !== 'number') return null;
    return {
      cost: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
      durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : null,
      inputTokens: input,
      outputTokens: output,
    };
  }

  function formatUsage(u) {
    if (!u) return '';
    var bits = [];
    if (typeof u.cost === 'number') bits.push('$' + u.cost.toFixed(u.cost < 0.01 ? 4 : 2));
    if (u.inputTokens || u.outputTokens) bits.push((u.inputTokens || 0).toLocaleString() + ' in / ' + (u.outputTokens || 0).toLocaleString() + ' out');
    if (u.durationMs) bits.push((u.durationMs / 1000).toFixed(1) + 's');
    return bits.join(' \u00b7 ');
  }

  // Strip the <DRAFT_PR_COMMENT>…</DRAFT_PR_COMMENT> block claude emits in
  // single-finding mode out of the implement summary, returning both the
  // cleaned text and the draft body.
  function extractDraftCommentFromText(text) {
    var src = text || '';
    var m = src.match(/<DRAFT_PR_COMMENT>([\s\S]*?)<\/DRAFT_PR_COMMENT>/);
    if (m) {
      return {
        text: (src.slice(0, m.index) + src.slice(m.index + m[0].length)).trim(),
        draft: m[1].trim(),
      };
    }
    // Truncated mid-stream / cancelled before the close marker: drop the
    // dangling opener so the raw marker doesn't leak into the visible
    // implement summary.
    var openIdx = src.indexOf('<DRAFT_PR_COMMENT>');
    if (openIdx !== -1) {
      return { text: src.slice(0, openIdx).trim(), draft: null };
    }
    return { text: src, draft: null };
  }

  // Unified entry point for every implement flow (single finding from a
  // finding card, single finding from a conversation thread, batch "all").
  // Spawns an interactive `claude` in a PTY, mounts an xterm.js so the user
  // can answer Bash/MCP permission prompts, and routes the JSONL-derived
  // structured events back to the caller's mode-specific state updates.
  //
  // opts:
  //   mode             — 'one' | 'all' (passed through to the IPC, controls
  //                      the prompt template in claude-stream-ipc.js)
  //   body             — the finding text(s) to apply
  //   repaint()        — re-renders the surface that shows progress
  //   onAssistantText? — latest assistant text block (for summary / draft)
  //   onUsage?         — usage totals for this turn
  //   onTool?          — chip-shaped { kind: 'tool', label }
  //   onDone?          — fired on stop_reason=end_turn (or manual "mark done")
  //   onError?         — IPC error / unexpected PTY exit
  //   onCancelled?     — user cancelled mid-run
  function startImplementRun(opts) {
    if (implRunIsLive()) return;
    // Carry over the persistent terminal but drop the finalized implRun
    // so the new run's status/repaint isn't shadowed by the old one.
    if (implRun) { cleanupImplementRun(); implRun = null; }
    var requestId = (opts.mode === 'all' ? 'impla-' : 'impl-')
      + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    // Reuse the persistent xterm. If it doesn't exist yet, create it now
    // (and the first mount in mountImplementTerminalIfActive will call
    // terminal.open against the Terminal-tab host).
    var rt = ensureReviewTerminal();

    // Banner so successive runs are scannable in scrollback.
    var bodyPreview = (opts.body || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    var label = (opts.mode === 'all' ? 'Implement all' : 'Implement')
      + (bodyPreview ? ': ' + bodyPreview : '');
    writeRunSeparator(label);

    implRun = {
      requestId: requestId,
      mode: opts.mode,
      status: 'running',
      finalized: false,
      repaint: opts.repaint,
      onAssistantText: opts.onAssistantText,
      onUsage: opts.onUsage,
      onTool: opts.onTool,
      onDone: opts.onDone,
      onError: opts.onError,
      onCancelled: opts.onCancelled,
      unsubData: null,
      unsubEvent: null,
      unsubDone: null,
    };

    // Wire output streams BEFORE the spawn so we don't miss the first
    // bytes claude writes (typically a banner + prompt echo).
    implRun.unsubData = window.klaus.pr.onReviewImplementData(requestId, function (chunk) {
      if (!implRun || implRun.requestId !== requestId) return;
      try { rt.terminal.write(chunk); rt.hasContent = true; } catch (_) {}
    });
    implRun.unsubEvent = window.klaus.pr.onReviewImplementEvent(requestId, function (ev) {
      if (!implRun || implRun.requestId !== requestId) return;
      if (ev.kind === 'tool') {
        var hint = ev.hint ? String(ev.hint).split('/').pop().slice(0, 40) : '';
        if (implRun.onTool) implRun.onTool({ kind: 'tool', label: ev.name + (hint ? ': ' + hint : '') });
        if (implRun.repaint) implRun.repaint();
      } else if (ev.kind === 'text') {
        if (implRun.onAssistantText) implRun.onAssistantText(ev.text);
        if (implRun.repaint) implRun.repaint();
      } else if (ev.kind === 'usage') {
        if (implRun.onUsage) implRun.onUsage(ev.usage);
        if (implRun.repaint) implRun.repaint();
      } else if (ev.kind === 'end_turn') {
        finalizeImplementRun('done');
      }
    });
    implRun.unsubDone = window.klaus.pr.onReviewImplementDone(requestId, function (data) {
      if (!implRun || implRun.requestId !== requestId) return;
      // If we already finalized via end_turn, the PTY exit is just
      // cleanup — don't downgrade the status.
      if (implRun.finalized) { cleanupImplementRun(); return; }
      var signal = data && data.signal;
      if (implRun.status === 'cancelled' || signal === 'SIGTERM' || signal === 'SIGKILL') {
        finalizeImplementRun('cancelled');
      } else {
        finalizeImplementRun('error', 'The agent exited without finishing the turn');
      }
    });

    opts.repaint();

    // Implement with the current global default agent (the one shown on the
    // Review split button / Preferences). opts.provider lets a caller override.
    var implProvider = opts.provider || (window.AgentSplit && AgentSplit.getAgent());
    window.klaus.pr.reviewImplementStart(requestId, opts.mode, opts.body, implProvider).then(function (r) {
      if (!implRun || implRun.requestId !== requestId) return;
      if (r && r.cancelled) {
        finalizeImplementRun('cancelled'); // user declined the trust prompt
      } else if (r && r.error) {
        finalizeImplementRun('error', r.error);
      } else if (r && r.worktreePath) {
        aiReview.worktreePath = r.worktreePath;
      }
    });
  }

  function finalizeImplementRun(finalStatus, errMsg) {
    if (!implRun || implRun.finalized) return;
    implRun.finalized = true;
    implRun.status = finalStatus;
    if (finalStatus === 'done' && implRun.onDone) implRun.onDone();
    else if (finalStatus === 'error' && implRun.onError) implRun.onError(errMsg || 'Implementation failed');
    else if (finalStatus === 'cancelled' && implRun.onCancelled) implRun.onCancelled();
    if (implRun.repaint) implRun.repaint();
    refreshLocalChanges();
    // Ask the main process to terminate the PTY in case it's still alive
    // (e.g. claude's interactive prompt is hanging after end_turn). Cancel
    // is idempotent — if the PTY already exited it's a no-op.
    try { window.klaus.pr.reviewImplementCancel(implRun.requestId); } catch (_) {}
  }

  function cleanupImplementRun() {
    if (!implRun) return;
    if (implRun.unsubData) implRun.unsubData();
    if (implRun.unsubEvent) implRun.unsubEvent();
    if (implRun.unsubDone) implRun.unsubDone();
    implRun.unsubData = null;
    implRun.unsubEvent = null;
    implRun.unsubDone = null;
    // The xterm belongs to reviewTerminal (not implRun) and is reused
    // across runs — only disposeReviewTerminal touches it.
  }

  function dismissImplementRun() {
    cleanupImplementRun();
    implRun = null;
    disposeReviewTerminal();
    repaintForImplRun();
  }

  // True only while a run is actively executing (PTY alive, no end_turn
  // yet) — used as the guard for "can the user start a new Implement?".
  // Done/error/cancelled runs are kept around so their final status
  // renders, but they don't block a fresh run from appending to the
  // same terminal.
  function implRunIsLive() {
    return !!(implRun && implRun.status === 'running');
  }

  function cancelImplementRun() {
    if (!implRun) return;
    implRun.status = 'cancelled';
    if (implRun.repaint) implRun.repaint();
    try { window.klaus.pr.reviewImplementCancel(implRun.requestId); } catch (_) {}
    // The actual finalize fires when the PTY exits — main process sends
    // Ctrl+C first, then SIGTERM after a 2s grace period.
  }

  function startImplement(f) {
    if (implRunIsLive()) return;
    if (f.implementDraftStatus === 'approved') {
      // Clear the queued draft comment so a redo doesn't accumulate stale
      // pendingComments entries alongside the new one.
      pendingComments = pendingComments.filter(function (c) {
        return !(c.fromImplementDraft && c.fromFindingId === f.id);
      });
    }
    f.implementOut = '';
    f.implementError = null;
    f.implementDraftComment = '';
    f.implementDraftStatus = null;
    f.status = 'implementing';
    switchToTerminalTab();
    startImplementRun({
      mode: 'one',
      body: f.text,
      repaint: repaintForImplRun,
      onAssistantText: function (text) { f.implementOut = text; },
      onUsage: function (u) { f.usage = u; },
      onDone: function () {
        var parsed = extractDraftCommentFromText(f.implementOut);
        f.implementOut = parsed.text;
        if (parsed.draft) {
          f.implementDraftComment = parsed.draft;
          f.implementDraftStatus = 'pending';
        }
        f.status = 'implemented';
        f.implementId = null;
        saveAiReviewCache();
      },
      onError: function (msg) {
        f.status = 'failed';
        f.implementError = msg;
        f.implementId = null;
        saveAiReviewCache();
      },
      onCancelled: function () {
        f.status = 'open';
        f.implementId = null;
        saveAiReviewCache();
      },
    });
    // Track the in-flight request on the finding so the per-card "Cancel"
    // button and the Rerun handler can find it via aiReview.findings.
    if (implRun) f.implementId = implRun.requestId;
  }

  // Does the pendingComments list already hold a draft sourced from this
  // finding? Keyed by finding id stored on the pending entry so the
  // "Added to draft / Remove draft" button can toggle correctly.
  function pendingCommentExistsForFinding(findingId) {
    return pendingComments.some(function (c) { return c.fromFindingId === findingId; });
  }

  // Add a finding to the PR. Two paths:
  //   - verified inline location → push onto pendingComments so the draft
  //     appears anchored to the file:line in the diff, and the user can
  //     batch-submit via the existing Submit-review flow.
  //   - unverified or no location → post directly as a general PR issue
  //     comment (legacy behavior, with attribution prefix).
  // The commentStatus lifecycle (posting/posted/failed) only applies to the
  // issue-comment path — drafts are purely client-side until submitted.
  async function postFindingAsComment(f) {
    // Toggle-off when the user clicks the button on an already-drafted
    // finding: pull the draft back out of pendingComments.
    if (pendingCommentExistsForFinding(f.id)) {
      pendingComments = pendingComments.filter(function (c) { return c.fromFindingId !== f.id; });
      repaintAiReviewTab();
      if (lastState) render(lastState);
      return;
    }
    if (f.commentStatus === 'posting' || f.commentStatus === 'posted') return;

    // Post the review block as-is. Prepend an "AI-generated" attribution
    // only when the user hasn't edited the text — once they've rewritten it,
    // the attribution is misleading.
    var userEdited = f.originalText != null && f.text !== f.originalText;
    var attributedBody = userEdited
      ? f.text
      : '> *AI-generated review finding (via Klaussy):*\n\n' + (f.text || '');

    if (f.postMode === 'inline' && f.locationVerified && f.path && f.line) {
      pendingComments.push({
        id: 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        fromFindingId: f.id,
        path: f.path,
        line: f.line,
        side: f.side || 'RIGHT',
        body: attributedBody,
      });
      repaintAiReviewTab();
      saveAiReviewCache();
      if (lastState) render(lastState);
      return;
    }

    // Issue-comment fallback. The await below can reject (not just resolve
    // with {error}) — historically a missing `spawn` import in main left the
    // promise rejected and this function threw an unhandled rejection,
    // stranding the UI at "posting". Wrap in try/catch so the failed badge
    // and error block always render.
    f.commentStatus = 'posting';
    f.commentError = null;
    repaintAiReviewTab();
    try {
      var result = await window.klaus.pr.addIssueComment(attributedBody);
      if (result && result.error) {
        f.commentStatus = 'failed';
        f.commentError = result.error;
      } else {
        f.commentStatus = 'posted';
      }
    } catch (err) {
      console.error('addIssueComment IPC failed', err);
      f.commentStatus = 'failed';
      f.commentError = (err && err.message) ? err.message : String(err);
    }
    repaintAiReviewTab();
    saveAiReviewCache();
    if (f.commentStatus === 'posted') window.klaus.pr.refreshThreads();
  }

  // Approve a Claude-implement draft comment: push it onto pendingComments
  // so it'll post when the user submits the review. Inline when we have a
  // verified path+line, otherwise queued as an issue-comment variant
  // (pr-submit-review posts those after the inline review goes up).
  function approveImplementDraft(f) {
    if (!f.implementDraftComment) return;
    // Don't double-queue if already approved.
    if (pendingComments.some(function (c) { return c.fromImplementDraft && c.fromFindingId === f.id; })) {
      f.implementDraftStatus = 'approved';
      repaintAiReviewTab();
      saveAiReviewCache();
      return;
    }
    var entry = {
      id: 'pending-impl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      fromFindingId: f.id,
      fromImplementDraft: true,
      body: f.implementDraftComment,
    };
    if (f.locationVerified && f.path && f.line) {
      entry.path = f.path;
      entry.line = f.line;
      entry.side = f.side || 'RIGHT';
    } else {
      entry.issueComment = true;
    }
    pendingComments.push(entry);
    f.implementDraftStatus = 'approved';
    repaintAiReviewTab();
    saveAiReviewCache();
    if (lastState) render(lastState);
  }

  function removeImplementDraft(f) {
    pendingComments = pendingComments.filter(function (c) {
      return !(c.fromImplementDraft && c.fromFindingId === f.id);
    });
    f.implementDraftStatus = 'pending';
    repaintAiReviewTab();
    saveAiReviewCache();
    if (lastState) render(lastState);
  }

  // Copy a finding's markdown body to the clipboard — whatever is currently
  // in the review block, edits and all. Flips a transient state flag for a
  // ~1.5s "Copied" label.
  async function copyFindingAsMarkdown(f) {
    try {
      await navigator.clipboard.writeText(f.text || '');
      f.copyStatus = 'copied';
      repaintAiReviewTab();
      setTimeout(function () {
        f.copyStatus = null;
        repaintAiReviewTab();
      }, 1500);
    } catch (err) {
      console.error('clipboard write failed', err);
      f.copyStatus = 'failed';
      repaintAiReviewTab();
      setTimeout(function () { f.copyStatus = null; repaintAiReviewTab(); }, 2000);
    }
  }

  // Kick off a chat turn. Appends the user's message, spawns Claude with
  // the finding body + full transcript, streams the response into
  // f.chatStreaming, then commits it as an assistant message on done.
  async function startChat(f, userMessage) {
    if (f.chatRequestId) return;
    var requestId = 'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    f.chatMessages = (f.chatMessages || []).concat([{ role: 'user', content: userMessage }]);
    f.chatRequestId = requestId;
    f.chatStreaming = '';
    f.chatError = null;
    repaintAiReviewTab();

    var buffered = '';
    var unsubData = window.klaus.pr.onReviewChatData(requestId, function (chunk) {
      if (f.chatRequestId !== requestId) return;
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
              if (block.type === 'text' && block.text) f.chatStreaming = block.text;
            });
          } else if (ev.type === 'result' && ev.result) {
            f.chatStreaming = ev.result;
          }
        } catch (_) {}
      }
      repaintAiReviewTab();
    });
    window.klaus.pr.onReviewChatDone(requestId, function (result) {
      if (unsubData) unsubData();
      if (f.chatRequestId !== requestId) return;
      f.chatRequestId = null;
      if (result && result.error) {
        f.chatError = result.error;
      } else if (result && result.cancelled) {
        // Commit whatever streamed before the cancel so the user keeps the
        // partial response; Claude doesn't get a second chance at the turn.
        if (f.chatStreaming) {
          f.chatMessages.push({ role: 'assistant', content: f.chatStreaming });
        }
      } else {
        f.chatMessages.push({ role: 'assistant', content: f.chatStreaming || '' });
      }
      f.chatStreaming = '';
      repaintAiReviewTab();
      saveAiReviewCache();
    });

    // Send the full transcript so Claude has the arc of the conversation.
    // findingId is passed so the agent's dedupeKey survives across PR loads
    // (otherwise rehydration after navigation can't find the running agent).
    window.klaus.pr.reviewChatStart(requestId, f.text, f.chatMessages, f.id).then(function (r) {
      if (r && r.error) {
        if (unsubData) unsubData();
        f.chatRequestId = null;
        f.chatError = r.error;
        // Roll back the user message we optimistically appended — easier
        // than disabling Send until the IPC resolves.
        f.chatMessages = f.chatMessages.slice(0, -1);
        repaintAiReviewTab();
      }
    });
  }

  // After findings are reconciled, scan the registry for any chat agent
  // still streaming for this PR. If we find one, rebind it to its finding so
  // the streaming bubble shows up again on return.
  function rehydrateChatAgents() {
    if (!lastState || !lastState.number) return;
    if (!aiReview.findings || !aiReview.findings.length) return;
    if (!window.klaus || !window.klaus.agents) return;
    window.klaus.agents.list().then(function (list) {
      if (!list || !list.length) return;
      var prefix = 'pr-review-chat:' + lastState.number + ':';
      list.forEach(function (agent) {
        if (agent.kind !== 'pr-review-chat' || agent.status !== 'running') return;
        if (!agent.dedupeKey || agent.dedupeKey.indexOf(prefix) !== 0) return;
        var fid = agent.dedupeKey.slice(prefix.length);
        var f = aiReview.findings.find(function (x) { return x.id === fid; });
        if (!f || f.chatRequestId === agent.id) return;
        attachChatAgentToFinding(f, agent);
      });
    });
  }

  function attachChatAgentToFinding(f, agent) {
    f.chatRequestId = agent.id;
    f.chatStreaming = '';
    f.chatError = null;
    repaintAiReviewTab();

    var buffered = '';
    var unsubData = window.klaus.pr.onReviewChatData(agent.id, function (chunk) {
      if (f.chatRequestId !== agent.id) return;
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
              if (block.type === 'text' && block.text) f.chatStreaming = block.text;
            });
          } else if (ev.type === 'result' && ev.result) {
            f.chatStreaming = ev.result;
          }
        } catch (_) {}
      }
      repaintAiReviewTab();
    });
    window.klaus.pr.onReviewChatDone(agent.id, function (result) {
      if (unsubData) unsubData();
      if (f.chatRequestId !== agent.id) return;
      f.chatRequestId = null;
      if (result && result.error) {
        f.chatError = result.error;
      } else if (result && result.cancelled) {
        if (f.chatStreaming) f.chatMessages.push({ role: 'assistant', content: f.chatStreaming });
      } else {
        f.chatMessages.push({ role: 'assistant', content: f.chatStreaming || '' });
      }
      f.chatStreaming = '';
      repaintAiReviewTab();
      saveAiReviewCache();
    });
  }

  // ---- Conversation-tab Claude actions ----

  // Build the prompt context for a conv-comment Claude run. Includes the
  // commenter's body and (for review-thread comments) the file/line plus
  // diff hunk so claude doesn't have to guess where to look.
  function buildConvPromptBody(s) {
    var ctx = (s && s.ctx) || {};
    var parts = [];
    if (ctx.kind === 'review' && ctx.path) parts.push('Anchored at: ' + ctx.path);
    if (ctx.hunk && ctx.hunk.trim()) parts.push('Diff hunk:\n```\n' + ctx.hunk + '\n```');
    parts.push('Reviewer comment:\n\n' + (ctx.body || ''));
    return parts.join('\n\n');
  }

  function startConvInvestigate(dbid) {
    var s = convClaudeState[dbid];
    if (!s || s.investigateId) return;
    var requestId = 'cinv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    s.investigateId = requestId;
    s.investigateStreaming = '';
    s.investigateResult = '';
    s.investigateError = null;
    repaintConversationTab();

    var buffered = '';
    var unsubData = window.klaus.pr.onReviewInvestigateData(requestId, function (chunk) {
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
              if (block.type === 'text' && block.text) s.investigateStreaming = block.text;
            });
          } else if (ev.type === 'result' && ev.result) {
            s.investigateStreaming = ev.result;
          }
        } catch (_) {}
      }
      repaintConversationTab();
    });
    window.klaus.pr.onReviewInvestigateDone(requestId, function (result) {
      if (unsubData) unsubData();
      if (s.investigateId !== requestId) return;
      s.investigateId = null;
      if (result && result.error) {
        s.investigateError = result.error;
      } else if (result && result.cancelled) {
        if (s.investigateStreaming) s.investigateResult = s.investigateStreaming;
      } else {
        s.investigateResult = s.investigateStreaming || '';
      }
      s.investigateStreaming = '';
      repaintConversationTab();
    });

    window.klaus.pr.reviewInvestigateStart(requestId, buildConvPromptBody(s)).then(function (r) {
      if (r && r.error) {
        if (unsubData) unsubData();
        s.investigateId = null;
        s.investigateError = r.error;
        repaintConversationTab();
      }
    });
  }

  function startConvImplement(dbid) {
    var s = convClaudeState[dbid];
    if (!s || implRunIsLive()) return;
    s.implementOut = '';
    s.implementError = null;
    s.implementDraft = '';
    s.implementDraftStatus = null;
    repaintConversationTab();

    // The xterm itself mounts in the Terminal tab; the conv card just
    // mirrors progress text. Repaint all three surfaces so the user can
    // switch tabs freely and see consistent state.
    var repaintAll = function () { repaintAiReviewTab(); repaintConversationTab(); repaintTerminalTab(); };

    switchToTerminalTab();
    startImplementRun({
      mode: 'one',
      body: buildConvPromptBody(s),
      repaint: repaintAll,
      onAssistantText: function (text) { s.implementOut = text; },
      onDone: function () {
        var parsed = extractDraftCommentFromText(s.implementOut);
        s.implementOut = parsed.text;
        if (parsed.draft) {
          s.implementDraft = parsed.draft;
          s.implementDraftStatus = 'pending';
        }
        s.implementId = null;
      },
      onError: function (msg) {
        s.implementError = msg;
        s.implementId = null;
      },
      onCancelled: function () {
        s.implementId = null;
      },
    });
    if (implRun) s.implementId = implRun.requestId;
  }

  // Approve and post the implement draft. Inline thread comments → reply
  // via pr-reply-to-review-comment; issue comments → addIssueComment.
  // Refreshes threads on success so the new comment appears in the feed.
  async function approveConvImplementDraft(dbid, btn) {
    var s = convClaudeState[dbid];
    if (!s || !s.implementDraft) return;
    if (s.draftPosting) return;
    var card = btn && btn.closest('.pr-conv-claude-draft');
    var ta = card && card.querySelector('.pr-conv-claude-draft-input');
    var body = ta ? ta.value.trim() : s.implementDraft.trim();
    if (!body) return;
    s.implementDraft = body;
    s.draftPosting = true;
    s.draftError = null;
    repaintConversationTab();

    var ctx = s.ctx || {};
    var result;
    try {
      if (ctx.kind === 'review' && ctx.replyParentId) {
        result = await window.klaus.pr.replyToReviewComment(ctx.replyParentId, body);
      } else {
        result = await window.klaus.pr.addIssueComment(body);
      }
    } catch (err) {
      result = { error: (err && err.message) ? err.message : String(err) };
    }

    s.draftPosting = false;
    if (result && result.error) {
      s.draftError = result.error;
      repaintConversationTab();
      return;
    }
    s.implementDraftStatus = 'approved';
    repaintConversationTab();
    try { await window.klaus.pr.refreshThreads(); } catch (_) {}
  }

  // Kick off a Claude-investigate run. Single-shot read-only: claude reads
  // the code in the worktree and returns a Verdict/Reasoning/Recommendation
  // block. Stores the result on f.investigateResult for the panel to render.
  function startInvestigate(f) {
    if (f.investigateId) return;
    var requestId = 'inv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    f.investigateId = requestId;
    f.investigateStreaming = '';
    f.investigateResult = '';
    f.investigateError = null;
    repaintAiReviewTab();

    var buffered = '';
    var unsubData = window.klaus.pr.onReviewInvestigateData(requestId, function (chunk) {
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
              if (block.type === 'text' && block.text) f.investigateStreaming = block.text;
            });
          } else if (ev.type === 'result' && ev.result) {
            f.investigateStreaming = ev.result;
          }
        } catch (_) {}
      }
      repaintAiReviewTab();
    });
    window.klaus.pr.onReviewInvestigateDone(requestId, function (result) {
      if (unsubData) unsubData();
      if (f.investigateId !== requestId) return;
      f.investigateId = null;
      if (result && result.error) {
        f.investigateError = result.error;
      } else if (result && result.cancelled) {
        // Keep whatever streamed before cancel so the user sees partial progress.
        if (f.investigateStreaming) f.investigateResult = f.investigateStreaming;
      } else {
        f.investigateResult = f.investigateStreaming || '';
      }
      f.investigateStreaming = '';
      repaintAiReviewTab();
      saveAiReviewCache();
    });

    window.klaus.pr.reviewInvestigateStart(requestId, f.text).then(function (r) {
      if (r && r.error) {
        if (unsubData) unsubData();
        f.investigateId = null;
        f.investigateError = r.error;
        repaintAiReviewTab();
      }
    });
  }

  function startImplementAll() {
    if (implRunIsLive()) return;
    var pending = aiReview.findings.filter(function (f) {
      return !f.ignored && f.status !== 'implemented' && f.status !== 'implementing';
    });
    if (pending.length === 0) return;

    pending.forEach(function (f) { f.status = 'implementing'; });
    aiReview.implementAllProgress = [{ kind: 'system', label: 'Implementing ' + pending.length + ' findings\u2026' }];
    aiReview.implementAllError = null;
    aiReview.implementAllSummary = null;
    aiReview.implementAllUsage = null;

    var combined = pending.map(function (f, i) {
      return '### Finding ' + (i + 1) + '\n' + f.text;
    }).join('\n\n');

    switchToTerminalTab();
    startImplementRun({
      mode: 'all',
      body: combined,
      repaint: repaintForImplRun,
      onAssistantText: function (text) { aiReview.implementAllSummary = text; },
      onUsage: function (u) { aiReview.implementAllUsage = u; },
      onTool: function (chip) { aiReview.implementAllProgress.push(chip); },
      onDone: function () {
        pending.forEach(function (f) {
          f.status = 'implemented';
          f.implementOut = aiReview.implementAllSummary || '';
          f.implementId = null;
        });
        aiReview.implementAllId = null;
        saveAiReviewCache();
      },
      onError: function (msg) {
        aiReview.implementAllError = msg;
        pending.forEach(function (f) {
          f.status = 'failed';
          f.implementError = msg;
          f.implementId = null;
        });
        aiReview.implementAllId = null;
        saveAiReviewCache();
      },
      onCancelled: function () {
        pending.forEach(function (f) {
          if (f.status === 'implementing') f.status = 'open';
          f.implementId = null;
        });
        aiReview.implementAllId = null;
        saveAiReviewCache();
      },
    });
    // Tracker for the Rerun button + the disabled state of the
    // "Implement all" button while a run is in flight.
    if (implRun) aiReview.implementAllId = implRun.requestId;
  }

  function bindFileList() {
    hostEl.querySelectorAll('.pr-review-file').forEach(function (row) {
      row.addEventListener('click', function () {
        selectedFile = row.dataset.file;
        if (lastState) render(lastState);
      });
    });
  }

  // ---- G4: draft review comments ----

  // Map the current text selection to a GitHub line-comment range. Mirrors
  // the diff-panel's F5 logic: pool the touched diff-line elements by side
  // (RIGHT if any addition/context touched, else LEFT) and collapse to
  // first/last line. Returns null if nothing usable is selected.
  function computeCommentRange() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    var diffArea = hostEl.querySelector('.pr-review-diff');
    if (!diffArea) return null;
    if (!diffArea.contains(sel.anchorNode) && !diffArea.contains(sel.focusNode)) return null;

    var range = sel.getRangeAt(0);
    var allLines = Array.from(diffArea.querySelectorAll('.diff-line[data-line]'));
    var touched = allLines.filter(function (el) {
      try { return range.intersectsNode(el); } catch (_) { return false; }
    });
    var rightLines = [], leftLines = [];
    touched.forEach(function (el) {
      var ln = parseInt(el.dataset.line, 10);
      if (isNaN(ln)) return;
      if (el.dataset.side === 'LEFT') leftLines.push(ln);
      else rightLines.push(ln);
    });
    var useRight = rightLines.length > 0;
    var pool = useRight ? rightLines : leftLines;
    if (!pool.length) return null;
    pool.sort(function (a, b) { return a - b; });
    var side = useRight ? 'RIGHT' : 'LEFT';
    var first = pool[0], last = pool[pool.length - 1];
    return {
      path: selectedFile,
      side: side,
      line: last,
      startLine: first !== last ? first : null,
      startSide: first !== last ? side : null,
      anchorEl: touched[touched.length - 1],
    };
  }

  function openCommentComposer(range) {
    if (!range || !range.path) return;
    window.getSelection().removeAllRanges();
    // Only one composer at a time — and it's modal-ish for the active range.
    var existing = hostEl.querySelector('.pr-comment-composer');
    if (existing) existing.remove();

    var label = range.startLine
      ? range.path + ':L' + range.startLine + '-L' + range.line
      : range.path + ':L' + range.line;

    var composer = document.createElement('div');
    composer.className = 'pr-comment-composer';
    composer.innerHTML =
      '<div class="pr-comment-composer-head">'
        + '<span>Draft comment on <code>' + escHtml(label) + '</code></span>'
        + '<button class="pr-comment-composer-close" type="button" title="Cancel">&times;</button>'
      + '</div>'
      + '<textarea class="pr-comment-composer-input" placeholder="Comment (\u2318\u23CE to save)" rows="3"></textarea>'
      + '<div class="pr-comment-composer-actions">'
        + '<span class="pr-comment-composer-hint">Saved to your pending review; submit from the header when you\u2019re done.</span>'
        + '<button class="pr-comment-composer-save" type="button">Add comment</button>'
      + '</div>';
    range.anchorEl.insertAdjacentElement('afterend', composer);

    var ta = composer.querySelector('textarea');
    var saveBtn = composer.querySelector('.pr-comment-composer-save');
    ta.focus();

    function close() { composer.remove(); }
    composer.querySelector('.pr-comment-composer-close').addEventListener('click', close);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveBtn.click(); }
    });
    saveBtn.addEventListener('click', function () {
      var body = ta.value.trim();
      if (!body) return;
      pendingComments.push({
        id: 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        path: range.path,
        line: range.line,
        side: range.side,
        startLine: range.startLine,
        startSide: range.startSide,
        body: body,
      });
      close();
      if (lastState) render(lastState);
    });
  }

  function removePendingComment(id) {
    pendingComments = pendingComments.filter(function (c) { return c.id !== id; });
    if (lastState) render(lastState);
  }

  function renderPendingCount() {
    return pendingComments.length;
  }

  function injectPendingComments() {
    if (!selectedFile) return;
    var forFile = pendingComments.filter(function (c) { return c.path === selectedFile; });
    if (forFile.length === 0) return;
    var diffPre = hostEl.querySelector('.pr-review-diff-pre');
    if (!diffPre) return;

    var lineAnchors = {};
    diffPre.querySelectorAll('[data-line]').forEach(function (el) {
      var key = el.dataset.side + ':' + el.dataset.line;
      if (!lineAnchors[key]) lineAnchors[key] = el;
    });

    forFile.forEach(function (c) {
      var anchor = lineAnchors[c.side + ':' + c.line];
      if (!anchor) return;
      // Chain after any existing pending/real threads on the same line.
      var after = anchor;
      while (after.nextElementSibling
        && (after.nextElementSibling.classList.contains('pr-inline-thread')
            || after.nextElementSibling.classList.contains('pr-pending-comment'))) {
        after = after.nextElementSibling;
      }
      var el = document.createElement('div');
      el.className = 'pr-pending-comment';
      el.dataset.pendingId = c.id;
      el.innerHTML =
        '<div class="pr-pending-head">'
          + '<span class="pr-pending-badge">draft</span>'
          + '<span class="pr-pending-summary">' + escHtml(firstTwoLines(c.body)) + '</span>'
          + '<button class="pr-pending-remove" type="button" title="Discard draft">&times;</button>'
        + '</div>'
        + '<div class="pr-pending-body">' + renderCommentBody(c.body) + '</div>';
      after.insertAdjacentElement('afterend', el);
      el.querySelector('.pr-pending-remove').addEventListener('click', function () {
        removePendingComment(c.id);
      });
    });
  }

  function openSubmitReviewDialog() {
    if (pendingComments.length === 0) {
      if (!confirm('No pending comments. Submit review anyway (summary only)?')) return;
    }
    var overlay = document.createElement('div');
    overlay.className = 'pr-submit-overlay';
    overlay.innerHTML =
      '<div class="pr-submit-dialog">'
        + '<div class="pr-submit-head">Submit review</div>'
        + '<div class="pr-submit-count">' + pendingComments.length
          + ' pending comment' + (pendingComments.length === 1 ? '' : 's') + '</div>'
        + '<textarea class="pr-submit-body" placeholder="Overall summary (optional)" rows="4"></textarea>'
        + '<div class="pr-submit-events">'
          + '<label class="pr-submit-event"><input type="radio" name="pr-event" value="COMMENT" checked /> <span class="pr-submit-event-label">Comment</span><span class="pr-submit-event-hint">Submit without approval</span></label>'
          + '<label class="pr-submit-event"><input type="radio" name="pr-event" value="APPROVE" /> <span class="pr-submit-event-label">Approve</span><span class="pr-submit-event-hint">Submit feedback and approve</span></label>'
          + '<label class="pr-submit-event"><input type="radio" name="pr-event" value="REQUEST_CHANGES" /> <span class="pr-submit-event-label">Request changes</span><span class="pr-submit-event-hint">Submit feedback that must be addressed</span></label>'
        + '</div>'
        + '<div class="pr-submit-actions">'
          + '<button class="pr-submit-cancel" type="button">Cancel</button>'
          + '<button class="pr-submit-send" type="button">Submit review</button>'
        + '</div>'
        + '<div class="pr-submit-error" style="display:none;"></div>'
      + '</div>';
    document.body.appendChild(overlay);

    function close() { overlay.remove(); }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('.pr-submit-cancel').addEventListener('click', close);

    var bodyTa = overlay.querySelector('.pr-submit-body');
    var sendBtn = overlay.querySelector('.pr-submit-send');
    var errEl = overlay.querySelector('.pr-submit-error');
    bodyTa.focus();

    sendBtn.addEventListener('click', async function () {
      var event = overlay.querySelector('input[name="pr-event"]:checked').value;
      var body = bodyTa.value.trim();
      // GitHub requires a body for REQUEST_CHANGES and COMMENT reviews (with
      // no inline comments); surface that ahead of the round trip.
      if (event === 'REQUEST_CHANGES' && !body) {
        errEl.style.display = '';
        errEl.textContent = 'Please provide a summary when requesting changes.';
        return;
      }
      if (event === 'COMMENT' && !body && pendingComments.length === 0) {
        errEl.style.display = '';
        errEl.textContent = 'Add a summary or at least one line comment.';
        return;
      }
      sendBtn.disabled = true;
      sendBtn.textContent = 'Submitting\u2026';
      var result = await window.klaus.pr.submitReview({ event: event, body: body, comments: pendingComments });
      if (result.error) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Submit review';
        errEl.style.display = '';
        errEl.textContent = result.error;
        return;
      }
      pendingComments = [];
      close();
      // Pull in the newly-posted threads so they replace the drafts inline.
      await window.klaus.pr.refreshThreads();
    });
  }

  // ---- G3: inline review threads ----

  function injectInlineThreads(threadsByPath) {
    if (!selectedFile) return;
    var fileThreads = threadsByPath[selectedFile] || [];
    if (fileThreads.length === 0) return;
    var diffPre = hostEl.querySelector('.pr-review-diff-pre');
    if (!diffPre) return;

    // Build a map of (side:line) → the DOM node of the matching diff line,
    // so multiple threads on the same line still share an anchor.
    var anchors = {};
    diffPre.querySelectorAll('[data-line]').forEach(function (el) {
      var key = el.dataset.side + ':' + el.dataset.line;
      // First match wins — that's the actual add/del line; context lines also
      // share keys but shouldn't clobber a preferred anchor if one exists.
      if (!anchors[key]) anchors[key] = el;
    });

    var outdated = [];
    fileThreads.forEach(function (thread) {
      var line = thread.line || thread.originalLine;
      var side = thread.diffSide || 'RIGHT';
      var key = side + ':' + line;
      var anchor = line != null ? anchors[key] : null;
      var panel = renderThreadPanel(thread);
      if (anchor) {
        // Chain panels after any existing same-anchor panels so order is stable.
        var after = anchor;
        while (after.nextElementSibling && after.nextElementSibling.classList.contains('pr-inline-thread')) {
          after = after.nextElementSibling;
        }
        after.insertAdjacentHTML('afterend', panel);
      } else {
        outdated.push(thread);
      }
    });

    if (outdated.length > 0) {
      var header = '<div class="pr-inline-thread-outdated-header">'
        + outdated.length + ' outdated ' + (outdated.length === 1 ? 'thread' : 'threads')
        + ' (line no longer present in diff)</div>';
      diffPre.insertAdjacentHTML('beforeend',
        '<div class="pr-inline-thread-outdated">' + header
          + outdated.map(renderThreadPanel).join('')
        + '</div>');
    }

    bindThreadControls();
  }

  function renderThreadPanel(thread) {
    var comments = (thread.comments && thread.comments.nodes) || [];
    var resolvedCls = thread.isResolved ? ' resolved collapsed' : '';
    var outdatedCls = thread.isOutdated ? ' outdated' : '';
    var firstAuthor = comments[0] && comments[0].author ? comments[0].author.login : 'unknown';
    var summary = comments[0] ? firstTwoLines(comments[0].body) : '';

    var commentsHtml = comments.map(function (c) {
      var author = (c.author && c.author.login) || 'unknown';
      var when = c.createdAt ? new Date(c.createdAt).toLocaleString() : '';
      return '<div class="pr-inline-comment">'
        + '<div class="pr-inline-comment-head">'
          + '<span class="pr-inline-author">' + escHtml(author) + '</span>'
          + '<span class="pr-inline-when">' + escHtml(when) + '</span>'
        + '</div>'
        + '<div class="pr-inline-comment-body">' + renderCommentBody(c.body) + '</div>'
      + '</div>';
    }).join('');

    return '<div class="pr-inline-thread' + resolvedCls + outdatedCls + '" data-thread-id="' + escHtml(thread.id) + '">'
      + '<div class="pr-inline-thread-head">'
        + '<span class="pr-inline-thread-chevron">\u25B8</span>'
        + '<span class="pr-inline-thread-summary">'
          + (thread.isResolved ? '<span class="pr-inline-thread-badge resolved">resolved</span>' : '')
          + (thread.isOutdated ? '<span class="pr-inline-thread-badge outdated">outdated</span>' : '')
          + '<span class="pr-inline-thread-author">' + escHtml(firstAuthor) + '</span>'
          + '<span class="pr-inline-thread-preview">' + escHtml(summary) + '</span>'
          + '<span class="pr-inline-thread-count">' + comments.length + '</span>'
        + '</span>'
      + '</div>'
      + '<div class="pr-inline-thread-body">' + commentsHtml + '</div>'
    + '</div>';
  }

  function firstTwoLines(text) {
    if (!text) return '';
    var lines = text.split('\n').filter(function (l) { return l.trim(); });
    var joined = lines.slice(0, 2).join(' ');
    return joined.length > 140 ? joined.slice(0, 140) + '\u2026' : joined;
  }

  // Minimal markdown rendering: preserve newlines + escape everything. Real
  // markdown (code fences, links) can land with G4's composer.
  function renderCommentBody(body) {
    if (!body) return '';
    return escHtml(body).replace(/\n/g, '<br>');
  }

  function bindThreadControls() {
    hostEl.querySelectorAll('.pr-inline-thread').forEach(function (el) {
      var head = el.querySelector('.pr-inline-thread-head');
      head.addEventListener('click', function () {
        el.classList.toggle('collapsed');
      });
    });
  }

  // ---- Conversation tab: per-comment Claude actions ----

  function getConvClaudeState(dbid) {
    if (!dbid) return null;
    if (!convClaudeState[dbid]) convClaudeState[dbid] = {
      investigateId: null, investigateStreaming: '', investigateResult: '', investigateError: null,
      implementId: null, implementOut: '', implementError: null,
      implementDraft: '', implementDraftStatus: null,
    };
    return convClaudeState[dbid];
  }

  // Renders the Claude action row + any in-flight panels for one comment.
  // `ctx` carries everything the button handlers need: dbid, kind ('issue' |
  // 'review'), the comment body (prompt context), and for review comments
  // the thread path/line/replyParentId so an approved draft posts correctly.
  function renderConvClaudeBlock(ctx) {
    if (!ctx || !ctx.dbid) return '';
    var s = getConvClaudeState(ctx.dbid);
    if (!s) return '';
    // Stash the latest context so click handlers can build prompts without
    // scraping the DOM. Refreshed on every render so edits to the underlying
    // comment body flow through.
    s.ctx = ctx;

    var investigateBtn = s.investigateId
      ? '<button class="pr-conv-claude-investigate-cancel" type="button" data-dbid="' + ctx.dbid + '" title="Cancel investigation">Cancel investigate</button>'
      : '<button class="pr-conv-claude-investigate" type="button" data-dbid="' + ctx.dbid + '" title="Ask the agent if this comment’s concern is valid">'
        + (s.investigateResult ? 'Investigate again' : 'Investigate')
        + '</button>';

    var implementBtn = s.implementId
      ? '<button class="pr-conv-claude-implement-cancel" type="button" data-dbid="' + ctx.dbid + '" title="Cancel implement">Cancel implement</button>'
      : '<button class="pr-conv-claude-implement" type="button" data-dbid="' + ctx.dbid + '" title="The agent updates the file(s) and drafts a reply for your approval">'
        + (s.implementDraft ? 'Implement again' : 'Implement')
        + '</button>';

    var actions = '<div class="pr-conv-claude-actions">' + investigateBtn + implementBtn + '</div>';

    var investigatePanel = '';
    if (s.investigateId || s.investigateResult || s.investigateError) {
      var body;
      if (s.investigateId) {
        var stream = (s.investigateStreaming || '').trim();
        body = stream
          ? '<div class="pr-conv-claude-investigate-body streaming">' + renderMarkdown(s.investigateStreaming) + '</div>'
          : '<div class="pr-conv-claude-investigate-body streaming status-pulse">Investigating…</div>';
      } else if (s.investigateError) {
        body = '<div class="pr-conv-claude-investigate-error">' + escHtml(s.investigateError) + '</div>';
      } else {
        body = '<div class="pr-conv-claude-investigate-body">' + renderMarkdown(s.investigateResult) + '</div>';
      }
      var clearBtn = (!s.investigateId && (s.investigateResult || s.investigateError))
        ? '<button class="pr-conv-claude-investigate-clear" type="button" data-dbid="' + ctx.dbid + '" title="Clear this verdict">Clear</button>'
        : '';
      investigatePanel = '<div class="pr-conv-claude-panel">'
        + '<div class="pr-conv-claude-head"><span class="pr-conv-claude-label">Agent verdict</span>' + clearBtn + '</div>'
        + body
      + '</div>';
    }

    var implementPanel = '';
    if (s.implementId || s.implementOut || s.implementError) {
      var iBody;
      if (s.implementError) {
        iBody = '<div class="pr-conv-claude-implement-error">' + escHtml(s.implementError) + '</div>';
      } else {
        var out = (s.implementOut || '').trim();
        iBody = '<div class="pr-conv-claude-implement-body' + (s.implementId ? ' streaming' : '') + '">'
          + (out ? escHtml(out) : (s.implementId ? 'Applying changes…' : ''))
        + '</div>';
      }
      implementPanel = '<div class="pr-conv-claude-panel">'
        + '<div class="pr-conv-claude-head"><span class="pr-conv-claude-label">Implement</span></div>'
        + iBody
      + '</div>';
    }

    var draftPanel = '';
    if (s.implementDraft && s.implementDraftStatus !== 'dismissed') {
      if (s.implementDraftStatus === 'approved') {
        draftPanel = '<div class="pr-conv-claude-draft approved">'
          + '<span class="pr-conv-claude-draft-badge">✓ Reply posted</span>'
        + '</div>';
      } else {
        var anchor = ctx.kind === 'review'
          ? 'Will post as a reply in this thread'
          : 'Will post as a new PR comment';
        draftPanel = '<div class="pr-conv-claude-draft pending" data-dbid="' + ctx.dbid + '">'
          + '<div class="pr-conv-claude-draft-head">'
            + '<span class="pr-conv-claude-draft-label">Draft reply</span>'
            + '<span class="pr-conv-claude-draft-anchor">' + escHtml(anchor) + '</span>'
          + '</div>'
          + '<textarea class="pr-conv-claude-draft-input" rows="3">' + escHtml(s.implementDraft) + '</textarea>'
          + (s.draftError ? '<div class="pr-conv-claude-draft-error">' + escHtml(s.draftError) + '</div>' : '')
          + '<div class="pr-conv-claude-draft-actions">'
            + '<button class="pr-conv-claude-draft-dismiss" type="button" data-dbid="' + ctx.dbid + '">Dismiss</button>'
            + '<button class="pr-conv-claude-draft-approve" type="button" data-dbid="' + ctx.dbid + '">'
              + (s.draftPosting ? 'Posting…' : 'Approve &amp; post')
            + '</button>'
          + '</div>'
        + '</div>';
      }
    }

    return '<div class="pr-conv-claude" data-dbid="' + ctx.dbid + '" data-kind="' + ctx.kind + '"'
      + (ctx.replyParentId ? ' data-reply-to="' + ctx.replyParentId + '"' : '')
    + '>' + actions + investigatePanel + implementPanel + draftPanel + '</div>';
  }

  // ---- Conversation tab (GitHub-style feed) ----

  function renderConversation(state) {
    var meta = state.meta || {};
    var items = buildConversationItems(state);
    var author = (meta.author && (meta.author.login || meta.author.name)) || 'unknown';
    var when = meta.createdAt ? new Date(meta.createdAt).toLocaleString() : '';

    var body = '<div class="pr-conv-item pr-conv-description">'
      + '<div class="pr-conv-head">'
        + '<span class="pr-conv-author">' + escHtml(author) + '</span>'
        + '<span class="pr-conv-kind">opened this pull request</span>'
        + (when ? '<span class="pr-conv-when">' + escHtml(when) + '</span>' : '')
      + '</div>'
      + '<div class="pr-conv-body">' + (meta.body ? renderCommentBody(meta.body) : '<em class="pr-conv-empty">No description provided.</em>') + '</div>'
    + '</div>';

    var feed = items.length === 0
      ? '<div class="pr-conv-empty-feed">No comments or reviews yet.</div>'
      : items.map(renderConversationItem).join('');

    var composer = '<div class="pr-conv-new-comment">'
        + '<div class="pr-conv-new-head">Add a comment</div>'
        + '<textarea class="pr-conv-new-body" placeholder="Write a general comment (\u2318\u23CE to post)" rows="3"></textarea>'
        + '<div class="pr-conv-new-actions">'
          + '<button class="pr-conv-new-post" type="button">Comment</button>'
        + '</div>'
      + '</div>';

    return body + feed + composer;
  }

  function buildConversationItems(state) {
    var items = [];
    (state.issueComments || []).forEach(function (c) {
      items.push({ kind: 'comment', when: c.createdAt, data: c });
    });

    // Thread lookup: each PR review comment belongs to a reviewThread, and
    // the thread holds *all* replies regardless of which review submission
    // wrapped them. Mirror GitHub's UI: show each thread in full under the
    // review that originated it, and hide pure-reply review wrappers.
    var threadByCommentId = {};
    (state.threads || []).forEach(function (t) {
      var threadComments = (t.comments && t.comments.nodes) || [];
      threadComments.forEach(function (c) {
        if (c.databaseId) threadByCommentId[c.databaseId] = t;
      });
    });

    (state.reviews || []).forEach(function (r) {
      if (!r.submittedAt) return;
      var hasBody = r.body && r.body.trim();
      var reviewComments = (r.comments && r.comments.nodes) || [];

      // A review "originates" a thread when the thread's first comment is
      // one of this review's comments. Reply-only reviews never originate
      // anything and drop out of the feed.
      var originatedThreads = [];
      reviewComments.forEach(function (rc) {
        var t = threadByCommentId[rc.databaseId];
        if (!t) return;
        var firstInThread = t.comments && t.comments.nodes && t.comments.nodes[0];
        if (firstInThread && firstInThread.databaseId === rc.databaseId) {
          originatedThreads.push(t);
        }
      });

      if (!hasBody && originatedThreads.length === 0) return;
      items.push({ kind: 'review', when: r.submittedAt, data: r, originatedThreads: originatedThreads });
    });
    items.sort(function (a, b) {
      return new Date(a.when || 0) - new Date(b.when || 0);
    });
    return items;
  }

  function renderConversationItem(item) {
    if (item.kind === 'comment') return renderIssueComment(item.data);
    if (item.kind === 'review') return renderReviewSubmission(item.data, item.originatedThreads);
    return '';
  }

  function renderIssueComment(c) {
    var author = (c.author && c.author.login) || 'unknown';
    var when = c.createdAt ? new Date(c.createdAt).toLocaleString() : '';
    var dbid = c.databaseId;
    var displayBody = (dbid != null && editedCommentOverrides[dbid] != null)
      ? editedCommentOverrides[dbid]
      : c.body;
    var mine = currentUserLogin && author === currentUserLogin;
    var isEditing = editingCommentId === dbid && editingCommentKind === 'issue';
    var claudeBlock = (dbid != null && !isEditing)
      ? renderConvClaudeBlock({ dbid: dbid, kind: 'issue', body: displayBody || '' })
      : '';
    return '<div class="pr-conv-item pr-conv-comment">'
      + '<div class="pr-conv-head">'
        + '<span class="pr-conv-author">' + escHtml(author) + '</span>'
        + '<span class="pr-conv-kind">commented</span>'
        + '<span class="pr-conv-when">' + escHtml(when) + '</span>'
        + (mine && !isEditing && dbid != null
            ? '<button class="pr-conv-edit-btn" type="button" data-kind="issue" data-id="' + dbid + '" title="Edit">✎</button>'
            : '')
      + '</div>'
      + (isEditing
          ? renderCommentEditor(dbid, 'issue', displayBody)
          : '<div class="pr-conv-body">' + renderCommentBody(displayBody) + '</div>')
      + claudeBlock
    + '</div>';
  }

  // Shared composer markup used by both issue comments and inline review
  // thread comments. The save handler picks the PATCH endpoint based on
  // `kind` (stored on the wrapper via data-kind).
  function renderCommentEditor(dbid, kind, body) {
    return '<div class="pr-conv-edit-wrap" data-id="' + dbid + '" data-kind="' + kind + '">'
      + '<textarea class="pr-conv-edit-input" rows="5">' + escHtml(body || '') + '</textarea>'
      + '<div class="pr-conv-edit-actions">'
        + '<span class="pr-conv-edit-error"></span>'
        + '<button class="pr-conv-edit-cancel" type="button">Cancel</button>'
        + '<button class="pr-conv-edit-save" type="button">Save</button>'
      + '</div>'
    + '</div>';
  }

  function renderReviewSubmission(r, originatedThreads) {
    var author = (r.author && r.author.login) || 'unknown';
    var when = r.submittedAt ? new Date(r.submittedAt).toLocaleString() : '';
    var stateLabel = reviewStateLabel(r.state);
    var stateCls = 'pr-conv-state pr-conv-state-' + (r.state || '').toLowerCase();
    var threads = originatedThreads || [];

    var threadsHtml = '';
    if (threads.length > 0) {
      threadsHtml = '<div class="pr-conv-inline-list">'
        + threads.map(renderConversationThread).join('')
      + '</div>';
    }

    var bodyHtml = r.body && r.body.trim() ? '<div class="pr-conv-body">' + renderCommentBody(r.body) + '</div>' : '';

    return '<div class="pr-conv-item pr-conv-review">'
      + '<div class="pr-conv-head">'
        + '<span class="pr-conv-author">' + escHtml(author) + '</span>'
        + '<span class="' + stateCls + '">' + escHtml(stateLabel) + '</span>'
        + (threads.length > 0 ? '<span class="pr-conv-inline-count">' + threads.length + ' inline</span>' : '')
        + '<span class="pr-conv-when">' + escHtml(when) + '</span>'
      + '</div>'
      + bodyHtml
      + threadsHtml
    + '</div>';
  }

  // Render a full thread: the hunk context once, then every comment in the
  // thread stacked (originator + replies), and a Reply composer trigger on
  // the *last* comment so replying posts to the right parent.
  function renderConversationThread(thread) {
    var comments = (thread.comments && thread.comments.nodes) || [];
    if (comments.length === 0) return '';
    var first = comments[0];
    var path = first.path ? first.path + (first.line != null ? ':' + first.line : (thread.line != null ? ':' + thread.line : '')) : (thread.path || '');

    var resolvedCls = thread.isResolved ? ' resolved' : '';
    var outdatedCls = thread.isOutdated ? ' outdated' : '';
    var replyParentId = comments[comments.length - 1].databaseId;

    var threadPath = path;
    var threadHunk = first.diffHunk || '';
    var commentsHtml = comments.map(function (c, i) {
      var author = (c.author && c.author.login) || 'unknown';
      var when = c.createdAt ? new Date(c.createdAt).toLocaleString() : '';
      var dbid = c.databaseId;
      var displayBody = (dbid != null && editedCommentOverrides[dbid] != null)
        ? editedCommentOverrides[dbid]
        : c.body;
      var mine = currentUserLogin && author === currentUserLogin;
      var isEditing = editingCommentId === dbid && editingCommentKind === 'review';
      var claudeBlock = (dbid != null && !isEditing)
        ? renderConvClaudeBlock({
            dbid: dbid,
            kind: 'review',
            body: displayBody || '',
            path: threadPath,
            hunk: threadHunk,
            replyParentId: replyParentId,
          })
        : '';
      return '<div class="pr-conv-thread-comment' + (i === 0 ? ' first' : '') + '">'
        + '<div class="pr-conv-thread-comment-head">'
          + '<span class="pr-conv-author">' + escHtml(author) + '</span>'
          + '<span class="pr-conv-when">' + escHtml(when) + '</span>'
          + (mine && !isEditing && dbid != null
              ? '<button class="pr-conv-edit-btn" type="button" data-kind="review" data-id="' + dbid + '" title="Edit">✎</button>'
              : '')
        + '</div>'
        + (isEditing
            ? renderCommentEditor(dbid, 'review', displayBody)
            : '<div class="pr-conv-thread-comment-body">' + renderCommentBody(displayBody) + '</div>')
        + claudeBlock
      + '</div>';
    }).join('');

    var replyBtn = replyParentId
      ? '<button class="pr-conv-reply-btn" type="button" data-reply-to="' + replyParentId + '">Reply</button>'
      : '';

    return '<div class="pr-conv-inline pr-conv-thread' + resolvedCls + outdatedCls + '">'
      + (path ? '<div class="pr-conv-inline-path">' + escHtml(path)
          + (thread.isResolved ? ' <span class="pr-inline-thread-badge resolved">resolved</span>' : '')
          + (thread.isOutdated ? ' <span class="pr-inline-thread-badge outdated">outdated</span>' : '')
        + '</div>' : '')
      + (first.diffHunk ? '<pre class="pr-conv-inline-hunk">' + escHtml(lastLinesOfHunk(first.diffHunk, 4)) + '</pre>' : '')
      + '<div class="pr-conv-thread-comments">' + commentsHtml + '</div>'
      + (replyBtn ? '<div class="pr-conv-inline-actions">' + replyBtn + '</div>' : '')
    + '</div>';
  }

  function reviewStateLabel(state) {
    switch ((state || '').toUpperCase()) {
      case 'APPROVED': return 'approved these changes';
      case 'CHANGES_REQUESTED': return 'requested changes';
      case 'COMMENTED': return 'reviewed';
      case 'DISMISSED': return 'dismissed review';
      case 'PENDING': return 'pending review';
      default: return (state || '').toLowerCase();
    }
  }

  // diffHunk from the GraphQL API is the full hunk context up to the commented
  // line — showing the tail gives meaningful context without flooding the feed.
  function lastLinesOfHunk(hunk, n) {
    var lines = (hunk || '').split('\n');
    return lines.slice(Math.max(0, lines.length - n)).join('\n');
  }

  // ---- G6: CI checks + merge ----

  async function fetchAndRenderChecks(forNumber) {
    var result = await window.klaus.pr.reviewChecks();
    // Drop stale results if the user switched PRs mid-flight.
    if (!lastState || lastState.number !== forNumber) return;
    currentChecks = result;
    // Required-checks list is independent of the per-commit checks data; fetch
    // in parallel-ish (after main checks so the user sees something fast).
    try {
      var req = await window.klaus.pr.reviewRequiredChecks();
      if (lastState && lastState.number === forNumber) {
        currentRequiredChecks = (req && req.required) || [];
        currentRequiredChecksError = (req && req.error) || '';
      }
    } catch (err) {
      // The gate must not silently green-light merges if the fetch itself
      // crashes (the IPC handler is supposed to catch and return an error,
      // but renderer crashes happen too). Surface as "unknown" in the gate.
      if (lastState && lastState.number === forNumber) {
        currentRequiredChecks = [];
        currentRequiredChecksError = (err && err.message) || 'unknown error';
      }
    }
    renderChecksIntoSlot();
    // Merge gate depends on checks, so repaint the merge control too.
    var mergeWrap = hostEl.querySelector('.pr-merge-wrap');
    if (mergeWrap) updateMergeGate(mergeWrap, lastState);
  }

  function renderChecksTabCount() {
    if (!currentChecks || !currentChecks.checks) return '';
    var n = currentChecks.checks.length;
    if (!n) return '';
    return ' <span class="pr-tab-count">' + n + '</span>';
  }

  function renderChecksTab() {
    if (!currentChecks) {
      return '<div class="pr-conv-empty-feed">Loading checks\u2026</div>';
    }
    if (currentChecks.error) {
      return '<div class="pr-checks-error">Checks failed: ' + escHtml(currentChecks.error) + '</div>';
    }
    var checks = currentChecks.checks || [];
    if (checks.length === 0) {
      return '<div class="pr-conv-empty-feed">No checks reported for this PR.</div>';
    }
    // Group by bucket so the user sees failures first; pending next; pass last.
    var order = ['fail', 'pending', 'cancel', 'skipping', 'pass'];
    function bucketOf(c) {
      if (c.bucket) return c.bucket;
      var s = (c.state || '').toLowerCase();
      if (s === 'success' || s === 'neutral') return 'pass';
      if (s === 'failure' || s === 'timed_out' || s === 'action_required' || s === 'error') return 'fail';
      if (s === 'cancelled') return 'cancel';
      if (s === 'skipped') return 'skipping';
      return 'pending';
    }
    var sorted = checks.slice().sort(function (a, b) {
      return order.indexOf(bucketOf(a)) - order.indexOf(bucketOf(b));
    });
    var header = '<div class="pr-checks-tab-head">'
      + '<span>' + checks.length + ' check' + (checks.length === 1 ? '' : 's') + '</span>'
      + '<div class="pr-checks-tab-actions">'
        + '<button type="button" class="pr-review-btn pr-checks-dispatch">Dispatch workflow…</button>'
        + '<button type="button" class="pr-review-btn pr-checks-refresh">Refresh</button>'
      + '</div>'
    + '</div>';
    // Required-checks gate: shows X/Y required passing + a chip list. Required
    // names that have no matching check today are rendered as "missing" chips —
    // those still gate merge per branch protection rules.
    //
    // If the fetch errored (e.g. gh returned garbage, auth scope missing),
    // render an "unknown" gate explicitly. Silently rendering as "no required
    // checks" would falsely green-light merges.
    var requiredGate = '';
    if (currentRequiredChecksError) {
      requiredGate = '<div class="pr-required-gate pr-required-unknown" title="' + escHtml(currentRequiredChecksError) + '">'
        + '<div class="pr-required-summary">'
          + 'Required checks: <strong>unknown</strong> — could not load branch protection rules. Verify on GitHub before merging.'
        + '</div>'
      + '</div>';
    } else if (currentRequiredChecks && currentRequiredChecks.length > 0) {
      var passingRequired = 0;
      var chipHtml = currentRequiredChecks.map(function (name) {
        var match = checks.find(function (c) { return (c.name || '') === name; });
        var b = match ? bucketOf(match) : 'missing';
        if (b === 'pass') passingRequired += 1;
        return '<span class="pr-required-chip pr-required-' + b + '" title="' + escHtml(b) + '">' + escHtml(name) + '</span>';
      }).join('');
      var allPass = passingRequired === currentRequiredChecks.length;
      requiredGate = '<div class="pr-required-gate ' + (allPass ? 'pr-required-all-pass' : 'pr-required-blocking') + '">'
        + '<div class="pr-required-summary">'
          + '<strong>' + passingRequired + '/' + currentRequiredChecks.length + '</strong> required check' + (currentRequiredChecks.length === 1 ? '' : 's') + ' passing'
        + '</div>'
        + '<div class="pr-required-chips">' + chipHtml + '</div>'
      + '</div>';
    }
    function formatDur(startedAt, completedAt) {
      if (!startedAt) return '';
      var end = completedAt ? new Date(completedAt) : new Date();
      var ms = end - new Date(startedAt);
      if (!isFinite(ms) || ms < 0) return '';
      if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + 's';
      return Math.round(ms / 60000) + 'm';
    }

    function renderRowHtml(c) {
      var b = bucketOf(c);
      var icon = b === 'pass' ? '\u2713' : b === 'fail' ? '\u2717' : b === 'pending' ? '\u25CB' : b === 'cancel' ? '\u2296' : '\u2298';
      var linkAttr = c.link ? ' data-link="' + escHtml(c.link) + '"' : '';
      var debugBtn = (b === 'fail' && c.link)
        ? '<button class="pr-check-debug-btn" type="button" data-link="' + escHtml(c.link) + '" data-name="' + escHtml(c.name || '') + '" data-check-id="' + escHtml(c.id ? String(c.id) : '') + '" title="Use the agent to diagnose this failure">Debug</button>'
        : '';
      // Primary action for failing checks: spawn Claude in the PR worktree
      // with edit tools, then surface the resulting diff for the user to
      // review and push. Debug stays as the read-only inspector for cases
      // where you want analysis without auto-edit.
      var fixBtn = (b === 'fail' && c.link && c.id)
        ? '<button class="pr-check-fix-btn pr-check-action-primary" type="button" data-link="' + escHtml(c.link) + '" data-name="' + escHtml(c.name || '') + '" data-check-id="' + escHtml(String(c.id)) + '" title="Have the agent edit, commit, and push a fix">Fix</button>'
        : '';
      var annotationsBtn = (b === 'fail' && c.id)
        ? '<button class="pr-check-annotations-btn" type="button" data-check-id="' + escHtml(String(c.id)) + '" data-name="' + escHtml(c.name || '') + '" title="Show file:line annotations">Annotations</button>'
        : '';
      var rerunBtn = (b === 'fail' && c.runId)
        ? '<button class="pr-check-action-btn pr-check-action-rerun" type="button" data-run-id="' + escHtml(String(c.runId)) + '" data-name="' + escHtml(c.name || '') + '" title="Rerun failed jobs in this workflow run">Rerun</button>'
        : '';
      var cancelBtn = (b === 'pending' && c.runId)
        ? '<button class="pr-check-action-btn pr-check-action-cancel" type="button" data-run-id="' + escHtml(String(c.runId)) + '" data-name="' + escHtml(c.name || '') + '" title="Cancel this workflow run">Cancel</button>'
        : '';
      var watchBtn = (b === 'pending' && c.runId)
        ? '<button class="pr-check-action-btn pr-check-action-watch" type="button" data-run-id="' + escHtml(String(c.runId)) + '" data-name="' + escHtml(c.name || '') + '" title="Stream the workflow log live">Watch log</button>'
        : '';
      var dur = formatDur(c.startedAt, c.completedAt);
      var durHtml = dur ? '<span class="pr-check-dur">' + dur + '</span>' : '';
      return '<div class="pr-check-row pr-check-' + b + '"' + linkAttr + '>'
        + '<span class="pr-check-icon">' + icon + '</span>'
        + '<div class="pr-check-labels">'
          + '<div class="pr-check-name">' + escHtml(c.name || '(unnamed)') + '</div>'
          + (c.workflow ? '<div class="pr-check-workflow">' + escHtml(c.workflow) + '</div>' : '')
          + (c.description ? '<div class="pr-check-desc">' + escHtml(c.description) + '</div>' : '')
        + '</div>'
        + durHtml
        + '<span class="pr-check-state">' + escHtml((c.state || b).toLowerCase()) + '</span>'
        + watchBtn
        + rerunBtn
        + cancelBtn
        + annotationsBtn
        + debugBtn
        + fixBtn
        + (c.link ? '<span class="pr-check-arrow">\u2197</span>' : '')
      + '</div>';
    }

    // Group checks by runId so the user can see which jobs belong to the same
    // workflow run. Singletons and runId-less checks render flat.
    var groups = {};
    var loose = [];
    sorted.forEach(function (c) {
      if (c.runId) {
        if (!groups[c.runId]) groups[c.runId] = [];
        groups[c.runId].push(c);
      } else {
        loose.push(c);
      }
    });

    function aggregateBucket(items) {
      var buckets = items.map(bucketOf);
      if (buckets.indexOf('fail') >= 0) return 'fail';
      if (buckets.indexOf('pending') >= 0) return 'pending';
      if (buckets.indexOf('cancel') >= 0) return 'cancel';
      if (buckets.indexOf('skipping') >= 0 && buckets.every(function (b) { return b === 'skipping'; })) return 'skipping';
      return 'pass';
    }
    function aggregateDur(items) {
      var starts = items.map(function (c) { return c.startedAt; }).filter(Boolean);
      var ends = items.map(function (c) { return c.completedAt; }).filter(Boolean);
      if (!starts.length) return '';
      var earliest = starts.reduce(function (a, b) { return new Date(a) < new Date(b) ? a : b; });
      var latest = ends.length === items.length ? ends.reduce(function (a, b) { return new Date(a) > new Date(b) ? a : b; }) : null;
      return formatDur(earliest, latest);
    }

    var groupHtml = Object.keys(groups).map(function (runId) {
      var items = groups[runId];
      // Single-check groups don't need a header \u2014 render flat.
      if (items.length < 2) {
        loose = loose.concat(items);
        return '';
      }
      var b = aggregateBucket(items);
      var dur = aggregateDur(items);
      var workflowName = (items.find(function (c) { return c.workflow; }) || {}).workflow || '';
      return '<div class="pr-check-group pr-check-group-' + b + '">'
        + '<div class="pr-check-group-head">'
          + '<span class="pr-check-group-label">' + escHtml(workflowName || ('Run #' + runId)) + '</span>'
          + '<span class="pr-check-group-meta">' + items.length + ' job' + (items.length === 1 ? '' : 's') + (dur ? ' \u00B7 ' + dur : '') + '</span>'
        + '</div>'
        + '<div class="pr-check-group-rows">' + items.map(renderRowHtml).join('') + '</div>'
      + '</div>';
    }).join('');

    var looseHtml = loose.length ? '<div class="pr-checks-list">' + loose.map(renderRowHtml).join('') + '</div>' : '';

    return header + requiredGate + groupHtml + looseHtml;
  }

  function bindChecksTab() {
    var refresh = hostEl.querySelector('.pr-checks-refresh');
    if (refresh) {
      refresh.addEventListener('click', function () {
        refresh.disabled = true;
        refresh.textContent = 'Refreshing\u2026';
        // Force the repaint even if the data hasn't changed \u2014 the button
        // text/disabled state needs to reset, and the user explicitly asked
        // for a refresh so they expect a visible response.
        fetchAndRenderChecks(lastState && lastState.number)
          .then(function () { repaintChecksTab({ force: true }); });
      });
    }
    // Auto-refresh: pull fresh data on every tab activation, then poll while
    // the tab stays active. Without this, an in-progress run kicked off
    // moments ago wouldn't show up until the user manually clicked Refresh
    // (the per-task CI poll updates the sidebar icon but not this surface).
    startChecksPolling();
    var dispatchBtn = hostEl.querySelector('.pr-checks-dispatch');
    if (dispatchBtn) {
      dispatchBtn.addEventListener('click', function () { openWorkflowDispatchModal(); });
    }
    hostEl.querySelectorAll('.pr-check-row[data-link]').forEach(function (row) {
      row.addEventListener('click', function (e) {
        // Don't open the run URL when the user clicks an inline action btn.
        if (e.target.closest('.pr-check-debug-btn')) return;
        if (e.target.closest('.pr-check-fix-btn')) return;
        if (e.target.closest('.pr-check-annotations-btn')) return;
        if (e.target.closest('.pr-check-action-btn')) return;
        var url = row.dataset.link;
        if (url) window.klaus.gh.openExternal(url);
      });
    });
    hostEl.querySelectorAll('.pr-check-debug-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        startDebugCheck(btn);
      });
    });
    hostEl.querySelectorAll('.pr-check-fix-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        startFixCheck(btn);
      });
    });
    hostEl.querySelectorAll('.pr-check-annotations-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleAnnotations(btn);
      });
    });
    hostEl.querySelectorAll('.pr-check-action-rerun').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        runQuickAction(btn, 'rerun');
      });
    });
    hostEl.querySelectorAll('.pr-check-action-cancel').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        runQuickAction(btn, 'cancel');
      });
    });
    hostEl.querySelectorAll('.pr-check-action-watch').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleLogWatch(btn);
      });
    });
    // Restore any panels the user had open before this re-render. Survives
    // both polling repaints and full render() rebuilds (which call
    // bindChecksTab via the tab-activation path).
    restoreOpenAnnotations();
    restoreOpenDebugChecks();
  }

  // Live log tail for an in-progress run. Click again to stop. Renders into a
  // panel below the row with auto-scroll to bottom unless the user has
  // scrolled up (basic stick-to-bottom behavior).
  function toggleLogWatch(btn) {
    var row = btn.closest('.pr-check-row');
    if (!row) return;
    var existing = row.nextElementSibling && row.nextElementSibling.classList.contains('pr-check-log-watch-panel')
      ? row.nextElementSibling : null;
    if (existing) {
      var existingId = existing.dataset.requestId;
      if (existingId) window.klaus.pr.reviewRunLogWatchStop(existingId);
      existing.remove();
      btn.textContent = 'Watch log';
      return;
    }
    var runId = btn.dataset.runId;
    if (!runId) return;
    var requestId = 'log-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    var panel = document.createElement('div');
    panel.className = 'pr-check-log-watch-panel';
    panel.dataset.requestId = requestId;
    panel.innerHTML = '<div class="pr-check-log-watch-head">'
        + '<span>Tailing run #' + escHtml(runId) + '</span>'
        + '<button type="button" class="pr-check-log-watch-stop">Stop</button>'
      + '</div>'
      + '<pre class="pr-check-log-watch-body">Waiting for log…</pre>';
    row.insertAdjacentElement('afterend', panel);
    btn.textContent = 'Stop watching';

    var bodyEl = panel.querySelector('.pr-check-log-watch-body');
    var firstChunk = true;
    var stickBottom = true;
    bodyEl.addEventListener('scroll', function () {
      // Within 12px of the bottom counts as "stuck" for resume-after-render.
      stickBottom = (bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight) < 12;
    });

    var unsubChunk = window.klaus.pr.onRunLogChunk(requestId, function (chunk) {
      if (firstChunk) { bodyEl.textContent = ''; firstChunk = false; }
      bodyEl.appendChild(document.createTextNode(chunk));
      if (stickBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
    });
    var unsubDone = window.klaus.pr.onRunLogDone(requestId, function (info) {
      var head = panel.querySelector('.pr-check-log-watch-head span');
      if (head) {
        if (info && info.truncated) head.textContent = 'Log too large — stopped tailing';
        else if (info && info.conclusion) head.textContent = 'Run completed: ' + info.conclusion;
        else head.textContent = 'Run completed';
      }
      btn.textContent = 'Watch log';
    });

    panel.querySelector('.pr-check-log-watch-stop').addEventListener('click', function () {
      window.klaus.pr.reviewRunLogWatchStop(requestId);
      if (unsubChunk) unsubChunk();
      if (unsubDone) unsubDone();
      panel.remove();
      btn.textContent = 'Watch log';
    });

    window.klaus.pr.reviewRunLogWatchStart(requestId, runId).then(function (res) {
      if (res && res.error) {
        bodyEl.classList.add('diff-error');
        bodyEl.textContent = res.error;
        btn.textContent = 'Watch log';
      }
    });
  }

  // Shared rerun/cancel handler. Button label flips to a transient state, then
  // the Checks tab is refreshed once gh returns. Errors surface on the button
  // itself rather than a toast — keeps the row in scope for the user.
  function runQuickAction(btn, kind) {
    var runId = btn.dataset.runId;
    if (!runId) return;
    var name = btn.dataset.name || ('run #' + runId);
    var verb = kind === 'rerun' ? 'Rerun failed jobs' : 'Cancel run';
    if (!confirm(verb + ' for "' + name + '"?')) return;

    var originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = kind === 'rerun' ? 'Rerunning…' : 'Cancelling…';

    var p = kind === 'rerun'
      ? window.klaus.pr.reviewRunRerunFailed(runId)
      : window.klaus.pr.reviewRunCancel(runId);

    p.then(function (res) {
      if (res && res.error) {
        btn.disabled = false;
        btn.textContent = 'Failed';
        btn.title = res.error;
        setTimeout(function () { btn.textContent = originalText; btn.title = ''; }, 4000);
        return;
      }
      // Successful kick — refresh checks so the row's state reflects the new
      // run. Repaint just the Checks-tab slot rather than re-rendering the
      // whole PR view; the latter caused the entire section to flash empty
      // for the duration of the rebuild. Force the repaint so the user
      // sees the action's result immediately even if GH hasn't propagated
      // the state flip into the API response yet.
      fetchAndRenderChecks(lastState && lastState.number)
        .then(function () { repaintChecksTab({ force: true }); });
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = 'Failed';
      btn.title = (err && err.message) || 'unknown error';
    });
  }

  // Swap only the .pr-review-checks-tab innerHTML and rebind. Leaves the
  // rest of the PR-review surface untouched so action-driven refreshes
  // (rerun, cancel, periodic poll) don't flash the whole tab.
  // Build a stable signature of the data that drives renderChecksTab(). Used
  // by repaintChecksTab to skip no-op repaints. Excludes derived-from-clock
  // bits (in-progress duration ticks) — those will catch up the next time
  // the underlying state actually changes, which is fine for a value rounded
  // to the minute.
  function checksSignature() {
    var parts = [];
    if (currentChecks && currentChecks.error) parts.push('ERR:' + currentChecks.error);
    var checks = (currentChecks && currentChecks.checks) || [];
    checks.forEach(function (c) {
      parts.push([
        c.id, c.name, c.workflow, c.description,
        c.state, c.conclusion, c.startedAt, c.completedAt,
        c.runId, c.link
      ].join('|'));
    });
    parts.push('REQ:' + (currentRequiredChecks || []).join(','));
    parts.push('REQERR:' + (currentRequiredChecksError || ''));
    return parts.join('\n');
  }

  function repaintChecksTab(opts) {
    var slot = hostEl.querySelector('.pr-review-checks-tab');
    if (!slot) return;
    var force = opts && opts.force;
    var sig = checksSignature();
    // No-op when polling lands the same data we already painted. Without
    // this, the 15s tick would tear down and rebuild the tab even when
    // nothing's changed.
    if (!force && sig === lastChecksSignature && slot.firstChild) return;
    lastChecksSignature = sig;

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

    slot.innerHTML = renderChecksTab();
    bindChecksTab(); // bindChecksTab now also restores annotations + debug panels

    liveFixPanels.forEach(function (p) {
      var btn = slot.querySelector('.pr-check-fix-btn[data-check-id="' + p.dataset.checkId + '"]');
      if (!btn) return; // row no longer in the rendered set (check passed/disappeared)
      var row = btn.closest('.pr-check-row');
      if (row) row.insertAdjacentElement('afterend', p);
    });
  }

  // Periodic refresh while Checks is the active tab. Idempotent — calling
  // start while already running just resets the interval. Stops on tab
  // switch (bindTabs hook) and on PR change (clearChecksPolling at the top
  // of render() when isNewPr).
  function startChecksPolling() {
    clearChecksPolling();
    // Kick off an immediate refresh on tab activation so the user sees fresh
    // data without clicking Refresh. Skip if the PR isn't loaded yet.
    if (lastState && lastState.number && !checksFetchInFlight) {
      checksFetchInFlight = true;
      fetchAndRenderChecks(lastState.number).then(function () {
        checksFetchInFlight = false;
        repaintChecksTab();
      }, function () { checksFetchInFlight = false; });
    }
    checksPollTimer = setInterval(function () {
      if (!lastState || !lastState.number) { clearChecksPolling(); return; }
      // Skip if the previous poll hasn't returned yet — avoids fetch storms
      // when the user's network is slow.
      if (checksFetchInFlight) return;
      checksFetchInFlight = true;
      fetchAndRenderChecks(lastState.number).then(function () {
        checksFetchInFlight = false;
        repaintChecksTab();
      }, function () { checksFetchInFlight = false; });
    }, 15000);
  }

  function clearChecksPolling() {
    if (checksPollTimer) { clearInterval(checksPollTimer); checksPollTimer = null; }
  }

  // Hand-built modal for manually dispatching a workflow. Inputs are accepted
  // as a raw JSON object since parsing the workflow YAML's `on.workflow_dispatch.inputs`
  // would require pulling in a YAML lib for a niche feature. Most workflows
  // either have no inputs or simple key/value inputs the user already knows.
  function openWorkflowDispatchModal() {
    var existing = document.querySelector('.pr-workflow-dispatch-modal-backdrop');
    if (existing) { existing.remove(); return; }

    var defaultRef = (lastState && lastState.headRefName) || '';
    var backdrop = document.createElement('div');
    backdrop.className = 'pr-workflow-dispatch-modal-backdrop';
    backdrop.innerHTML = '<div class="pr-workflow-dispatch-modal">'
        + '<div class="pr-workflow-dispatch-head">Dispatch workflow</div>'
        + '<div class="pr-workflow-dispatch-body">'
          + '<label>Workflow</label>'
          + '<select class="pr-workflow-select"><option value="">Loading…</option></select>'
          + '<label>Ref (branch or tag)</label>'
          + '<input class="pr-workflow-ref" type="text" value="' + escHtml(defaultRef) + '" />'
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
        return '<option value="' + escHtml(String(w.id)) + '">' + escHtml(w.name) + ' (' + escHtml(w.path) + ')</option>';
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
        if (lastState) {
          fetchAndRenderChecks(lastState.number).then(function () { render(lastState); });
        }
      });
    });
  }

  function annotationsPanelHtml(state) {
    if (!state || (state.data == null && !state.error)) {
      return '<div class="pr-check-annotations-body">Loading annotations…</div>';
    }
    if (state.error) {
      return '<div class="pr-check-annotations-body diff-error">Failed to load annotations: '
        + escHtml(state.error) + '</div>';
    }
    var ann = state.data || [];
    if (ann.length === 0) {
      return '<div class="pr-check-annotations-body pr-check-annotations-empty">No annotations from this check.</div>';
    }
    return '<div class="pr-check-annotations-body">' + ann.map(function (a) {
      var levelClass = 'pr-annotation-' + (a.level || 'notice').replace(/[^a-z]/gi, '');
      var loc = a.path ? escHtml(a.path) + (a.startLine ? ':' + a.startLine : '') : '';
      return '<div class="pr-annotation ' + levelClass + '">'
        + '<div class="pr-annotation-head">'
          + '<span class="pr-annotation-level">' + escHtml(a.level || 'notice') + '</span>'
          + (loc ? '<span class="pr-annotation-loc">' + loc + '</span>' : '')
          + (a.title ? '<span class="pr-annotation-title">' + escHtml(a.title) + '</span>' : '')
        + '</div>'
        + '<div class="pr-annotation-msg">' + escHtml(a.message || '') + '</div>'
        + (a.rawDetails ? '<pre class="pr-annotation-raw">' + escHtml(a.rawDetails) + '</pre>' : '')
      + '</div>';
    }).join('') + '</div>';
  }

  // Insert (or replace) the annotations panel for this checkId. Looks up
  // existing panels by data-check-id rather than row.nextElementSibling so
  // multiple action panels under the same row (Debug + Annotations) don't
  // confuse the duplicate-detection and end up stacking.
  function mountAnnotationsPanel(row, checkId) {
    var existing = hostEl.querySelector('.pr-check-annotations-panel[data-check-id="' + checkId + '"]');
    var panel = existing || document.createElement('div');
    panel.className = 'pr-check-annotations-panel';
    panel.dataset.checkId = checkId;
    panel.innerHTML = annotationsPanelHtml(openAnnotations[checkId]);
    if (!existing) row.insertAdjacentElement('afterend', panel);
    return panel;
  }

  function fetchAnnotations(checkId) {
    window.klaus.pr.reviewCheckAnnotations(checkId).then(function (res) {
      if (!openAnnotations[checkId]) return; // user collapsed before fetch returned
      if (res && res.error) {
        openAnnotations[checkId] = { data: null, error: res.error };
      } else {
        openAnnotations[checkId] = { data: (res && res.annotations) || [], error: null };
      }
      restoreOpenAnnotations();
    }).catch(function (err) {
      if (!openAnnotations[checkId]) return;
      openAnnotations[checkId] = { data: null, error: (err && err.message) || 'unknown error' };
      restoreOpenAnnotations();
    });
  }

  // Re-mount any annotations panels the user had expanded. Called after
  // repaintChecksTab() blows away the tab DOM.
  function restoreOpenAnnotations() {
    Object.keys(openAnnotations).forEach(function (checkId) {
      var btn = hostEl.querySelector('.pr-check-annotations-btn[data-check-id="' + checkId + '"]');
      if (!btn) return; // row no longer in the rendered set (e.g., check passed after rerun)
      var row = btn.closest('.pr-check-row');
      if (row) mountAnnotationsPanel(row, checkId);
    });
  }

  // Click handler: toggle the panel for this row. Fetches lazily on first
  // expand; subsequent expands reuse the cached annotations so polling
  // repaints don't refetch. Lookup is by data-check-id, not nextElementSibling,
  // so an in-the-way Debug panel doesn't confuse the close path.
  function toggleAnnotations(btn) {
    var row = btn.closest('.pr-check-row');
    if (!row) return;
    var checkId = btn.dataset.checkId;
    if (!checkId) return;
    if (openAnnotations[checkId]) {
      delete openAnnotations[checkId];
      var existing = hostEl.querySelector('.pr-check-annotations-panel[data-check-id="' + checkId + '"]');
      if (existing) existing.remove();
      return;
    }
    openAnnotations[checkId] = { data: null, error: null };
    mountAnnotationsPanel(row, checkId);
    fetchAnnotations(checkId);
  }

  var DEBUG_STATUS_MESSAGES = [
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
  function paintDebugPanel(checkId) {
    var entry = openDebugChecks[checkId];
    if (!entry) return;
    var panel = hostEl.querySelector('.pr-check-debug-panel[data-check-id="' + checkId + '"]');
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
          sendDebugChatTurn(checkId, text);
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
        return '<div class="' + cls + '">' + escHtml(m.content) + '</div>';
      });
      if (entry.chatStreaming) {
        turns.push('<div class="pr-check-debug-chat-assistant pr-check-debug-chat-streaming">' + escHtml(entry.chatStreaming) + '</div>');
      } else if (entry.chatRequestId) {
        turns.push('<div class="pr-check-debug-chat-assistant pr-check-debug-chat-streaming">…</div>');
      }
      if (entry.chatError) {
        turns.push('<div class="pr-check-debug-chat-error">' + escHtml(entry.chatError) + '</div>');
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
        '<div class="pr-check-debug-usage">Ran in ' + escHtml(String(entry.durationSec || 0)) + 's on your Anthropic account</div>'
        + '<div class="pr-check-debug-actions">'
          + '<button class="pr-check-debug-fix pr-check-action-primary" type="button" title="Apply this analysis as a code fix in the PR worktree">Fix this</button>'
          + '<button class="pr-check-debug-open-task" type="button"' + (entry.openTaskState === 'opening' ? ' disabled' : '') + ' title="Spawn an interactive agent task seeded with this analysis">' + escHtml(openLabel) + '</button>'
        + '</div>';

      footerEl.querySelector('.pr-check-debug-fix').addEventListener('click', function () {
        var fixBtn = hostEl.querySelector('.pr-check-fix-btn[data-check-id="' + checkId + '"]');
        if (fixBtn) startFixCheck(fixBtn);
      });

      footerEl.querySelector('.pr-check-debug-open-task').addEventListener('click', function () {
        var e = openDebugChecks[checkId];
        if (!e || e.openTaskState === 'opening') return;
        e.openTaskState = 'opening';
        paintDebugPanel(checkId);
        var prNumber = lastState && lastState.number;
        window.klaus.pr.debugCheckOpenAsTask(e.accumulated, e.checkName || '', prNumber).then(function (res) {
          if (!openDebugChecks[checkId]) return;
          if (res && res.error) {
            openDebugChecks[checkId].openTaskState = 'failed';
            openDebugChecks[checkId].openTaskError = res.error;
            paintDebugPanel(checkId);
            setTimeout(function () {
              if (openDebugChecks[checkId] && openDebugChecks[checkId].openTaskState === 'failed') {
                openDebugChecks[checkId].openTaskState = 'idle';
                paintDebugPanel(checkId);
              }
            }, 4000);
            return;
          }
          openDebugChecks[checkId].openTaskState = 'opened';
          paintDebugPanel(checkId);
        }).catch(function (err) {
          if (!openDebugChecks[checkId]) return;
          openDebugChecks[checkId].openTaskState = 'failed';
          openDebugChecks[checkId].openTaskError = (err && err.message) || 'unknown error';
          paintDebugPanel(checkId);
        });
      });
    }
  }

  // Send one turn in the debug-panel chat. Reuses the existing pr-review-chat
  // IPC (read-only: Claude can grep/read, can't edit) since "discuss this
  // analysis" is shape-identical to "discuss this finding".
  function sendDebugChatTurn(checkId, text) {
    var entry = openDebugChecks[checkId];
    if (!entry || entry.state !== 'done' || entry.chatRequestId) return;

    entry.chatMessages.push({ role: 'user', content: text });
    entry.chatError = null;
    entry.chatStreaming = '';
    var requestId = 'dbgchat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    entry.chatRequestId = requestId;
    paintDebugPanel(checkId);

    var buffered = '';
    var unsubData = window.klaus.pr.onReviewChatData(requestId, function (chunk) {
      var e = openDebugChecks[checkId];
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
      paintDebugPanel(checkId);
    });
    window.klaus.pr.onReviewChatDone(requestId, function (result) {
      if (unsubData) unsubData();
      var e = openDebugChecks[checkId];
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
      paintDebugPanel(checkId);
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
        var e = openDebugChecks[checkId];
        if (!e || e.chatRequestId !== requestId) return;
        e.chatRequestId = null;
        e.chatError = r.error;
        // Roll back the optimistic user message so the user can retry without
        // duplicating it.
        if (e.chatMessages.length && e.chatMessages[e.chatMessages.length - 1].role === 'user'
            && e.chatMessages[e.chatMessages.length - 1].content === text) {
          e.chatMessages.pop();
        }
        paintDebugPanel(checkId);
      }
    });
  }

  function mountDebugPanel(row, checkId) {
    var entry = openDebugChecks[checkId];
    if (!entry) return null;
    // Look up existing panel by checkId rather than nextElementSibling — when
    // both Annotations and Debug are open, panels stack under the row and
    // sibling-based lookup misses, causing duplicates on each remount.
    var existing = hostEl.querySelector('.pr-check-debug-panel[data-check-id="' + checkId + '"]');
    if (existing) return existing;

    var panel = document.createElement('div');
    panel.className = 'pr-check-debug-panel';
    panel.dataset.checkId = checkId;
    panel.dataset.requestId = entry.requestId;
    panel.innerHTML =
      '<div class="pr-check-debug-head">'
        + '<span>' + (entry.state === 'running' ? 'Debugging' : 'Debug') + ' — ' + escHtml(entry.checkName || '') + '</span>'
        + '<button class="pr-check-debug-close" type="button" title="Cancel / close">&times;</button>'
      + '</div>'
      + '<div class="pr-check-debug-body' + (entry.state === 'running' && !entry.accumulated ? ' status-pulse' : '') + '">'
        + (entry.state === 'running' && !entry.accumulated ? escHtml(DEBUG_STATUS_MESSAGES[0]) : '')
      + '</div>';
    row.insertAdjacentElement('afterend', panel);

    panel.querySelector('.pr-check-debug-close').addEventListener('click', function () {
      var e = openDebugChecks[checkId];
      if (e && e.state === 'running' && e.requestId) {
        try { window.klaus.pr.debugCheckCancel(e.requestId); } catch (_) {}
      }
      if (e && e.statusTimer) clearInterval(e.statusTimer);
      delete openDebugChecks[checkId];
      panel.remove();
    });

    paintDebugPanel(checkId);
    return panel;
  }

  function restoreOpenDebugChecks() {
    Object.keys(openDebugChecks).forEach(function (checkId) {
      var btn = hostEl.querySelector('.pr-check-debug-btn[data-check-id="' + checkId + '"]');
      if (!btn) return;
      var row = btn.closest('.pr-check-row');
      if (!row) return;
      mountDebugPanel(row, checkId);
    });
  }

  function startDebugCheck(btn) {
    var row = btn.closest('.pr-check-row');
    if (!row) return;
    var checkId = btn.dataset.checkId;
    if (!checkId) return;

    // Toggle: re-clicking on an existing entry closes it (and cancels if
    // still running). Single source of truth is the cache, not the DOM.
    if (openDebugChecks[checkId]) {
      var prev = openDebugChecks[checkId];
      if (prev.state === 'running' && prev.requestId) {
        try { window.klaus.pr.debugCheckCancel(prev.requestId); } catch (_) {}
      }
      if (prev.statusTimer) clearInterval(prev.statusTimer);
      delete openDebugChecks[checkId];
      var existingPanel = hostEl.querySelector('.pr-check-debug-panel[data-check-id="' + checkId + '"]');
      if (existingPanel) existingPanel.remove();
      return;
    }

    var requestId = 'dbg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    openDebugChecks[checkId] = {
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

    mountDebugPanel(row, checkId);

    // Rotating "Fetching..." pulse until the first chunk lands. Reads bodyEl
    // fresh each tick so a remount-during-warmup keeps the pulse animated.
    var statusIdx = 0;
    openDebugChecks[checkId].statusTimer = setInterval(function () {
      var entry = openDebugChecks[checkId];
      if (!entry) return;
      if (entry.accumulated || entry.state !== 'running') {
        if (entry.statusTimer) { clearInterval(entry.statusTimer); entry.statusTimer = null; }
        return;
      }
      var bodyEl = hostEl.querySelector('.pr-check-debug-panel[data-check-id="' + checkId + '"] .pr-check-debug-body');
      if (!bodyEl) return;
      statusIdx = (statusIdx + 1) % DEBUG_STATUS_MESSAGES.length;
      bodyEl.textContent = DEBUG_STATUS_MESSAGES[statusIdx];
    }, 1800);

    // Subscriptions write into the cache; paintDebugPanel updates whichever
    // panel DOM is currently mounted (or none, if the panel was closed but
    // the entry kept). Cleanup happens via the close button or PR change,
    // which deletes the cache entry.
    var unsubChunk = window.klaus.pr.onDebugCheckChunk(requestId, function (chunk) {
      var entry = openDebugChecks[checkId];
      if (!entry || entry.requestId !== requestId) return;
      entry.accumulated += chunk;
      paintDebugPanel(checkId);
    });
    window.klaus.pr.onDebugCheckDone(requestId, function (result) {
      if (unsubChunk) unsubChunk();
      var entry = openDebugChecks[checkId];
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
      paintDebugPanel(checkId);
    });

    btn.disabled = true;
    var origText = btn.textContent;
    btn.textContent = 'Debugging…';
    setTimeout(function () { btn.disabled = false; btn.textContent = origText; }, 200);

    window.klaus.pr.debugCheckStart(requestId, btn.dataset.link, btn.dataset.name, checkId).then(function (r) {
      if (r && r.error) {
        var entry = openDebugChecks[checkId];
        if (!entry || entry.requestId !== requestId) return;
        if (entry.statusTimer) { clearInterval(entry.statusTimer); entry.statusTimer = null; }
        entry.state = 'error';
        entry.error = r.error;
        paintDebugPanel(checkId);
      }
    });
  }

  // Legacy stub head — body deleted just below.
  // Autonomous-fix flow: spawn Claude in the PR worktree with edit tools,
  // stream tool-use progress, and on done show the resulting diff with a
  // "Push" button that commits + pushes to the PR branch. Confirm-before-push
  // is deliberate — see AskUserQuestion in commit history; the alternative
  // (full auto) would push bad fixes before the user ever sees them.
  function startFixCheck(btn) {
    var row = btn.closest('.pr-check-row');
    if (!row) return;

    // One panel per checkId. Lookup is by data-check-id so a stacked Debug
    // or Annotations panel under the same row doesn't break the toggle.
    var checkIdForToggle = btn.dataset.checkId || '';
    var existing = checkIdForToggle
      ? hostEl.querySelector('.pr-check-fix-panel[data-check-id="' + checkIdForToggle + '"]')
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
        + '<span>Fixing — ' + escHtml(checkName) + '</span>'
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
        return '<div class="' + cls + '">' + escHtml(p.label) + '</div>';
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
        summaryEl.innerHTML = '<div class="pr-check-fix-summary-body">' + renderMarkdownLite(finalText) + '</div>';
      }

      // Pull the worktree's diff so the user can review what Claude actually
      // changed before consenting to the push.
      window.klaus.pr.localState(worktreePath).then(function (state) {
        if (!panel.isConnected) return;
        renderFixDiffAndActions(panel, state, checkName, worktreePath);
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
  }

  // Render the diff + Push/Discard footer once Claude is done. Diff is shown
  // raw (monospace block); a syntax-highlighted view would be nicer but adds
  // a chunk of code for a confirmation surface — keep simple.
  function renderFixDiffAndActions(panel, state, checkName, worktreePath) {
    var summaryEl = panel.querySelector('.pr-check-fix-summary');
    var diffEl = panel.querySelector('.pr-check-fix-diff');
    var footerEl = panel.querySelector('.pr-check-fix-footer');
    var progressEl = panel.querySelector('.pr-check-fix-progress-list');

    if (state && state.error) {
      diffEl.innerHTML = '<div class="diff-error">Could not read worktree state: ' + escHtml(state.error) + '</div>';
      return;
    }
    var files = (state && state.files) || [];
    if (files.length === 0) {
      diffEl.innerHTML = '<div class="pr-check-fix-empty">The agent didn’t make any file changes. Read the summary above for context.</div>';
      return;
    }

    diffEl.innerHTML =
      '<div class="pr-check-fix-files-head">'
        + escHtml(String(files.length)) + ' file' + (files.length === 1 ? '' : 's') + ' changed'
      + '</div>'
      + '<pre class="pr-check-fix-diff-pre">' + escHtml(state.diff || '(no diff content)') + '</pre>';

    var commitMsg = 'Fix CI: ' + (checkName || 'failing check');
    footerEl.innerHTML =
      '<label class="pr-check-fix-msg-label">Commit message'
        + '<input class="pr-check-fix-msg" type="text" value="' + escHtml(commitMsg) + '" />'
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
          fetchAndRenderChecks(lastState && lastState.number)
            .then(function () { repaintChecksTab({ force: true }); });
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
  }

  // Tiny markdown -> HTML for the fix summary. Just enough for headings,
  // bold, code spans, and lists — anything more is overkill for the 3-bullet
  // structure we ask Claude to emit.
  function renderMarkdownLite(text) {
    var safe = escHtml(text);
    return safe
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br/>');
  }

  function renderChecksIntoSlot() {
    var slot = hostEl.querySelector('.pr-review-checks-slot');
    if (!slot) return;
    if (!currentChecks) { slot.innerHTML = ''; return; }
    if (currentChecks.error) {
      slot.innerHTML = '<span class="pr-check-pill fail" title="' + escHtml(currentChecks.error) + '">checks: error</span>';
      return;
    }
    var checks = currentChecks.checks || [];
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
  }

  function renderMergeControl(state) {
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
  }

  function bindMergeControl(state) {
    var wrap = hostEl.querySelector('.pr-merge-wrap');
    if (!wrap) return;
    var btn = wrap.querySelector('.pr-merge-btn');
    var menu = wrap.querySelector('.pr-merge-menu');

    updateMergeGate(wrap, state);

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
        updateMergeGate(wrap, lastState);
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
  }

  function updateMergeGate(wrap, state) {
    var btn = wrap.querySelector('.pr-merge-btn');
    if (!btn) return;
    var reason = mergeGateReason(state);
    if (reason) {
      btn.disabled = true;
      btn.title = reason;
      btn.classList.remove('ready');
    } else {
      btn.disabled = false;
      btn.title = 'Merge this PR';
      btn.classList.add('ready');
    }
  }

  // Mirrors the subset of pr-panel.js's mergeGateReason that applies to
  // someone else's PR. We don't have commit-sign branch-protection nuance
  // here — GitHub itself will reject if the PR isn't mergeable.
  function mergeGateReason(state) {
    var meta = (state && state.meta) || {};
    if ((meta.state || '').toUpperCase() !== 'OPEN') return 'Only open PRs can be merged';
    if (meta.isDraft) return 'PR is a draft';
    if (meta.mergeable === 'CONFLICTING') return 'Has conflicts';
    if (currentChecks && currentChecks.checks) {
      var failing = currentChecks.checks.some(function (c) {
        var b = c.bucket || '';
        var s = (c.state || '').toLowerCase();
        return b === 'fail' || s === 'failure' || s === 'error' || s === 'timed_out';
      });
      if (failing) return 'Failing checks';
    }
    if (meta.mergeStateStatus === 'BEHIND') return 'Branch is behind base';
    if (meta.mergeable === 'UNKNOWN' && !meta.mergeStateStatus) return 'Mergeability still computing\u2026';
    if (!currentChecks) return 'Checking mergeability\u2026';
    return null;
  }

  function renderThreadsStatusBadge(state) {
    var actions = hostEl.querySelector('.pr-review-actions');
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
  }

  // refresh: re-run render() against the current state. Used by AgentRouter
  // when a navigation intent lands while the PR is already mounted so
  // applyPendingNav gets a chance to consume it.
  function refresh() { if (lastState) render(lastState); }

  return { mount: mount, unmount: unmount, refresh: refresh };
})();
