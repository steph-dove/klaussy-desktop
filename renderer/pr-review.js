// Phase G: PR review surface. Shared renderer module, mounted in two hosts:
//   - main window: host = #pr-review-root, coexists with the rest of app.js
//   - pop-out:     host = document.body inside pr-review.html (see init call
//                  at the bottom of that file)
//
// State lives in the main process (activePrReview). We pull initial state on
// mount and subscribe to pr-review-state broadcasts so both hosts stay in sync
// without duplicating fetches.

window.PrReview = window.PrReview || {};

(function(PR) {
  PR.escHtml = (window.AppUtils && window.AppUtils.escHtml) || function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  // Actionable banner for a gh/GraphQL failure: a plain-language summary plus
  // the exact `gh` command to fix it (with a Copy button, wired via delegation
  // in mount()). Used by the Conversation tab and anywhere else a gh call's
  // error needs to be shown without breaking the surface.
  PR.renderGhErrorBanner = function (summary, fix) {
    if (!summary) return '';
    var fixBlock = fix
      ? '<div class="pr-gh-error-fix">'
          + '<code class="pr-gh-error-cmd">' + PR.escHtml(fix) + '</code>'
          + '<button class="pr-gh-error-copy" type="button" data-copy="' + PR.escHtml(fix) + '">Copy</button>'
        + '</div>'
      : '';
    return '<div class="pr-gh-error-banner">'
      + '<div class="pr-gh-error-head">'
        + '<span class="pr-gh-error-icon">⚠</span>'
        + '<span class="pr-gh-error-summary">' + PR.escHtml(summary) + '</span>'
      + '</div>'
      + fixBlock
    + '</div>';
  };

  PR.hostEl = null;
  PR.isPopout = false;
  PR.unsubState = null;
  PR.lastState = null;
  PR.selectedFile = null;
  PR.activeTab = 'files'; // 'files' | 'conversation' | 'checks' | 'ai-review' | 'terminal'

  // Per-render IPC subscriptions for rehydrated explain agents. render() blows
  // away hostEl.innerHTML, which orphans these listeners — we clear them each
  // time so chunks don't pile up onto detached DOM.
  PR.rehydrateUnsubs = [];

  // Current gh user login — used to gate the edit pencil on comments. Fetched
  // once per review session; stays null if gh api fails (which just means
  // the edit UI never appears, not an error state).
  PR.currentUserLogin = null;

  // In-flight edit: which comment is in edit mode, and what kind (for PATCH
  // endpoint selection). Kind: 'issue' | 'review'.
  PR.editingCommentId = null;

  PR.editingCommentKind = null;

  // When a comment has been locally edited (PATCH succeeded), we stash the
  // new body here until the next refresh overwrites the nodes, so the UI
  // doesn't flicker back to the old text.
  PR.editedCommentOverrides = {}; // { [commentDatabaseId]: newBody }

  PR.selectionFab = null;
  PR.onSelectionChange = null;

  // G4: draft review comments accumulated client-side until the user submits
  // a review. Structure: { id, path, line, side, startLine?, startSide?, body }
  PR.pendingComments = [];

  // Per-conversation-comment Claude state, keyed by comment databaseId.
  // Comments in the Conversation tab get Claude-investigate and
  // Claude-implement buttons that share the same IPC plumbing as the
  // Review-tab findings. Stored here (not on the comment itself) because
  // threads rerender on every refresh and would clobber inline state.
  // Shape per entry: { investigateId, investigateStreaming, investigateResult, investigateError,
  //                    implementId, implementOut, implementError, implementDraft, implementDraftStatus }
  PR.convClaudeState = {};

  // G6: latest checks result for the active PR. null = not yet fetched.
  PR.currentChecks = null;

  // Required-status-checks for the PR's base branch (from branch protection).
  // Loaded lazily alongside currentChecks.
  //   []                  → no protection rules (or branch not protected)
  //   ['name', 'name', …] → required contexts
  // currentRequiredChecksError carries a string when the fetch parsed garbage
  // or hit auth issues — the gate must render as "unknown" in that case so we
  // don't falsely green-light merges.
  PR.currentRequiredChecks = [];

  PR.currentRequiredChecksError = '';

  // Periodic refresh while the Checks tab is the active tab. Cleared on tab
  // switch and on PR change. 15s cadence is the same ballpark as the per-task
  // CI poll (30s) but more responsive when the user is actively watching.
  PR.checksPollTimer = null;

  PR.checksFetchInFlight = false;

  // Signature of the last data we painted into the Checks tab. Lets the 15s
  // poll skip the DOM rebuild when nothing changed — keeps any open
  // annotations panels stable and avoids unnecessary reflow. Reset on PR
  // change so a freshly-loaded PR always paints.
  PR.lastChecksSignature = '';

  // Annotations-panel open state, keyed by checkId. Survives repaintChecksTab
  // AND full render() rebuilds so the user's expanded panels persist. Value:
  //   { data: Array|null, error: string|null }
  // data === null means "fetch in flight"; on repaint we re-render synchronously
  // from the cached value so there's no flash and no refetch.
  PR.openAnnotations = Object.create(null);

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
  PR.openDebugChecks = Object.create(null);

  // Durable cache of COMPLETED debug analyses, keyed by checkId, each tagged
  // with the check's CI-output signature. Survives closing the panel and tab
  // switches so re-opening restores the analysis instantly (no re-run) — as
  // long as the CI output hasn't changed (a rerun invalidates it). Reset per PR.
  PR.debugCache = Object.create(null);

  // Local-changes panel state (Review tab). Refreshed on tab show and after
  // each implement/commit/push. Stays null until the first fetch completes.
  // Shape: { worktreePath, branch, files:[{status,file}], diff, unpushed:[{hash,short,subject}], headRefOid }
  // or { error } when the lookup itself failed (rare — usually just empty).
  PR.localChanges = null;

  PR.localCommitMsg = 'Apply review feedback';
  PR.localBusy = null; // 'committing' | 'pushing' | null
  PR.localBanner = null; // { kind: 'ok'|'error', text }

  // G7: in-flight AI review state. requestId is set while streaming; the
  // panel persists across re-renders until the user closes it.
  PR.aiReview = {
    requestId: null,           // streaming review-generation IPC
    finalText: '',              // accumulated review markdown
    progress: [],               // chips while streaming
    error: null,
    cancelled: false,
    worktreePath: null,         // where the implement IPCs will run
    findings: [],               // [{ id, text, severity, status, ignored, implementId, implementOut, implementError, usage }]
    summary: null,              // { verdict, highestRisk[], testCoverage } from the structured JSON contract
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
  PR.implRun = null;

  // The Terminal-tab xterm. Persists across implement runs so a "Rerun"
  // (or a fresh Implement after a previous run finished) appends a new
  // banner + output to the same scrollback. Disposed only on explicit
  // user dismissal (Hide terminal), PR navigation, or unmount.
  //
  // Shape when present: { terminal, fitAddon, hasContent }
  //   - hasContent flips true once the first byte has been written, so we
  //     can suppress the leading separator on the first-ever run.
  PR.reviewTerminal = null;

  // The persistent PR-aware chat session that backs the Terminal tab. The
  // default agent runs in the PR's worktree, seeded once with the PR context,
  // and stays open so the reviewer can chat about the change. Keystrokes go
  // here whenever no implement run is live; implement runs share the same
  // xterm, separated by banners.
  //
  // Shape: { chatKey, worktreePath, status: 'starting'|'running'|'exited'|'error',
  //          starting, unsubData, unsubExit }
  PR.chatRun = null;

  // Re-attach bookkeeping: which PR we've already checked for a backgrounded
  // implement run (so we ask main at most once per PR per mount), and the
  // window focus/visibility handler that re-fits the xterm after the OS
  // un-occludes it (belt-and-suspenders for a blank repaint on refocus).
  PR.implReattachCheckedPr = null;

  PR.implFocusRefitHandler = null;
  PR.implVisibilityRefitHandler = null;

  PR.mount = function(options) {
    PR.hostEl = options.host;
    PR.isPopout = !!options.isPopout;
    PR.hostEl.classList.add('pr-review-host');
    // Delegated "Copy" for gh-error fix commands. Bound on hostEl (not its
    // children) so it survives the innerHTML rewrites every render does.
    PR.hostEl.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) return;
      // Reddit-style collapse: clicking a comment's gutter rail folds it.
      var rail = e.target.closest('.pr-conv-collapse');
      if (rail) {
        var item = rail.closest('.pr-conv-item');
        if (item) item.classList.toggle('collapsed');
        return;
      }
      var resolveBtn = e.target.closest('.pr-conv-thread-resolve-btn');
      if (resolveBtn) {
        PR.toggleThreadResolved(resolveBtn);
        return;
      }
      var btn = e.target.closest('.pr-gh-error-copy');
      if (!btn) return;
      navigator.clipboard.writeText(btn.getAttribute('data-copy') || '').then(function () {
        var prev = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = prev; }, 1200);
      }).catch(function () {});
    });
    // Keep the Terminal-tab xterm matching the app theme on live theme switches.
    PR.themeChangeHandler = function () { if (PR.onAppThemeChanged) PR.onAppThemeChanged(); };
    window.addEventListener('theme-changed', PR.themeChangeHandler);
    PR.renderLoading();
    PR.initSelectionExplain();
    PR.setupImplementFocusRefit();

    // Fetch the current gh user once per mount. Drives whether the edit
    // pencil shows on a comment. If this fails we simply don't show the
    // pencil anywhere — no error state needed.
    if (!PR.currentUserLogin) {
      window.klaus.pr.currentUser().then(function (r) {
        if (r && r.login) {
          PR.currentUserLogin = r.login;
          if (PR.lastState) PR.render(PR.lastState);
        }
      });
    }

    PR.unsubState = window.klaus.pr.onReviewState(function (state) {
      if (!state) {
        // In the pop-out, no state = the review was closed elsewhere, so the
        // window has nothing left to show. In the main window, app.js owns
        // mount/unmount and will call unmount() on us — do nothing here.
        if (PR.isPopout) window.close();
        return;
      }
      PR.render(state);
    });

    window.klaus.pr.reviewState().then(function (state) {
      if (!state) {
        PR.renderEmpty();
        return;
      }
      PR.render(state);
    });
  };

  PR.unmount = function() {
    if (PR.unsubState) { try { PR.unsubState(); } catch (_) {} PR.unsubState = null; }
    if (PR.themeChangeHandler) { window.removeEventListener('theme-changed', PR.themeChangeHandler); PR.themeChangeHandler = null; }
    PR.teardownSelectionExplain();
    PR.teardownImplementFocusRefit();
    PR.implReattachCheckedPr = null;
    // DETACH the in-flight implement run — do NOT cancel it. The PTY lives in
    // the main process and stays running in the background; re-opening this PR
    // (here or in a pop-out) re-attaches and repaints from the buffer. This is
    // what stopped runs from vanishing on pop-out / space-switch / navigate.
    if (PR.implRun) {
      try { window.klaus.pr.reviewImplementDetach(PR.implRun.requestId); } catch (_) {}
      PR.cleanupImplementRun();
      PR.implRun = null;
    }
    // Detach the chat session too — it survives in the background like the
    // implement run and re-attaches when this PR is reopened.
    PR.teardownChatRun();
    PR.disposeReviewTerminal();
    if (PR.hostEl) {
      PR.hostEl.innerHTML = '';
      PR.hostEl.classList.remove('pr-review-host');
    }
    PR.lastState = null;
    PR.selectedFile = null;
  };

  PR.renderLoading = function() {
    PR.hostEl.innerHTML = '<div class="pr-review-loading">Loading PR\u2026</div>';
  };

  PR.renderEmpty = function() {
    PR.hostEl.innerHTML = '<div class="pr-review-loading">No active PR review.</div>';
  };

  PR.render = function(state) {
    // The main window never paints a popped-out review — app.js hides this
    // surface and the pop-out owns the display. Without this, a late
    // onReviewState(popped:true) (the broadcast races app.js's unmount) could
    // repaint the panel back in, leaving the review visible in BOTH windows.
    if (state && state.popped && !PR.isPopout) return;
    // Preserve selection across updates unless the PR number changed, and
    // fire a one-shot checks fetch when a new PR comes into view (also
    // covers first-load since lastState is null then).
    var isNewPr = !PR.lastState || PR.lastState.number !== state.number;
    if (isNewPr) {
      PR.selectedFile = null;
      PR.currentChecks = null;
      // Cancel any in-flight debug streams from the previous PR so they don't
      // keep filling the cache after we drop it. Annotations are read-only so
      // we just clear the map.
      Object.keys(PR.openDebugChecks).forEach(function (k) {
        var e = PR.openDebugChecks[k];
        if (e && e.state === 'running' && e.requestId) {
          try { window.klaus.pr.debugCheckCancel(e.requestId); } catch (_) {}
        }
        if (e && e.statusTimer) clearInterval(e.statusTimer);
      });
      PR.openDebugChecks = Object.create(null);
      PR.debugCache = Object.create(null);
      PR.openAnnotations = Object.create(null);
      PR.lastChecksSignature = '';
      // Stop any in-flight checks polling so it doesn't repaint with the
      // previous PR's data after the new PR's render lands.
      PR.clearChecksPolling();
      // DETACH (don't cancel) the previous PR's implement run — it keeps
      // running in the background and can be re-attached by re-opening that
      // PR. Drop our local subscriptions + xterm; the main process owns the
      // PTY and its output buffer.
      if (PR.implRun) {
        try { window.klaus.pr.reviewImplementDetach(PR.implRun.requestId); } catch (_) {}
        PR.cleanupImplementRun();
        PR.implRun = null;
      }
      // Detach (don't kill) the previous PR's chat session — it keeps running
      // for that worktree and re-attaches if the user reopens the PR.
      PR.teardownChatRun();
      PR.disposeReviewTerminal();
      PR.implReattachCheckedPr = null;
      // Don't cancel in-flight AI work for the previous PR — those agents
      // are now backgroundable and the user can monitor / re-attach via the
      // Agents panel. Just drop the local subscriptions by stashing the old
      // requestIds (chunk callbacks bail when aiReview.requestId no longer
      // matches) and reset our own state for the new PR.
      PR.aiReview = {
        requestId: null, finalText: '', progress: [], error: null, cancelled: false,
        worktreePath: null, findings: [], summary: null,
        implementAllId: null, implementAllProgress: [], implementAllError: null, implementAllSummary: null,
        implementAllUsage: null, usage: null,
      };
      // Drop the previous PR's local-changes snapshot so the panel doesn't
      // briefly show stale file names while the new PR's state is fetched.
      PR.localChanges = null;
      PR.localCommitMsg = 'Apply review feedback';
      PR.localSelectedFiles = {};
      PR.localBusy = null;
      PR.localBanner = null;
      // Fire-and-forget. Pass the PR number explicitly — lastState isn't
      // assigned until below, and the async handler would otherwise compare
      // against a null on first load and drop its own result.
      PR.fetchAndRenderChecks(state.number);
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
        PR.loadAiReviewCache(baseOwner, baseRepo, prNumber)
          .then(function () { PR.adoptBackgroundedReviewAgent(baseOwner, baseRepo, prNumber); });
      }
    }
    PR.lastState = state;

    var files = PR.parseDiffFiles(state.diff || '');
    if (!PR.selectedFile && files.length > 0) PR.selectedFile = files[0].path;

    var threadsByPath = PR.groupThreadsByPath(state.threads || []);

    var meta = state.meta || {};
    var author = (meta.author && (meta.author.login || meta.author.name)) || 'unknown';
    var stateBadge = meta.isDraft ? 'DRAFT' : (meta.state || '').toUpperCase();
    var reviewDecision = meta.reviewDecision || '';

    PR.hostEl.innerHTML =
      '<div class="pr-review-header">'
        + '<div class="pr-review-title">'
          + '<span class="pr-review-num">#' + PR.escHtml(state.number) + '</span> '
          + '<span class="pr-review-title-text">' + PR.escHtml(meta.title || '') + '</span>'
        + '</div>'
        + '<div class="pr-review-meta">'
          + '<span class="pr-review-state pr-state-' + PR.escHtml((stateBadge || 'open').toLowerCase()) + '">' + PR.escHtml(stateBadge || 'OPEN') + '</span>'
          + (reviewDecision ? '<span class="pr-review-decision pr-decision-' + PR.escHtml(reviewDecision.toLowerCase()) + '">' + PR.escHtml(reviewDecision.replace('_', ' ')) + '</span>' : '')
          + '<span class="pr-review-author">' + PR.escHtml(author) + '</span>'
          + '<span class="pr-review-branch">' + PR.escHtml(meta.headRefName || '') + ' \u2192 ' + PR.escHtml(meta.baseRefName || '') + '</span>'
          + '<span class="pr-review-checks-slot"></span>'
        + '</div>'
        + '<div class="pr-review-actions">'
          + '<a href="#" class="pr-review-external" data-url="' + PR.escHtml(meta.url || '') + '">Open on GitHub</a>'
          + '<button class="pr-review-btn js-pull-updates" title="Re-fetch PR data + advance the local worktree to the PR’s latest commit">Pull updates</button>'
          + '<button class="pr-review-btn js-ai-review" title="Run an AI code review against this PR">Review</button>'
          + '<button class="pr-review-btn js-checkout-local" title="Fetch this PR into a new worktree and spawn a task">Check out locally</button>'
          + PR.renderMergeControl(state)
          + (PR.isPopout
              ? '<button class="pr-review-btn js-pop-in" title="Return to main window">\u21B2 Pop back in</button>'
              : '<button class="pr-review-btn js-pop-out" title="Open in a separate window">Pop out \u2197</button>')
          + (PR.isPopout
              ? ''
              : '<button class="pr-review-btn js-close" title="Close review">\u2190 Back to tasks</button>')
        + '</div>'
      + '</div>'
      + '<div class="pr-review-tabs">'
        + '<button class="pr-review-tab' + (PR.activeTab === 'files' ? ' active' : '') + '" data-tab="files">Changes <span class="pr-tab-count">' + files.length + '</span></button>'
        + '<button class="pr-review-tab' + (PR.activeTab === 'conversation' ? ' active' : '') + '" data-tab="conversation">Conversation' + PR.renderConversationCount(state) + '</button>'
        + '<button class="pr-review-tab' + (PR.activeTab === 'checks' ? ' active' : '') + '" data-tab="checks">CI View' + PR.renderChecksTabCount() + '</button>'
        + '<button class="pr-review-tab' + (PR.activeTab === 'ai-review' ? ' active' : '') + '" data-tab="ai-review">AI Review' + PR.renderAiReviewTabCount() + '</button>'
        + '<button class="pr-review-tab' + (PR.activeTab === 'terminal' ? ' active' : '') + '" data-tab="terminal">Terminal View' + PR.renderTerminalTabBadge() + '</button>'
      + '</div>'
      + '<div class="pr-review-body' + (PR.activeTab !== 'files' ? ' one-col' : '') + '">'
        + (PR.activeTab === 'files'
            ? '<div class="pr-review-file-list">' + PR.renderFileList(files, threadsByPath) + '</div>'
              + '<div class="pr-review-diff">' + PR.renderSelectedFileDiff(files) + '</div>'
            : PR.activeTab === 'conversation'
              ? '<div class="pr-review-conversation">' + PR.renderConversation(state) + '</div>'
              : PR.activeTab === 'checks'
                ? '<div class="pr-review-checks-tab">' + PR.renderChecksTab() + '</div>'
                : PR.activeTab === 'terminal'
                  ? '<div class="pr-review-terminal-tab">' + PR.renderTerminalTab() + '</div>'
                  : '<div class="pr-review-ai-tab">' + PR.renderAiReviewTab() + '</div>'
          )
      + '</div>';

    PR.bindHeader(state);
    PR.bindMergeControl(state);
    PR.renderChecksIntoSlot();
    PR.bindTabs();
    if (PR.activeTab === 'files') {
      PR.bindFileList();
      PR.injectInlineThreads(threadsByPath);
      PR.injectPendingComments();
      PR.rehydrateExplanations();
    } else if (PR.activeTab === 'conversation') {
      PR.bindConversationComposer();
      PR.bindReplyButtons();
      PR.bindEditCommentButtons();
    } else if (PR.activeTab === 'checks') {
      PR.bindChecksTab();
    } else if (PR.activeTab === 'ai-review') {
      PR.bindAiReviewTab();
      // Pull worktree state once per tab activation so a returning user sees
      // any uncommitted edits or unpushed commits without clicking refresh.
      PR.refreshLocalChanges();
    } else if (PR.activeTab === 'terminal') {
      PR.bindTerminalTab();
      PR.mountImplementTerminalIfActive();
    }
    PR.renderThreadsStatusBadge(state);
    PR.renderPendingReviewBar(state);

    // Re-attach to a backgrounded implement run for this PR, if any (pop-out,
    // navigate-back, or a teardown that dropped the local run while the PTY
    // kept going). Cheap: asks main at most once per PR per mount.
    PR.maybeReattachImplement(state.number);

    // If a navigation intent is pending for this PR (set by AgentRouter when
    // the user clicks "Open" on an explain agent), apply it now: switch to
    // Files, select the right file, re-render, then scroll the explanation
    // into view once rehydration has injected it.
    PR.applyPendingNav(state);
  };

  PR.applyPendingNav = function(state) {
    var nav = window._pendingAgentNav;
    if (!nav || !state || nav.prNumber !== state.number) return;
    var targetTab = nav.tab || 'files';
    var needsRerender = false;
    if (PR.activeTab !== targetTab) { PR.activeTab = targetTab; needsRerender = true; }
    if (nav.file && PR.selectedFile !== nav.file) { PR.selectedFile = nav.file; needsRerender = true; }
    var agentId = nav.agentId;
    var kind = nav.kind || (targetTab === 'ai-review' ? 'pr-review-ai' : 'explain-diff');
    window._pendingAgentNav = null;

    if (needsRerender) {
      PR.render(state);
    }

    // Tab-specific rehydration — explain agents anchor under their hunk in
    // the diff; AI review reattaches to the streaming JSONL.
    if (kind === 'pr-review-ai' && agentId) {
      PR.rehydrateAiReview(agentId);
      return;
    }

    if (agentId) {
      requestAnimationFrame(function () {
        var el = PR.hostEl.querySelector('.diff-explanation[data-request-id="' + agentId + '"]');
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  };

  // Reattach the renderer to a backgrounded AI review: re-parse the JSONL
  // the agent has already produced, populate aiReview state, then subscribe
  // to future chunks/done so the live stream continues to land here.
  PR.rehydrateAiReview = function(agentId) {
    if (!window.klaus || !window.klaus.agents) return;
    if (PR.aiReview.requestId === agentId) return; // already attached
    window.klaus.agents.get(agentId).then(function (agent) {
      if (!agent || agent.kind !== 'pr-review-ai') return;
      PR.aiReview.requestId = agent.status === 'running' ? agentId : null;
      PR.aiReview.finalText = '';
      PR.aiReview.progress = [];
      PR.aiReview.error = agent.status === 'error' ? agent.error : null;
      PR.aiReview.cancelled = agent.status === 'cancelled';
      PR.aiReview.findings = [];
      PR.aiReview.usage = null;
      PR.aiReview.worktreePath = (agent.sourceContext && agent.sourceContext.worktreePath) || PR.aiReview.worktreePath;

      // Re-parse the JSONL events the agent has already written.
      var lines = (agent.text || '').split('\n');
      lines.forEach(function (line) {
        if (!line.trim()) return;
        try { PR.handleAiEvent(JSON.parse(line)); } catch (_) {}
      });
      PR.applyReviewParse();
      PR.repaintAiReviewTab();
      PR.rehydrateChatAgents();

      // For a still-running agent, attach to future chunks. Same handlers
      // as startAiReview's so the streaming UX continues seamlessly.
      if (agent.status === 'running') {
        var buffered = '';
        var unsubData = window.klaus.pr.onReviewAiData(agentId, function (chunk) {
          if (PR.aiReview.requestId !== agentId) return;
          buffered += chunk;
          var idx;
          while ((idx = buffered.indexOf('\n')) !== -1) {
            var line = buffered.slice(0, idx);
            buffered = buffered.slice(idx + 1);
            if (!line.trim()) continue;
            try { PR.handleAiEvent(JSON.parse(line)); } catch (_) {}
          }
          PR.applyReviewParse();
          PR.repaintAiReviewTab();
        });
        window.klaus.pr.onReviewAiDone(agentId, function (result) {
          if (unsubData) unsubData();
          if (PR.aiReview.requestId !== agentId) return;
          PR.aiReview.requestId = null;
          if (result && result.error) PR.aiReview.error = result.error;
          if (result && result.cancelled) PR.aiReview.cancelled = true;
          PR.applyReviewParse();
          PR.repaintAiReviewTab();
          if (PR.aiReview.finalText) PR.saveAiReviewCache();
        });
      }
    });
  };

  // On PR open / re-mount, see if there's a backgrounded pr-review-ai
  // agent for this PR whose result the renderer missed (because the cache
  // is only written by the renderer's done handler — an agent that
  // completed while we were unmounted leaves the cache stale). Unlike
  // rehydrateAiReview (which wipes findings to [] before reconciling),
  // this preserves per-finding state already loaded from cache because
  // reconcileFindings merges by key.
  PR.adoptBackgroundedReviewAgent = function(baseOwner, baseRepo, prNumber) {
    if (!window.klaus || !window.klaus.agents) return;
    if (PR.aiReview.requestId) return; // already attached to a live stream
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
      if (!PR.lastState || PR.lastState.number !== prNumber || PR.lastState.baseOwner !== baseOwner || PR.lastState.baseRepo !== baseRepo) return;

      // Re-parse the JSONL events the agent has written. handleAiEvent
      // updates aiReview.finalText / progress / usage in-place.
      var lines = agent.text.split('\n');
      lines.forEach(function (line) {
        if (!line.trim()) return;
        try { PR.handleAiEvent(JSON.parse(line)); } catch (_) {}
      });
      PR.applyReviewParse();
      PR.aiReview.worktreePath = (agent.sourceContext && agent.sourceContext.worktreePath) || PR.aiReview.worktreePath;

      if (agent.status === 'running') {
        // Still streaming — attach to live updates so chunks land here.
        PR.aiReview.requestId = agent.id;
        var buffered = '';
        var unsubData = window.klaus.pr.onReviewAiData(agent.id, function (chunk) {
          if (PR.aiReview.requestId !== agent.id) return;
          buffered += chunk;
          var idx;
          while ((idx = buffered.indexOf('\n')) !== -1) {
            var line = buffered.slice(0, idx);
            buffered = buffered.slice(idx + 1);
            if (!line.trim()) continue;
            try { PR.handleAiEvent(JSON.parse(line)); } catch (_) {}
          }
          PR.applyReviewParse();
          PR.repaintAiReviewTab();
        });
        window.klaus.pr.onReviewAiDone(agent.id, function (result) {
          if (unsubData) unsubData();
          if (PR.aiReview.requestId !== agent.id) return;
          PR.aiReview.requestId = null;
          if (result && result.error) PR.aiReview.error = result.error;
          if (result && result.cancelled) PR.aiReview.cancelled = true;
          PR.applyReviewParse();
          PR.repaintAiReviewTab();
          if (PR.aiReview.finalText) PR.saveAiReviewCache();
        });
      } else if (PR.aiReview.finalText) {
        // Completed — persist what we just adopted so future loads hit
        // the cache without re-scanning the agent registry.
        PR.saveAiReviewCache();
      }
      PR.repaintAiReviewTab();
    });
  };

  // When the diff comes back into focus (file switch, tab switch, mount),
  // re-inject any explain-diff agents already in the registry so the user
  // doesn't lose their results just because the DOM was rebuilt.
  PR.rehydrateExplanations = function() {
    // Clear any previous rehydrated subscriptions — those listeners point at
    // detached DOM after the innerHTML swap.
    PR.rehydrateUnsubs.forEach(function (fn) { try { fn(); } catch (_) {} });
    PR.rehydrateUnsubs = [];

    var diffPre = PR.hostEl.querySelector('.pr-review-diff-pre');
    if (!diffPre || !PR.selectedFile) return;

    window.klaus.agents.list().then(function (agents) {
      if (!agents || !agents.length) return;
      var matching = agents.filter(function (a) {
        return a.kind === 'explain-diff'
            && a.sourceContext
            && a.sourceContext.file === PR.selectedFile;
      });
      // Newest first so the most recent explanation lands closest to the diff.
      matching.sort(function (a, b) { return b.startedAt - a.startedAt; });
      matching.forEach(function (agent) { PR.injectRehydratedExplanation(agent, diffPre); });
    });
  };

  // Strip the leading diff marker (+/-/space) from a diff-line's textContent
  // so we can compare against a user selection that grabbed only the code.
  PR.stripDiffPrefix = function(s) {
    if (!s) return '';
    var first = s.charAt(0);
    if (first === '+' || first === '-' || first === ' ') return s.slice(1);
    return s;
  };

  // Find a contiguous run of code-bearing .diff-line elements whose content
  // matches the hunk lines. Returns the LAST element of the matching range
  // so the explanation can be inserted directly after it.
  //
  // Matching is done on the diff-line's content with the leading +/-/space
  // marker stripped (the user's selection naturally excludes the marker),
  // then trimmed to absorb whitespace drift. Meta/hunk-header lines are
  // skipped — they can't match a code selection. Returns null on miss
  // (caller falls back to bottom render).
  PR.findHunkAnchor = function(diffPre, hunkText) {
    if (!hunkText) return null;
    var hunkLines = hunkText.split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 0; });
    if (!hunkLines.length) return null;

    // Only consider code-bearing lines — skip @@ headers, --- /+++ headers,
    // and the diff/index/file headers. Selections never span those.
    var codeLines = Array.from(diffPre.querySelectorAll('.diff-line.diff-add, .diff-line.diff-del, .diff-line.diff-context'));
    if (codeLines.length < hunkLines.length) return null;

    // Read the code span (gutter + prefix are separate, non-selectable spans),
    // so line numbers and the +/- marker never pollute the match text.
    var normCode = codeLines.map(function (el) {
      var code = el.querySelector('.diff-code');
      return (code ? code.textContent : PR.stripDiffPrefix(el.textContent)).trim();
    });

    for (var i = 0; i <= normCode.length - hunkLines.length; i++) {
      var ok = true;
      for (var j = 0; j < hunkLines.length; j++) {
        if (normCode[i + j] !== hunkLines[j]) { ok = false; break; }
      }
      if (ok) return codeLines[i + hunkLines.length - 1];
    }
    return null;
  };

  PR.injectRehydratedExplanation = function(agent, diffPre) {
    // Skip if the inline-click flow already has an element for this agent
    // (avoids double-rendering when render() fires shortly after a click).
    if (PR.hostEl.querySelector('.diff-explanation[data-request-id="' + agent.id + '"]')) return;

    var el = document.createElement('div');
    el.className = 'diff-explanation diff-explanation-rehydrated';
    el.dataset.requestId = agent.id;
    var hunkPreview = (agent.sourceContext && agent.sourceContext.hunkPreview) || '';
    var headerLabel = hunkPreview
      ? hunkPreview.replace(/\s+/g, ' ').slice(0, 80)
      : 'Previous explanation';
    el.innerHTML =
      '<div class="diff-explanation-header">'
        + '<span title="' + PR.escHtml(hunkPreview) + '">' + PR.escHtml(headerLabel) + '</span>'
        + '<button class="diff-explanation-close" title="Hide">&times;</button>'
      + '</div>'
      + '<div class="diff-explanation-body"></div>';

    // Try to anchor under the original hunk; if the diff has drifted, fall
    // back to appending at the bottom of the diff container.
    var fullHunk = agent.sourceContext && agent.sourceContext.hunk;
    var anchor = fullHunk ? PR.findHunkAnchor(diffPre, fullHunk) : null;
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
      PR.rehydrateUnsubs.push(unsubChunk, unsubDone);
    }
  };

  PR.bindConversationComposer = function() {
    var composer = PR.hostEl.querySelector('.pr-conv-new-comment');
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
    PR.bindConvClaudeButtons();
  };

  // Per-comment Claude actions: investigate / implement / draft approve /
  // dismiss / clear. Wired with explicit per-button listeners on each
  // repaint \u2014 simple, low-risk, mirrors the rest of this file's style
  // (most other binders also re-attach on every render).
  PR.bindConvClaudeButtons = function() {
    PR.hostEl.querySelectorAll('.pr-conv-claude-investigate').forEach(function (b) {
      b.addEventListener('click', function () { PR.startConvInvestigate(b.dataset.dbid); });
    });
    PR.hostEl.querySelectorAll('.pr-conv-claude-investigate-cancel').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = PR.convClaudeState[b.dataset.dbid];
        if (s && s.investigateId) window.klaus.pr.reviewInvestigateCancel(s.investigateId);
      });
    });
    PR.hostEl.querySelectorAll('.pr-conv-claude-investigate-clear').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = PR.convClaudeState[b.dataset.dbid];
        if (!s) return;
        s.investigateResult = '';
        s.investigateError = null;
        PR.repaintConversationTab();
      });
    });
    PR.hostEl.querySelectorAll('.pr-conv-claude-implement').forEach(function (b) {
      b.addEventListener('click', function () { PR.startConvImplement(b.dataset.dbid); });
    });
    PR.hostEl.querySelectorAll('.pr-conv-claude-implement-cancel').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = PR.convClaudeState[b.dataset.dbid];
        if (!s || !s.implementId) return;
        if (PR.implRun && PR.implRun.requestId === s.implementId) {
          PR.cancelImplementRun();
        } else {
          window.klaus.pr.reviewImplementCancel(s.implementId);
        }
      });
    });
    PR.hostEl.querySelectorAll('.pr-conv-claude-draft-approve').forEach(function (b) {
      b.addEventListener('click', function () { PR.approveConvImplementDraft(b.dataset.dbid, b); });
    });
    PR.hostEl.querySelectorAll('.pr-conv-claude-draft-dismiss').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = PR.convClaudeState[b.dataset.dbid];
        if (!s) return;
        s.implementDraftStatus = 'dismissed';
        PR.repaintConversationTab();
      });
    });
  };

  // Repaint the conversation tab in place. Mirrors repaintAiReviewTab so
  // streaming chunks don't trigger a full app render.
  PR.repaintConversationTab = function() {
    if (PR.activeTab !== 'conversation') return;
    var tab = PR.hostEl.querySelector('.pr-review-conversation');
    if (!tab || !PR.lastState) return;
    tab.innerHTML = PR.renderConversation(PR.lastState);
    PR.bindConversationComposer();
    PR.bindReplyButtons();
    PR.bindEditCommentButtons();
  };

  PR.bindReplyButtons = function() {
    PR.hostEl.querySelectorAll('.pr-conv-reply-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        PR.openReplyComposer(btn);
      });
    });
  };

  PR.bindEditCommentButtons = function() {
    // Enter edit mode — swap the body for a textarea on the next render.
    PR.hostEl.querySelectorAll('.pr-conv-edit-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        PR.editingCommentId = parseInt(btn.dataset.id, 10);
        PR.editingCommentKind = btn.dataset.kind;
        if (PR.lastState) PR.render(PR.lastState);
      });
    });
    // Cancel / Save handlers for any currently-open composer.
    PR.hostEl.querySelectorAll('.pr-conv-edit-wrap').forEach(function (wrap) {
      var dbid = parseInt(wrap.dataset.id, 10);
      var kind = wrap.dataset.kind;
      var ta = wrap.querySelector('.pr-conv-edit-input');
      var saveBtn = wrap.querySelector('.pr-conv-edit-save');
      var cancelBtn = wrap.querySelector('.pr-conv-edit-cancel');
      var errEl = wrap.querySelector('.pr-conv-edit-error');
      if (ta) ta.focus();
      if (cancelBtn) cancelBtn.addEventListener('click', function () {
        PR.editingCommentId = null;
        PR.editingCommentKind = null;
        if (PR.lastState) PR.render(PR.lastState);
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
        PR.editedCommentOverrides[dbid] = body;
        PR.editingCommentId = null;
        PR.editingCommentKind = null;
        // Ask the main process for fresh threads so our state reflects the
        // canonical server view — the override is there for the brief gap.
        window.klaus.pr.refreshThreads();
        if (PR.lastState) PR.render(PR.lastState);
      });
    });
  };

  PR.openReplyComposer = function(btn) {
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
  };

  PR.renderPendingReviewBar = function(state) {
    var actions = PR.hostEl.querySelector('.pr-review-actions');
    if (!actions) return;
    var prev = actions.querySelector('.pr-pending-review-bar');
    if (prev) prev.remove();
    if (PR.pendingComments.length === 0) return;

    var bar = document.createElement('span');
    bar.className = 'pr-pending-review-bar';
    bar.innerHTML = '<span class="pr-pending-count">' + PR.pendingComments.length + ' pending</span>'
      + '<button class="pr-review-btn pr-pending-submit" type="button">Finish review\u2026</button>';
    actions.insertBefore(bar, actions.firstChild);
    bar.querySelector('.pr-pending-submit').addEventListener('click', PR.openSubmitReviewDialog);
  };

  // Floating action bar that appears when the user selects text inside the
  // review diff — mirrors the Changes tab's selection FAB but adds a Comment
  // button so reviewers can leave line comments (G4). Lives on document.body
  // so it can float outside the scroll container.
  PR.initSelectionExplain = function() {
    if (PR.selectionFab) return;
    PR.selectionFab = document.createElement('div');
    PR.selectionFab.id = 'pr-review-selection-fab';
    PR.selectionFab.style.display = 'none';
    PR.selectionFab.innerHTML =
      '<button type="button" data-action="explain" title="Explain selection">Explain</button>'
      + '<button type="button" data-action="comment" title="Leave a review comment">Comment</button>';
    document.body.appendChild(PR.selectionFab);

    // Prevent the click from collapsing the selection before we read it.
    PR.selectionFab.addEventListener('mousedown', function (e) { e.preventDefault(); });
    PR.selectionFab.querySelector('[data-action="explain"]').addEventListener('click', function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      var text = sel.toString().trim();
      if (!text) return;
      PR.selectionFab.style.display = 'none';
      PR.explainSelection(text);
    });
    PR.selectionFab.querySelector('[data-action="comment"]').addEventListener('click', function () {
      var range = PR.computeCommentRange();
      PR.selectionFab.style.display = 'none';
      if (!range) {
        window.toast.error('Select one or more diff lines (add / delete / context) to comment on.');
        return;
      }
      PR.openCommentComposer(range);
    });

    PR.onSelectionChange = function () {
      if (!PR.selectionFab) return;
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        PR.selectionFab.style.display = 'none';
        return;
      }
      var diffArea = PR.hostEl.querySelector('.pr-review-diff');
      if (!diffArea) { PR.selectionFab.style.display = 'none'; return; }
      if (!diffArea.contains(sel.anchorNode) && !diffArea.contains(sel.focusNode)) {
        PR.selectionFab.style.display = 'none';
        return;
      }
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      PR.selectionFab.style.display = 'flex';
      PR.selectionFab.style.top = (rect.top - 32 + window.scrollY) + 'px';
      PR.selectionFab.style.left = Math.max(4, rect.right - PR.selectionFab.offsetWidth) + 'px';
    };
    document.addEventListener('selectionchange', PR.onSelectionChange);
  };

  PR.teardownSelectionExplain = function() {
    if (PR.onSelectionChange) {
      document.removeEventListener('selectionchange', PR.onSelectionChange);
      PR.onSelectionChange = null;
    }
    if (PR.selectionFab) {
      PR.selectionFab.remove();
      PR.selectionFab = null;
    }
  };

  // Rotating status messages shown before the first streamed chunk arrives.
  // Honest about what's happening at each stage — not fake tool steps.
  PR.EXPLAIN_STATUS_MESSAGES = [
    'Sending to the agent\u2026',
    'Reading the change\u2026',
    'Considering intent\u2026',
    'Looking at surrounding context\u2026',
    'Drafting explanation\u2026',
  ];

  PR.explainSelection = async function(text) {
    // Anchor the explanation panel to the last diff-line the selection touches
    // so it lands under the selected block rather than at the top of the diff.
    var sel = window.getSelection();
    var anchor = sel && sel.focusNode;
    var lineEl = anchor;
    while (lineEl && !lineEl.classList) lineEl = lineEl.parentElement;
    while (lineEl && !lineEl.classList.contains('diff-line')) lineEl = lineEl.parentElement;
    var diffPre = PR.hostEl.querySelector('.pr-review-diff-pre');
    var insertAfter = lineEl || (diffPre && diffPre.lastElementChild);
    if (!insertAfter) return;

    // Only one explanation at a time.
    var existing = PR.hostEl.querySelector('.diff-explanation');
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
    var fileLabel = PR.selectedFile || 'unknown';
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
      + '<div class="diff-explanation-body status-pulse">' + PR.escHtml(PR.EXPLAIN_STATUS_MESSAGES[0]) + '</div>';
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
      statusIdx = (statusIdx + 1) % PR.EXPLAIN_STATUS_MESSAGES.length;
      bodyEl.textContent = PR.EXPLAIN_STATUS_MESSAGES[statusIdx];
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
      var prNumber = (PR.lastState && PR.lastState.number) || null;
      window.klaus.ai.explainDiffStreamStart(requestId, null, fileLabel, text, prNumber);
    }
  };

  PR.renderConversationCount = function(state) {
    var n = ((state.issueComments && state.issueComments.length) || 0)
          + ((state.reviews && state.reviews.length) || 0);
    if (!n) return '';
    return ' <span class="pr-tab-count">' + n + '</span>';
  };

  PR.bindTabs = function() {
    PR.hostEl.querySelectorAll('.pr-review-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.dataset.tab;
        if (PR.activeTab === tab) return;
        // Leaving the Checks tab: stop the periodic poll. Re-entering it
        // re-binds and bindChecksTab() restarts the poll.
        if (PR.activeTab === 'checks' && tab !== 'checks') PR.clearChecksPolling();
        PR.activeTab = tab;
        if (PR.lastState) PR.render(PR.lastState);
      });
    });
  };

  PR.groupThreadsByPath = function(threads) {
    var map = {};
    threads.forEach(function (t) {
      if (!map[t.path]) map[t.path] = [];
      map[t.path].push(t);
    });
    return map;
  };

  PR.renderFileList = function(files, threadsByPath) {
    if (files.length === 0) return '<div class="pr-review-empty">No files.</div>';
    return files.map(function (f) {
      var isSelected = f.path === PR.selectedFile ? ' selected' : '';
      var threads = (threadsByPath && threadsByPath[f.path]) || [];
      var openThreads = threads.filter(function (t) { return !t.isResolved; }).length;
      var threadBadge = openThreads > 0
        ? '<span class="pr-file-threads" title="' + openThreads + ' open thread' + (openThreads === 1 ? '' : 's') + '">\u{1F4AC}' + openThreads + '</span>'
        : '';
      // Split into basename (emphasized) + directory (dimmed), like the diff
      // panel's file rows so the two surfaces read the same.
      var slash = f.path.lastIndexOf('/');
      var base = slash === -1 ? f.path : f.path.slice(slash + 1);
      var dir = slash === -1 ? '' : f.path.slice(0, slash);
      var adds = f.adds || 0, dels = f.dels || 0;
      var bar = (adds + dels) > 0
        ? '<span class="diff-file-bar" title="+' + adds + ' \u2212' + dels + '">'
            + '<span class="diff-file-bar-add" style="flex:' + adds + '"></span>'
            + '<span class="diff-file-bar-del" style="flex:' + dels + '"></span>'
          + '</span>'
        : '';
      return '<div class="diff-file pr-review-file' + isSelected + '" data-file="' + PR.escHtml(f.path) + '" title="' + PR.escHtml(f.path) + '">'
        + '<span class="diff-file-name">' + PR.escHtml(base) + '</span>'
        + '<span class="diff-file-path">' + PR.escHtml(dir) + '</span>'
        + threadBadge
        + '<span class="diff-file-stats">'
          + (adds ? '<span class="pr-file-add">+' + adds + '</span>' : '')
          + (dels ? '<span class="pr-file-del">\u2212' + dels + '</span>' : '')
        + '</span>'
        + bar
      + '</div>';
    }).join('');
  };

  PR.renderSelectedFileDiff = function(files) {
    var file = files.find(function (f) { return f.path === PR.selectedFile; });
    if (!file) return '<div class="pr-review-empty">Select a file.</div>';
    return '<pre class="pr-review-diff-pre">' + PR.renderUnifiedDiff(file.raw) + '</pre>';
  };

  // Parse a `gh pr diff` unified diff into per-file blocks.
  PR.parseDiffFiles = function(diffText) {
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
  };

  // Build the set of lines GitHub will accept as inline-comment anchors,
  // keyed by path then side. A line is commentable only if it appears in a
  // diff hunk (added/deleted/context) — the same lines renderUnifiedDiff tags
  // with data-side/data-line. AI findings verify their line against the full
  // worktree file, which can resolve to an unchanged line that is NOT in the
  // diff; posting that inline yields GitHub's 422 "line must be part of the
  // diff". Callers use this index to gate inline posting and fall back to an
  // issue comment instead. Returns { [path]: { RIGHT: Set<number>, LEFT: Set<number> } }.
  PR.buildCommentableLineIndex = function(diffText) {
    var index = {};
    if (!diffText) return index;
    var lines = diffText.split('\n');
    var path = null, sides = null, inHunk = false, oldLn = 0, newLn = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.startsWith('diff --git ')) {
        var m = line.match(/^diff --git a\/.* b\/(.*)$/);
        path = m ? m[1] : null;
        sides = path ? (index[path] = index[path] || { RIGHT: {}, LEFT: {} }) : null;
        inHunk = false; oldLn = newLn = 0;
      } else if (!sides) {
        continue;
      } else if (line.startsWith('@@')) {
        var hm = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hm) { oldLn = parseInt(hm[1], 10) - 1; newLn = parseInt(hm[2], 10) - 1; inHunk = true; }
      } else if (!inHunk) {
        // File-header noise before the first hunk (index/mode/---/+++/rename…).
        continue;
      } else if (line.startsWith('+')) {
        newLn++; sides.RIGHT[newLn] = true;
      } else if (line.startsWith('-')) {
        oldLn++; sides.LEFT[oldLn] = true;
      } else if (line.startsWith('\\')) {
        continue; // "\ No newline at end of file"
      } else {
        oldLn++; newLn++; sides.RIGHT[newLn] = true; sides.LEFT[oldLn] = true;
      }
    }
    return index;
  };

  // True when (path, line, side) is a valid inline-comment anchor in `diffText`.
  // Defaults to RIGHT (the new-file side findings resolve against). Returns true
  // when the diff is empty/unparsed so a missing diff never blocks posting.
  PR.isLineInDiff = function(diffText, path, line, side) {
    if (!diffText || !path || typeof line !== 'number') return true;
    var index = PR._commentableIndex;
    if (!index || PR._commentableIndexSource !== diffText) {
      index = PR._commentableIndex = PR.buildCommentableLineIndex(diffText);
      PR._commentableIndexSource = diffText;
    }
    var entry = index[path];
    if (!entry) return false;
    return !!entry[side === 'LEFT' ? 'LEFT' : 'RIGHT'][line];
  };

  // Unified-diff renderer that tags each add/del/context line with (side,
  // line) so G3 can anchor review threads by GitHub's position model
  // (LEFT=old_ln, RIGHT=new_ln). Explain lives in a floating action button
  // triggered by text selection (see initSelectionExplain), not inline.
  PR.renderUnifiedDiff = function(diffText) {
    var lines = diffText.split('\n');
    var out = '';
    var oldLn = 0, newLn = 0;
    // Two-column line-number gutter (old | new). user-select:none in CSS keeps
    // the numbers out of text selections (selection grabs only .diff-code).
    function gut(o, n) {
      return '<span class="diff-gutter diff-gutter-old">' + (o || '') + '</span>'
        + '<span class="diff-gutter diff-gutter-new">' + (n || '') + '</span>';
    }
    function meta(line) { return '<div class="diff-line diff-meta">' + gut() + '<span class="diff-code">' + PR.escHtml(line) + '</span></div>'; }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.startsWith('+++') || line.startsWith('---')) {
        out += meta(line);
      } else if (line.startsWith('@@')) {
        var hm = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hm) { oldLn = parseInt(hm[1], 10) - 1; newLn = parseInt(hm[2], 10) - 1; }
        out += '<div class="diff-line diff-hunk">' + gut() + '<span class="diff-hunk-text">' + PR.escHtml(line) + '</span></div>';
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        newLn++;
        out += '<div class="diff-line diff-add" data-side="RIGHT" data-line="' + newLn + '" data-new-ln="' + newLn + '">'
          + gut('', newLn) + '<span class="diff-prefix">+</span><span class="diff-code">' + PR.escHtml(line.substring(1)) + '</span></div>';
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        oldLn++;
        out += '<div class="diff-line diff-del" data-side="LEFT" data-line="' + oldLn + '" data-old-ln="' + oldLn + '">'
          + gut(oldLn, '') + '<span class="diff-prefix">−</span><span class="diff-code">' + PR.escHtml(line.substring(1)) + '</span></div>';
      } else if (line.startsWith('diff ')) {
        out += '<div class="diff-line diff-header">' + gut() + '<span class="diff-code">' + PR.escHtml(line) + '</span></div>';
      } else if (line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
        out += meta(line);
      } else {
        oldLn++; newLn++;
        out += '<div class="diff-line diff-context" data-side="RIGHT" data-line="' + newLn + '" data-new-ln="' + newLn + '" data-old-ln="' + oldLn + '">'
          + gut(oldLn, newLn) + '<span class="diff-prefix"> </span><span class="diff-code">' + PR.escHtml(line.substring(1)) + '</span></div>';
      }
    }
    return out;
  };

  PR.bindHeader = function(state) {
    var extBtn = PR.hostEl.querySelector('.pr-review-external');
    if (extBtn) extBtn.addEventListener('click', function (e) {
      e.preventDefault();
      var url = extBtn.dataset.url;
      if (url) window.klaus.gh.openExternal(url);
    });
    var popOut = PR.hostEl.querySelector('.js-pop-out');
    if (popOut) popOut.addEventListener('click', function () { window.klaus.pr.popOut(); });
    var popIn = PR.hostEl.querySelector('.js-pop-in');
    if (popIn) popIn.addEventListener('click', function () { window.klaus.pr.popIn(); });
    var closeBtn = PR.hostEl.querySelector('.js-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { window.klaus.pr.reviewClose(); });
    var pullBtn = PR.hostEl.querySelector('.js-pull-updates');
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
    var checkoutBtn = PR.hostEl.querySelector('.js-checkout-local');
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
    var aiBtn = PR.hostEl.querySelector('.js-ai-review');
    if (aiBtn && window.AgentSplit && AgentSplit.createToolbar) {
      // Replace the static review button with a global Agent + Version toolbar.
      // The selection here is the one default agent (and its model) that every
      // PR action uses — review, implement, CI debug, ask.
      var toolbar = AgentSplit.createToolbar({
        runLabel: 'Run Review',
        onRun: function (agent) {
          PR.activeTab = 'ai-review';
          PR.startAiReview(agent); // no-ops if a run is already in flight
        },
      });
      toolbar.classList.add('js-ai-review');
      aiBtn.replaceWith(toolbar);
    } else if (aiBtn) {
      aiBtn.addEventListener('click', function () {
        PR.activeTab = 'ai-review';
        if (!PR.aiReview.requestId && !PR.aiReview.finalText) PR.startAiReview();
        else if (PR.lastState) PR.render(PR.lastState);
      });
    }
  };

  // ---- G7: AI review cache ----

  PR.loadAiReviewCache = async function(owner, repo, number) {
    var result = await window.klaus.pr.cacheGetByPr(owner, repo, number);
    if (!result || !result.cached) return;
    // Bail if the user navigated to a different PR while we were loading.
    if (!PR.lastState || PR.lastState.number !== number) return;
    var cached = result.cached;

    PR.aiReview.finalText = cached.finalText || '';
    PR.applyReviewParse();
    if (cached.findingState) {
      PR.aiReview.findings.forEach(function (f) {
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
    if (cached.implementAllSummary) PR.aiReview.implementAllSummary = cached.implementAllSummary;
    if (cached.implementAllUsage) PR.aiReview.implementAllUsage = cached.implementAllUsage;
    if (cached.usage) PR.aiReview.usage = cached.usage;
    PR.repaintAiReviewTab();
    // Tab badge was set to 0 in the new-PR reset; rerender meta to update it.
    var tabBtn = PR.hostEl.querySelector('.pr-review-tab[data-tab="ai-review"]');
    if (tabBtn) tabBtn.innerHTML = 'AI Review' + PR.renderAiReviewTabCount();
    // After cached findings settle, rebind any chat agents still running
    // for those findings (user sent a chat message, navigated away, came back).
    PR.rehydrateChatAgents();
  };

  PR.saveAiReviewCache = function() {
    if (!PR.lastState || !PR.lastState.baseOwner || !PR.lastState.baseRepo) return;
    if (!PR.aiReview.finalText && PR.aiReview.findings.length === 0) return;
    var findingState = {};
    PR.aiReview.findings.forEach(function (f) {
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
      PR.lastState.baseOwner, PR.lastState.baseRepo, PR.lastState.number,
      {
        savedAt: new Date().toISOString(),
        finalText: PR.aiReview.finalText,
        findingState: findingState,
        implementAllSummary: PR.aiReview.implementAllSummary || null,
        implementAllUsage: PR.aiReview.implementAllUsage || null,
        usage: PR.aiReview.usage || null,
      }
    );
  };

  // ---- G7: AI review tab ----

  // Shared with pr-panel.js via renderer/finding-parser.js — the single
  // source of truth for splitting review text into preamble / finding cards /
  // postamble (delimited <FINDINGS> contract first, legacy [Severity:]
  // anchors second, whole-text fallback card last). Defensive fallback: if
  // the shared script ever fails to load, the surface must degrade to
  // whole-text cards, not die at module eval.
  PR._FP = window.FindingParser || {
    sanitizeAiTone: function (t) { return t; },
    parseReviewFindings: function (t) { return { preamble: t || '', findings: [], postamble: '' }; },
    severityOf: function () { return ''; },
  };

})(window.PrReview);
