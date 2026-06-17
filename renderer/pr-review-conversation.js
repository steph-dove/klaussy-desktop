// Part of the PrReview surface (window.PrReview); see pr-review.js for the
// core. Conversation tab: threads, comments, review submission.
// All cross-references go through the shared `PR` object, so load order
// only needs core (pr-review.js) first; siblings may load in any order.

(function (PR) {

  PR.firstTwoLines = function(text) {
    if (!text) return '';
    var lines = text.split('\n').filter(function (l) { return l.trim(); });
    var joined = lines.slice(0, 2).join(' ');
    return joined.length > 140 ? joined.slice(0, 140) + '\u2026' : joined;
  };

  PR.renderMarkdownBody = function(body) {
    if (window.MarkdownPreview && window.MarkdownPreview.render) {
      return '<div class="pr-conv-md">' + window.MarkdownPreview.render(body, { breaks: true }) + '</div>';
    }
    return PR.escHtml(body).replace(/\n/g, '<br>');
  };

  // Render comment bodies as full markdown (markdown-it + hljs + DOMPurify via
  // MarkdownPreview), wrapped in .pr-conv-md for scoped prose styling. A posted
  // review finding still carries its [Severity:]/[Location:]/[Category:]
  // metadata — render that with the same severity-dot / category-tag / location
  // treatment as the Review tab instead of dumping the brackets.
  PR.renderCommentBody = function(body) {
    if (!body) return '';
    if (/\*{0,2}\[Severity\s*:/i.test(body)) return PR.renderFindingComment(body);
    return PR.renderMarkdownBody(body);
  };

  PR.renderFindingComment = function(body) {
    var sev = (PR.severityOf ? PR.severityOf(body) : '').toLowerCase();
    var category = PR.parseCategory ? PR.parseCategory(body) : '';
    var loc = PR.parseLocation ? PR.parseLocation(body) : null;
    var sevKey = sev ? sev.replace(/\s+/g, '-') : 'note';
    var sevLabel = (PR.SEV_LABELS && PR.SEV_LABELS[sev])
      || (sev ? sev.charAt(0).toUpperCase() + sev.slice(1) : '');
    var dot = sev
      ? '<span class="pr-ai-finding-sev pr-ai-finding-sev-' + sevKey + '">'
          + '<span class="pr-ai-finding-dot"></span>' + PR.escHtml(sevLabel) + '</span>'
      : '';
    var cat = category ? '<span class="pr-ai-finding-cat">' + PR.escHtml(category) + '</span>' : '';
    var header = (dot || cat)
      ? '<div class="pr-ai-finding-head-row"><span class="pr-ai-finding-head-left">' + dot + cat + '</span></div>'
      : '';
    var locText = loc ? loc.path + ':' + loc.line + (loc.endLine ? '-' + loc.endLine : '') : '';
    var locDesc = loc && loc.snippet ? loc.snippet.replace(/^[\s,;]+/, '').trim() : '';
    var locLabel = locText
      ? '<div class="pr-ai-finding-loc-label"' + (locDesc ? ' title="' + PR.escHtml(locText + ' — ' + locDesc) + '"' : '') + '>'
          + '<span class="pr-ai-finding-loc-path">' + PR.escHtml(locText) + '</span></div>'
      : '';
    var clean = PR.stripFindingHeaders ? PR.stripFindingHeaders(body) : body;
    return '<div class="pr-conv-finding">' + header + locLabel + PR.renderMarkdownBody(clean) + '</div>';
  };

  // The timeline gutter dot: a colored initial avatar (reusing the sidebar's
  // iconColor palette) so every item has a visual anchor. opts lets AI findings
  // override the color/letter/class to read as the distinct Klaussy marker.
  PR.avatarHtml = function(login, opts) {
    opts = opts || {};
    var name = login || '?';
    var color = opts.color || ((window.AppUtils && AppUtils.iconColor) ? AppUtils.iconColor(name) : 'var(--surface-hover)');
    var letter = opts.letter || name.charAt(0).toUpperCase();
    var cls = 'pr-conv-avatar' + (opts.cls ? ' ' + opts.cls : '');
    return '<span class="' + cls + '" style="background:' + color + '" title="' + PR.escHtml(name) + '">'
      + PR.escHtml(letter) + '</span>';
  };

  // Reddit-style gutter: the avatar sits on top of a collapse rail that runs
  // the full height of the comment (and any nested replies, since the item is a
  // flex row and the gutter stretches to match the content column). Clicking
  // the rail folds the comment — see the delegated handler in pr-review.js.
  PR.gutterHtml = function(avatar) {
    return '<div class="pr-conv-gutter">'
      + avatar
      + '<button class="pr-conv-collapse" type="button" title="Collapse thread" aria-label="Collapse thread"></button>'
    + '</div>';
  };

  // Agent-posted review findings are issue comments whose body carries the
  // Klaussy signature — detect heuristically so they get the accent marker.
  PR.isAiFinding = function(body) {
    // Match the unambiguous parts so any hyphen variant in "AI-generated" or
    // markdown emphasis around it doesn't break detection.
    return /via\s*Klaussy|generated\s+review\s+finding/i.test(body || '');
  };

  PR.bindThreadControls = function() {
    PR.hostEl.querySelectorAll('.pr-inline-thread').forEach(function (el) {
      var head = el.querySelector('.pr-inline-thread-head');
      head.addEventListener('click', function () {
        el.classList.toggle('collapsed');
      });
    });
  };

  // ---- Conversation tab: per-comment Claude actions ----

  PR.getConvClaudeState = function(dbid) {
    if (!dbid) return null;
    if (!PR.convClaudeState[dbid]) PR.convClaudeState[dbid] = {
      investigateId: null, investigateStreaming: '', investigateResult: '', investigateError: null,
      implementId: null, implementOut: '', implementError: null,
      implementDraft: '', implementDraftStatus: null,
    };
    return PR.convClaudeState[dbid];
  };

  // Renders the Claude action row + any in-flight panels for one comment.
  // `ctx` carries everything the button handlers need: dbid, kind ('issue' |
  // 'review'), the comment body (prompt context), and for review comments
  // the thread path/line/replyParentId so an approved draft posts correctly.
  PR.renderConvClaudeBlock = function(ctx) {
    if (!ctx || !ctx.dbid) return '';
    var s = PR.getConvClaudeState(ctx.dbid);
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

    // Reply sits inline with Investigate/Implement on the thread's last comment.
    var replyBtn = (ctx.showReply && ctx.replyParentId)
      ? '<button class="pr-conv-reply-btn" type="button" data-reply-to="' + ctx.replyParentId + '">Reply</button>'
      : '';
    var actions = '<div class="pr-conv-claude-actions">' + investigateBtn + implementBtn + replyBtn + '</div>';

    var investigatePanel = '';
    if (s.investigateId || s.investigateResult || s.investigateError) {
      var body;
      if (s.investigateId) {
        var stream = (s.investigateStreaming || '').trim();
        body = stream
          ? '<div class="pr-conv-claude-investigate-body streaming">' + PR.renderMarkdown(s.investigateStreaming) + '</div>'
          : '<div class="pr-conv-claude-investigate-body streaming status-pulse">Investigating…</div>';
      } else if (s.investigateError) {
        body = '<div class="pr-conv-claude-investigate-error">' + PR.escHtml(s.investigateError) + '</div>';
      } else {
        body = '<div class="pr-conv-claude-investigate-body">' + PR.renderMarkdown(s.investigateResult) + '</div>';
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
        iBody = '<div class="pr-conv-claude-implement-error">' + PR.escHtml(s.implementError) + '</div>';
      } else {
        var out = (s.implementOut || '').trim();
        iBody = '<div class="pr-conv-claude-implement-body' + (s.implementId ? ' streaming' : '') + '">'
          + (out ? PR.escHtml(out) : (s.implementId ? 'Applying changes…' : ''))
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
            + '<span class="pr-conv-claude-draft-anchor">' + PR.escHtml(anchor) + '</span>'
          + '</div>'
          + '<textarea class="pr-conv-claude-draft-input" rows="3">' + PR.escHtml(s.implementDraft) + '</textarea>'
          + (s.draftError ? '<div class="pr-conv-claude-draft-error">' + PR.escHtml(s.draftError) + '</div>' : '')
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
  };

  // ---- Conversation tab (GitHub-style feed) ----

  PR.renderConversation = function(state) {
    var meta = state.meta || {};
    var items = PR.buildConversationItems(state);
    var author = (meta.author && (meta.author.login || meta.author.name)) || 'unknown';
    var when = meta.createdAt ? new Date(meta.createdAt).toLocaleString() : '';

    var body = '<div class="pr-conv-item pr-conv-description">'
      + PR.avatarHtml(author)
      + '<div class="pr-conv-main">'
        + '<div class="pr-conv-head">'
          + '<span class="pr-conv-author">' + PR.escHtml(author) + '</span>'
          + '<span class="pr-conv-kind">opened this pull request</span>'
          + (when ? '<span class="pr-conv-when">' + PR.escHtml(when) + '</span>' : '')
        + '</div>'
        + '<div class="pr-conv-body">' + (meta.body ? PR.renderCommentBody(meta.body) : '<em class="pr-conv-empty">No description provided.</em>') + '</div>'
      + '</div>'
    + '</div>';

    // When the threads/comments fetch failed, don't imply the PR is empty —
    // show the actionable gh-error banner instead of "No comments yet".
    var feed;
    if (state.threadsError) {
      feed = PR.renderGhErrorBanner(state.threadsError, state.threadsErrorFix)
        + (items.length ? items.map(PR.renderConversationItem).join('') : '');
    } else {
      feed = items.length === 0
        ? '<div class="pr-conv-empty-feed">No comments or reviews yet.</div>'
        : items.map(PR.renderConversationItem).join('');
    }

    var composer = '<div class="pr-conv-new-comment">'
        + '<div class="pr-conv-new-head">Add a comment</div>'
        + '<textarea class="pr-conv-new-body" placeholder="Write a general comment (\u2318\u23CE to post)" rows="3"></textarea>'
        + '<div class="pr-conv-new-actions">'
          + '<button class="pr-conv-new-post" type="button">Comment</button>'
        + '</div>'
      + '</div>';

    return body + feed + composer;
  };

  PR.buildConversationItems = function(state) {
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
  };

  PR.renderConversationItem = function(item) {
    if (item.kind === 'comment') return PR.renderIssueComment(item.data);
    if (item.kind === 'review') return PR.renderReviewSubmission(item.data, item.originatedThreads);
    return '';
  };

  PR.renderIssueComment = function(c) {
    var author = (c.author && c.author.login) || 'unknown';
    var when = c.createdAt ? new Date(c.createdAt).toLocaleString() : '';
    var dbid = c.databaseId;
    var displayBody = (dbid != null && PR.editedCommentOverrides[dbid] != null)
      ? PR.editedCommentOverrides[dbid]
      : c.body;
    var mine = PR.currentUserLogin && author === PR.currentUserLogin;
    var isEditing = PR.editingCommentId === dbid && PR.editingCommentKind === 'issue';
    var claudeBlock = (dbid != null && !isEditing)
      ? PR.renderConvClaudeBlock({ dbid: dbid, kind: 'issue', body: displayBody || '' })
      : '';
    var aiFinding = PR.isAiFinding(displayBody);
    var avatar = aiFinding
      ? PR.avatarHtml('Klaussy', { color: 'var(--accent)', letter: 'K', cls: 'pr-conv-avatar-ai' })
      : PR.avatarHtml(author);
    return '<div class="pr-conv-item pr-conv-comment' + (aiFinding ? ' pr-conv-ai-finding' : '') + '">'
      + avatar
      + '<div class="pr-conv-main">'
        + '<div class="pr-conv-head">'
          + '<span class="pr-conv-author">' + PR.escHtml(aiFinding ? 'Klaussy' : author) + '</span>'
          + '<span class="pr-conv-kind">' + (aiFinding ? 'review finding' : 'commented') + '</span>'
          + '<span class="pr-conv-when">' + PR.escHtml(when) + '</span>'
          + (mine && !isEditing && dbid != null && !aiFinding
              ? '<button class="pr-conv-edit-btn" type="button" data-kind="issue" data-id="' + dbid + '" title="Edit">✎</button>'
              : '')
        + '</div>'
        + (isEditing
            ? PR.renderCommentEditor(dbid, 'issue', displayBody)
            : '<div class="pr-conv-body">' + PR.renderCommentBody(displayBody) + '</div>')
        + claudeBlock
      + '</div>'
    + '</div>';
  };

  // Shared composer markup used by both issue comments and inline review
  // thread comments. The save handler picks the PATCH endpoint based on
  // `kind` (stored on the wrapper via data-kind).
  PR.renderCommentEditor = function(dbid, kind, body) {
    return '<div class="pr-conv-edit-wrap" data-id="' + dbid + '" data-kind="' + kind + '">'
      + '<textarea class="pr-conv-edit-input" rows="5">' + PR.escHtml(body || '') + '</textarea>'
      + '<div class="pr-conv-edit-actions">'
        + '<span class="pr-conv-edit-error"></span>'
        + '<button class="pr-conv-edit-cancel" type="button">Cancel</button>'
        + '<button class="pr-conv-edit-save" type="button">Save</button>'
      + '</div>'
    + '</div>';
  };

  PR.renderReviewSubmission = function(r, originatedThreads) {
    var author = (r.author && r.author.login) || 'unknown';
    var when = r.submittedAt ? new Date(r.submittedAt).toLocaleString() : '';
    var stateLabel = PR.reviewStateLabel(r.state);
    var stateCls = 'pr-conv-state pr-conv-state-' + (r.state || '').toLowerCase();
    var threads = originatedThreads || [];

    var threadsHtml = '';
    if (threads.length > 0) {
      threadsHtml = '<div class="pr-conv-inline-list">'
        + threads.map(PR.renderConversationThread).join('')
      + '</div>';
    }

    var bodyHtml = r.body && r.body.trim() ? '<div class="pr-conv-body">' + PR.renderCommentBody(r.body) + '</div>' : '';

    return '<div class="pr-conv-item pr-conv-review">'
      + PR.avatarHtml(author)
      + '<div class="pr-conv-main">'
        + '<div class="pr-conv-head">'
          + '<span class="pr-conv-author">' + PR.escHtml(author) + '</span>'
          + '<span class="' + stateCls + '">' + PR.escHtml(stateLabel) + '</span>'
          + (threads.length > 0 ? '<span class="pr-conv-inline-count">' + threads.length + ' inline</span>' : '')
          + '<span class="pr-conv-when">' + PR.escHtml(when) + '</span>'
        + '</div>'
        + bodyHtml
        + threadsHtml
      + '</div>'
    + '</div>';
  };

  // Render a full thread: the hunk context once, then every comment in the
  // thread stacked (originator + replies), and a Reply composer trigger on
  // the *last* comment so replying posts to the right parent.
  PR.renderConversationThread = function(thread) {
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
      var displayBody = (dbid != null && PR.editedCommentOverrides[dbid] != null)
        ? PR.editedCommentOverrides[dbid]
        : c.body;
      var mine = PR.currentUserLogin && author === PR.currentUserLogin;
      var isEditing = PR.editingCommentId === dbid && PR.editingCommentKind === 'review';
      var claudeBlock = (dbid != null && !isEditing)
        ? PR.renderConvClaudeBlock({
            dbid: dbid,
            kind: 'review',
            body: displayBody || '',
            path: threadPath,
            hunk: threadHunk,
            replyParentId: replyParentId,
            showReply: i === comments.length - 1,
          })
        : '';
      return '<div class="pr-conv-thread-comment' + (i === 0 ? ' first' : '') + '">'
        + '<div class="pr-conv-thread-comment-head">'
          + '<span class="pr-conv-author">' + PR.escHtml(author) + '</span>'
          + '<span class="pr-conv-when">' + PR.escHtml(when) + '</span>'
          + (mine && !isEditing && dbid != null
              ? '<button class="pr-conv-edit-btn" type="button" data-kind="review" data-id="' + dbid + '" title="Edit">✎</button>'
              : '')
        + '</div>'
        + (isEditing
            ? PR.renderCommentEditor(dbid, 'review', displayBody)
            : '<div class="pr-conv-thread-comment-body">' + PR.renderCommentBody(displayBody) + '</div>')
        + claudeBlock
      + '</div>';
    }).join('');

    // Reply now lives inline with Investigate/Implement on the last comment
    // (see renderConvClaudeBlock's showReply), so no separate thread-bottom row.
    return '<div class="pr-conv-inline pr-conv-thread' + resolvedCls + outdatedCls + '">'
      + (path ? '<div class="pr-conv-inline-path">' + PR.escHtml(path)
          + (thread.isResolved ? ' <span class="pr-inline-thread-badge resolved">resolved</span>' : '')
          + (thread.isOutdated ? ' <span class="pr-inline-thread-badge outdated">outdated</span>' : '')
        + '</div>' : '')
      + (first.diffHunk ? '<pre class="pr-conv-inline-hunk">' + PR.escHtml(PR.lastLinesOfHunk(first.diffHunk, 4)) + '</pre>' : '')
      + '<div class="pr-conv-thread-comments">' + commentsHtml + '</div>'
    + '</div>';
  };

  PR.reviewStateLabel = function(state) {
    switch ((state || '').toUpperCase()) {
      case 'APPROVED': return 'approved these changes';
      case 'CHANGES_REQUESTED': return 'requested changes';
      case 'COMMENTED': return 'reviewed';
      case 'DISMISSED': return 'dismissed review';
      case 'PENDING': return 'pending review';
      default: return (state || '').toLowerCase();
    }
  };

  // diffHunk from the GraphQL API is the full hunk context up to the commented
  // line — showing the tail gives meaningful context without flooding the feed.
  PR.lastLinesOfHunk = function(hunk, n) {
    var lines = (hunk || '').split('\n');
    return lines.slice(Math.max(0, lines.length - n)).join('\n');
  };

  // ---- G6: CI checks + merge ----

  PR.fetchAndRenderChecks = async function(forNumber) {
    var result = await window.klaus.pr.reviewChecks();
    // Drop stale results if the user switched PRs mid-flight.
    if (!PR.lastState || PR.lastState.number !== forNumber) return;
    PR.currentChecks = result;
    // Required-checks list is independent of the per-commit checks data; fetch
    // in parallel-ish (after main checks so the user sees something fast).
    try {
      var req = await window.klaus.pr.reviewRequiredChecks();
      if (PR.lastState && PR.lastState.number === forNumber) {
        PR.currentRequiredChecks = (req && req.required) || [];
        PR.currentRequiredChecksError = (req && req.error) || '';
      }
    } catch (err) {
      // The gate must not silently green-light merges if the fetch itself
      // crashes (the IPC handler is supposed to catch and return an error,
      // but renderer crashes happen too). Surface as "unknown" in the gate.
      if (PR.lastState && PR.lastState.number === forNumber) {
        PR.currentRequiredChecks = [];
        PR.currentRequiredChecksError = (err && err.message) || 'unknown error';
      }
    }
    PR.renderChecksIntoSlot();
    // Merge gate depends on checks, so repaint the merge control too.
    var mergeWrap = PR.hostEl.querySelector('.pr-merge-wrap');
    if (mergeWrap) PR.updateMergeGate(mergeWrap, PR.lastState);
  };

  PR.renderChecksTabCount = function() {
    if (!PR.currentChecks || !PR.currentChecks.checks) return '';
    var n = PR.currentChecks.checks.length;
    if (!n) return '';
    return ' <span class="pr-tab-count">' + n + '</span>';
  };

  PR.renderChecksTab = function() {
    if (!PR.currentChecks) {
      return '<div class="pr-conv-empty-feed">Loading checks\u2026</div>';
    }
    if (PR.currentChecks.error) {
      return '<div class="pr-checks-error">Checks failed: ' + PR.escHtml(PR.currentChecks.error) + '</div>';
    }
    var checks = PR.currentChecks.checks || [];
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
    if (PR.currentRequiredChecksError) {
      requiredGate = '<div class="pr-required-gate pr-required-unknown" title="' + PR.escHtml(PR.currentRequiredChecksError) + '">'
        + '<div class="pr-required-summary">'
          + 'Required checks: <strong>unknown</strong> — could not load branch protection rules. Verify on GitHub before merging.'
        + '</div>'
      + '</div>';
    } else if (PR.currentRequiredChecks && PR.currentRequiredChecks.length > 0) {
      var passingRequired = 0;
      var chipHtml = PR.currentRequiredChecks.map(function (name) {
        var match = checks.find(function (c) { return (c.name || '') === name; });
        var b = match ? bucketOf(match) : 'missing';
        if (b === 'pass') passingRequired += 1;
        return '<span class="pr-required-chip pr-required-' + b + '" title="' + PR.escHtml(b) + '">' + PR.escHtml(name) + '</span>';
      }).join('');
      var allPass = passingRequired === PR.currentRequiredChecks.length;
      requiredGate = '<div class="pr-required-gate ' + (allPass ? 'pr-required-all-pass' : 'pr-required-blocking') + '">'
        + '<div class="pr-required-summary">'
          + '<strong>' + passingRequired + '/' + PR.currentRequiredChecks.length + '</strong> required check' + (PR.currentRequiredChecks.length === 1 ? '' : 's') + ' passing'
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
      // Failing checks with an id can expand their file:line annotations inline
      // \u2014 the whole row is the toggle (chevron rotates), so no separate button.
      var expandable = b === 'fail' && c.id != null && c.id !== '';
      var debugBtn = (b === 'fail' && c.link)
        ? '<button class="pr-check-debug-btn" type="button" data-link="' + PR.escHtml(c.link) + '" data-name="' + PR.escHtml(c.name || '') + '" data-check-id="' + PR.escHtml(c.id ? String(c.id) : '') + '" title="Use the agent to diagnose this failure">Debug</button>'
        : '';
      // Primary action for failing checks: spawn Claude in the PR worktree
      // with edit tools, then surface the resulting diff for the user to
      // review and push.
      var fixBtn = (b === 'fail' && c.link && c.id)
        ? '<button class="pr-check-fix-btn pr-check-action-primary" type="button" data-link="' + PR.escHtml(c.link) + '" data-name="' + PR.escHtml(c.name || '') + '" data-check-id="' + PR.escHtml(String(c.id)) + '" title="Have the agent edit, commit, and push a fix">Fix</button>'
        : '';
      var rerunBtn = (b === 'fail' && c.runId)
        ? '<button class="pr-check-action-btn pr-check-action-rerun" type="button" data-run-id="' + PR.escHtml(String(c.runId)) + '" data-name="' + PR.escHtml(c.name || '') + '" title="Rerun failed jobs in this workflow run">Rerun</button>'
        : '';
      var cancelBtn = (b === 'pending' && c.runId)
        ? '<button class="pr-check-action-btn pr-check-action-cancel" type="button" data-run-id="' + PR.escHtml(String(c.runId)) + '" data-name="' + PR.escHtml(c.name || '') + '" title="Cancel this workflow run">Cancel</button>'
        : '';
      var watchBtn = (b === 'pending' && c.runId)
        ? '<button class="pr-check-action-btn pr-check-action-watch" type="button" data-run-id="' + PR.escHtml(String(c.runId)) + '" data-name="' + PR.escHtml(c.name || '') + '" title="Stream the workflow log live">Watch log</button>'
        : '';
      var openBtn = c.link
        ? '<button class="pr-check-open" type="button" data-link="' + PR.escHtml(c.link) + '" title="Open on GitHub">\u2197</button>'
        : '';
      var dur = formatDur(c.startedAt, c.completedAt);
      var durHtml = dur ? '<span class="pr-check-dur">' + dur + '</span>' : '';
      var sub = [c.workflow, c.description].filter(Boolean).map(PR.escHtml).join(' \u00B7 ');
      var chevron = '<span class="pr-check-chevron' + (expandable ? '' : ' pr-check-chevron-hidden') + '">\u203A</span>';
      var attrs = ' class="pr-check-row pr-check-' + b + (expandable ? ' pr-check-expandable' : '') + '"';
      if (c.link) attrs += ' data-link="' + PR.escHtml(c.link) + '"';
      if (expandable) attrs += ' data-check-id="' + PR.escHtml(String(c.id)) + '"';
      return '<div' + attrs + '>'
        + chevron
        + '<span class="pr-check-icon">' + icon + '</span>'
        + '<div class="pr-check-labels">'
          + '<div class="pr-check-name">' + PR.escHtml(c.name || '(unnamed)') + '</div>'
          + (sub ? '<div class="pr-check-sub">' + sub + '</div>' : '')
        + '</div>'
        + '<div class="pr-check-meta">' + durHtml + '<span class="pr-check-state">' + PR.escHtml((c.state || b).toLowerCase()) + '</span></div>'
        + '<div class="pr-check-actions">' + watchBtn + rerunBtn + cancelBtn + debugBtn + fixBtn + openBtn + '</div>'
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
          + '<span class="pr-check-group-label">' + PR.escHtml(workflowName || ('Run #' + runId)) + '</span>'
          + '<span class="pr-check-group-meta">' + items.length + ' job' + (items.length === 1 ? '' : 's') + (dur ? ' \u00B7 ' + dur : '') + '</span>'
        + '</div>'
        + '<div class="pr-check-group-rows">' + items.map(renderRowHtml).join('') + '</div>'
      + '</div>';
    }).join('');

    var looseHtml = loose.length ? '<div class="pr-checks-list">' + loose.map(renderRowHtml).join('') + '</div>' : '';

    return header + requiredGate + groupHtml + looseHtml;
  };

  PR.bindChecksTab = function() {
    var refresh = PR.hostEl.querySelector('.pr-checks-refresh');
    if (refresh) {
      refresh.addEventListener('click', function () {
        refresh.disabled = true;
        refresh.textContent = 'Refreshing\u2026';
        // Force the repaint even if the data hasn't changed \u2014 the button
        // text/disabled state needs to reset, and the user explicitly asked
        // for a refresh so they expect a visible response.
        PR.fetchAndRenderChecks(PR.lastState && PR.lastState.number)
          .then(function () { PR.repaintChecksTab({ force: true }); });
      });
    }
    // Auto-refresh: pull fresh data on every tab activation, then poll while
    // the tab stays active. Without this, an in-progress run kicked off
    // moments ago wouldn't show up until the user manually clicked Refresh
    // (the per-task CI poll updates the sidebar icon but not this surface).
    PR.startChecksPolling();
    var dispatchBtn = PR.hostEl.querySelector('.pr-checks-dispatch');
    if (dispatchBtn) {
      dispatchBtn.addEventListener('click', function () { PR.openWorkflowDispatchModal(); });
    }
    PR.hostEl.querySelectorAll('.pr-check-row').forEach(function (row) {
      row.addEventListener('click', function (e) {
        // Inline action buttons handle their own clicks.
        if (e.target.closest('button')) return;
        // Failing checks expand their annotations; everything else opens the run.
        if (row.classList.contains('pr-check-expandable') && row.dataset.checkId) {
          PR.toggleAnnotations(row);
          return;
        }
        var url = row.dataset.link;
        if (url) window.klaus.gh.openExternal(url);
      });
    });
    PR.hostEl.querySelectorAll('.pr-check-open').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var url = btn.dataset.link;
        if (url) window.klaus.gh.openExternal(url);
      });
    });
    PR.hostEl.querySelectorAll('.pr-check-debug-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        PR.startDebugCheck(btn);
      });
    });
    PR.hostEl.querySelectorAll('.pr-check-fix-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        PR.startFixCheck(btn);
      });
    });
    PR.hostEl.querySelectorAll('.pr-check-action-rerun').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        PR.runQuickAction(btn, 'rerun');
      });
    });
    PR.hostEl.querySelectorAll('.pr-check-action-cancel').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        PR.runQuickAction(btn, 'cancel');
      });
    });
    PR.hostEl.querySelectorAll('.pr-check-action-watch').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        PR.toggleLogWatch(btn);
      });
    });
    // Restore any panels the user had open before this re-render. Survives
    // both polling repaints and full render() rebuilds (which call
    // bindChecksTab via the tab-activation path).
    PR.restoreOpenAnnotations();
    PR.restoreOpenDebugChecks();
  };

  // Live log tail for an in-progress run. Click again to stop. Renders into a
  // panel below the row with auto-scroll to bottom unless the user has
  // scrolled up (basic stick-to-bottom behavior).
  PR.toggleLogWatch = function(btn) {
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
        + '<span>Tailing run #' + PR.escHtml(runId) + '</span>'
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
  };

  // Shared rerun/cancel handler. Button label flips to a transient state, then
  // the Checks tab is refreshed once gh returns. Errors surface on the button
  // itself rather than a toast — keeps the row in scope for the user.
  PR.runQuickAction = function(btn, kind) {
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
      PR.fetchAndRenderChecks(PR.lastState && PR.lastState.number)
        .then(function () { PR.repaintChecksTab({ force: true }); });
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = 'Failed';
      btn.title = (err && err.message) || 'unknown error';
    });
  };

})(window.PrReview);
