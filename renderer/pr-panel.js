// PR panel module — view PR details, comments, leave comments, approve/request changes
window.PRPanel = (function () {
  var prInfoEl, commentsListEl, commentInput;
  var currentWorktreePath = null;
  var currentPR = null;
  var currentChecks = null;
  var replyCounter = 0;

  function init() {
    prInfoEl = document.getElementById('pr-info');
    commentsListEl = document.getElementById('pr-comments-list');
    commentInput = document.getElementById('pr-comment-input');

    document.getElementById('btn-pr-comment').addEventListener('click', submitComment);
    document.getElementById('btn-pr-approve').addEventListener('click', function () { submitReview('approve'); });
    document.getElementById('btn-pr-request-changes').addEventListener('click', function () { submitReview('request-changes'); });
    initMergeControls();

    // Event delegation for all comment interactions
    commentsListEl.addEventListener('click', function (e) {
      var askBtn = e.target.closest('.pr-reply-ask-claude');
      if (askBtn) {
        handleAskClaude(askBtn);
        return;
      }
      var sendBtn = e.target.closest('.pr-reply-send');
      if (sendBtn) {
        handleSendReply(sendBtn);
        return;
      }
      var expandBtn = e.target.closest('.pr-hunk-expand-btn');
      if (expandBtn) {
        var wrap = expandBtn.closest('.pr-comment-hunk-wrap');
        if (wrap) wrap.classList.remove('collapsed');
        expandBtn.remove();
        return;
      }
      var resolveBtn = e.target.closest('.pr-thread-resolve-btn');
      if (resolveBtn) {
        handleToggleResolve(resolveBtn);
        return;
      }
      // Expand a resolved thread when its header is clicked (but ignore button clicks).
      var header = e.target.closest('.pr-thread-header');
      if (header && !e.target.closest('button')) {
        var thread = header.closest('.pr-thread');
        if (thread && thread.classList.contains('pr-thread-resolved')) {
          thread.classList.toggle('pr-thread-expanded');
        }
        return;
      }
    });

    // Tab switching
    var allTabContents = ['changes-tab-content', 'pr-tab-content', 'files-tab-content', 'search-tab-content', 'history-tab-content', 'stash-tab-content', 'env-tab-content'];
    document.querySelectorAll('#diff-tabs .diff-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('#diff-tabs .diff-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var target = tab.dataset.tab;
        allTabContents.forEach(function (id) {
          var el = document.getElementById(id);
          if (el) el.style.display = id === target + '-tab-content' ? '' : 'none';
        });
        if (target === 'pr') {
          loadPR();
        }
        if (target === 'files') {
          window.dispatchEvent(new CustomEvent('load-file-tree'));
        }
        if (target === 'history') {
          window.dispatchEvent(new CustomEvent('load-history'));
        }
        if (target === 'stash') {
          window.dispatchEvent(new CustomEvent('load-stash'));
        }
        if (target === 'env') {
          window.dispatchEvent(new CustomEvent('load-env'));
        }
      });
    });
  }

  function setWorktree(worktreePath) {
    currentWorktreePath = worktreePath;
    currentPR = null;
    currentChecks = null;
    prInfoEl.innerHTML = '';
    commentsListEl.innerHTML = '';
    var checksEl = document.getElementById('pr-checks');
    if (checksEl) checksEl.innerHTML = '';
    var aiEl = document.getElementById('pr-ai-review');
    if (aiEl) aiEl.innerHTML = '';
    updateMergeButton();
    // Background fetch — populates currentPR without rendering into the PR
    // tab, so the diff-panel Comment action works even from the Changes tab.
    fetchPRSilent(worktreePath);
    reloadActiveTab();
  }

  // Subscribe to the renderer event bus for task switches. The public
  // setWorktree stays callable for any code that needs to force a reload.
  Events.on('task:switched', function (detail) {
    var task = detail && detail.task;
    if (!task) return;
    // Match the old gating — PRPanel only updated when DiffPanel was visible
    // (PRPanel renders inside the diff-panel tab strip).
    if (window.DiffPanel && window.DiffPanel.isVisible && !window.DiffPanel.isVisible()) return;
    setWorktree(task.worktreePath);
  });

  async function fetchPRSilent(worktreePathAtRequest) {
    if (!worktreePathAtRequest) return;
    var result;
    try {
      result = await window.klaus.pr.forBranch(worktreePathAtRequest);
    } catch (_) { return; }
    // Drop the response if the user has since switched worktrees or the PR tab
    // has already rendered a fresher result.
    if (worktreePathAtRequest !== currentWorktreePath) return;
    if (currentPR) return;
    if (result && result.pr) {
      currentPR = result.pr;
      updateMergeButton();
    }
  }

  function reloadActiveTab() {
    var activeTab = document.querySelector('#diff-tabs .diff-tab.active');
    if (!activeTab) return;
    var target = activeTab.dataset.tab;
    if (target === 'pr') {
      loadPR();
    } else if (target !== 'changes' && window._reloadDiffTab) {
      window._reloadDiffTab(target, currentWorktreePath);
    }
  }

  async function loadPR() {
    if (!currentWorktreePath) return;
    prInfoEl.innerHTML = '<div class="pr-loading">Loading PR...</div>';
    commentsListEl.innerHTML = '';
    var checksEl = document.getElementById('pr-checks');
    if (checksEl) checksEl.innerHTML = '';
    var aiEl = document.getElementById('pr-ai-review');
    if (aiEl) aiEl.innerHTML = '';

    var result = await window.klaus.pr.forBranch(currentWorktreePath);

    if (result.error) {
      prInfoEl.innerHTML = '<div class="pr-error">' + escHtml(result.error) + '</div>';
      return;
    }

    if (!result.pr) {
      prInfoEl.innerHTML = '<div class="pr-empty">No pull request found for this branch.</div>';
      return;
    }

    currentPR = result.pr;
    currentChecks = null;
    renderPRInfo(result.pr);
    renderComments(result.pr);
    updateMergeButton();

    // Fetch CI checks and inline review threads in parallel.
    var prNumber = result.pr.number;
    var worktreeAtRequest = currentWorktreePath;
    var [checksResult, threadsResult] = await Promise.all([
      window.klaus.pr.checks(worktreeAtRequest, prNumber),
      window.klaus.pr.reviewThreads(worktreeAtRequest, prNumber),
    ]);

    // Drop stale responses if the user switched worktrees/PRs mid-flight.
    if (worktreeAtRequest !== currentWorktreePath || !currentPR || currentPR.number !== prNumber) return;

    currentChecks = checksResult;
    renderPRChecks(checksResult);
    updateMergeButton();

    if (threadsResult.error) {
      commentsListEl.insertAdjacentHTML('beforeend',
        '<div class="pr-error" style="text-align:left;padding:8px 14px;">Review threads failed: '
        + escHtml(threadsResult.error) + '</div>');
    }
    if (threadsResult.threads && threadsResult.threads.length > 0) {
      renderReviewThreads(threadsResult.threads);
    }

    // Load cached AI review (non-blocking; renders if present)
    loadCachedAiReview(worktreeAtRequest, prNumber);
  }

  async function loadCachedAiReview(worktreeAtRequest, prNumber) {
    var host = document.getElementById('pr-ai-review');
    if (!host) return;
    var cacheResult = await window.klaus.prReviewCacheGet(worktreeAtRequest, prNumber);
    if (worktreeAtRequest !== currentWorktreePath || !currentPR || currentPR.number !== prNumber) return;
    if (!cacheResult || !cacheResult.cached) return;
    renderCompletedReview(cacheResult.cached.review, cacheResult.cached.savedAt);
  }

  function renderPRChecks(result) {
    var host = document.getElementById('pr-checks');
    if (!host) return;
    host.innerHTML = '';

    if (result.error) {
      host.innerHTML = '<div class="pr-checks-empty">Checks unavailable: ' + escHtml(result.error) + '</div>';
      return;
    }
    var checks = result.checks || [];
    if (checks.length === 0) {
      host.innerHTML = '<div class="pr-checks-empty">No checks reported.</div>';
      return;
    }

    // gh emits normalized buckets: pass, fail, pending, skipping, cancel.
    // Fall back to `state` when a check row has no bucket.
    function bucketOf(c) {
      if (c.bucket) return c.bucket;
      var s = (c.state || '').toLowerCase();
      if (s === 'success' || s === 'neutral') return 'pass';
      if (s === 'failure' || s === 'timed_out' || s === 'action_required' || s === 'error') return 'fail';
      if (s === 'cancelled') return 'cancel';
      if (s === 'skipped') return 'skipping';
      return 'pending';
    }

    var counts = { pass: 0, fail: 0, pending: 0, cancel: 0, skipping: 0 };
    checks.forEach(function (c) {
      var b = bucketOf(c);
      counts[b] = (counts[b] || 0) + 1;
    });

    var summaryBits = [];
    if (counts.pass) summaryBits.push('<span class="pr-check-pill pass">&#10003; ' + counts.pass + ' passing</span>');
    if (counts.fail) summaryBits.push('<span class="pr-check-pill fail">&#10007; ' + counts.fail + ' failing</span>');
    if (counts.pending) summaryBits.push('<span class="pr-check-pill pending">&#9711; ' + counts.pending + ' pending</span>');
    if (counts.cancel) summaryBits.push('<span class="pr-check-pill cancel">&#8854; ' + counts.cancel + ' cancelled</span>');
    if (counts.skipping) summaryBits.push('<span class="pr-check-pill skipping">&#8211; ' + counts.skipping + ' skipped</span>');

    var hasFail = counts.fail > 0;
    var expanded = hasFail; // auto-expand when anything is failing

    var html = '<div class="pr-checks-section' + (expanded ? ' expanded' : '') + '">';
    html += '<button type="button" class="pr-checks-toggle">';
    html += '<span class="pr-checks-summary">' + summaryBits.join(' <span class="pr-check-dot">&middot;</span> ') + '</span>';
    html += '<span class="pr-checks-caret">&#9662;</span>';
    html += '</button>';
    html += '<div class="pr-checks-list">';
    checks.forEach(function (c) {
      var b = bucketOf(c);
      var label = c.workflow ? (c.workflow + ' / ' + (c.name || '')) : (c.name || '(unnamed)');
      html += '<div class="pr-check-row">';
      html += '<span class="pr-check-bucket pr-check-bucket-' + b + '">' + bucketGlyph(b) + '</span>';
      html += '<span class="pr-check-name">' + escHtml(label) + '</span>';
      html += '<span class="pr-check-conclusion">' + escHtml(c.state || '') + '</span>';
      if (c.link) {
        html += '<a href="#" class="pr-check-link" data-url="' + escAttr(c.link) + '" title="Open in browser">&#8599;</a>';
      }
      html += '</div>';
    });
    html += '</div>';
    html += '</div>';

    host.innerHTML = html;

    var section = host.querySelector('.pr-checks-section');
    var toggle = host.querySelector('.pr-checks-toggle');
    if (toggle && section) {
      toggle.addEventListener('click', function () { section.classList.toggle('expanded'); });
    }
    host.querySelectorAll('.pr-check-link').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        window.klaus.gh.openExternal(a.dataset.url);
      });
    });
  }

  function bucketGlyph(b) {
    switch (b) {
      case 'pass': return '&#10003;';
      case 'fail': return '&#10007;';
      case 'pending': return '&#9711;';
      case 'cancel': return '&#8854;';
      case 'skipping': return '&#8211;';
      default: return '&bull;';
    }
  }

  function renderPRInfo(pr) {
    var stateClass = 'pr-state-' + pr.state.toLowerCase();
    var reviewBadge = '';
    if (pr.reviewDecision) {
      var rdClass = 'pr-review-' + pr.reviewDecision.toLowerCase().replace(/_/g, '-');
      var rdLabel = pr.reviewDecision.replace(/_/g, ' ');
      reviewBadge = ' <span class="pr-review-badge ' + rdClass + '">' + escHtml(rdLabel) + '</span>';
    }

    var html = '<div class="pr-header">';
    html += '<div class="pr-title">';
    html += '<span class="pr-state-badge ' + stateClass + '">' + escHtml(pr.state) + '</span> ';
    html += '<strong>#' + pr.number + '</strong> ' + escHtml(pr.title);
    html += reviewBadge;
    html += '</div>';
    html += '<div class="pr-meta">';
    html += escHtml(pr.baseRefName) + ' &larr; ' + escHtml(pr.headRefName);
    if (pr.additions !== undefined) {
      html += ' &nbsp; <span class="pr-additions">+' + pr.additions + '</span>';
      html += ' <span class="pr-deletions">-' + pr.deletions + '</span>';
    }
    html += '</div>';
    if (pr.url) {
      html += '<div class="pr-url">';
      html += '<a href="#" class="pr-link" data-url="' + escAttr(pr.url) + '">Open on GitHub</a>';
      html += ' <button type="button" class="pr-ai-review-btn" title="Ask Claude for a structured review of the whole PR">Review with Claude</button>';
      html += '</div>';
    }
    if (pr.body) {
      html += '<div class="pr-body">' + renderMarkdown(pr.body) + '</div>';
    }
    html += '</div>';

    prInfoEl.innerHTML = html;

    var link = prInfoEl.querySelector('.pr-link');
    if (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        window.klaus.gh.openExternal(link.dataset.url);
      });
    }
    var aiBtn = prInfoEl.querySelector('.pr-ai-review-btn');
    if (aiBtn) {
      aiBtn.addEventListener('click', runAiReview);
    }
  }

  // Build the reply area HTML that goes under every comment
  function buildReplyArea(opts) {
    // opts: { id, commentId, author, body, filePath, diffHunk, threadable }
    var rid = 'reply-' + (replyCounter++);
    var html = '<div class="pr-reply-area" id="' + rid + '">';
    // AI analysis area (hidden until Ask Claude is clicked)
    html += '<div class="pr-reply-ai-result" id="' + rid + '-ai" style="display:none;"></div>';
    // Reply input row
    html += '<div class="pr-reply-input-row">';
    html += '<textarea class="pr-reply-input" id="' + rid + '-input" placeholder="Write a reply..." rows="1"></textarea>';
    html += '<button class="pr-reply-ask-claude" data-rid="' + rid + '"';
    html += ' data-author="' + escAttr(opts.author) + '"';
    html += ' data-body="' + escAttr(opts.body) + '"';
    if (opts.filePath) html += ' data-file="' + escAttr(opts.filePath) + '"';
    if (opts.diffHunk) html += ' data-hunk="' + escAttr(opts.diffHunk) + '"';
    html += ' title="Ask Claude to draft a reply">Claude</button>';
    html += '<button class="pr-reply-send" data-rid="' + rid + '"';
    if (opts.commentId) html += ' data-comment-id="' + escAttr(String(opts.commentId)) + '"';
    html += ' data-threadable="' + (opts.threadable ? '1' : '0') + '"';
    html += ' title="' + (opts.threadable ? 'Reply in thread' : 'Post comment') + '">Reply</button>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  function renderComments(pr) {
    var items = [];

    if (pr.comments) {
      pr.comments.forEach(function (c) {
        items.push({
          type: 'comment',
          author: c.author ? c.author.login : 'unknown',
          body: c.body,
          createdAt: c.createdAt,
          commentId: null, // issue comments don't support threading
          threadable: false,
        });
      });
    }

    if (pr.reviews) {
      pr.reviews.forEach(function (r) {
        if (r.state === 'COMMENTED' && !r.body) return;
        items.push({
          type: 'review',
          author: r.author ? r.author.login : 'unknown',
          body: r.body || '',
          state: r.state,
          createdAt: r.submittedAt || r.createdAt,
          commentId: null,
          threadable: false,
        });
      });
    }

    items.sort(function (a, b) {
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    if (items.length === 0) {
      commentsListEl.innerHTML = '<div class="pr-empty">No comments yet.</div>';
      return;
    }

    var html = '<div class="pr-comments-section">';
    html += '<div class="pr-comments-header">Comments (' + items.length + ')</div>';
    items.forEach(function (item) {
      html += renderCommentItem(item);
    });
    html += '</div>';
    commentsListEl.innerHTML = html;
  }

  function renderCommentItem(item) {
    var time = formatTime(item.createdAt);
    var badge = '';
    if (item.type === 'review' && item.state) {
      var badgeClass = 'pr-review-' + item.state.toLowerCase().replace(/_/g, '-');
      badge = ' <span class="pr-review-badge ' + badgeClass + '">' + escHtml(item.state.replace(/_/g, ' ')) + '</span>';
    }

    var html = '<div class="pr-comment-item">';
    html += '<div class="pr-comment-meta">';
    html += '<strong>' + escHtml(item.author) + '</strong>';
    html += badge;
    html += ' <span class="pr-comment-time">' + escHtml(time) + '</span>';
    html += '</div>';
    if (item.body) {
      html += '<div class="pr-comment-body">' + renderMarkdown(item.body) + '</div>';
    }
    // Reply area under each comment
    if (item.body) {
      html += buildReplyArea({
        commentId: item.commentId || null,
        author: item.author,
        body: item.body,
        threadable: item.threadable,
      });
    }
    html += '</div>';
    return html;
  }

  function renderReviewThreads(threads) {
    if (!threads || threads.length === 0) return;

    // Drop any truly empty threads (should be rare) and warn for debugging.
    var rendered = threads.filter(function (t) {
      var hasComments = t.comments && t.comments.nodes && t.comments.nodes.length > 0;
      if (!hasComments) console.warn('[pr-panel] dropping empty thread', t);
      return hasComments;
    });
    if (rendered.length < threads.length) {
      console.warn('[pr-panel] ' + (threads.length - rendered.length) + ' thread(s) had no comments and were skipped');
    }

    // Count unresolved threads for the header summary
    var unresolved = rendered.filter(function (t) { return !t.isResolved; }).length;
    var summary = rendered.length + ' thread' + (rendered.length === 1 ? '' : 's');
    if (unresolved !== rendered.length) {
      summary += ' (' + unresolved + ' unresolved)';
    }

    var html = '<div class="pr-comments-section">';
    html += '<div class="pr-comments-header">Inline Review Comments — ' + summary + '</div>';

    rendered.forEach(function (t) {
      var comments = t.comments.nodes;

      var root = comments[0];
      var rootDbId = root.databaseId || '';
      var rootAuthor = (root.author && root.author.login) || 'unknown';

      var side = t.diffSide || root.side || 'RIGHT';
      var line = side === 'LEFT' ? (t.originalLine || root.originalLine) : (t.line || root.line);
      var pathLabel = t.path ? (t.path + (line != null ? ':' + line : '')) : '';

      var threadCls = 'pr-thread' + (t.isResolved ? ' pr-thread-resolved' : '')
                                  + (t.isOutdated ? ' pr-thread-outdated' : '');
      html += '<div class="' + threadCls + '" data-thread-id="' + escAttr(t.id) + '">';

      // Thread header: path:line + state badges + resolve toggle
      html += '<div class="pr-thread-header">';
      html += '<span class="pr-thread-path">' + escHtml(pathLabel) + '</span>';
      html += '<span class="pr-thread-meta">';
      if (t.isOutdated) html += '<span class="pr-thread-badge outdated">outdated</span>';
      if (t.isResolved) {
        html += '<span class="pr-thread-badge resolved">resolved</span>';
        html += '<span class="pr-thread-count">' + comments.length + ' comment' + (comments.length === 1 ? '' : 's') + '</span>';
      }
      html += '<button type="button" class="pr-thread-resolve-btn" data-thread-id="' + escAttr(t.id) + '" data-resolved="' + (t.isResolved ? '1' : '0') + '">'
           +  (t.isResolved ? 'Unresolve' : 'Resolve') + '</button>';
      html += '</div>';
      html += '</div>';

      // Collapsible body: hunk + conversation + reply box
      html += '<div class="pr-thread-body">';
      // Hunk once at top, using root comment's diffHunk + thread's line/side
      var hunkHtml = renderReviewHunk({
        diff_hunk: root.diffHunk,
        line: t.line,
        original_line: t.originalLine,
        side: side,
      });
      if (!hunkHtml && pathLabel) {
        hunkHtml = '<div class="pr-thread-no-hunk">' + escHtml(pathLabel) + '</div>';
      }
      html += hunkHtml;

      // Conversation
      comments.forEach(function (c, idx) {
        var author = (c.author && c.author.login) || 'unknown';
        var time = formatTime(c.createdAt);
        var isReply = idx > 0;
        var cCls = 'pr-comment-item pr-inline-comment' + (isReply ? ' pr-inline-reply' : '');
        html += '<div class="' + cCls + '">';
        html += '<div class="pr-comment-meta">';
        html += '<strong>' + escHtml(author) + '</strong>';
        html += ' <span class="pr-comment-time">' + escHtml(time) + '</span>';
        html += '</div>';
        html += '<div class="pr-comment-body">' + renderMarkdown(c.body) + '</div>';
        html += '</div>';
      });

      // Single reply composer per thread, anchored to the root comment
      html += buildReplyArea({
        commentId: rootDbId,
        author: rootAuthor,
        body: root.body,
        filePath: t.path || null,
        diffHunk: root.diffHunk || null,
        threadable: true,
      });

      html += '</div>'; // .pr-thread-body
      html += '</div>'; // .pr-thread
    });

    html += '</div>';
    commentsListEl.innerHTML += html;
  }

  // ---- Ask Claude handler ----

  async function handleAskClaude(btn) {
    var rid = btn.dataset.rid;
    var aiEl = document.getElementById(rid + '-ai');
    var inputEl = document.getElementById(rid + '-input');
    if (!aiEl || !inputEl || !currentPR || !currentWorktreePath) return;

    btn.disabled = true;
    btn.textContent = 'Thinking...';
    aiEl.style.display = '';
    aiEl.innerHTML = '<div class="pr-ai-loading">Claude is reviewing this comment...</div>';

    var result = await window.klaus.pr.aiReviewComment({
      worktreePath: currentWorktreePath,
      prTitle: currentPR.title,
      prBody: currentPR.body || '',
      commentAuthor: btn.dataset.author,
      commentBody: btn.dataset.body,
      filePath: btn.dataset.file || null,
      diffHunk: btn.dataset.hunk || null,
    });

    btn.disabled = false;
    btn.textContent = 'Claude';

    if (result.error) {
      aiEl.innerHTML = '<div class="pr-ai-error">Failed: ' + escHtml(result.error) + '</div>';
      return;
    }

    var reviewText = result.review;
    var replyMatch = reviewText.match(/SUGGESTED REPLY:\s*\n?([\s\S]*)/i);
    var suggestedReply = replyMatch ? replyMatch[1].trim() : '';

    var html = '<div class="pr-ai-review-content">';
    html += '<div class="pr-ai-review-header">Claude\'s Analysis</div>';
    html += '<div class="pr-ai-review-body">' + renderMarkdown(reviewText) + '</div>';
    html += '</div>';
    aiEl.innerHTML = html;

    // Fill the textarea with the suggested reply
    if (suggestedReply) {
      inputEl.value = suggestedReply;
      autoGrow(inputEl);
      inputEl.focus();
    }
  }

  // ---- Send reply handler ----

  async function handleSendReply(btn) {
    var rid = btn.dataset.rid;
    var inputEl = document.getElementById(rid + '-input');
    var replyArea = document.getElementById(rid);
    if (!inputEl || !currentPR || !currentWorktreePath) return;

    var body = inputEl.value.trim();
    if (!body) return;

    var commentId = btn.dataset.commentId;
    var threadable = btn.dataset.threadable === '1';

    btn.disabled = true;
    btn.textContent = 'Posting...';

    var result;
    if (threadable && commentId) {
      // Post as a threaded reply to the inline review comment
      result = await window.klaus.pr.replyToComment(currentWorktreePath, currentPR.number, commentId, body);
    } else {
      // Post as a general PR comment
      result = await window.klaus.pr.addComment(currentWorktreePath, currentPR.number, body);
    }

    if (result.error) {
      btn.disabled = false;
      btn.textContent = 'Reply';
      window.toast.error('Failed to post reply: ' + (result.error || 'Unknown error'));
      return;
    }

    // Show the posted reply inline immediately
    var postedHtml = '<div class="pr-reply-posted">';
    postedHtml += '<div class="pr-comment-meta"><strong>You</strong> <span class="pr-comment-time">just now</span></div>';
    postedHtml += '<div class="pr-comment-body">' + renderMarkdown(body) + '</div>';
    postedHtml += '</div>';

    // Insert before the reply area and reset
    replyArea.insertAdjacentHTML('beforebegin', postedHtml);
    inputEl.value = '';
    autoGrow(inputEl);
    btn.disabled = false;
    btn.textContent = 'Reply';

    // Hide AI result if showing
    var aiEl = document.getElementById(rid + '-ai');
    if (aiEl) {
      aiEl.style.display = 'none';
      aiEl.innerHTML = '';
    }
  }

  // ---- Resolve / unresolve review thread ----

  async function handleToggleResolve(btn) {
    if (!currentWorktreePath) return;
    var threadId = btn.dataset.threadId;
    var wasResolved = btn.dataset.resolved === '1';
    if (!threadId) return;

    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '...';

    var fn = wasResolved ? window.klaus.pr.unresolveThread : window.klaus.pr.resolveThread;
    var result = await fn(currentWorktreePath, threadId);

    if (result && result.error) {
      btn.disabled = false;
      btn.textContent = origText;
      window.toast.error('Failed to ' + (wasResolved ? 'unresolve' : 'resolve') + ' thread: ' + result.error);
      return;
    }

    // Reflect state locally without a full PR reload
    var thread = btn.closest('.pr-thread');
    if (thread) {
      thread.classList.toggle('pr-thread-resolved', !wasResolved);
      if (wasResolved) thread.classList.remove('pr-thread-expanded');
    }
    btn.disabled = false;
    btn.dataset.resolved = wasResolved ? '0' : '1';
    btn.textContent = wasResolved ? 'Resolve' : 'Unresolve';
  }

  // ---- Whole-PR AI review (F6) ----

  var currentAiReviewId = null;

  async function runAiReview() {
    if (!currentPR || !currentWorktreePath) return;
    var host = document.getElementById('pr-ai-review');
    if (!host) return;
    var btn = prInfoEl.querySelector('.pr-ai-review-btn');

    var requestId = 'ai-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    currentAiReviewId = requestId;

    host.innerHTML = '<div class="pr-ai-review-card">'
      + '<div class="pr-ai-review-header">'
        + '<strong>Claude\'s PR Review</strong>'
        + '<span class="pr-ai-elapsed">0s</span>'
        + '<button type="button" class="pr-ai-cancel-btn" title="Cancel review">Cancel</button>'
        + '<button type="button" class="pr-ai-review-close" title="Dismiss">&times;</button>'
      + '</div>'
      + '<div class="pr-ai-progress"></div>'
      + '<div class="pr-ai-review-body">'
        + '<div class="pr-ai-loading">Starting review — small PRs take ~1 min, large PRs (≥150 lines) fan out to 4 parallel agents…</div>'
      + '</div>'
      + '</div>';

    var bodyEl = host.querySelector('.pr-ai-review-body');
    var progressEl = host.querySelector('.pr-ai-progress');
    var elapsedEl = host.querySelector('.pr-ai-elapsed');
    var cancelBtn = host.querySelector('.pr-ai-cancel-btn');
    var closeBtn = host.querySelector('.pr-ai-review-close');

    var startedAt = Date.now();
    var elapsedTimer = setInterval(function () {
      var secs = Math.floor((Date.now() - startedAt) / 1000);
      var mins = Math.floor(secs / 60);
      elapsedEl.textContent = mins > 0 ? mins + 'm ' + (secs % 60) + 's' : secs + 's';
    }, 1000);

    closeBtn.addEventListener('click', function () {
      window.klaus.pr.aiReviewCancel(requestId);
      clearInterval(elapsedTimer);
      host.innerHTML = '';
    });

    cancelBtn.addEventListener('click', function () {
      window.klaus.pr.aiReviewCancel(requestId);
    });

    if (btn) { btn.disabled = true; btn.textContent = 'Reviewing…'; }

    // Stream handler: parse stream-json events and accumulate the final
    // assistant text; show tool-use calls as progress chips.
    var finalText = '';
    var buffered = '';
    var progressEvents = [];

    function handleEvent(ev) {
      if (!ev || !ev.type) return;
      if (ev.type === 'assistant' && ev.message && ev.message.content) {
        ev.message.content.forEach(function (block) {
          if (block.type === 'text' && block.text) {
            finalText = block.text; // final assistant text block — keep latest
          } else if (block.type === 'tool_use' && block.name) {
            progressEvents.push({ kind: 'tool', name: block.name, input: block.input });
          }
        });
      } else if (ev.type === 'result' && ev.result) {
        finalText = ev.result;
      } else if (ev.type === 'system' && ev.subtype) {
        progressEvents.push({ kind: 'system', text: ev.subtype });
      }
      renderProgress();
      renderFinal();
    }

    function renderProgress() {
      var recent = progressEvents.slice(-6).map(function (p) {
        if (p.kind === 'tool') {
          var hint = '';
          if (p.input) {
            if (p.input.command) hint = String(p.input.command).slice(0, 50);
            else if (p.input.file_path) hint = String(p.input.file_path).split('/').pop();
            else if (p.input.pattern) hint = String(p.input.pattern).slice(0, 30);
            else if (p.input.description) hint = String(p.input.description).slice(0, 40);
          }
          var label = p.name + (hint ? ': ' + hint : '');
          return '<span class="pr-ai-progress-chip">' + escHtml(label) + '</span>';
        }
        return '<span class="pr-ai-progress-chip pr-ai-progress-system">' + escHtml(p.text) + '</span>';
      }).join('');
      progressEl.innerHTML = recent;
    }

    function renderFinal() {
      if (!finalText) return;
      bodyEl.innerHTML = renderReviewContent(finalText);
      wireFixButtons(bodyEl, finalText);
    }

    var unsubscribe = window.klaus.pr.onAiReviewData(requestId, function (chunk) {
      buffered += chunk;
      var idx;
      while ((idx = buffered.indexOf('\n')) !== -1) {
        var line = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 1);
        if (!line.trim()) continue;
        try { handleEvent(JSON.parse(line)); } catch (e) { /* ignore parse errors */ }
      }
    });

    window.klaus.pr.onAiReviewDone(requestId, function (result) {
      clearInterval(elapsedTimer);
      unsubscribe();
      if (btn) { btn.disabled = false; btn.textContent = 'Review with Claude'; }
      if (currentAiReviewId !== requestId) return; // stale
      if (cancelBtn) cancelBtn.remove();
      if (result && result.cancelled) {
        bodyEl.innerHTML = '<div class="pr-ai-error">Cancelled.</div>';
        return;
      }
      if (result && result.error) {
        bodyEl.innerHTML = '<div class="pr-ai-error">Failed: ' + escHtml(result.error) + '</div>';
        return;
      }
      // Render final text (if we didn't already via stream events)
      renderFinal();
      progressEl.innerHTML = ''; // clear progress chips once done

      // Persist so reopening the app doesn't lose the review
      if (finalText && currentPR) {
        window.klaus.prReviewCacheSave(currentWorktreePath, currentPR.number, finalText);
      }
    });

    var startResult = await window.klaus.pr.aiReviewStart({
      worktreePath: currentWorktreePath,
      baseBranch: currentPR.baseRefName || 'main',
      requestId: requestId,
    });

    if (startResult && startResult.error) {
      clearInterval(elapsedTimer);
      unsubscribe();
      bodyEl.innerHTML = '<div class="pr-ai-error">Failed to start: ' + escHtml(startResult.error) + '</div>';
      if (btn) { btn.disabled = false; btn.textContent = 'Review with Claude'; }
    }
  }

  // ---- Bottom form: general comment / approve / request changes ----

  async function submitComment() {
    if (!currentPR || !currentWorktreePath) return;
    var body = commentInput.value.trim();
    if (!body) return;

    var btn = document.getElementById('btn-pr-comment');
    btn.disabled = true;
    btn.textContent = 'Posting...';

    var result = await window.klaus.pr.addComment(currentWorktreePath, currentPR.number, body);

    btn.disabled = false;
    btn.textContent = 'Comment';

    if (result.error) {
      window.toast.error('Failed to post comment: ' + result.error);
      return;
    }

    commentInput.value = '';
    await loadPR();
  }

  async function submitReview(event) {
    if (!currentPR || !currentWorktreePath) return;
    var body = commentInput.value.trim();

    var btnId = event === 'approve' ? 'btn-pr-approve' : 'btn-pr-request-changes';
    var btn = document.getElementById(btnId);
    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Submitting...';

    var result = await window.klaus.pr.review(currentWorktreePath, currentPR.number, event, body || undefined);

    btn.disabled = false;
    btn.textContent = origText;

    if (result.error) {
      window.toast.error('Review failed: ' + result.error);
      return;
    }

    commentInput.value = '';
    await loadPR();
  }

  // ---- Utilities ----

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.max(el.scrollHeight, 28) + 'px';
  }

  // Auto-grow all reply textareas on input
  document.addEventListener('input', function (e) {
    if (e.target.classList.contains('pr-reply-input')) {
      autoGrow(e.target);
    }
  });

  function formatTime(isoString) {
    if (!isoString) return '';
    try {
      var d = new Date(isoString);
      var now = new Date();
      var diffMs = now - d;
      var diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 1) return 'just now';
      if (diffMins < 60) return diffMins + 'm ago';
      var diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return diffHours + 'h ago';
      var diffDays = Math.floor(diffHours / 24);
      if (diffDays < 30) return diffDays + 'd ago';
      return d.toLocaleDateString();
    } catch (e) {
      return isoString;
    }
  }

  function renderMarkdown(text) {
    // Extract fenced code blocks BEFORE escaping so their contents aren't
    // double-escaped. The previous impl ran escHtml first, which mangled any
    // `<` inside a code fence by the time triple-backtick replacement ran.
    var src = (text || '').toString();
    var blocks = [];
    src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, function (_match, _lang, code) {
      var idx = blocks.length;
      blocks.push('<pre class="pr-code-block">' + escHtml(code.replace(/\n$/, '')) + '</pre>');
      return ' CODEBLOCK' + idx + ' ';
    });
    src = escHtml(src)
      .replace(/`([^`]+)`/g, '<code class="pr-inline-code">$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
    src = src.replace(/ CODEBLOCK(\d+) /g, function (_, i) { return blocks[parseInt(i, 10)]; });
    return src;
  }

  function renderDiffHunk(hunkText) {
    var lines = escHtml(hunkText).split('\n');
    return lines.map(function (line) {
      if (line.startsWith('+')) {
        return '<span class="pr-hunk-add">' + line + '</span>';
      } else if (line.startsWith('-')) {
        return '<span class="pr-hunk-del">' + line + '</span>';
      }
      return '<span>' + line + '</span>';
    }).join('\n');
  }

  // Full inline-comment hunk with line numbers + target line highlight.
  function renderReviewHunk(c) {
    if (!c.diff_hunk) return '';
    var raw = c.diff_hunk.replace(/\n+$/, '');
    if (!raw) return '';
    var lines = raw.split('\n');

    // Locate the (last) @@ header and seed starting line numbers.
    var headerIdx = -1;
    for (var i = 0; i < lines.length; i++) {
      if (/^@@.*@@/.test(lines[i])) headerIdx = i;
    }
    var oldLn = 0, newLn = 0;
    if (headerIdx >= 0) {
      var m = lines[headerIdx].match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldLn = parseInt(m[1], 10) - 1; newLn = parseInt(m[2], 10) - 1; }
    }

    var side = c.side || 'RIGHT';
    var targetLine = side === 'LEFT' ? (c.original_line || c.original_position) : (c.line || c.position);

    var rows = lines.map(function (line, idx) {
      var cls = 'pr-hunk-line';
      var oldN = '', newN = '', isTarget = false;
      if (idx === headerIdx) {
        cls += ' pr-hunk-header-line';
      } else {
        var first = line.charAt(0);
        if (first === '+') {
          newLn++; newN = newLn; cls += ' pr-hunk-add';
          if (side === 'RIGHT' && newLn === targetLine) isTarget = true;
        } else if (first === '-') {
          oldLn++; oldN = oldLn; cls += ' pr-hunk-del';
          if (side === 'LEFT' && oldLn === targetLine) isTarget = true;
        } else {
          oldLn++; newLn++; oldN = oldLn; newN = newLn; cls += ' pr-hunk-ctx';
          if ((side === 'RIGHT' && newLn === targetLine) ||
              (side === 'LEFT' && oldLn === targetLine)) isTarget = true;
        }
      }
      if (isTarget) cls += ' pr-hunk-target';
      return { cls: cls, text: line, oldN: oldN, newN: newN };
    });

    var COLLAPSE_AT = 15;
    var tooLong = rows.length > COLLAPSE_AT;
    var wrapCls = 'pr-comment-hunk-wrap' + (tooLong ? ' collapsed' : '');

    var html = '<div class="' + wrapCls + '">';
    if (tooLong) {
      html += '<button type="button" class="pr-hunk-expand-btn">'
           +  'Show full hunk (' + rows.length + ' lines)</button>';
    }
    html += '<pre class="pr-comment-hunk">';
    rows.forEach(function (r) {
      html += '<div class="' + r.cls + '">'
           +  '<span class="pr-hunk-ln pr-hunk-ln-old">' + r.oldN + '</span>'
           +  '<span class="pr-hunk-ln pr-hunk-ln-new">' + r.newN + '</span>'
           +  '<span class="pr-hunk-text">' + escHtml(r.text) + '</span>'
           +  '</div>';
    });
    html += '</pre>';
    html += '</div>';
    return html;
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  }

  // ---- Merge controls (F3) ----

  function initMergeControls() {
    var btn = document.getElementById('btn-pr-merge');
    var menu = document.getElementById('pr-merge-menu');
    if (!btn || !menu) return;

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (btn.disabled) return;
      menu.hidden = !menu.hidden;
    });

    menu.addEventListener('click', function (e) {
      var target = e.target.closest('button[data-strategy]');
      if (!target) return;
      menu.hidden = true;
      mergePR(target.dataset.strategy);
    });

    // Dismiss menu on outside click
    document.addEventListener('click', function (e) {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) {
        menu.hidden = true;
      }
    });
  }

  function mergeGateReason(pr, checks) {
    if (!pr) return 'No PR loaded';
    if (pr.state !== 'OPEN') return 'PR is ' + pr.state.toLowerCase();
    if (pr.isDraft) return 'PR is a draft';
    if (pr.mergeable === 'CONFLICTING') return 'PR has merge conflicts';
    if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'Changes requested';
    // mergeStateStatus values: BLOCKED, CLEAN, DIRTY, DRAFT, HAS_HOOKS, UNKNOWN, UNSTABLE, BEHIND
    if (pr.mergeStateStatus === 'DIRTY') return 'Branch has conflicts with base';
    if (pr.mergeStateStatus === 'BLOCKED') {
      // Refine: prefer a checks-based reason if available
      if (checks && Array.isArray(checks.checks)) {
        var failing = checks.checks.filter(function (c) { return (c.bucket || '').toLowerCase() === 'fail'; }).length;
        if (failing > 0) return failing + ' failing check' + (failing === 1 ? '' : 's');
      }
      return 'Blocked by branch protection';
    }
    if (pr.mergeStateStatus === 'BEHIND') return 'Branch is behind base';
    if (pr.mergeable === 'UNKNOWN' && !pr.mergeStateStatus) return 'Mergeability still computing';
    return null;
  }

  function updateMergeButton() {
    var btn = document.getElementById('btn-pr-merge');
    var menu = document.getElementById('pr-merge-menu');
    if (!btn) return;
    if (menu) menu.hidden = true;

    var reason = mergeGateReason(currentPR, currentChecks);
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

  async function mergePR(strategy) {
    if (!currentPR || !currentWorktreePath) return;
    var btn = document.getElementById('btn-pr-merge');
    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Merging...';

    var result = await window.klaus.pr.merge(currentWorktreePath, currentPR.number, strategy);

    btn.textContent = origText;

    if (result.error) {
      window.toast.error('Merge failed: ' + result.error);
      updateMergeButton();
      return;
    }

    await loadPR();
  }

  // ---- F6 finding parser + Fix button wiring ----

  // Split Claude's review text into preamble / findings / postamble. Each
  // finding starts at a `**[Severity: …]**` line; postamble begins at the
  // final "**Overall verdict:**" if present.
  function parseReviewFindings(text) {
    if (!text) return { preamble: '', findings: [], postamble: '' };
    // Tolerant split: line start, optional whitespace, 0–2 asterisks, then
    // `[Severity:`. Kept in lockstep with pr-review.js. Looser markdown
    // prefixes caused false splits on `---` rules.
    var parts = text.split(/(?=^\s*\*{0,2}\[Severity:)/m);
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
    // Junk filter (mirrors pr-review.js): drop findings that don't actually
    // contain a severity marker, or whose only content is a `---`/`===`
    // separator. Safety net against loose split boundaries.
    findings = findings.filter(function (f) {
      if (!f) return false;
      if (!/\*{0,2}\[Severity:/i.test(f)) return false;
      var lines = f.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      var meaningful = lines.filter(function (l) {
        if (/^\*?\*?\[[^\]]+\]\*?\*?$/.test(l)) return false;
        if (/^-{3,}$/.test(l)) return false;
        if (/^={3,}$/.test(l)) return false;
        return true;
      });
      return meaningful.length > 0;
    });
    return { preamble: preamble, findings: findings, postamble: postamble };
  }

  function severityOf(findingText) {
    var m = (findingText || '').match(/\*{0,2}\[Severity:\s*([^\]|]+)(?:\|[^\]]*)?\]\*{0,2}/);
    return m ? m[1].trim().toLowerCase() : '';
  }

  function renderReviewContent(text) {
    var parsed = parseReviewFindings(text);
    var html = '';
    if (parsed.findings.length > 0) {
      html += '<div class="pr-ai-findings-header">';
      html += '<span class="pr-ai-findings-count">' + parsed.findings.length + ' finding' + (parsed.findings.length === 1 ? '' : 's') + '</span>';
      html += '<button type="button" class="pr-ai-fix-all-btn" title="Send all findings to the Claude terminal for this worktree">Fix all findings</button>';
      html += '</div>';
    }
    if (parsed.preamble) {
      html += '<div class="pr-ai-section"><div class="pr-ai-section-body">' + renderMarkdown(parsed.preamble) + '</div></div>';
    }
    parsed.findings.forEach(function (f, idx) {
      var sev = severityOf(f);
      var sevCls = sev ? ' pr-ai-finding-sev-' + sev.replace(/\s+/g, '-') : '';
      html += '<div class="pr-ai-finding' + sevCls + '" data-finding-index="' + idx + '">';
      html += '<div class="pr-ai-finding-body">' + renderMarkdown(f) + '</div>';
      html += '<div class="pr-ai-finding-actions">';
      html += '<button type="button" class="pr-ai-fix-btn" data-finding-index="' + idx + '">Fix this</button>';
      html += '</div>';
      html += '</div>';
    });
    if (parsed.postamble) {
      html += '<div class="pr-ai-section pr-ai-postamble"><div class="pr-ai-section-body">' + renderMarkdown(parsed.postamble) + '</div></div>';
    }
    return html || ('<div class="pr-ai-section"><div class="pr-ai-section-body">' + renderMarkdown(text) + '</div></div>');
  }

  function wireFixButtons(container, reviewText) {
    var parsed = parseReviewFindings(reviewText);
    var fixAll = container.querySelector('.pr-ai-fix-all-btn');
    if (fixAll) {
      fixAll.addEventListener('click', function () {
        sendFix(buildFixAllPrompt(parsed.findings), fixAll);
      });
    }
    container.querySelectorAll('.pr-ai-fix-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.dataset.findingIndex, 10);
        if (isNaN(idx) || !parsed.findings[idx]) return;
        sendFix(buildFixSinglePrompt(parsed.findings[idx]), btn);
      });
    });
  }

  function buildFixSinglePrompt(finding) {
    return 'Please fix the following PR review finding. Read the file(s) referenced, ' +
      'trace the code path, and implement the suggested change. Prefer small, focused commits.\n\n' +
      finding + '\n';
  }

  function buildFixAllPrompt(findings) {
    var body = findings.map(function (f, i) { return '### Finding ' + (i + 1) + '\n\n' + f; }).join('\n\n');
    return 'Please address all of the following PR review findings, highest severity first. ' +
      'For each: read the referenced file(s), trace the code path, and implement the suggested change. ' +
      'Make focused commits — one per finding or per cluster of related findings.\n\n' + body + '\n';
  }

  function buildFixAllFromReviewPrompt(reviewText) {
    return 'Please address every issue, suggestion, and concern raised in the PR review below. ' +
      'Read the referenced file(s), trace the code paths, and implement the changes. ' +
      'Prioritize the highest-severity items first and make focused commits.\n\n' +
      '---\n\n' + reviewText + '\n';
  }

  async function sendFix(prompt, btn) {
    if (!currentWorktreePath) { window.toast.error('No worktree active.'); return; }
    var origText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    var result = await window.klaus.pr.fixInTerminal(currentWorktreePath, prompt);
    if (btn) { btn.disabled = false; btn.textContent = origText; }
    if (result && result.error) {
      window.toast.error('Could not send to terminal: ' + result.error);
      return;
    }
    if (btn) {
      btn.textContent = 'Sent ✓';
      setTimeout(function () { btn.textContent = origText; }, 2000);
    }
  }

  function renderCompletedReview(reviewText, savedAt) {
    var host = document.getElementById('pr-ai-review');
    if (!host) return;
    var parsed = parseReviewFindings(reviewText);
    var ageLabel = savedAt ? ' <span class="pr-ai-elapsed">saved ' + formatTime(savedAt) + '</span>' : '';
    var fixAllLabel = parsed.findings.length > 0
      ? 'Claude fix all (' + parsed.findings.length + ')'
      : 'Claude fix all';
    var headerFixBtn = reviewText && reviewText.trim()
      ? '<button type="button" class="pr-ai-fix-all-header-btn" title="Send the review to the Claude terminal for this worktree to fix">' + fixAllLabel + '</button>'
      : '';
    host.innerHTML = '<div class="pr-ai-review-card">'
      + '<div class="pr-ai-review-header">'
        + '<strong>Claude\'s PR Review</strong>' + ageLabel
        + headerFixBtn
        + '<button type="button" class="pr-ai-regen-btn" title="Re-run the review">Re-run</button>'
        + '<button type="button" class="pr-ai-discard-btn" title="Discard cached review">Discard</button>'
        + '<button type="button" class="pr-ai-review-close" title="Dismiss">&times;</button>'
      + '</div>'
      + '<div class="pr-ai-review-body">' + renderReviewContent(reviewText) + '</div>'
      + '</div>';

    var bodyEl = host.querySelector('.pr-ai-review-body');
    wireFixButtons(bodyEl, reviewText);

    var headerFix = host.querySelector('.pr-ai-fix-all-header-btn');
    if (headerFix) {
      headerFix.addEventListener('click', function () {
        var prompt = parsed.findings.length > 0
          ? buildFixAllPrompt(parsed.findings)
          : buildFixAllFromReviewPrompt(reviewText);
        sendFix(prompt, headerFix);
      });
    }

    host.querySelector('.pr-ai-review-close').addEventListener('click', function () { host.innerHTML = ''; });
    host.querySelector('.pr-ai-regen-btn').addEventListener('click', function () { runAiReview(); });
    host.querySelector('.pr-ai-discard-btn').addEventListener('click', async function () {
      if (!currentPR) return;
      await window.klaus.prReviewCacheClear(currentWorktreePath, currentPR.number);
      host.innerHTML = '';
    });
  }

  function getCurrentPR() {
    return currentPR;
  }

  return { init: init, setWorktree: setWorktree, loadPR: loadPR, getCurrentPR: getCurrentPR };
})();
