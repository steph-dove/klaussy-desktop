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
    // Preserve selection across updates unless the PR number changed.
    if (lastState && lastState.number !== state.number) selectedFile = null;
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
        + '</div>'
        + '<div class="pr-review-actions">'
          + '<a href="#" class="pr-review-external" data-url="' + escHtml(meta.url || '') + '">Open on GitHub</a>'
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
      + '</div>'
      + '<div class="pr-review-body' + (activeTab === 'conversation' ? ' conversation-mode' : '') + '">'
        + (activeTab === 'files'
            ? '<div class="pr-review-file-list">' + renderFileList(files, threadsByPath) + '</div>'
              + '<div class="pr-review-diff">' + renderSelectedFileDiff(files) + '</div>'
            : '<div class="pr-review-conversation">' + renderConversation(state) + '</div>'
          )
      + '</div>';

    bindHeader(state);
    bindTabs();
    if (activeTab === 'files') {
      bindFileList();
      injectInlineThreads(threadsByPath);
      injectPendingComments();
    } else if (activeTab === 'conversation') {
      bindConversationComposer();
      bindReplyButtons();
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
