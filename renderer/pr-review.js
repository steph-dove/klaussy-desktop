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
  var activeTab = 'files'; // 'files' | 'conversation'
  var selectionFab = null;
  var onSelectionChange = null;
  // G4: draft review comments accumulated client-side until the user submits
  // a review. Structure: { id, path, line, side, startLine?, startSide?, body }
  var pendingComments = [];
  // G6: latest checks result for the active PR. null = not yet fetched.
  var currentChecks = null;
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

  function mount(options) {
    hostEl = options.host;
    isPopout = !!options.isPopout;
    hostEl.classList.add('pr-review-host');
    renderLoading();
    initSelectionExplain();

    unsubState = window.klaus.onPrReviewState(function (state) {
      if (!state) {
        // In the pop-out, no state = the review was closed elsewhere, so the
        // window has nothing left to show. In the main window, app.js owns
        // mount/unmount and will call unmount() on us — do nothing here.
        if (isPopout) window.close();
        return;
      }
      render(state);
    });

    window.klaus.prReviewState().then(function (state) {
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
      // Tear down any in-flight AI work for the previous PR so we don't bleed
      // findings/state across PRs.
      if (aiReview.requestId) window.klaus.prReviewAiCancel(aiReview.requestId);
      if (aiReview.implementAllId) window.klaus.prReviewImplementCancel(aiReview.implementAllId);
      aiReview.findings.forEach(function (f) {
        if (f.implementId) window.klaus.prReviewImplementCancel(f.implementId);
      });
      aiReview = {
        requestId: null, finalText: '', progress: [], error: null, cancelled: false,
        worktreePath: null, findings: [],
        implementAllId: null, implementAllProgress: [], implementAllError: null, implementAllSummary: null,
        implementAllUsage: null, usage: null,
      };
      // Fire-and-forget. Pass the PR number explicitly — lastState isn't
      // assigned until below, and the async handler would otherwise compare
      // against a null on first load and drop its own result.
      fetchAndRenderChecks(state.number);
      // Restore cached AI review (text + per-finding ignore/implement state)
      // for this PR if we have one. Async; the tab repaints when it lands.
      if (state.baseOwner && state.baseRepo) {
        loadAiReviewCache(state.baseOwner, state.baseRepo, state.number);
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
          + '<button class="pr-review-btn js-ai-review" title="Run an AI code review against this PR">Review with Claude</button>'
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
      + '</div>'
      + '<div class="pr-review-body' + (activeTab !== 'files' ? ' one-col' : '') + '">'
        + (activeTab === 'files'
            ? '<div class="pr-review-file-list">' + renderFileList(files, threadsByPath) + '</div>'
              + '<div class="pr-review-diff">' + renderSelectedFileDiff(files) + '</div>'
            : activeTab === 'conversation'
              ? '<div class="pr-review-conversation">' + renderConversation(state) + '</div>'
              : activeTab === 'checks'
                ? '<div class="pr-review-checks-tab">' + renderChecksTab() + '</div>'
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
    } else if (activeTab === 'conversation') {
      bindConversationComposer();
      bindReplyButtons();
    } else if (activeTab === 'checks') {
      bindChecksTab();
    } else if (activeTab === 'ai-review') {
      bindAiReviewTab();
    }
    renderThreadsStatusBadge(state);
    renderPendingReviewBar(state);
  }

  function bindConversationComposer() {
    var composer = hostEl.querySelector('.pr-conv-new-comment');
    if (!composer) return;
    var ta = composer.querySelector('.pr-conv-new-body');
    var btn = composer.querySelector('.pr-conv-new-post');

    async function post() {
      var body = ta.value.trim();
      if (!body) return;
      btn.disabled = true;
      btn.textContent = 'Posting\u2026';
      var result = await window.klaus.prAddIssueComment(body);
      if (result.error) {
        btn.disabled = false;
        btn.textContent = 'Comment';
        alert('Post failed: ' + result.error);
        return;
      }
      ta.value = '';
      await window.klaus.prRefreshThreads();
      // render is re-triggered by the pr-review-state broadcast.
    }

    btn.addEventListener('click', post);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); }
    });
  }

  function bindReplyButtons() {
    hostEl.querySelectorAll('.pr-conv-reply-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openReplyComposer(btn);
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
      var result = await window.klaus.prReplyToReviewComment(parentId, body);
      if (result.error) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Reply';
        alert('Reply failed: ' + result.error);
        return;
      }
      composer.remove();
      await window.klaus.prRefreshThreads();
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
        alert('Select one or more diff lines (add / delete / context) to comment on.');
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
    'Sending to Claude\u2026',
    'Reading the change\u2026',
    'Considering intent\u2026',
    'Looking at surrounding context\u2026',
    'Drafting explanation\u2026',
  ];

  function explainSelection(text) {
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
      if (prevId) window.klaus.explainDiffStreamCancel(prevId);
      existing.remove();
    }

    var requestId = 'exp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    var explanationEl = document.createElement('div');
    explanationEl.className = 'diff-explanation';
    explanationEl.dataset.requestId = requestId;
    explanationEl.innerHTML = '<div class="diff-explanation-header">'
        + '<span>Explanation</span>'
        + '<button class="diff-explanation-close" title="Cancel / close">&times;</button>'
      + '</div>'
      + '<div class="diff-explanation-body status-pulse">' + escHtml(EXPLAIN_STATUS_MESSAGES[0]) + '</div>';
    insertAfter.after(explanationEl);

    var bodyEl = explanationEl.querySelector('.diff-explanation-body');
    var accumulated = '';

    // Cycle through status labels until the first chunk arrives (or the user
    // cancels). Stops itself as soon as `accumulated` is non-empty.
    var statusIdx = 0;
    var statusTimer = setInterval(function () {
      if (!bodyEl.isConnected) { clearInterval(statusTimer); return; }
      if (accumulated) { clearInterval(statusTimer); return; }
      statusIdx = (statusIdx + 1) % EXPLAIN_STATUS_MESSAGES.length;
      bodyEl.textContent = EXPLAIN_STATUS_MESSAGES[statusIdx];
    }, 1800);

    var unsubChunk = window.klaus.onExplainDiffChunk(requestId, function (chunk) {
      if (!accumulated) {
        bodyEl.classList.remove('status-pulse');
        bodyEl.textContent = '';
      }
      accumulated += chunk;
      bodyEl.textContent = accumulated;
      // Keep the body scrolled to the end so long explanations stay visible.
      bodyEl.scrollTop = bodyEl.scrollHeight;
    });

    var unsubDone = window.klaus.onExplainDiffDone(requestId, function (result) {
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
    });

    explanationEl.querySelector('.diff-explanation-close').addEventListener('click', function () {
      clearInterval(statusTimer);
      window.klaus.explainDiffStreamCancel(requestId);
      if (unsubChunk) unsubChunk();
      if (unsubDone) unsubDone();
      explanationEl.remove();
    });

    if (sel) sel.removeAllRanges();
    window.klaus.explainDiffStreamStart(requestId, null, selectedFile || 'unknown', text);
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
      if (url) window.klaus.openExternal(url);
    });
    var popOut = hostEl.querySelector('.js-pop-out');
    if (popOut) popOut.addEventListener('click', function () { window.klaus.popOutPrReview(); });
    var popIn = hostEl.querySelector('.js-pop-in');
    if (popIn) popIn.addEventListener('click', function () { window.klaus.popInPrReview(); });
    var closeBtn = hostEl.querySelector('.js-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { window.klaus.prReviewClose(); });
    var checkoutBtn = hostEl.querySelector('.js-checkout-local');
    if (checkoutBtn) checkoutBtn.addEventListener('click', async function () {
      checkoutBtn.disabled = true;
      var prev = checkoutBtn.textContent;
      checkoutBtn.textContent = 'Fetching\u2026';
      var result = await window.klaus.prCheckoutLocally();
      if (result && result.error) {
        alert('Check out failed:\n' + result.error);
        checkoutBtn.disabled = false;
        checkoutBtn.textContent = prev;
      }
      // Success path: main clears state and broadcasts pr-checkout-ready;
      // the main-window listener in app.js takes over from here.
    });
    var aiBtn = hostEl.querySelector('.js-ai-review');
    if (aiBtn) aiBtn.addEventListener('click', function () {
      // Always swing the user over to the Review tab; start a run if there
      // isn't one in flight or completed already.
      activeTab = 'ai-review';
      if (!aiReview.requestId && !aiReview.finalText) {
        startAiReview();
      } else if (lastState) {
        render(lastState);
      }
    });
  }

  // ---- G7: AI review cache ----

  async function loadAiReviewCache(owner, repo, number) {
    var result = await window.klaus.prReviewCacheGetByPr(owner, repo, number);
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
        if (saved.usage) f.usage = saved.usage;
      });
    }
    if (cached.implementAllSummary) aiReview.implementAllSummary = cached.implementAllSummary;
    if (cached.implementAllUsage) aiReview.implementAllUsage = cached.implementAllUsage;
    if (cached.usage) aiReview.usage = cached.usage;
    repaintAiReviewTab();
    // Tab badge was set to 0 in the new-PR reset; rerender meta to update it.
    var tabBtn = hostEl.querySelector('.pr-review-tab[data-tab="ai-review"]');
    if (tabBtn) tabBtn.innerHTML = 'Review' + renderAiReviewTabCount();
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
        usage: f.usage || null,
      };
    });
    window.klaus.prReviewCacheSaveByPr(
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

  // F6's review template emits findings prefixed with `**[Severity: ...]**`;
  // split the streaming text into preamble + findings + postamble. If the
  // parser doesn't match (memory says it can be unreliable) we fall back to
  // a single card containing the whole review.
  function parseReviewFindings(text) {
    if (!text) return { preamble: '', findings: [], postamble: '' };
    var parts = text.split(/(?=^\s*\*\*\[Severity:)/m);
    if (parts.length === 1) return { preamble: text.trim(), findings: [], postamble: '' };
    var preamble = parts[0].trim();
    var findings = [];
    var postamble = '';
    for (var i = 1; i < parts.length; i++) {
      var block = parts[i];
      var m = block.match(/(^|\n)\s*\*\*Overall verdict:/i);
      if (m) {
        findings.push(block.slice(0, m.index).trim());
        postamble = block.slice(m.index).trim();
      } else {
        findings.push(block.trim());
      }
    }
    // Drop empty entries (e.g. a Severity marker followed immediately by the
    // verdict block, or a stray blank section between findings) — they'd
    // otherwise render as empty cards with action buttons but no body.
    findings = findings.filter(function (f) {
      // A "real" finding has more than just a Severity marker — require at
      // least one non-marker line of content.
      if (!f) return false;
      var lines = f.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      if (lines.length === 0) return false;
      // If the only line is the bracketed marker itself, treat as empty.
      var meaningful = lines.filter(function (l) { return !/^\*?\*?\[[^\]]+\]\*?\*?$/.test(l); });
      return meaningful.length > 0;
    });
    return { preamble: preamble, findings: findings, postamble: postamble };
  }

  function severityOf(text) {
    var m = (text || '').match(/\*\*\[Severity:\s*([^\]|]+)(?:\|[^\]]*)?\]\*\*/);
    return m ? m[1].trim().toLowerCase() : '';
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
      var prev = byKey[key];
      if (prev) {
        prev.text = text;
        prev.severity = severityOf(text);
        return prev;
      }
      return {
        id: 'f-' + Date.now() + '-' + idx + '-' + Math.random().toString(36).slice(2, 6),
        key: key,
        text: text,
        severity: severityOf(text),
        status: 'open',
        implementId: null,
        implementOut: '',
        implementError: null,
        commentStatus: 'idle', // 'idle' | 'posting' | 'posted' | 'failed'
        commentError: null,
      };
    });
    aiReview.findings = next;
  }

  function findingKey(text, idx) {
    // First non-empty line tends to be unique (it's the title); fall back to
    // the index so keys are still stable for unparseable findings.
    var firstLine = (text || '').split('\n').find(function (l) { return l.trim(); }) || '';
    return idx + '|' + firstLine.slice(0, 80);
  }

  function renderAiReviewTabCount() {
    var openFindings = aiReview.findings.filter(function (f) { return !f.ignored && f.status !== 'implemented'; }).length;
    if (!openFindings && !aiReview.requestId && !aiReview.finalText) return '';
    if (!openFindings) return '';
    return ' <span class="pr-tab-count">' + openFindings + '</span>';
  }

  function renderAiReviewTab() {
    if (!aiReview.requestId && !aiReview.finalText && !aiReview.error && !aiReview.cancelled) {
      return '<div class="pr-ai-empty">'
        + '<button class="pr-review-btn pr-ai-run" type="button">Run review</button>'
        + '<div class="pr-ai-empty-hint">Spawns Claude in a worktree to review the PR end to end. ~1\u20133 min for an average PR.</div>'
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
      + (usageStr ? '<span class="pr-ai-usage" title="Reported by claude for this review run; charged to your Anthropic account">' + escHtml(usageStr) + '</span>' : '')
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
        + '<pre class="pr-ai-fallback-body">' + escHtml(aiReview.finalText || '') + '</pre>'
      + '</div>';
    } else {
      body = '<div class="pr-ai-findings">'
        + aiReview.findings.map(renderFindingCard).join('')
      + '</div>';
    }

    return '<div class="pr-ai-tab pr-ai-' + status + '">'
      + head + progress + implementAllSummary + implementAllError + body
    + '</div>';
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
    if (f.commentStatus === 'posted') {
      commentBadge = '<span class="pr-ai-finding-comment-status posted" title="Posted to the PR">\u2713 Commented</span>';
    } else if (f.commentStatus === 'posting') {
      commentBadge = '<span class="pr-ai-finding-comment-status posting">Posting\u2026</span>';
    } else if (f.commentStatus === 'failed') {
      commentBadge = '<span class="pr-ai-finding-comment-status failed" title="' + escHtml(f.commentError || '') + '">! Comment failed</span>';
      commentBtn = '<button class="pr-ai-finding-comment" type="button" title="Try again">Add to PR</button>';
    } else {
      commentBtn = '<button class="pr-ai-finding-comment" type="button" title="Post this finding as an issue comment on the PR">Add to PR</button>';
    }

    var actions;
    if (f.ignored) {
      actions = commentBadge + '<button class="pr-ai-finding-undo" type="button">Restore</button>';
    } else if (f.status === 'implementing') {
      actions = commentBadge + '<button class="pr-ai-finding-cancel" type="button">Cancel</button>';
    } else if (f.status === 'implemented') {
      actions = '<span class="pr-ai-finding-status">\u2713 Implemented</span>'
        + commentBadge
        + commentBtn
        + '<button class="pr-ai-finding-redo" type="button" title="Run implement again">Implement again</button>';
    } else {
      actions = commentBadge
        + '<button class="pr-ai-finding-ignore" type="button">Ignore</button>'
        + commentBtn
        + '<button class="pr-ai-finding-implement" type="button">Implement</button>';
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

    return '<div class="pr-ai-finding' + sevCls + statusCls + '" data-finding-id="' + f.id + '">'
      + '<div class="pr-ai-finding-body">' + renderMarkdown(f.text) + '</div>'
      + '<div class="pr-ai-finding-actions">' + actions + '</div>'
      + implementOut
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
    var runBtn = hostEl.querySelector('.pr-ai-run');
    if (runBtn) runBtn.addEventListener('click', function () { startAiReview(); });

    var rerunBtn = hostEl.querySelector('.pr-ai-rerun');
    if (rerunBtn) rerunBtn.addEventListener('click', function () {
      if (aiReview.implementAllId) window.klaus.prReviewImplementCancel(aiReview.implementAllId);
      aiReview.findings.forEach(function (f) {
        if (f.implementId) window.klaus.prReviewImplementCancel(f.implementId);
      });
      // Clear the disk cache so Rerun gives a clean slate.
      if (lastState && lastState.baseOwner && lastState.baseRepo) {
        window.klaus.prReviewCacheClearByPr(lastState.baseOwner, lastState.baseRepo, lastState.number);
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
      if (aiReview.requestId) window.klaus.prReviewAiCancel(aiReview.requestId);
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
        if (f.implementId) window.klaus.prReviewImplementCancel(f.implementId);
      });
      if (commentBtn) commentBtn.addEventListener('click', function () { postFindingAsComment(f); });
    });
  }

  function repaintAiReviewTab() {
    if (activeTab !== 'ai-review') return;
    var tab = hostEl.querySelector('.pr-review-ai-tab');
    if (!tab) return;
    tab.innerHTML = renderAiReviewTab();
    bindAiReviewTab();
    // Update tab count badge as findings change.
    var tabBtn = hostEl.querySelector('.pr-review-tab[data-tab="ai-review"]');
    if (tabBtn) tabBtn.innerHTML = 'Review' + renderAiReviewTabCount();
  }

  function startAiReview() {
    if (aiReview.requestId) return;
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
    var unsubData = window.klaus.onPrReviewAiData(requestId, function (chunk) {
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
    window.klaus.onPrReviewAiDone(requestId, function (result) {
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

    window.klaus.prReviewAiStart(requestId).then(function (r) {
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

  function startImplement(f) {
    if (f.implementId) return;
    var requestId = 'impl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    f.implementId = requestId;
    f.status = 'implementing';
    f.implementOut = '';
    f.implementError = null;
    repaintAiReviewTab();

    var buffered = '';
    var unsubData = window.klaus.onPrReviewImplementData(requestId, function (chunk) {
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
              if (block.type === 'text' && block.text) f.implementOut = block.text;
            });
          } else if (ev.type === 'result') {
            if (ev.result) f.implementOut = ev.result;
            f.usage = extractUsage(ev);
          }
        } catch (_) {}
      }
      repaintAiReviewTab();
    });
    window.klaus.onPrReviewImplementDone(requestId, function (result) {
      if (unsubData) unsubData();
      if (f.implementId !== requestId) return;
      f.implementId = null;
      if (result && result.error) {
        f.status = 'failed';
        f.implementError = result.error;
      } else if (result && result.cancelled) {
        f.status = 'open';
      } else {
        f.status = 'implemented';
      }
      repaintAiReviewTab();
      saveAiReviewCache();
    });

    window.klaus.prReviewImplementStart(requestId, 'one', f.text).then(function (r) {
      if (r && r.error) {
        if (unsubData) unsubData();
        f.implementId = null;
        f.status = 'failed';
        f.implementError = r.error;
        repaintAiReviewTab();
      }
    });
  }

  // Post a single AI-review finding as a general PR issue comment. Uses the
  // existing G4 IPC. Wraps the body with a small attribution header so the
  // PR author can see it came from the reviewer's AI pass.
  async function postFindingAsComment(f) {
    if (f.commentStatus === 'posting' || f.commentStatus === 'posted') return;
    f.commentStatus = 'posting';
    f.commentError = null;
    repaintAiReviewTab();

    var body = '> *AI-generated review finding (via Klaussy):*\n\n' + (f.text || '');
    var result = await window.klaus.prAddIssueComment(body);
    if (result && result.error) {
      f.commentStatus = 'failed';
      f.commentError = result.error;
    } else {
      f.commentStatus = 'posted';
    }
    repaintAiReviewTab();
    saveAiReviewCache();
    // Pull the newly-posted comment into the Conversation tab.
    if (f.commentStatus === 'posted') window.klaus.prRefreshThreads();
  }

  function startImplementAll() {
    if (aiReview.implementAllId) return;
    var pending = aiReview.findings.filter(function (f) {
      return !f.ignored && f.status !== 'implemented' && f.status !== 'implementing';
    });
    if (pending.length === 0) return;
    var requestId = 'impla-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    aiReview.implementAllId = requestId;
    aiReview.implementAllProgress = [{ kind: 'system', label: 'Implementing ' + pending.length + ' findings\u2026' }];
    aiReview.implementAllError = null;
    aiReview.implementAllSummary = null;
    repaintAiReviewTab();

    // Mark all targeted findings as implementing — the single claude run will
    // touch all of them at once. We mark them implemented on success.
    pending.forEach(function (f) { f.status = 'implementing'; });

    var combined = pending.map(function (f, i) {
      return '### Finding ' + (i + 1) + '\n' + f.text;
    }).join('\n\n');

    var buffered = '';
    var finalText = '';
    var unsubData = window.klaus.onPrReviewImplementData(requestId, function (chunk) {
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
                if (typeof hint === 'string') hint = hint.split('/').pop().slice(0, 40);
                aiReview.implementAllProgress.push({ kind: 'tool', label: block.name + (hint ? ': ' + hint : '') });
              }
            });
          } else if (ev.type === 'result') {
            if (ev.result) finalText = ev.result;
            aiReview.implementAllUsage = extractUsage(ev);
          }
        } catch (_) {}
      }
      repaintAiReviewTab();
    });
    window.klaus.onPrReviewImplementDone(requestId, function (result) {
      if (unsubData) unsubData();
      if (aiReview.implementAllId !== requestId) return;
      aiReview.implementAllId = null;
      if (result && result.error) {
        aiReview.implementAllError = result.error;
        pending.forEach(function (f) { f.status = 'failed'; f.implementError = result.error; });
      } else if (result && result.cancelled) {
        pending.forEach(function (f) { if (f.status === 'implementing') f.status = 'open'; });
      } else {
        aiReview.implementAllSummary = finalText;
        pending.forEach(function (f) { f.status = 'implemented'; f.implementOut = finalText; });
      }
      repaintAiReviewTab();
      saveAiReviewCache();
    });

    window.klaus.prReviewImplementStart(requestId, 'all', combined).then(function (r) {
      if (r && r.error) {
        if (unsubData) unsubData();
        aiReview.implementAllId = null;
        aiReview.implementAllError = r.error;
        pending.forEach(function (f) { f.status = 'failed'; f.implementError = r.error; });
        repaintAiReviewTab();
      }
    });
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
      var result = await window.klaus.prSubmitReview({ event: event, body: body, comments: pendingComments });
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
      await window.klaus.prRefreshThreads();
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
    return '<div class="pr-conv-item pr-conv-comment">'
      + '<div class="pr-conv-head">'
        + '<span class="pr-conv-author">' + escHtml(author) + '</span>'
        + '<span class="pr-conv-kind">commented</span>'
        + '<span class="pr-conv-when">' + escHtml(when) + '</span>'
      + '</div>'
      + '<div class="pr-conv-body">' + renderCommentBody(c.body) + '</div>'
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

    var commentsHtml = comments.map(function (c, i) {
      var author = (c.author && c.author.login) || 'unknown';
      var when = c.createdAt ? new Date(c.createdAt).toLocaleString() : '';
      return '<div class="pr-conv-thread-comment' + (i === 0 ? ' first' : '') + '">'
        + '<div class="pr-conv-thread-comment-head">'
          + '<span class="pr-conv-author">' + escHtml(author) + '</span>'
          + '<span class="pr-conv-when">' + escHtml(when) + '</span>'
        + '</div>'
        + '<div class="pr-conv-thread-comment-body">' + renderCommentBody(c.body) + '</div>'
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
    var result = await window.klaus.prReviewChecks();
    // Drop stale results if the user switched PRs mid-flight.
    if (!lastState || lastState.number !== forNumber) return;
    currentChecks = result;
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
      + '<button type="button" class="pr-review-btn pr-checks-refresh">Refresh</button>'
    + '</div>';
    return header + '<div class="pr-checks-list">'
      + sorted.map(function (c) {
        var b = bucketOf(c);
        var icon = b === 'pass' ? '\u2713' : b === 'fail' ? '\u2717' : b === 'pending' ? '\u25CB' : b === 'cancel' ? '\u2296' : '\u2298';
        var linkAttr = c.link ? ' data-link="' + escHtml(c.link) + '"' : '';
        var debugBtn = (b === 'fail' && c.link)
          ? '<button class="pr-check-debug-btn" type="button" data-link="' + escHtml(c.link) + '" data-name="' + escHtml(c.name || '') + '" title="Use Claude to diagnose this failure">Debug</button>'
          : '';
        return '<div class="pr-check-row pr-check-' + b + '"' + linkAttr + '>'
          + '<span class="pr-check-icon">' + icon + '</span>'
          + '<div class="pr-check-labels">'
            + '<div class="pr-check-name">' + escHtml(c.name || '(unnamed)') + '</div>'
            + (c.workflow ? '<div class="pr-check-workflow">' + escHtml(c.workflow) + '</div>' : '')
            + (c.description ? '<div class="pr-check-desc">' + escHtml(c.description) + '</div>' : '')
          + '</div>'
          + '<span class="pr-check-state">' + escHtml((c.state || b).toLowerCase()) + '</span>'
          + debugBtn
          + (c.link ? '<span class="pr-check-arrow">\u2197</span>' : '')
        + '</div>';
      }).join('')
      + '</div>';
  }

  function bindChecksTab() {
    var refresh = hostEl.querySelector('.pr-checks-refresh');
    if (refresh) {
      refresh.addEventListener('click', function () {
        refresh.disabled = true;
        refresh.textContent = 'Refreshing\u2026';
        fetchAndRenderChecks(lastState && lastState.number).then(function () {
          // Re-render the tab to pick up new data.
          if (lastState) render(lastState);
        });
      });
    }
    hostEl.querySelectorAll('.pr-check-row[data-link]').forEach(function (row) {
      row.addEventListener('click', function (e) {
        // Don't open the run URL when the user clicks the inline Debug btn.
        if (e.target.closest('.pr-check-debug-btn')) return;
        var url = row.dataset.link;
        if (url) window.klaus.openExternal(url);
      });
    });
    hostEl.querySelectorAll('.pr-check-debug-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        startDebugCheck(btn);
      });
    });
  }

  var DEBUG_STATUS_MESSAGES = [
    'Fetching failing job log\u2026',
    'Reading PR diff\u2026',
    'Looking for the failing line\u2026',
    'Comparing failure to the change\u2026',
    'Drafting analysis\u2026',
  ];

  function startDebugCheck(btn) {
    var row = btn.closest('.pr-check-row');
    if (!row) return;

    // One panel per row at a time — clicking again cancels the in-flight one.
    var existing = row.nextElementSibling && row.nextElementSibling.classList.contains('pr-check-debug-panel')
      ? row.nextElementSibling : null;
    if (existing) {
      var existingId = existing.dataset.requestId;
      if (existingId) window.klaus.prDebugCheckCancel(existingId);
      existing.remove();
      return;
    }

    var requestId = 'dbg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    var panel = document.createElement('div');
    panel.className = 'pr-check-debug-panel';
    panel.dataset.requestId = requestId;
    panel.innerHTML =
      '<div class="pr-check-debug-head">'
        + '<span>Debugging \u2014 ' + escHtml(btn.dataset.name || '') + '</span>'
        + '<button class="pr-check-debug-close" type="button" title="Cancel / close">&times;</button>'
      + '</div>'
      + '<div class="pr-check-debug-body status-pulse">' + escHtml(DEBUG_STATUS_MESSAGES[0]) + '</div>';
    row.insertAdjacentElement('afterend', panel);

    var bodyEl = panel.querySelector('.pr-check-debug-body');
    var accumulated = '';

    var statusIdx = 0;
    var statusTimer = setInterval(function () {
      if (!bodyEl.isConnected) { clearInterval(statusTimer); return; }
      if (accumulated) { clearInterval(statusTimer); return; }
      statusIdx = (statusIdx + 1) % DEBUG_STATUS_MESSAGES.length;
      bodyEl.textContent = DEBUG_STATUS_MESSAGES[statusIdx];
    }, 1800);

    // Debug uses plain `claude -p` (text streaming, not stream-json) — so
    // we don't get a usage envelope here. Show duration instead so the user
    // still gets a sense of cost.
    var startedAt = Date.now();
    var unsubChunk = window.klaus.onPrDebugCheckChunk(requestId, function (chunk) {
      if (!accumulated) {
        bodyEl.classList.remove('status-pulse');
        bodyEl.textContent = '';
      }
      accumulated += chunk;
      bodyEl.textContent = accumulated;
      bodyEl.scrollTop = bodyEl.scrollHeight;
    });
    var unsubDone = window.klaus.onPrDebugCheckDone(requestId, function (result) {
      clearInterval(statusTimer);
      if (unsubChunk) unsubChunk();
      if (!bodyEl.isConnected) return;
      if (result && result.error) {
        bodyEl.classList.remove('status-pulse');
        bodyEl.classList.add('diff-error');
        bodyEl.textContent = result.error;
        return;
      }
      // Append a small footer so the user sees roughly how long the call ran.
      var seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      var footer = document.createElement('div');
      footer.className = 'pr-check-debug-usage';
      footer.textContent = 'Ran in ' + seconds + 's on your Anthropic account';
      panel.appendChild(footer);
    });

    panel.querySelector('.pr-check-debug-close').addEventListener('click', function () {
      clearInterval(statusTimer);
      window.klaus.prDebugCheckCancel(requestId);
      if (unsubChunk) unsubChunk();
      if (unsubDone) unsubDone();
      panel.remove();
    });

    btn.disabled = true;
    var origText = btn.textContent;
    btn.textContent = 'Debugging\u2026';
    // Re-enable button after start so the user can click it again to cancel.
    setTimeout(function () { btn.disabled = false; btn.textContent = origText; }, 200);

    window.klaus.prDebugCheckStart(requestId, btn.dataset.link, btn.dataset.name).then(function (r) {
      if (r && r.error) {
        clearInterval(statusTimer);
        bodyEl.classList.remove('status-pulse');
        bodyEl.classList.add('diff-error');
        bodyEl.textContent = r.error;
      }
    });
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
      var result = await window.klaus.prReviewMerge(strategy);
      if (result && result.error) {
        alert('Merge failed:\n' + result.error);
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

  return { mount: mount, unmount: unmount };
})();
