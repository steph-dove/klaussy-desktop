// PR panel module — view PR details, comments, leave comments, approve/request changes
window.PRPanel = (function () {
  var prInfoEl, commentsListEl, commentInput;
  var currentWorktreePath = null;
  var currentPR = null;
  var replyCounter = 0;

  function init() {
    prInfoEl = document.getElementById('pr-info');
    commentsListEl = document.getElementById('pr-comments-list');
    commentInput = document.getElementById('pr-comment-input');

    document.getElementById('btn-pr-comment').addEventListener('click', submitComment);
    document.getElementById('btn-pr-approve').addEventListener('click', function () { submitReview('approve'); });
    document.getElementById('btn-pr-request-changes').addEventListener('click', function () { submitReview('request-changes'); });

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
    prInfoEl.innerHTML = '';
    commentsListEl.innerHTML = '';
    reloadActiveTab();
  }

  function reloadActiveTab() {
    var activeTab = document.querySelector('#diff-tabs .diff-tab.active');
    if (!activeTab) return;
    var target = activeTab.dataset.tab;
    if (target === 'pr') {
      loadPR();
    } else if (target !== 'changes') {
      if (window._reloadDiffTab) {
        window._reloadDiffTab(target, currentWorktreePath);
      }
    }
  }

  async function loadPR() {
    if (!currentWorktreePath) return;
    prInfoEl.innerHTML = '<div class="pr-loading">Loading PR...</div>';
    commentsListEl.innerHTML = '';

    var result = await window.klaus.prForBranch(currentWorktreePath);

    if (result.error) {
      prInfoEl.innerHTML = '<div class="pr-error">' + escHtml(result.error) + '</div>';
      return;
    }

    if (!result.pr) {
      prInfoEl.innerHTML = '<div class="pr-empty">No pull request found for this branch.</div>';
      return;
    }

    currentPR = result.pr;
    renderPRInfo(result.pr);
    renderComments(result.pr);

    // Also fetch inline review comments
    var reviewComments = await window.klaus.prReviewComments(currentWorktreePath, result.pr.number);
    if (reviewComments.comments && reviewComments.comments.length > 0) {
      renderReviewComments(reviewComments.comments);
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
      html += '<div class="pr-url"><a href="#" class="pr-link" data-url="' + escAttr(pr.url) + '">Open on GitHub</a></div>';
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
        window.klaus.openExternal(link.dataset.url);
      });
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

  function renderReviewComments(comments) {
    if (comments.length === 0) return;

    var html = '<div class="pr-comments-section">';
    html += '<div class="pr-comments-header">Inline Review Comments (' + comments.length + ')</div>';
    comments.forEach(function (c) {
      var time = formatTime(c.created_at);
      var author = c.user ? c.user.login : 'unknown';
      var commentId = c.id || '';
      var side = c.side || 'RIGHT';
      var targetLine = side === 'LEFT' ? (c.original_line || c.original_position) : (c.line || c.position);
      var pathLabel = c.path
        ? (c.path + (targetLine != null ? ':' + targetLine : ''))
        : '';

      var isReply = !!c.in_reply_to_id;
      var itemCls = 'pr-comment-item pr-inline-comment' + (isReply ? ' pr-inline-reply' : '');
      html += '<div class="' + itemCls + '">';
      html += '<div class="pr-comment-meta">';
      html += '<strong>' + escHtml(author) + '</strong>';
      html += ' <span class="pr-comment-time">' + escHtml(time) + '</span>';
      if (!isReply && pathLabel) {
        html += ' on <span class="pr-comment-file">' + escHtml(pathLabel) + '</span>';
      }
      html += '</div>';
      if (!isReply) html += renderReviewHunk(c);
      html += '<div class="pr-comment-body">' + renderMarkdown(c.body) + '</div>';
      // Reply area — inline review comments support threading
      html += buildReplyArea({
        commentId: commentId,
        author: author,
        body: c.body,
        filePath: c.path || null,
        diffHunk: c.diff_hunk || null,
        threadable: true,
      });
      html += '</div>';
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

    var result = await window.klaus.prAiReviewComment({
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
      result = await window.klaus.prReplyToComment(currentWorktreePath, currentPR.number, commentId, body);
    } else {
      // Post as a general PR comment
      result = await window.klaus.prAddComment(currentWorktreePath, currentPR.number, body);
    }

    if (result.error) {
      btn.disabled = false;
      btn.textContent = 'Reply';
      alert('Failed to post reply: ' + (result.error || 'Unknown error'));
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

  // ---- Bottom form: general comment / approve / request changes ----

  async function submitComment() {
    if (!currentPR || !currentWorktreePath) return;
    var body = commentInput.value.trim();
    if (!body) return;

    var btn = document.getElementById('btn-pr-comment');
    btn.disabled = true;
    btn.textContent = 'Posting...';

    var result = await window.klaus.prAddComment(currentWorktreePath, currentPR.number, body);

    btn.disabled = false;
    btn.textContent = 'Comment';

    if (result.error) {
      alert('Failed to post comment: ' + result.error);
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

    var result = await window.klaus.prReview(currentWorktreePath, currentPR.number, event, body || undefined);

    btn.disabled = false;
    btn.textContent = origText;

    if (result.error) {
      alert('Review failed: ' + result.error);
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
    var escaped = escHtml(text);
    escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, function (_match, _lang, code) {
      return '<pre class="pr-code-block">' + code.replace(/\n$/, '') + '</pre>';
    });
    escaped = escaped.replace(/`([^`]+)`/g, '<code class="pr-inline-code">$1</code>');
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    escaped = escaped.replace(/\n/g, '<br>');
    return escaped;
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

  return { init: init, setWorktree: setWorktree, loadPR: loadPR };
})();
