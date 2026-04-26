// Routes "Open" clicks from the Agents panel back to the surface that
// originated the agent. Best-effort: for v1 we navigate to the broad
// context (the right PR, the right task) and let the user find the
// specific finding/hunk if they need to. Future revisions can add deep
// linking to scroll to a specific item.

window.AgentRouter = (function () {

  function findTaskIdByWorktree(wt) {
    if (!wt || !window.AppState || !AppState.tasks) return null;
    for (var entry of AppState.tasks) {
      var id = entry[0];
      var task = entry[1];
      if (task && task.worktreePath === wt) return id;
    }
    return null;
  }

  function openTaskAndDiff(worktreePath) {
    var id = findTaskIdByWorktree(worktreePath);
    if (id != null && window.TerminalManager && typeof TerminalManager.switchToTask === 'function') {
      TerminalManager.switchToTask(id);
    }
    // Open the diff panel if it isn't already showing this worktree.
    if (worktreePath && window.DiffPanel) {
      try {
        if (!DiffPanel.isVisible()) DiffPanel.show(worktreePath);
        var btnDiff = document.getElementById('btn-diff');
        if (btnDiff) btnDiff.classList.add('active');
      } catch (e) { /* DiffPanel API surface drift — non-fatal */ }
    }
  }

  async function openPrReview(prNumber, navIntent) {
    if (!prNumber) return;
    // Stash the navigation intent so pr-review.js's render() can pick it up
    // once the surface is mounted (load + mount is async, can't push directly).
    if (navIntent) {
      window._pendingAgentNav = Object.assign({ prNumber: prNumber }, navIntent);
    }
    // If a PR review is already mounted for this PR, just (re)enter the
    // surface. Otherwise ask main to load it — the resulting
    // pr-review-state broadcast triggers enterPrReviewMode.
    try {
      var state = await window.klaus.pr.reviewState();
      var matchesActive = state && state.meta && state.meta.number === prNumber;
      if (matchesActive) {
        if (typeof window.enterPrReviewMode === 'function') window.enterPrReviewMode();
        // PR is already mounted — applyPendingNav doesn't fire on its own
        // because there's no impending render, so nudge it.
        if (window.PrReview && typeof window.PrReview.refresh === 'function') {
          window.PrReview.refresh();
        }
        return;
      }
      var loaded = await window.klaus.pr.load({ number: prNumber });
      if (loaded && loaded.error && window.toast) {
        window.toast.error('Could not open PR #' + prNumber + ': ' + loaded.error);
      }
    } catch (err) {
      if (window.toast) window.toast.error('Could not open PR: ' + (err.message || err));
    }
  }

  function open(agent) {
    if (!agent) return;
    var ctx = agent.sourceContext || {};
    switch (agent.kind) {
      case 'explain-diff':
        // PR-originated explains have prNumber but no worktreePath; route to
        // the PR review surface and ask it to focus the right file +
        // scroll to the rehydrated explanation. Worktree-originated explains
        // route to the task + diff panel.
        if (ctx.prNumber) openPrReview(ctx.prNumber, { file: ctx.file, agentId: agent.id });
        else openTaskAndDiff(ctx.worktreePath);
        return;
      case 'pr-ai-review':
      case 'commit-message':
        openTaskAndDiff(ctx.worktreePath);
        return;
      case 'pr-review-ai':
        // AI review lives on the Review tab; ask the surface to switch tabs
        // and rehydrate the in-flight review state from the registry.
        openPrReview(ctx.prNumber, { tab: 'ai-review', agentId: agent.id });
        return;
      case 'pr-debug-check':
      case 'pr-review-implement':
      case 'pr-review-investigate':
      case 'pr-review-chat':
        openPrReview(ctx.prNumber);
        return;
      default:
        // Unknown kind — log and bail; the panel still marks it read.
        if (console && console.warn) console.warn('AgentRouter: no route for kind', agent.kind);
    }
  }

  return { open: open };
})();
