// Part of the PrReview surface (window.PrReview); see pr-review.js for the
// core. Terminal tab: chrome, chat session, terminal lifecycle, AI-review start.
// All cross-references go through the shared `PR` object, so load order
// only needs core (pr-review.js) first; siblings may load in any order.

(function (PR) {

  // Chrome above the shared xterm. Shows the chat session's status, plus the
  // implement run's status when one exists, and the controls for whichever is
  // relevant. The host ids are unchanged so mountImplementTerminalIfActive can
  // re-parent the live xterm into the body.
  PR.renderTerminalChrome = function() {
    var chips = [];
    var chatLabel = !PR.chatRun || PR.chatRun.starting ? 'Starting chat…'
      : PR.chatRun.status === 'running' ? 'Chat ready'
      : PR.chatRun.status === 'exited' ? 'Chat ended'
      : PR.chatRun.status === 'error' ? 'Chat unavailable'
      : 'Chat';
    var chatCls = (PR.chatRun && PR.chatRun.status === 'running') ? 'running'
      : (PR.chatRun && PR.chatRun.status === 'error') ? 'error' : '';
    var dot = (PR.chatRun && PR.chatRun.status === 'running') ? '● ' : '';
    chips.push('<span class="pr-term-chip pr-term-chip-chat ' + chatCls + '">' + dot + PR.escHtml(chatLabel) + '</span>');
    if (PR.implRun) {
      var implLabel = PR.implRunIsLive() ? 'Implementing…'
        : PR.implRun.status === 'done' ? 'Implement done'
        : PR.implRun.status === 'error' ? 'Implement error'
        : PR.implRun.status === 'cancelled' ? 'Implement cancelled'
        : 'Implement';
      chips.push('<span class="pr-term-chip pr-term-chip-impl ' + PR.escHtml(PR.implRun.status || '') + '">' + PR.escHtml(implLabel) + '</span>');
    }
    var ctaButtons = '';
    if (PR.implRunIsLive()) {
      ctaButtons += '<button class="pr-implement-cancel pr-review-btn" type="button">Stop implement</button>';
    }
    if (PR.chatRun && (PR.chatRun.status === 'exited' || PR.chatRun.status === 'error')) {
      ctaButtons += '<button class="pr-tchat-restart pr-review-btn" type="button">Restart chat</button>';
    }
    return '<div class="pr-implement-terminal" id="pr-implement-terminal-host">'
      + '<div class="pr-implement-terminal-head">'
        + '<span class="pr-term-chips">' + chips.join('') + '</span>'
        + ctaButtons
      + '</div>'
      + '<div class="pr-implement-terminal-body"></div>'
    + '</div>';
  };

  // Body of the Terminal tab. Always renders the live terminal host — the tab
  // is an always-on chat with the default agent (seeded with the PR context),
  // and implement runs stream into the same xterm, separated by banners. The
  // chat session itself is started lazily by ensureChatSession when the tab is
  // shown.
  PR.renderTerminalTab = function() {
    return PR.renderTerminalChrome();
  };

  // Tiny badge next to the "Terminal" tab label while a run is in flight.
  // Mirrors how renderAiReviewTabCount uses the .pr-tab-count chip.
  PR.renderTerminalTabBadge = function() {
    if (!PR.implRun) return '';
    var label;
    if (PR.implRun.status === 'running') label = '●';
    else if (PR.implRun.status === 'done') label = '✓';
    else if (PR.implRun.status === 'error') label = '!';
    else if (PR.implRun.status === 'cancelled') label = '×';
    else label = '●';
    return ' <span class="pr-tab-count pr-tab-count-' + PR.implRun.status + '">' + label + '</span>';
  };

  PR.bindTerminalTab = function() {
    // The xterm itself is mounted by mountImplementTerminalIfActive after
    // this runs; the chrome buttons get re-bound there too (same pattern as
    // the old inline-on-Review-tab flow).
  };

  // Local-changes block: shows uncommitted edits + unpushed commits in the
  // PR's worktree, with controls to commit (stage all + commit) and push to
  // the PR's head fork branch. Hidden when nothing is local.
  //
  // Renders empty string in three cases:
  //   - localChanges hasn't been fetched yet (no flicker on first render)
  //   - no worktree exists for this PR (user hasn't checked out / implemented)
  //   - worktree exists but is clean and in sync with the PR head SHA
  PR.renderLocalChanges = function() {
    var files = (PR.localChanges && PR.localChanges.files) || [];
    var unpushed = (PR.localChanges && PR.localChanges.unpushed) || [];
    var diverged = !!(PR.localChanges && PR.localChanges.diverged);
    var hasWt = !!(PR.localChanges && PR.localChanges.worktreePath);
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
    if (!PR.localChanges) {
      return '<div class="pr-local-changes pr-local-empty">'
        + '<span class="pr-local-title">Local changes</span>'
        + '<span class="pr-local-counts"> — loading…</span>'
      + '</div>';
    }
    if (PR.localChanges.error) {
      return '<div class="pr-local-changes pr-local-empty">'
        + '<span class="pr-local-title">Local changes</span>'
        + '<span class="pr-local-counts"> — ' + PR.escHtml(PR.localChanges.error) + '</span>'
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
    if (files.length === 0 && unpushed.length === 0 && !diverged && !PR.localBanner) {
      return '<div class="pr-local-changes pr-local-empty">'
        + '<span class="pr-local-title">Local changes</span>'
        + '<span class="pr-local-counts"> — none. Worktree in sync with PR head.</span>'
        + '<button class="pr-local-refresh" type="button" title="Refresh">↻</button>'
      + '</div>';
    }

    var bannerHtml = '';
    if (PR.localBanner) {
      var actionsHtml = (PR.localBanner.actions && PR.localBanner.actions.length)
        ? '<div class="pr-local-banner-actions">'
            + PR.localBanner.actions.map(function (a) {
                return '<button class="pr-review-btn pr-local-banner-btn" type="button"'
                  + ' data-action="' + PR.escHtml(a.id) + '"' + (PR.localBusy ? ' disabled' : '') + '>'
                  + PR.escHtml(a.label) + '</button>';
              }).join('')
          + '</div>'
        : '';
      bannerHtml = '<div class="pr-local-banner ' + PR.localBanner.kind + '">'
        + '<div class="pr-local-banner-text">' + PR.escHtml(PR.localBanner.text) + '</div>'
        + actionsHtml
      + '</div>';
    }

    // Per-file staging: only checked files are committed. Default unchecked so
    // nothing lands in a commit unless the user explicitly picks it.
    var selected = PR.localSelectedFiles || (PR.localSelectedFiles = {});
    var fileListHtml = files.length
      ? '<ul class="pr-local-file-list">'
          + files.map(function (f) {
              return '<li class="pr-local-file-item"><label class="pr-local-file-label">'
                + '<input type="checkbox" class="pr-local-file-check" data-file="' + PR.escHtml(f.file) + '"'
                  + (selected[f.file] ? ' checked' : '') + (PR.localBusy ? ' disabled' : '') + '> '
                + '<code class="pr-local-file-status">' + PR.escHtml(f.status) + '</code> '
                + PR.escHtml(f.file) + '</label></li>';
            }).join('')
        + '</ul>'
      : '';
    var selectedCount = files.filter(function (f) { return selected[f.file]; }).length;

    var diffHtml = (files.length && PR.localChanges.diff)
      ? '<details class="pr-local-diff"><summary>View diff</summary>'
          + '<pre class="pr-local-diff-body">' + PR.escHtml(PR.localChanges.diff) + '</pre>'
        + '</details>'
      : '';

    var commitHtml = files.length
      ? '<div class="pr-local-commit">'
          + '<input type="text" class="pr-local-commit-msg" placeholder="Commit message"'
            + ' value="' + PR.escHtml(PR.localCommitMsg || '') + '"'
            + (PR.localBusy ? ' disabled' : '') + '>'
          + '<button class="pr-review-btn pr-local-commit-btn" type="button"'
            + ((PR.localBusy || !selectedCount) ? ' disabled' : '') + '>'
            + (PR.localBusy === 'committing' ? 'Committing…' : 'Commit' + (selectedCount ? ' (' + selectedCount + ')' : ''))
          + '</button>'
        + '</div>'
      : '';

    var unpushedHtml = unpushed.length
      ? '<div class="pr-local-unpushed">'
          + '<div class="pr-local-unpushed-head">Unpushed commits ('
            + unpushed.length + ')</div>'
          + '<ul class="pr-local-commit-list">'
            + unpushed.map(function (c) {
                return '<li><code>' + PR.escHtml(c.short) + '</code> ' + PR.escHtml(c.subject || '') + '</li>';
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
          + (PR.localBusy ? ' disabled' : '') + '>'
          + (PR.localBusy === 'pushing' ? 'Pushing…' : 'Push to PR branch')
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
  };

  PR.bindLocalChanges = function() {
    var section = PR.hostEl.querySelector('.pr-local-changes');
    if (!section) return;

    var msgInput = section.querySelector('.pr-local-commit-msg');
    if (msgInput) {
      msgInput.addEventListener('input', function () {
        // Capture the typed value so a repaint (triggered by an unrelated
        // implement-done callback, etc.) doesn't blow it away.
        PR.localCommitMsg = msgInput.value;
      });
    }

    var refreshBtn = section.querySelector('.pr-local-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () {
      PR.localBanner = null;
      PR.refreshLocalChanges();
    });

    var commitBtn = section.querySelector('.pr-local-commit-btn');

    // Keep the selection set + Commit button in sync as boxes are toggled,
    // without a full repaint (which would collapse the diff view / drop focus).
    var checks = section.querySelectorAll('.pr-local-file-check');
    Array.prototype.forEach.call(checks, function (cb) {
      cb.addEventListener('change', function () {
        var file = cb.getAttribute('data-file');
        if (!file) return;
        PR.localSelectedFiles = PR.localSelectedFiles || {};
        if (cb.checked) PR.localSelectedFiles[file] = true;
        else delete PR.localSelectedFiles[file];
        var n = section.querySelectorAll('.pr-local-file-check:checked').length;
        if (commitBtn) {
          commitBtn.disabled = !!PR.localBusy || n === 0;
          if (!PR.localBusy) commitBtn.textContent = 'Commit' + (n ? ' (' + n + ')' : '');
        }
      });
    });

    if (commitBtn) commitBtn.addEventListener('click', function () {
      var msg = msgInput ? msgInput.value.trim() : (PR.localCommitMsg || '').trim();
      if (!msg) {
        PR.localBanner = { kind: 'error', text: 'Commit message required.' };
        PR.repaintAiReviewTab();
        return;
      }
      // Read the checked files straight from the DOM so stale set entries
      // (files that vanished after a prior commit) can't sneak in.
      var selectedFiles = Array.prototype.map.call(
        section.querySelectorAll('.pr-local-file-check:checked'),
        function (cb) { return cb.getAttribute('data-file'); }
      ).filter(Boolean);
      if (!selectedFiles.length) {
        PR.localBanner = { kind: 'error', text: 'Select at least one file to commit.' };
        PR.repaintAiReviewTab();
        return;
      }
      PR.localCommitMsg = msg;
      PR.localBusy = 'committing';
      PR.localBanner = null;
      PR.repaintAiReviewTab();
      window.klaus.pr.commitLocal(msg, PR.aiReview.worktreePath || null, selectedFiles).then(function (r) {
        PR.localBusy = null;
        if (r && r.error) {
          PR.localBanner = { kind: 'error', text: r.error };
          PR.repaintAiReviewTab();
        } else {
          PR.localBanner = { kind: 'ok', text: 'Committed.' };
          // Clear the message field + selection on success so the next commit
          // starts clean.
          PR.localCommitMsg = 'Apply review feedback';
          PR.localSelectedFiles = {};
          PR.refreshLocalChanges();
        }
      });
    });

    var pushBtn = section.querySelector('.pr-local-push-btn');
    if (pushBtn) pushBtn.addEventListener('click', function () { PR.doPushLocal({}); });

    // Recovery actions surfaced in the error banner after a failed auto-rebase.
    var bannerBtns = section.querySelectorAll('.pr-local-banner-btn');
    Array.prototype.forEach.call(bannerBtns, function (b) {
      b.addEventListener('click', function () {
        var action = b.dataset.action;
        if (action === 'stash') PR.doPushLocal({ stash: true });
        else if (action === 'resolve') PR.resolveConflicts();
      });
    });
  };

  // Push the worktree's commits to the PR branch. opts.stash makes main set
  // aside uncommitted changes, integrate the remote (fetch + rebase), push,
  // then restore them. On a non-fast-forward that can't auto-resolve, main
  // returns canStash/canResolve flags and we render them as banner actions.
  PR.doPushLocal = function (opts) {
    opts = opts || {};
    PR.localBusy = 'pushing';
    PR.localBanner = null;
    PR.repaintAiReviewTab();
    window.klaus.pr.pushLocal(PR.aiReview.worktreePath || null, opts).then(function (r) {
      PR.localBusy = null;
      if (r && r.error) {
        var actions = [];
        if (r.canStash) actions.push({ id: 'stash', label: 'Stash, pull & retry' });
        if (r.canResolve) actions.push({ id: 'resolve', label: 'Resolve with agent' });
        PR.localBanner = { kind: 'error', text: r.error, actions: actions };
        PR.repaintAiReviewTab();
      } else {
        PR.localBanner = { kind: 'ok', text: (r && r.rebased ? 'Integrated the latest remote commit, then pushed to ' : 'Pushed to ') + (r && r.target ? r.target : 'PR branch') + '.' };
        PR.refreshLocalChanges();
      }
    });
  };

  // Hand a non-fast-forward / conflict situation to a Claude agent in the
  // worktree. Main spawns/reuses the task, pastes a resolve+commit+push prompt,
  // then exits review mode and focuses the task (via pr-checkout-ready), so on
  // success there's nothing left to paint here.
  PR.resolveConflicts = function () {
    PR.localBusy = 'pushing';
    PR.repaintAiReviewTab();
    window.klaus.pr.resolveConflicts(PR.aiReview.worktreePath || null).then(function (r) {
      PR.localBusy = null;
      if (r && r.error) {
        PR.localBanner = { kind: 'error', text: r.error };
        PR.repaintAiReviewTab();
      }
    });
  };

  // Fetch the worktree's local-state and repaint. Safe to call repeatedly —
  // the IPC is cheap (a few git commands) and refresh is the right tool both
  // after Claude implements something and after manual commit/push.
  //
  // Pass aiReview.worktreePath as a hint when we have it: the cross-clone
  // lookup in main can miss when the user's local clone has its origin set
  // to the head fork (a self-PR), since that doesn't match the PR's base
  // repo. The hint short-circuits that lookup.
  PR.refreshLocalChanges = function() {
    if (!window.klaus || !window.klaus.pr || !window.klaus.pr.localState) return;
    window.klaus.pr.localState(PR.aiReview.worktreePath || null).then(function (r) {
      PR.localChanges = r || null;
      PR.repaintAiReviewTab();
    }).catch(function () {
      // IPC threw — leave localChanges as-is rather than wiping the panel.
    });
  };

  // Severity → display label. Keeps the chip text tidy regardless of how the
  // agent cased it.
  PR.SEV_LABELS = {
    blocker: 'Blocker', high: 'High', medium: 'Medium',
    low: 'Low', warn: 'Warn', nit: 'Nit',
  };

  // Header row for a structured finding: severity chip, category, title, and a
  // location chip. Legacy (marker/text) findings render their own bracketed
  // headers inside the prose, so this returns nothing for them to avoid
  // doubling up.
  // Header for every finding (structured or markdown): a color-coded severity
  // dot + label, a category tag, and (structured) the title. Location is NOT
  // here — it renders de-bracketed above the code snippet.
  PR.renderFindingHeader = function(f) {
    var sev = (f.severity || '').toLowerCase();
    var category = f.category || (f.structured ? '' : PR.parseCategory(f.text));
    if (!sev && !category && !f.title) return '';
    var sevKey = sev ? sev.replace(/\s+/g, '-') : 'note';
    var sevLabel = PR.SEV_LABELS[sev] || (f.severity || 'Note');
    var dot = sev
      ? '<span class="pr-ai-finding-sev pr-ai-finding-sev-' + sevKey + '">'
          + '<span class="pr-ai-finding-dot"></span>' + PR.escHtml(sevLabel)
        + '</span>'
      : '';
    var cat = category
      ? '<span class="pr-ai-finding-cat">' + PR.escHtml(category) + '</span>'
      : '';
    var title = f.title
      ? '<span class="pr-ai-finding-title-text">' + PR.escHtml(f.title) + '</span>'
      : '';
    return '<div class="pr-ai-finding-head-row">'
      + '<span class="pr-ai-finding-head-left">' + dot + cat + title + '</span>'
    + '</div>';
  };

  PR.renderFindingCard = function(f) {
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

    // Add-to-PR always stages onto pendingComments (the Submit-review UI
    // batches them). Verified findings draft as inline comments; unverified
    // ones draft as general issue comments posted after the review.
    var inDraft = PR.pendingCommentDraftExistsForFinding(f.id);
    var addBtnTitle = (f.postMode === 'inline' && f.locationVerified)
      ? (inDraft
          ? 'Draft review comment — click to remove from the pending review'
          : 'Add as draft inline comment at ' + f.path + ':' + f.line)
      : (f.lineNotInDiff
          ? f.path + ':' + f.line + ' isn’t part of this PR’s diff — will post as a general PR comment'
          : 'No verified file/line — will post as a general PR comment');

    if (f.commentStatus === 'posted') {
      commentBadge = '<span class="pr-ai-finding-comment-status posted" title="Posted to the PR">\u2713 Commented</span>';
    } else if (f.commentStatus === 'posting') {
      commentBadge = '<span class="pr-ai-finding-comment-status posting">Posting\u2026</span>';
    } else if (f.commentStatus === 'failed') {
      commentBadge = '<span class="pr-ai-finding-comment-status failed">! Failed</span>';
      commentBtn = '<button class="pr-ai-finding-comment" type="button" title="Try again">Add to PR</button>';
      editCommentBtn = '<button class="pr-ai-finding-edit-comment" type="button" title="Edit the review block">✎</button>';
    } else if (inDraft) {
      commentBadge = '<span class="pr-ai-finding-comment-status drafted" title="Queued — submit the review to post it">✎ Drafted</span>';
      commentBtn = '<button class="pr-ai-finding-comment" type="button" title="' + PR.escHtml(addBtnTitle) + '">Remove draft</button>';
      editCommentBtn = '<button class="pr-ai-finding-edit-comment" type="button" title="Edit the review block">✎</button>';
    } else {
      commentBtn = '<button class="pr-ai-finding-comment" type="button" title="' + PR.escHtml(addBtnTitle) + '">Add to PR</button>';
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
      + PR.escHtml(discussLabel)
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
          + '<div class="pr-ai-finding-comment-error-body">' + PR.escHtml(f.commentError) + '</div>'
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
    var implementUsage = f.usage ? PR.formatUsage(f.usage) : '';
    var implementOut = (f.status === 'implementing' || f.status === 'implemented' || f.status === 'failed')
      && (implementOutTxt || implementUsage)
      ? '<div class="pr-ai-finding-implement-out' + (f.implementError ? ' error' : '') + '">'
          + (implementOutTxt ? PR.escHtml(implementOutTxt) : '')
          + (implementUsage ? '<div class="pr-ai-implement-usage">' + PR.escHtml(implementUsage) + '</div>' : '')
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
          + '<textarea class="pr-ai-finding-body-input" rows="8">' + PR.escHtml(f.text) + '</textarea>'
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
      // The bracketed metadata now renders as the dot/tag/location label, so
      // strip it from the prose. Run the full strip on BOTH chunks — the
      // metadata (and its orphan `**` markers) can land before OR after the
      // Comment: marker depending on how the agent formatted the block.
      postText = postText.replace(/^\s*\*{0,2}Comment\*{0,2}\s*:[^\S\n]*\n?/i, '');
      preText = PR.stripFindingHeaders(preText);
      postText = PR.stripFindingHeaders(postText);

      // The de-bracketed location, shown above the code snippet it describes.
      var loc = PR.parseLocation(f.text);
      var locText = '';
      if (f.verifiedSnippet && f.verifiedSnippet.text) {
        var vs = f.verifiedSnippet;
        locText = vs.path + ':' + vs.startLine
          + (vs.endLine && vs.endLine !== vs.startLine ? '-' + vs.endLine : '');
      } else if (loc) {
        locText = loc.path + ':' + loc.line + (loc.endLine ? '-' + loc.endLine : '');
      } else if (f.path && f.line) {
        locText = f.path + ':' + f.line;
      }
      // The descriptive tail ("…, the restart path in handleEnd") is context for
      // the agent, not the reader — keep it only as a hover title, show just the
      // clean path:line.
      var locDesc = (loc && loc.snippet ? loc.snippet : '').replace(/^[\s,;]+/, '').trim();
      var locTitle = locDesc ? ' title="' + PR.escHtml(locText + ' — ' + locDesc) + '"' : '';
      var locHeadHtml = locText
        ? '<div class="pr-ai-finding-loc-label"' + locTitle + '>'
            + '<span class="pr-ai-finding-loc-path">' + PR.escHtml(locText) + '</span>'
          + '</div>'
        : '';

      var originalSnippetHtml = '';
      if (f.verifiedSnippet && f.verifiedSnippet.text) {
        // Location label sits above the code box it describes.
        originalSnippetHtml = '<div class="pr-ai-finding-original-wrap">'
          + locHeadHtml
          + '<div class="pr-ai-finding-original">'
            + '<pre class="pr-ai-finding-original-code"><code>' + PR.escHtml(f.verifiedSnippet.text) + '</code></pre>'
          + '</div>'
        + '</div>';
        // Drop redundant fenced code block(s) from pre-Comment text — those
        // are Claude's pasted "original code" which we now show verbatim
        // from the file. Don't touch postText: a Suggested change block
        // there is intentional.
        preText = preText.replace(/```[a-zA-Z0-9_-]*\n[\s\S]*?```\n?/g, '').trim();
      } else if (locHeadHtml) {
        // No verified snippet — still surface the location above the body.
        originalSnippetHtml = locHeadHtml;
      }

      bodyHtml = PR.renderFindingHeader(f)
        + '<div class="pr-ai-finding-body">'
        + (preText ? PR.renderMarkdown(preText) : '')
        + originalSnippetHtml
        + (postText ? PR.renderMarkdown(postText) : '')
      + '</div>';
    }

    return '<div class="pr-ai-finding' + sevCls + statusCls + '" data-finding-id="' + f.id + '">'
      + bodyHtml
      + '<div class="pr-ai-finding-actions">' + actions + '</div>'
      + errorBlock
      + PR.renderInvestigatePanel(f)
      + PR.renderChatPanel(f)
      + implementOut
      + PR.renderDraftCommentBlock(f)
    + '</div>';
  };

  // Investigate panel — shown when a claude-investigate run is streaming or
  // has produced a result. Single-shot (no composer); user can re-run via
  // the Investigate button, which fires startInvestigate again.
  PR.renderInvestigatePanel = function(f) {
    if (!f.investigateId && !f.investigateResult && !f.investigateError) return '';
    var body;
    if (f.investigateId) {
      var stream = (f.investigateStreaming || '').trim();
      body = stream
        ? '<div class="pr-ai-finding-investigate-body streaming">' + PR.renderMarkdown(f.investigateStreaming) + '</div>'
        : '<div class="pr-ai-finding-investigate-body streaming status-pulse">Investigating…</div>';
    } else if (f.investigateError) {
      body = '<div class="pr-ai-finding-investigate-error">' + PR.escHtml(f.investigateError) + '</div>';
    } else {
      body = '<div class="pr-ai-finding-investigate-body">' + PR.renderMarkdown(f.investigateResult) + '</div>';
    }
    var header = '<div class="pr-ai-finding-investigate-head">'
      + '<span class="pr-ai-finding-investigate-label">Agent verdict</span>'
      + (!f.investigateId && (f.investigateResult || f.investigateError)
          ? '<button class="pr-ai-finding-investigate-clear" type="button" title="Clear this verdict">Clear</button>'
          : '')
    + '</div>';
    return '<div class="pr-ai-finding-investigate-panel">' + header + body + '</div>';
  };

  // Draft-comment block — shown when Claude implement has produced a
  // follow-up PR comment awaiting approval. Editable textarea + Approve /
  // Dismiss buttons. Approved drafts are pushed onto pendingComments and
  // post with the next Submit review.
  PR.renderDraftCommentBlock = function(f) {
    if (!f.implementDraftComment) return '';
    if (f.implementDraftStatus === 'dismissed') return '';
    if (f.implementDraftStatus === 'approved') {
      return '<div class="pr-ai-finding-draft-comment approved">'
        + '<span class="pr-ai-finding-draft-badge">✓ Draft comment added</span>'
        + '<button class="pr-ai-finding-draft-unapprove" type="button" title="Pull this draft back out of the review">Remove</button>'
      + '</div>';
    }
    var anchorHint = (f.locationVerified && f.path && f.line)
      ? 'Inline at ' + PR.escHtml(f.path) + ':' + f.line
      : (f.lineNotInDiff
          ? 'General PR comment (' + PR.escHtml(f.path) + ':' + f.line + ' not in diff)'
          : 'General PR comment (no verified location)');
    return '<div class="pr-ai-finding-draft-comment pending">'
      + '<div class="pr-ai-finding-draft-head">'
        + '<span class="pr-ai-finding-draft-label">Draft PR comment</span>'
        + '<span class="pr-ai-finding-draft-anchor">' + anchorHint + '</span>'
      + '</div>'
      + '<textarea class="pr-ai-finding-draft-input" rows="3">' + PR.escHtml(f.implementDraftComment) + '</textarea>'
      + '<div class="pr-ai-finding-draft-actions">'
        + '<button class="pr-ai-finding-draft-dismiss" type="button">Dismiss</button>'
        + '<button class="pr-ai-finding-draft-approve" type="button">Approve &amp; add to draft</button>'
      + '</div>'
    + '</div>';
  };

  // Chat panel — rendered below the finding actions when f.chatOpen is true.
  // Messages are shown as bubbles; streaming assistant output appears as a
  // growing assistant bubble. Cancel button sits next to Send while a
  // response is in flight.
  PR.renderChatPanel = function(f) {
    if (!f.chatOpen) return '';
    var streaming = !!f.chatRequestId;
    var msgs = (f.chatMessages || []).map(function (m) {
      var cls = 'pr-ai-finding-chat-msg ' + (m.role === 'assistant' ? 'assistant' : 'user');
      return '<div class="' + cls + '">' + PR.renderMarkdown(m.content || '') + '</div>';
    }).join('');
    var streamingBubble = (streaming && (f.chatStreaming || '').trim())
      ? '<div class="pr-ai-finding-chat-msg assistant streaming">' + PR.renderMarkdown(f.chatStreaming) + '</div>'
      : streaming
        ? '<div class="pr-ai-finding-chat-msg assistant streaming status-pulse">Thinking…</div>'
        : '';
    var errorBar = f.chatError
      ? '<div class="pr-ai-finding-chat-error">' + PR.escHtml(f.chatError) + '</div>'
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
  };

  // Minimal markdown renderer: bold + inline code + line breaks + fenced
  // code blocks. Enough for review text without pulling in a real markdown
  // library.
  PR.renderMarkdown = function(text) {
    var src = (text || '').toString();
    // Pull out fenced code blocks first so their inner content isn't escaped twice.
    var blocks = [];
    src = src.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, function (_, lang, code) {
      var idx = blocks.length;
      blocks.push('<pre class="pr-ai-code"><code>' + PR.escHtml(code) + '</code></pre>');
      return '\u0000CODEBLOCK' + idx + '\u0000';
    });
    src = PR.escHtml(src)
      .replace(/`([^`]+)`/g, '<code class="pr-ai-inline-code">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    src = src.replace(/\u0000CODEBLOCK(\d+)\u0000/g, function (_, i) { return blocks[parseInt(i, 10)]; });
    return src;
  };

  PR.bindAiReviewTab = function() {
    PR.bindLocalChanges();

    var runBtn = PR.hostEl.querySelector('.pr-ai-run');
    if (runBtn) runBtn.addEventListener('click', function () { PR.startAiReview(); });

    var rerunBtn = PR.hostEl.querySelector('.pr-ai-rerun');
    if (rerunBtn) rerunBtn.addEventListener('click', function () {
      // Cancel any in-flight implement run so its PTY exits, but KEEP the
      // persistent reviewTerminal — the user wants new Implement runs to
      // append to the same scrollback, not start fresh in a blank xterm.
      if (PR.implRunIsLive()) PR.cancelImplementRun();
      PR.writeRunSeparator('Review rerun');
      // Clear the disk cache so Rerun gives a clean slate.
      if (PR.lastState && PR.lastState.baseOwner && PR.lastState.baseRepo) {
        window.klaus.pr.cacheClearByPr(PR.lastState.baseOwner, PR.lastState.baseRepo, PR.lastState.number);
      }
      PR.aiReview = {
        requestId: null, finalText: '', progress: [], error: null, cancelled: false,
        worktreePath: PR.aiReview.worktreePath, findings: [], summary: null,
        implementAllId: null, implementAllProgress: [], implementAllError: null, implementAllSummary: null,
        implementAllUsage: null, usage: null,
      };
      PR.startAiReview();
    });

    var cancelBtn = PR.hostEl.querySelector('.pr-ai-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function () {
      if (PR.aiReview.requestId) window.klaus.pr.reviewAiCancel(PR.aiReview.requestId);
    });

    var implementAllBtn = PR.hostEl.querySelector('.pr-ai-implement-all');
    if (implementAllBtn) implementAllBtn.addEventListener('click', function () { PR.startImplementAll(); });

    PR.hostEl.querySelectorAll('.pr-ai-finding').forEach(function (card) {
      var fid = card.dataset.findingId;
      var f = PR.aiReview.findings.find(function (x) { return x.id === fid; });
      if (!f) return;
      var ignore = card.querySelector('.pr-ai-finding-ignore');
      var implementBtn = card.querySelector('.pr-ai-finding-implement');
      var redoBtn = card.querySelector('.pr-ai-finding-redo');
      var undoBtn = card.querySelector('.pr-ai-finding-undo');
      var cancelImpl = card.querySelector('.pr-ai-finding-cancel');
      var commentBtn = card.querySelector('.pr-ai-finding-comment');
      if (ignore) ignore.addEventListener('click', function () { f.ignored = true; PR.repaintAiReviewTab(); PR.saveAiReviewCache(); });
      if (undoBtn) undoBtn.addEventListener('click', function () { f.ignored = false; PR.repaintAiReviewTab(); PR.saveAiReviewCache(); });
      if (implementBtn) implementBtn.addEventListener('click', function () { PR.startImplement(f); });
      if (redoBtn) redoBtn.addEventListener('click', function () { PR.startImplement(f); });
      if (cancelImpl) cancelImpl.addEventListener('click', function () {
        // Route through cancelImplementRun when the active run is this
        // finding's so the inline terminal flips to 'cancelled' immediately.
        if (PR.implRun && PR.implRun.requestId === f.implementId) {
          PR.cancelImplementRun();
        } else if (f.implementId) {
          window.klaus.pr.reviewImplementCancel(f.implementId);
        }
      });
      if (commentBtn) commentBtn.addEventListener('click', function () { PR.postFindingAsComment(f); });

      var copyBtnEl = card.querySelector('.pr-ai-finding-copy');
      if (copyBtnEl) copyBtnEl.addEventListener('click', function () { PR.copyFindingAsMarkdown(f); });

      // "Ask Claude" button toggles the inline chat panel.
      var discussBtnEl = card.querySelector('.pr-ai-finding-discuss');
      if (discussBtnEl) discussBtnEl.addEventListener('click', function () {
        f.chatOpen = !f.chatOpen;
        PR.repaintAiReviewTab();
        if (f.chatOpen) {
          var ta = PR.hostEl.querySelector('.pr-ai-finding[data-finding-id="' + f.id + '"] .pr-ai-finding-chat-input');
          if (ta) ta.focus();
        }
      });

      var chatSendBtn = card.querySelector('.pr-ai-finding-chat-send');
      var chatCancelBtn = card.querySelector('.pr-ai-finding-chat-cancel');
      var chatInputEl = card.querySelector('.pr-ai-finding-chat-input');
      if (chatSendBtn && chatInputEl) chatSendBtn.addEventListener('click', function () {
        var val = chatInputEl.value.trim();
        if (!val) return;
        PR.startChat(f, val);
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
      if (investigateBtnEl) investigateBtnEl.addEventListener('click', function () { PR.startInvestigate(f); });
      var investigateCancelEl = card.querySelector('.pr-ai-finding-investigate-cancel');
      if (investigateCancelEl) investigateCancelEl.addEventListener('click', function () {
        if (f.investigateId) window.klaus.pr.reviewInvestigateCancel(f.investigateId);
      });
      var investigateClearEl = card.querySelector('.pr-ai-finding-investigate-clear');
      if (investigateClearEl) investigateClearEl.addEventListener('click', function () {
        f.investigateResult = '';
        f.investigateError = null;
        PR.repaintAiReviewTab();
        PR.saveAiReviewCache();
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
        PR.approveImplementDraft(f);
      });
      if (draftDismissEl) draftDismissEl.addEventListener('click', function () {
        f.implementDraftStatus = 'dismissed';
        PR.repaintAiReviewTab();
        PR.saveAiReviewCache();
      });
      if (draftUnapproveEl) draftUnapproveEl.addEventListener('click', function () {
        PR.removeImplementDraft(f);
      });

      // ✎ now edits the review block itself (f.text), not a separate comment
      // composer. The body area swaps to a textarea on the next repaint.
      var editReviewBtn = card.querySelector('.pr-ai-finding-edit-comment');
      if (editReviewBtn) editReviewBtn.addEventListener('click', function () {
        f.textEditing = true;
        PR.repaintAiReviewTab();
        var ta = PR.hostEl.querySelector('.pr-ai-finding[data-finding-id="' + f.id + '"] .pr-ai-finding-body-input');
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
        f.severity = PR.severityOf(f.text);
        var loc = PR.parseLocation(f.text);
        if (loc) {
          f.path = loc.path;
          f.line = loc.line;
          f.locationRaw = loc;
        }
        f.locationVerified = false;
        f.postMode = (f.path && f.line) ? 'inline' : 'issue';
        PR.repaintAiReviewTab();
        PR.saveAiReviewCache();
        PR.verifyFindingLocations();
      });
      if (bodyCancel) bodyCancel.addEventListener('click', function () {
        f.textEditing = false;
        PR.repaintAiReviewTab();
      });
      if (bodyReset) bodyReset.addEventListener('click', function () {
        if (f.originalText != null) {
          f.text = f.originalText;
          f.severity = PR.severityOf(f.text);
          var loc = PR.parseLocation(f.text);
          f.path = loc ? loc.path : null;
          f.line = loc ? loc.line : null;
          f.locationRaw = loc;
          f.locationVerified = false;
          f.postMode = loc ? 'inline' : 'issue';
        }
        f.textEditing = false;
        PR.repaintAiReviewTab();
        PR.saveAiReviewCache();
        PR.verifyFindingLocations();
      });
    });
  };

  PR.repaintAiReviewTab = function() {
    PR.repaintTerminalTabBadge();
    if (PR.activeTab !== 'ai-review') return;
    var tab = PR.hostEl.querySelector('.pr-review-ai-tab');
    if (!tab) return;
    tab.innerHTML = PR.renderAiReviewTab();
    PR.bindAiReviewTab();
    // Update tab count badge as findings change.
    var tabBtn = PR.hostEl.querySelector('.pr-review-tab[data-tab="ai-review"]');
    if (tabBtn) tabBtn.innerHTML = 'AI Review' + PR.renderAiReviewTabCount();
  };

  // Repaint just the Terminal tab body — used while the implement run's
  // status transitions (running → done/error/cancelled). Cheap because
  // the xterm element is moved back into the new chrome rather than
  // re-instantiated.
  PR.repaintTerminalTab = function() {
    PR.repaintTerminalTabBadge();
    if (PR.activeTab !== 'terminal') return;
    var tab = PR.hostEl.querySelector('.pr-review-terminal-tab');
    if (!tab) return;
    tab.innerHTML = PR.renderTerminalTab();
    PR.mountImplementTerminalIfActive();
  };

  PR.repaintTerminalTabBadge = function() {
    if (!PR.hostEl) return;
    var tabBtn = PR.hostEl.querySelector('.pr-review-tab[data-tab="terminal"]');
    if (tabBtn) tabBtn.innerHTML = 'Terminal View' + PR.renderTerminalTabBadge();
  };

  // Called by implement-run lifecycle callbacks. Keeps Review tab cards
  // in sync (status, draft, usage) AND the Terminal tab chrome.
  PR.repaintForImplRun = function() {
    PR.repaintAiReviewTab();
    PR.repaintTerminalTab();
  };

  // Lazy-create the persistent Terminal-tab xterm. Returns the existing
  // instance on subsequent calls so multiple implement runs share the
  // same scrollback. onData/onResize proxy to the *current* implRun,
  // looked up at send time — so the reused terminal works across runs.
  PR.ensureReviewTerminal = function() {
    if (PR.reviewTerminal) return PR.reviewTerminal;
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
      minimumContrastRatio: 4.5, // never let low-contrast (e.g. white-on-white) text vanish
      allowProposedApi: true,
    });
    var fitAddon = new window.FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    // Always-current proxy: typed input goes to whichever session owns the
    // terminal right now. A live implement run takes priority; otherwise the
    // persistent chat session gets the keystrokes. Both share this one xterm.
    terminal.onData(function (data) {
      if (PR.implRun && PR.implRunIsLive()) {
        window.klaus.pr.reviewImplementInput(PR.implRun.requestId, data);
      } else if (PR.chatRun && PR.chatRun.chatKey && PR.chatRun.status === 'running') {
        window.klaus.pr.reviewTchatInput(PR.chatRun.chatKey, data);
      }
    });
    terminal.onResize(function (size) {
      // Keep both PTYs sized to the shared xterm so neither wraps oddly when it
      // next takes focus.
      if (PR.implRun && PR.implRunIsLive()) {
        window.klaus.pr.reviewImplementResize(PR.implRun.requestId, size.cols, size.rows);
      }
      if (PR.chatRun && PR.chatRun.chatKey) {
        window.klaus.pr.reviewTchatResize(PR.chatRun.chatKey, size.cols, size.rows);
      }
    });
    PR.reviewTerminal = { terminal: terminal, fitAddon: fitAddon, hasContent: false };
    PR.reviewTerminalDark = PR.termBgIsDark(theme && theme.background);
    return PR.reviewTerminal;
  };

  // Relative-luminance check on the terminal background, so we know whether a
  // theme change flipped light<->dark.
  PR.termBgIsDark = function(bg) {
    var m = /^#?([0-9a-fA-F]{6})$/.exec((bg || '').trim().replace(/^#/, ''));
    if (!m) return true;
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
  };

  // Re-apply the terminal theme when the app theme changes so the PR terminal
  // matches. The agent CLI detects light/dark from the terminal background at
  // startup, so when light<->dark actually flips we restart the chat to let it
  // re-render in the new theme (a same-darkness swap just retints the xterm).
  PR.onAppThemeChanged = function() {
    if (!PR.reviewTerminal || !(window.ThemeManager && ThemeManager.getTerminalTheme)) return;
    var theme = ThemeManager.getTerminalTheme();
    var nowDark = PR.termBgIsDark(theme && theme.background);
    var flipped = PR.reviewTerminalDark != null && PR.reviewTerminalDark !== nowDark;
    PR.reviewTerminalDark = nowDark;
    try {
      PR.reviewTerminal.terminal.options.theme = theme;
      PR.reviewTerminal.terminal.refresh(0, PR.reviewTerminal.terminal.rows - 1);
    } catch (_) {}
    if (flipped && PR.activeTab === 'terminal' && PR.ensureChatSession) {
      PR.ensureChatSession(true); // restart so the CLI re-detects the new background
    }
  };

  PR.disposeReviewTerminal = function() {
    if (!PR.reviewTerminal) return;
    try { PR.reviewTerminal.terminal.dispose(); } catch (_) {}
    PR.reviewTerminal = null;
  };

  // Drop this surface's subscription to the chat session. Does NOT kill the
  // PTY — the session keeps running in the background so a pop-out / navigate-
  // back can re-attach to it (same model as implement runs).
  PR.teardownChatRun = function() {
    if (!PR.chatRun) return;
    try { if (PR.chatRun.unsubData) PR.chatRun.unsubData(); } catch (_) {}
    try { if (PR.chatRun.unsubExit) PR.chatRun.unsubExit(); } catch (_) {}
    if (PR.chatRun.chatKey) { try { window.klaus.pr.reviewTchatDetach(PR.chatRun.chatKey); } catch (_) {} }
    PR.chatRun = null;
  };

  // Subscribe the shared xterm to a chat session's streams, then replay its
  // buffered scrollback. Replaying via attach covers both the spawn gap (bytes
  // emitted before this listener attached) and full re-attach on pop-out; the
  // agent's TUI redraws full frames, so any overlap just repaints.
  PR.subscribeChat = function(rt, chatKey) {
    if (PR.chatRun.unsubData) { try { PR.chatRun.unsubData(); } catch (_) {} }
    if (PR.chatRun.unsubExit) { try { PR.chatRun.unsubExit(); } catch (_) {} }
    PR.chatRun.unsubData = window.klaus.pr.onReviewTchatData(chatKey, function (chunk) {
      if (!PR.chatRun || PR.chatRun.chatKey !== chatKey) return;
      // Only one PTY paints the shared xterm at a time. While an implement run
      // owns the terminal, drop chat bytes here so the two TUIs don't interleave
      // and corrupt the display. The bytes stay in main's chat buffer; the chat
      // TUI redraws a full frame on the user's next keystroke (and on the resize
      // nudge fired when the implement run finishes), so nothing is lost.
      if (PR.implRun && PR.implRunIsLive()) return;
      try { rt.terminal.write(chunk); rt.hasContent = true; } catch (_) {}
    });
    PR.chatRun.unsubExit = window.klaus.pr.onReviewTchatExit(chatKey, function () {
      if (!PR.chatRun || PR.chatRun.chatKey !== chatKey) return;
      PR.chatRun.status = 'exited';
      try { rt.terminal.write('\r\n\x1b[2m── chat session ended (Restart chat to resume) ──\x1b[0m\r\n'); } catch (_) {}
      PR.repaintTerminalTab();
    });
    window.klaus.pr.reviewTchatAttach(chatKey).then(function (a) {
      if (!a || !a.found || !PR.chatRun || PR.chatRun.chatKey !== chatKey) return;
      if (a.buffer) { try { rt.terminal.write(a.buffer); rt.hasContent = true; } catch (_) {} }
      if (PR.activeTab === 'terminal') {
        PR.mountImplementTerminalIfActive();
        try { rt.fitAddon.fit(); } catch (_) {}
      }
    }).catch(function () {});
  };

  // Ensure the persistent chat session exists for the active PR. Starting it
  // provisions the PR's worktree if needed (same on-demand checkout as
  // implement), then seeds the agent with the PR context. Idempotent: a
  // running/starting session is left alone; a re-mount with a backgrounded
  // session re-attaches via the `already` flag. `force` restarts after an
  // exit/error (the Restart chat button).
  PR.ensureChatSession = function(force) {
    if (!PR.lastState) return;
    if (!window.klaus.pr.reviewTchatStart) return; // stale preload
    if (PR.chatRun && PR.chatRun.starting) return;
    if (PR.chatRun && PR.chatRun.status === 'running' && !force) return;
    if (PR.chatRun && (PR.chatRun.status === 'error') && !force) return; // don't auto-retry a failed start
    var rt = PR.ensureReviewTerminal();
    if (PR.chatRun) PR.teardownChatRun();
    PR.chatRun = { chatKey: null, worktreePath: null, status: 'starting', starting: true, unsubData: null, unsubExit: null };
    PR.repaintTerminalTab();
    var agent = window.AgentSplit && AgentSplit.getAgent();
    window.klaus.pr.reviewTchatStart(agent).then(function (r) {
      if (!PR.chatRun) return; // torn down (PR switched) while starting
      PR.chatRun.starting = false;
      if (!r || r.error || r.cancelled) {
        PR.chatRun.status = 'error';
        var msg = (r && r.error) ? r.error : (r && r.cancelled) ? 'Agent access was declined.' : 'Could not start the chat session.';
        try { rt.terminal.write('\r\n\x1b[31m' + msg + '\x1b[0m\r\n'); rt.hasContent = true; } catch (_) {}
        PR.repaintTerminalTab();
        return;
      }
      PR.chatRun.chatKey = r.chatKey;
      PR.chatRun.worktreePath = r.worktreePath;
      PR.chatRun.status = 'running';
      PR.subscribeChat(rt, r.chatKey);
      PR.repaintTerminalTab();
    }).catch(function (err) {
      if (!PR.chatRun) return;
      PR.chatRun.starting = false;
      PR.chatRun.status = 'error';
      try { rt.terminal.write('\r\n\x1b[31m' + ((err && err.message) || 'Chat failed to start') + '\x1b[0m\r\n'); } catch (_) {}
      PR.repaintTerminalTab();
    });
  };

  // ANSI-bold cyan banner between runs so the scrollback is scannable.
  PR.writeRunSeparator = function(label) {
    if (!PR.reviewTerminal) return;
    var prefix = PR.reviewTerminal.hasContent ? '\r\n' : '';
    var line = prefix + '\x1b[1;36m── ' + label + ' ──\x1b[0m\r\n';
    try { PR.reviewTerminal.terminal.write(line); } catch (_) {}
    PR.reviewTerminal.hasContent = true;
  };

  // Mount the shared xterm into the Terminal-tab host and make sure the
  // persistent chat session is running. Creates the xterm on first call (so the
  // tab is a live terminal even before any implement run), re-parents it on
  // subsequent repaints, and (re-)binds the chrome buttons.
  PR.mountImplementTerminalIfActive = function() {
    var host = PR.hostEl && PR.hostEl.querySelector('#pr-implement-terminal-host .pr-implement-terminal-body');
    // No host means the Terminal tab isn't on screen — don't provision a
    // worktree / start the agent just because some background repaint ran.
    if (!host) return;
    // Tab is visible: make sure the persistent chat session is running. This is
    // what makes the terminal "always open with the default agent". Idempotent
    // after the first start.
    PR.ensureChatSession();
    var rt = PR.ensureReviewTerminal();
    var term = rt.terminal;
    if (term.element && term.element.parentElement === host) {
      // Already mounted here; still rebind buttons below (chrome re-rendered).
    } else if (term.element) {
      host.appendChild(term.element);
      try { rt.fitAddon.fit(); } catch (_) {}
    } else {
      // First mount — xterm.open creates the element under the host.
      term.open(host);
      try { rt.fitAddon.fit(); } catch (_) {}
    }
    // The control buttons live in the chrome row which gets re-rendered every
    // repaint, so re-bind here.
    var hostRow = PR.hostEl.querySelector('#pr-implement-terminal-host .pr-implement-terminal-head');
    if (hostRow) {
      var cancelBtn = hostRow.querySelector('.pr-implement-cancel');
      if (cancelBtn) cancelBtn.addEventListener('click', PR.cancelImplementRun);
      var restartBtn = hostRow.querySelector('.pr-tchat-restart');
      if (restartBtn) restartBtn.addEventListener('click', function () { PR.ensureChatSession(true); });
    }
  };

  // After the OS un-occludes the window (Space-switch back, app refocus), the
  // xterm can paint blank until it's nudged. Re-fit + force a full refresh so
  // a backgrounded-then-foregrounded run's output reappears immediately.
  PR.setupImplementFocusRefit = function() {
    if (PR.implFocusRefitHandler) return;
    var refit = function () {
      if (!PR.reviewTerminal || PR.activeTab !== 'terminal') return;
      try {
        PR.reviewTerminal.fitAddon.fit();
        PR.reviewTerminal.terminal.refresh(0, PR.reviewTerminal.terminal.rows - 1);
      } catch (_) {}
    };
    PR.implFocusRefitHandler = refit;
    PR.implVisibilityRefitHandler = function () { if (!document.hidden) refit(); };
    window.addEventListener('focus', PR.implFocusRefitHandler);
    document.addEventListener('visibilitychange', PR.implVisibilityRefitHandler);
  };

  PR.teardownImplementFocusRefit = function() {
    if (PR.implFocusRefitHandler) {
      window.removeEventListener('focus', PR.implFocusRefitHandler);
      PR.implFocusRefitHandler = null;
    }
    if (PR.implVisibilityRefitHandler) {
      document.removeEventListener('visibilitychange', PR.implVisibilityRefitHandler);
      PR.implVisibilityRefitHandler = null;
    }
  };

  // Ask the main process whether a backgrounded implement run exists for the
  // PR now on screen; if so, re-attach to it. Covers pop-out (fresh window),
  // navigate-away-and-back, and any teardown that dropped the local run while
  // the PTY kept going. Runs at most once per PR per mount.
  PR.maybeReattachImplement = function(prNumber) {
    if (PR.implRun) return;
    if (PR.implReattachCheckedPr === prNumber) return;
    PR.implReattachCheckedPr = prNumber;
    window.klaus.pr.reviewImplementActive().then(function (res) {
      var active = res && res.active;
      if (!active || !active.requestId) return;
      if (PR.implRun) return; // a fresh run started while we were asking
      // Surface it: jump to the Terminal tab so a fresh surface (pop-out,
      // reopened PR) actually shows the implementation instead of looking like
      // it was never requested.
      if (PR.activeTab !== 'terminal') PR.activeTab = 'terminal';
      PR.attachToExistingRun(active.requestId, active.status);
      if (PR.lastState) PR.render(PR.lastState);
    }).catch(function () {});
  };

  // Re-bind a surface to an already-running (or just-finished) PTY: subscribe
  // to its live streams, replay its buffered output into the xterm, and adopt
  // its status. Used by maybeReattachImplement — not the start path.
  PR.attachToExistingRun = function(requestId, snapStatus) {
    if (PR.implRun && PR.implRun.requestId === requestId) return;
    if (PR.implRun) { PR.cleanupImplementRun(); PR.implRun = null; }
    var rt = PR.ensureReviewTerminal();
    PR.implRun = {
      requestId: requestId,
      mode: requestId.indexOf('impla-') === 0 ? 'all' : 'one',
      status: snapStatus === 'running' ? 'running' : snapStatus,
      finalized: snapStatus !== 'running',
      repaint: PR.repaintForImplRun,
      onAssistantText: null, onUsage: null, onTool: null,
      onDone: function () { PR.refreshLocalChanges(); },
      onError: null, onCancelled: null,
      unsubData: null, unsubEvent: null, unsubDone: null,
      reattached: true,
    };
    PR.implRun.unsubData = window.klaus.pr.onReviewImplementData(requestId, function (chunk) {
      if (!PR.implRun || PR.implRun.requestId !== requestId) return;
      try { rt.terminal.write(chunk); rt.hasContent = true; } catch (_) {}
    });
    PR.implRun.unsubEvent = window.klaus.pr.onReviewImplementEvent(requestId, function (ev) {
      if (!PR.implRun || PR.implRun.requestId !== requestId) return;
      if (ev.kind === 'tool' || ev.kind === 'text' || ev.kind === 'usage') {
        if (PR.implRun.repaint) PR.implRun.repaint();
      } else if (ev.kind === 'end_turn') {
        PR.finalizeImplementRun('done');
      }
    });
    PR.implRun.unsubDone = window.klaus.pr.onReviewImplementDone(requestId, function (data) {
      if (!PR.implRun || PR.implRun.requestId !== requestId) return;
      if (PR.implRun.finalized) { PR.cleanupImplementRun(); return; }
      var signal = data && data.signal;
      if (PR.implRun.status === 'cancelled' || signal === 'SIGTERM' || signal === 'SIGKILL') {
        PR.finalizeImplementRun('cancelled');
      } else {
        PR.finalizeImplementRun((data && data.status) || 'done');
      }
    });
    // Pull the buffered output + authoritative status and repaint.
    window.klaus.pr.reviewImplementAttach(requestId).then(function (r) {
      if (!r || !r.found || !PR.implRun || PR.implRun.requestId !== requestId) return;
      if (r.buffer) { try { rt.terminal.write(r.buffer); rt.hasContent = true; } catch (_) {} }
      if (r.status && r.status !== 'running') { PR.implRun.status = r.status; PR.implRun.finalized = true; }
      if (PR.activeTab === 'terminal') {
        PR.mountImplementTerminalIfActive();
        try { rt.fitAddon.fit(); } catch (_) {}
      }
      if (PR.implRun.repaint) PR.implRun.repaint();
    }).catch(function () {});
  };

  // Switch the PR review to the Terminal tab and re-render so the xterm
  // chrome is on screen before the implement IPC starts streaming.
  PR.switchToTerminalTab = function() {
    if (PR.activeTab === 'terminal') return;
    PR.activeTab = 'terminal';
    if (PR.lastState) PR.render(PR.lastState);
  };

  PR.startAiReview = function(provider) {
    if (PR.aiReview.requestId) return;
    provider = provider || (window.AgentSplit && AgentSplit.getAgent('review'));
    var requestId = 'air-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    PR.aiReview.requestId = requestId;
    PR.aiReview.finalText = '';
    PR.aiReview.summary = null;
    PR.aiReview.progress = [{ kind: 'system', label: 'Preparing worktree\u2026' }];
    PR.aiReview.error = null;
    PR.aiReview.cancelled = false;
    PR.aiReview.findings = [];
    PR.aiReview.usage = null;
    PR.repaintAiReviewTab();

    var buffered = '';
    var unsubData = window.klaus.pr.onReviewAiData(requestId, function (chunk) {
      // Agent kept running after the user navigated to a different PR. Drop
      // chunks that aren't for the AI review currently being tracked here.
      if (PR.aiReview.requestId !== requestId) return;
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
    window.klaus.pr.onReviewAiDone(requestId, function (result) {
      if (unsubData) unsubData();
      if (PR.aiReview.requestId !== requestId) return;
      PR.aiReview.requestId = null;
      if (result && result.error) PR.aiReview.error = result.error;
      if (result && result.cancelled) PR.aiReview.cancelled = true;
      PR.applyReviewParse();
      PR.repaintAiReviewTab();
      // Persist as soon as we have any content (even partial / cancelled —
      // user may still want to revisit the partial findings).
      if (PR.aiReview.finalText) PR.saveAiReviewCache();
    });

    window.klaus.pr.reviewAiStart(requestId, provider).then(function (r) {
      if (r && r.error) {
        if (unsubData) unsubData();
        PR.aiReview.requestId = null;
        PR.aiReview.error = r.error;
        PR.repaintAiReviewTab();
      } else if (r && r.worktreePath) {
        PR.aiReview.worktreePath = r.worktreePath;
      }
    });
  };

})(window.PrReview);
