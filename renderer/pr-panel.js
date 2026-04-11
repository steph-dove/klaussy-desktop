// PR panel module — view PR details, comments, leave comments, approve/request changes
window.PRPanel = (function () {
  var prInfoEl, commentsListEl, commentInput;
  var currentWorktreePath = null;
  var currentPR = null;

  function init() {
    prInfoEl = document.getElementById('pr-info');
    commentsListEl = document.getElementById('pr-comments-list');
    commentInput = document.getElementById('pr-comment-input');

    document.getElementById('btn-pr-comment').addEventListener('click', submitComment);
    document.getElementById('btn-pr-approve').addEventListener('click', function () { submitReview('approve'); });
    document.getElementById('btn-pr-request-changes').addEventListener('click', function () { submitReview('request-changes'); });

    // Tab switching
    document.querySelectorAll('#diff-tabs .diff-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('#diff-tabs .diff-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var target = tab.dataset.tab;
        document.getElementById('changes-tab-content').style.display = target === 'changes' ? '' : 'none';
        document.getElementById('pr-tab-content').style.display = target === 'pr' ? '' : 'none';
        if (target === 'pr') {
          loadPR();
        }
      });
    });
  }

  function setWorktree(worktreePath) {
    currentWorktreePath = worktreePath;
    currentPR = null;
    prInfoEl.innerHTML = '';
    commentsListEl.innerHTML = '';
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
      html += '<div class="pr-body">' + escHtml(pr.body) + '</div>';
    }
    html += '</div>';

    prInfoEl.innerHTML = html;

    // Bind GitHub link
    var link = prInfoEl.querySelector('.pr-link');
    if (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        window.klaus.openExternal(link.dataset.url);
      });
    }
  }

  function renderComments(pr) {
    var items = [];

    // Issue-level comments
    if (pr.comments) {
      pr.comments.forEach(function (c) {
        items.push({
          type: 'comment',
          author: c.author ? c.author.login : 'unknown',
          body: c.body,
          createdAt: c.createdAt,
        });
      });
    }

    // Reviews
    if (pr.reviews) {
      pr.reviews.forEach(function (r) {
        if (r.state === 'COMMENTED' && !r.body) return; // skip empty comment reviews
        items.push({
          type: 'review',
          author: r.author ? r.author.login : 'unknown',
          body: r.body || '',
          state: r.state,
          createdAt: r.submittedAt || r.createdAt,
        });
      });
    }

    // Sort by date
    items.sort(function (a, b) {
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    if (items.length === 0) {
      commentsListEl.innerHTML = '<div class="pr-empty">No comments yet.</div>';
      return;
    }

    var html = '<div class="pr-comments-header">Comments (' + items.length + ')</div>';
    items.forEach(function (item) {
      html += renderCommentItem(item);
    });
    commentsListEl.innerHTML = html;
  }

  function renderReviewComments(comments) {
    if (comments.length === 0) return;

    var html = '<div class="pr-comments-header">Inline Review Comments (' + comments.length + ')</div>';
    comments.forEach(function (c) {
      var time = formatTime(c.created_at);
      html += '<div class="pr-comment-item pr-inline-comment">';
      html += '<div class="pr-comment-meta">';
      html += '<strong>' + escHtml(c.user ? c.user.login : 'unknown') + '</strong>';
      html += ' <span class="pr-comment-time">' + escHtml(time) + '</span>';
      if (c.path) {
        html += ' on <span class="pr-comment-file">' + escHtml(c.path) + '</span>';
      }
      html += '</div>';
      if (c.diff_hunk) {
        html += '<pre class="pr-comment-hunk">' + escHtml(c.diff_hunk.split('\n').slice(-3).join('\n')) + '</pre>';
      }
      html += '<div class="pr-comment-body">' + escHtml(c.body) + '</div>';
      html += '</div>';
    });

    commentsListEl.innerHTML += html;
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
      html += '<div class="pr-comment-body">' + escHtml(item.body) + '</div>';
    }
    html += '</div>';
    return html;
  }

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

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  }

  return { init: init, setWorktree: setWorktree, loadPR: loadPR };
})();
