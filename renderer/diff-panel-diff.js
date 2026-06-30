// Part of the DiffPanel surface (window.DiffPanel); see diff-panel.js for the core.
// diff rendering, staging, commit area, inline comments, keybinds.
// Cross-references go through the shared `DP` object; load order only
// needs the core file first, siblings may load in any order after it.

(function (DP) {

  // Side-by-side split view, reusing parseAndHighlight to match the unified renderer.
  // Pairs consecutive - with + into rows; pure adds/dels get a blank opposite slot.
  // Checkboxes live in the pane owning the line (LEFT for -, RIGHT for +).
  DP.renderDiffSplit = function(diffText) {
    var parsed = DP.parseAndHighlight(diffText);
    var lines = parsed.lines;
    var hunks = parsed.hunks;
    var highlightedLines = parsed.highlightedLines;

    var allowStaging = DP.diffMode === 'working';
    var stageVerb = DP.currentDiffStaged ? 'Unstage' : 'Stage';

    var html = '';

    // File meta (everything before the first @@ of the first hunk) rendered
    // full-width above the grid so paths, diff header, new/deleted markers,
    // and binary-file notices stay visible.
    var firstHunkLineIdx = hunks.length > 0 ? hunks[0].start : lines.length;
    for (var i = 0; i < firstHunkLineIdx; i++) {
      var meta = lines[i];
      if (!meta) continue;
      if (meta.startsWith('diff ')) {
        html += '<div class="diff-split-meta diff-header">' + DP.escHtml(meta) + '</div>';
      } else {
        html += '<div class="diff-split-meta diff-meta">' + DP.escHtml(meta) + '</div>';
      }
    }

    hunks.forEach(function (hunk, hi) {
      var header = hunk.lines[0];
      var hm = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      var oldLn = hm ? parseInt(hm[1], 10) - 1 : 0;
      var newLn = hm ? parseInt(hm[2], 10) - 1 : 0;

      var stageBtn = allowStaging
        ? '<button class="diff-stage-hunk-btn" data-hunk-index="' + hi + '" title="' + stageVerb + ' this hunk">' + stageVerb + ' hunk</button>'
        : '';
      html += '<div class="diff-line diff-hunk diff-split-hunk-header" data-hunk-index="' + hi + '">'
        + '<span class="diff-hunk-text">' + DP.escHtml(header) + '</span>'
        + '<button class="diff-explain-btn" data-hunk-index="' + hi + '" title="Explain this change">Explain</button>'
        + stageBtn
        + '</div>';

      var body = hunk.lines.slice(1);
      var bodyStartIdx = hunk.start + 1; // index into `lines` for body[0]
      var b = 0;

      function paneAdd(info) {
        var cls = 'diff-line diff-split-right diff-add';
        var code = highlightedLines[info.idx] || DP.escHtml(info.text);
        return '<div class="' + cls + '" data-new-ln="' + info.newLn + '" data-side="RIGHT">'
          + '<span class="diff-ln-gutter">' + info.newLn + '</span>'
          + '<span class="diff-prefix">+</span>'
          + '<span class="diff-code">' + code + '</span>'
          + '</div>';
      }
      function paneDel(info) {
        var cls = 'diff-line diff-split-left diff-del';
        var code = highlightedLines[info.idx] || DP.escHtml(info.text);
        return '<div class="' + cls + '" data-old-ln="' + info.oldLn + '" data-side="LEFT">'
          + '<span class="diff-ln-gutter">' + info.oldLn + '</span>'
          + '<span class="diff-prefix">-</span>'
          + '<span class="diff-code">' + code + '</span>'
          + '</div>';
      }
      function paneBlank(side) {
        return '<div class="diff-line diff-blank diff-split-' + side + '"></div>';
      }
      function paneContext(info, side) {
        var cls = 'diff-line diff-split-' + side + ' diff-context';
        var code = highlightedLines[info.idx] || DP.escHtml(info.text);
        var lnAttr = side === 'left'
          ? 'data-old-ln="' + info.oldLn + '"'
          : 'data-new-ln="' + info.newLn + '" data-side="RIGHT"';
        var lnVal = side === 'left' ? info.oldLn : info.newLn;
        return '<div class="' + cls + '" ' + lnAttr + '>'
          + '<span class="diff-ln-gutter">' + lnVal + '</span>'
          + '<span class="diff-prefix"> </span>'
          + '<span class="diff-code">' + code + '</span>'
          + '</div>';
      }

      while (b < body.length) {
        var line = body[b];
        if (line.startsWith('\\')) { b++; continue; } // no-newline marker — skip in split view
        if (line.startsWith(' ') || line === '') {
          oldLn++; newLn++;
          var ctxInfo = { idx: bodyStartIdx + b, oldLn: oldLn, newLn: newLn, text: line.length > 0 ? line.substring(1) : '' };
          html += paneContext(ctxInfo, 'left') + paneContext(ctxInfo, 'right');
          b++;
        } else {
          // Line keys use body index (b+1) to match buildPartialPatch, which
          // is body-index-based. Counting content lines instead would drift
          // whenever a `\ No newline` marker sits inside the hunk body.
          var dels = [];
          while (b < body.length && body[b].startsWith('-')) {
            oldLn++;
            dels.push({ idx: bodyStartIdx + b, oldLn: oldLn, key: hi + ':' + (b + 1), text: body[b].substring(1) });
            b++;
          }
          while (b < body.length && body[b].startsWith('\\')) b++;
          var adds = [];
          while (b < body.length && body[b].startsWith('+')) {
            newLn++;
            adds.push({ idx: bodyStartIdx + b, newLn: newLn, key: hi + ':' + (b + 1), text: body[b].substring(1) });
            b++;
          }
          while (b < body.length && body[b].startsWith('\\')) b++;
          var rowCount = Math.max(dels.length, adds.length);
          for (var k = 0; k < rowCount; k++) {
            html += (dels[k] ? paneDel(dels[k]) : paneBlank('left'));
            html += (adds[k] ? paneAdd(adds[k]) : paneBlank('right'));
          }
        }
      }
    });

    return '<div class="diff-split-grid">' + html + '</div>';
  };

  DP.toggleCommitArea = function() {
    var visible = DP.commitAreaEl.style.display !== 'none';
    DP.commitAreaEl.style.display = visible ? 'none' : 'flex';
    if (!visible) {
      DP.commitInput.focus();
      // Fresh open = fresh review state for whatever is staged now. A review
      // still in flight from the previous open keeps the button disabled —
      // re-enabling here allowed double doCommit races.
      DP.commitFlowGen++;
      DP.precommitCleared = false;
      DP.clearPrecommitFindings();
      var b = document.getElementById('btn-do-commit');
      if (b) { b.textContent = DP.precommitPending ? 'Reviewing changes…' : 'Commit'; b.disabled = DP.precommitPending; }
    }
  };

  // ---- Pre-commit silent-failure review (app commit flow) ----
  // First Commit click runs the review; findings render above the message box
  // and the button re-arms as "Commit anyway". Pref `preCommitReview` gates it.
  DP.precommitCleared = false;

  DP.precommitPending = false;

  // Bumped whenever the commit area is (re)opened: a review that resolves
  // after the user closed/reopened must not act on the stale flow.
  DP.commitFlowGen = 0;

  DP.clearPrecommitFindings = function() {
    var box = document.getElementById('precommit-findings');
    if (box) box.remove();
  };

  DP.renderPrecommitFindings = function(text, count) {
    DP.clearPrecommitFindings();
    var box = document.createElement('div');
    box.id = 'precommit-findings';
    box.innerHTML =
      '<div class="precommit-findings-head">Pre-commit review found ' + count + ' issue' + (count === 1 ? '' : 's')
        + ' in the staged changes — fix them, or commit anyway.'
        + '<button type="button" class="precommit-findings-close" title="Dismiss">&times;</button></div>'
      + '<pre class="precommit-findings-body"></pre>';
    box.querySelector('.precommit-findings-body').textContent = text;
    box.querySelector('.precommit-findings-close').addEventListener('click', DP.clearPrecommitFindings);
    DP.commitAreaEl.insertBefore(box, DP.commitAreaEl.firstChild);
  };

  // Returns true → proceed with the commit now; false → findings rendered,
  // stop and let the user decide. Degrades to "proceed" on any infra error —
  // the review must never make committing impossible.
  DP.runPrecommitReview = async function(btn) {
    var prefs;
    try {
      prefs = (await window.klaus.ui.getPreferences()) || {};
    } catch (e) {
      // Can't read the pref → fail toward OFF: the review is a billed agent
      // run the user may have opted out of.
      window.toast.warn('Could not read preferences — committing without the pre-commit review');
      return true;
    }
    if (prefs.preCommitReview === false) return true;

    // Review with the agent of the task on this worktree (default otherwise).
    var agent = prefs.defaultProvider || 'claude';
    try {
      AppState.tasks.forEach(function (t) {
        if (t && t.worktreePath === DP.currentWorktreePath && t.mode && t.mode !== 'shell') agent = t.mode;
      });
    } catch (e) { /* keep default */ }

    btn.textContent = 'Reviewing changes…';
    var skip = document.createElement('button');
    skip.type = 'button';
    skip.id = 'precommit-skip';
    skip.textContent = 'Skip review';
    skip.addEventListener('click', function () {
      window.klaus.task.precommitReviewCancel(DP.currentWorktreePath);
    });
    if (btn.parentNode) btn.parentNode.insertBefore(skip, btn.nextSibling);

    var res;
    try {
      res = await window.klaus.task.precommitReview(DP.currentWorktreePath, agent);
    } catch (e) {
      res = { error: (e && e.message) || String(e) };
    }
    if (skip.parentNode) skip.remove();

    if (!res || res.cancelled) return true; // skipped — user's call
    if (res.error) {
      window.toast.warn('Pre-commit review unavailable (' + res.error + ') — committing without it');
      return true;
    }
    if (res.skipped || !res.findingsCount) {
      if (!res.skipped) window.toast.success('Pre-commit review passed — silent failures, secrets, debug leftovers, landmines, comments + lint all clean');
      return true;
    }
    DP.renderPrecommitFindings(res.text, res.findingsCount);
    return false; // caller arms "Commit anyway" (after staleness checks)
  };

  DP.doCommit = async function() {
    var msg = DP.commitInput.value.trim();
    if (!msg) {
      DP.showDiffStatus('Commit aborted: empty message', 'error');
      return;
    }
    var btn = document.getElementById('btn-do-commit');
    
    if (DP.currentSessionName) {
      var wts = DP.getSessionWorktrees();
      var committedCount = 0;
      var errors = [];
      
      btn.disabled = true;
      btn.textContent = 'Committing...';
      
      for (var i = 0; i < wts.length; i++) {
        var wt = wts[i];
        try {
          var status = await window.klaus.git.status(wt.path);
          var hasStaged = status && status.files && status.files.some(function(f) { return f.staged; });
          if (hasStaged) {
            var result = await window.klaus.git.commit(wt.path, msg);
            if (result && result.error) {
              errors.push(wt.name + ': ' + result.error);
            } else {
              committedCount++;
            }
          }
        } catch (e) {
          errors.push(wt.name + ': ' + (e.message || e));
        }
      }
      
      btn.disabled = false;
      btn.textContent = 'Commit';
      
      if (errors.length > 0) {
        var errMsgs = errors.join('; ');
        DP.showDiffStatus('Commit failed: ' + errMsgs, 'error');
        window.toast.error('Commit failed: ' + errMsgs);
        return;
      }
      
      if (committedCount === 0) {
        DP.showDiffStatus('Nothing committed: no repositories have staged changes', 'error');
        window.toast.error('Nothing committed: no repositories have staged changes');
        return;
      }
      
      DP.showDiffStatus('Committed successfully across ' + committedCount + ' repositories', 'success');
      DP.commitInput.value = '';
      DP.commitAreaEl.style.display = 'none';
      await DP.refresh();
      try { await DP.updateAheadBehind(); } catch (_) {}
      return;
    }

    if (DP.precommitPending) return; // a review is already running for this panel
    btn.disabled = true;

    if (!DP.precommitCleared) {
      var gen = DP.commitFlowGen;
      DP.precommitPending = true;
      var proceed;
      try {
        proceed = await DP.runPrecommitReview(btn);
      } finally {
        DP.precommitPending = false;
      }
      if (gen !== DP.commitFlowGen) {
        // The commit area was closed/reopened mid-review — this flow is
        // stale; the fresh open starts from scratch.
        btn.disabled = false;
        btn.textContent = 'Commit';
        return;
      }
      if (!proceed) {
        DP.precommitCleared = true; // informed decision: next click commits
        btn.disabled = false;
        btn.textContent = 'Commit anyway';
        return;
      }
    }
    DP.clearPrecommitFindings();

    btn.disabled = true;
    btn.textContent = 'Committing...';
    var result = await window.klaus.git.commit(DP.currentWorktreePath, msg);
    btn.disabled = false;
    btn.textContent = 'Commit';
    DP.precommitCleared = false;
    if (!result || result.error) {
      var errMsg = (result && result.error) || 'unknown failure';
      DP.showDiffStatus('Commit failed: ' + errMsg, 'error');
      window.toast.error('Commit failed: ' + errMsg);
      return;
    }
    // Show the subject line in the banner so the user sees what landed.
    var subject = msg.split('\n')[0].trim();
    DP.showDiffStatus('Committed: ' + (subject.length > 80 ? subject.slice(0, 77) + '...' : subject), 'success');
    DP.commitInput.value = '';
    DP.commitAreaEl.style.display = 'none';
    await DP.refresh();
    try { await DP.updateAheadBehind(); } catch (_) {}
  };

  // In-flight request id + unsubscribe handles for the sparkle button. When
  // the button is toggled off mid-stream we cancel the subprocess main-side
  // AND detach the IPC listeners so a late chunk doesn't keep typing after.
  DP.commitMsgRequestId = null;

  DP.commitMsgUnsubChunk = null;
  DP.commitMsgUnsubDone = null;

  DP.resetCommitMsgState = function() {
    if (DP.commitMsgUnsubChunk) { try { DP.commitMsgUnsubChunk(); } catch (_) {} DP.commitMsgUnsubChunk = null; }
    if (DP.commitMsgUnsubDone)  { try { DP.commitMsgUnsubDone();  } catch (_) {} DP.commitMsgUnsubDone  = null; }
    DP.commitMsgRequestId = null;
  };

  DP.generateCommitMessageWithClaude = async function() {
    var btn = document.getElementById('btn-claude-commit-msg');
    // Toggle behavior: second click while streaming cancels.
    if (DP.commitMsgRequestId) {
      try { await window.klaus.ai.commitMessageCancel(DP.commitMsgRequestId); } catch (_) {}
      DP.resetCommitMsgState();
      btn.textContent = '✨';
      btn.disabled = false;
      return;
    }
    if (!DP.currentWorktreePath) return;

    // Check if an agent is already in flight for this worktree (e.g. user
    // clicked sparkle, navigated to a task to test something, came back).
    var existing = await window.klaus.agents.findByDedupeKey('commit-message:' + DP.currentWorktreePath);
    if (existing) {
      DP.attachToCommitMessageAgent(existing);
      return;
    }

    btn.disabled = true;
    btn.textContent = '…';

    var requestId = 'ccm-' + Date.now() + '-' + Math.floor(Math.random() * 9999);
    DP.commitMsgRequestId = requestId;
    // Start fresh — Claude replaces whatever the user had typed. If they'd
    // entered something they wanted to keep they wouldn't have clicked this.
    DP.commitInput.value = '';

    DP.bindCommitMessageStreaming(requestId, btn);

    var start = await window.klaus.ai.commitMessageStart(requestId, DP.currentWorktreePath);
    if (start && start.error) {
      DP.resetCommitMsgState();
      btn.textContent = '✨';
      btn.disabled = false;
      window.toast.error(start.error);
    }
  };

  // Subscribe to an in-flight or completed commit-message agent and stream
  // its output into the commit input. Used by the initial click and by
  // rehydrateCommitMessage when the user returns to the diff panel.
  DP.attachToCommitMessageAgent = function(agent) {
    var btn = document.getElementById('btn-claude-commit-msg');
    DP.commitInput.value = agent.text || '';
    if (agent.status !== 'running') {
      // Already finished — just paint the result, normalize fences/whitespace.
      var cleaned = (DP.commitInput.value || '').trim();
      cleaned = cleaned.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```\s*$/, '');
      DP.commitInput.value = cleaned.trim();
      if (agent.status === 'error' && agent.error) {
        window.toast && window.toast.error('Commit message failed: ' + agent.error);
      }
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    DP.commitMsgRequestId = agent.id;
    DP.bindCommitMessageStreaming(agent.id, btn);
  };

  DP.bindCommitMessageStreaming = function(requestId, btn) {
    DP.commitMsgUnsubChunk = window.klaus.ai.onCommitMessageChunk(requestId, function (chunk) {
      if (DP.commitMsgRequestId !== requestId) return;
      DP.commitInput.value += chunk;
    });
    DP.commitMsgUnsubDone = window.klaus.ai.onCommitMessageDone(requestId, function (msg) {
      if (DP.commitMsgRequestId !== requestId) return;
      DP.resetCommitMsgState();
      if (btn) { btn.textContent = '✨'; btn.disabled = false; }
      if (msg && msg.error) {
        window.toast.error('Could not generate commit message: ' + msg.error);
        return;
      }
      var cleaned = (DP.commitInput.value || '').trim();
      cleaned = cleaned.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```\s*$/, '');
      DP.commitInput.value = cleaned.trim();
      DP.commitInput.focus();
    });
  };

  // On panel mount or worktree switch, rehydrate any in-flight commit-message
  // agent for this worktree. Lets the user kick off generation, navigate to
  // verify something, and return to find the message waiting.
  DP.rehydrateCommitMessage = async function() {
    if (!DP.currentWorktreePath || DP.commitMsgRequestId) return;
    var existing = await window.klaus.agents.findByDedupeKey('commit-message:' + DP.currentWorktreePath);
    if (existing) DP.attachToCommitMessageAgent(existing);
  };

  // Tiny ephemeral status banner inside the diff panel. Used for operations
  // (push, commit) where we want the user to see what happened without
  // hijacking focus with a modal alert. Auto-hides after a few seconds.
  DP.showDiffStatus = function(text, kind) {
    if (!DP.panelEl) return;
    var existing = DP.panelEl.querySelector('.diff-status-banner');
    if (existing) existing.remove();
    var el = document.createElement('div');
    el.className = 'diff-status-banner diff-status-' + (kind || 'info');
    el.textContent = text;
    DP.panelEl.appendChild(el);
    setTimeout(function () {
      if (el && el.parentElement) el.parentElement.removeChild(el);
    }, 6000);
  };

  DP.pushChanges = async function() {
    var btn = document.getElementById('btn-push');
    btn.disabled = true;
    btn.textContent = 'Pushing...';
    
    if (DP.currentSessionName) {
      var wts = DP.getSessionWorktrees();
      var paths = wts.map(function(w) { return w.path; });
      var results = await Promise.all(paths.map(async function(p) {
        try {
          return await window.klaus.git.push(p);
        } catch (e) {
          return { error: e.message || e };
        }
      }));
      btn.disabled = false;
      var errors = results.filter(function(r) { return r && r.error; });
      if (errors.length > 0) {
        btn.textContent = 'Failed';
        setTimeout(function () { btn.textContent = 'Push'; }, 2000);
        var errMsgs = errors.map(function(e) { return e.error; }).join('; ');
        DP.showDiffStatus('Push failed: ' + errMsgs, 'error');
        window.toast.error('Push failed: ' + errMsgs);
        return;
      }
      btn.textContent = 'Pushed!';
      setTimeout(function () { btn.textContent = 'Push'; }, 2000);
      DP.showDiffStatus('Pushed all repositories in session', 'success');
      try { await DP.updateAheadBehind(); } catch (_) {}
    } else {
      var result = await window.klaus.git.push(DP.currentWorktreePath);
      btn.disabled = false;
      if (result.error) {
        btn.textContent = 'Failed';
        setTimeout(function () { btn.textContent = 'Push'; }, 2000);
        DP.showDiffStatus('Push failed: ' + result.error, 'error');
        window.toast.error('Push failed: ' + result.error);
        return;
      }
      btn.textContent = 'Pushed!';
      setTimeout(function () { btn.textContent = 'Push'; }, 2000);
      var lines = (result.output || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      var summary;
      if (/everything up-to-date/i.test(result.output || '')) {
        summary = 'Nothing to push — ' + (result.branch || 'branch') + ' already up to date';
      } else {
        summary = 'Pushed ' + (result.branch || 'branch');
        var toLine = lines.find(function (l) { return l.startsWith('To '); });
        if (toLine) summary += ' · ' + toLine;
        var refLine = lines.find(function (l) { return /^\s*[a-f0-9]+\.\.[a-f0-9]+/.test(l) || /->/.test(l); });
        if (refLine && !toLine) summary += ' · ' + refLine;
      }
      DP.showDiffStatus(summary, 'success');
      btn.title = result.output || '';
      try { await DP.updateAheadBehind(); } catch (_) {}
    }
  };

  DP.createPR = async function() {
    var title = prompt('PR title:');
    if (!title) return;
    var body = prompt('PR description (optional):') || '';
    var btn = document.getElementById('btn-create-pr');
    btn.disabled = true;
    btn.textContent = 'Creating...';
    
    if (DP.currentSessionName && DP.viewScope === 'session') {
      var wts = DP.getSessionWorktrees();
      var results = await Promise.all(wts.map(async function(wt) {
        try {
          return await window.klaus.git.createPR(wt.path, title, body);
        } catch (e) {
          return { error: e.message || e };
        }
      }));
      btn.disabled = false;
      btn.textContent = 'PR';
      var errors = results.filter(function(r) { return r && r.error; });
      if (errors.length > 0) {
        var errMsgs = errors.map(function(e) { return e.error; }).join('; ');
        window.toast.error('PR creation failed: ' + errMsgs);
        return;
      }
      window.toast.success('Successfully created PRs for all repositories in session');
    } else {
      var path = DP.currentWorktreePath || DP.getActiveWorktreePath();
      var result = await window.klaus.git.createPR(path, title, body);
      btn.disabled = false;
      btn.textContent = 'PR';
      if (result.error) {
        window.toast.error('PR creation failed: ' + result.error);
        return;
      }
      if (result.url) {
        window.klaus.gh.openExternal(result.url);
      }
    }
    if (window.PRPanel) window.PRPanel.loadPR();
  };

  DP.stageAll = async function() {
    var unstaged = DP.currentFiles.filter(function (f) { return !f.staged; }).map(function (f) { return f.file; });
    if (unstaged.length > 0) {
      await window.klaus.git.stage(DP.currentWorktreePath, unstaged);
      await DP.refresh();
    }
  };

  DP.unstageAll = async function() {
    var staged = DP.currentFiles.filter(function (f) { return f.staged; }).map(function (f) { return f.file; });
    if (staged.length > 0) {
      await window.klaus.git.unstage(DP.currentWorktreePath, staged);
      await DP.refresh();
    }
  };

  DP.setCommentCallback = function(fn) {
    DP.commentCallback = fn;
  };

  // Feature 13: Keyboard shortcut to send selected diff/hunk to Claude
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'E') {
      e.preventDefault();
      if (!DP.commentCallback) return;

      // Try selected text first
      var sel = window.getSelection();
      var selectedText = sel && !sel.isCollapsed ? sel.toString().trim() : '';

      if (!selectedText && DP.currentParsedHunks.length > 0) {
        // Fall back to all hunks of the selected file
        selectedText = DP.currentParsedHunks.map(function (h) { return h.lines.join('\n'); }).join('\n');
      }

      if (!selectedText || !DP.selectedFile) return;

      var prompt = 'Regarding ' + DP.selectedFile + ':\n```\n' + selectedText + '\n```\nPlease review this code change.';
      DP.commentCallback(prompt);
    }
  });

  DP.getStatusClass = function(status) {
    var s = status.trim();
    if (s.startsWith('M')) return 'modified';
    if (s.startsWith('A') || s === '??') return 'added';
    if (s.startsWith('D')) return 'deleted';
    if (s.startsWith('R')) return 'renamed';
    return '';
  };

  DP.getStatusLabel = function(status) {
    var s = status.trim();
    if (s === '??') return 'U';
    return s.replace(/\s/g, '').charAt(0) || '?';
  };

  // Post-process a single highlighted line to add VS Code-like coloring
  // for patterns hljs doesn't tokenize: function calls, decorators, self/cls, CONSTANTS
  DP.enhanceLine = function(html) {
    // We need to only modify text that's NOT inside an existing span tag.
    // Strategy: split on tags, enhance only the text segments.
    var parts = html.split(/(<[^>]+>)/);
    var inSpan = 0;
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part.startsWith('<span')) { inSpan++; continue; }
      if (part === '</span>') { inSpan--; continue; }
      if (part.startsWith('<')) continue; // other tags
      if (inSpan > 0) continue; // inside an hljs span, skip

      // Enhance plain text segments
      // object.method( — color object as module, method as call
      part = part.replace(/\b([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)(\()/g,
        '<span class="hljs-module">$1</span>.<span class="hljs-call">$2</span>$3');
      // Remaining function calls: word followed by ( that we didn't already catch
      part = part.replace(/\b([a-zA-Z_]\w*)(\()/g, function(m, name, paren) {
        // Don't re-wrap spans or things we just wrapped
        if (name === 'span' || name === 'class') return m;
        return '<span class="hljs-call">' + name + '</span>' + paren;
      });
      // self/cls keyword
      part = part.replace(/\b(self|cls)\b/g, '<span class="hljs-self">$1</span>');
      // CONSTANT_NAMES (all caps with underscores, 2+ chars)
      part = part.replace(/\b([A-Z][A-Z0-9_]{1,})\b/g, '<span class="hljs-constant">$1</span>');
      // Decorators
      part = part.replace(/(@[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, '<span class="hljs-decorator">$1</span>');

      parts[i] = part;
    }
    return parts.join('');
  };

  // Split hljs-highlighted HTML by newlines, carrying open <span> tags
  // across line boundaries so each line is self-contained.
  DP.splitHighlightedLines = function(html) {
    var rawLines = html.split('\n');
    var result = [];
    var openSpans = []; // stack of open span tags (full tag strings)

    for (var i = 0; i < rawLines.length; i++) {
      var line = rawLines[i];

      // Prepend any spans that were open from previous lines
      var prefix = openSpans.join('');

      // Parse this line to track span opens/closes
      var spanOpenRe = /<span[^>]*>/g;
      var spanCloseRe = /<\/span>/g;
      var match;

      // Collect all opens and closes in order
      var events = [];
      while ((match = spanOpenRe.exec(line)) !== null) {
        events.push({ pos: match.index, type: 'open', tag: match[0] });
      }
      while ((match = spanCloseRe.exec(line)) !== null) {
        events.push({ pos: match.index, type: 'close' });
      }
      events.sort(function (a, b) { return a.pos - b.pos; });

      for (var j = 0; j < events.length; j++) {
        if (events[j].type === 'open') {
          openSpans.push(events[j].tag);
        } else {
          openSpans.pop();
        }
      }

      // Close any spans still open at end of this line, for valid HTML
      var suffix = '';
      for (var k = 0; k < openSpans.length; k++) {
        suffix += '</span>';
      }

      result.push(prefix + line + suffix);
    }

    return result;
  };

  DP.EXT_TO_LANG = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
    cs: 'csharp', swift: 'swift', kt: 'kotlin', scala: 'scala',
    php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
    html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    md: 'markdown', sql: 'sql', r: 'r',
    lua: 'lua', perl: 'perl', pl: 'perl',
    dockerfile: 'dockerfile', makefile: 'makefile',
  };

  DP.detectLang = function(filename) {
    if (!filename) return null;
    var name = filename.split('/').pop().toLowerCase();
    // Handle special filenames
    if (name === 'dockerfile') return 'dockerfile';
    if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
    var ext = name.split('.').pop();
    return DP.EXT_TO_LANG[ext] || null;
  };

  DP.basename = function(p) { return p.split('/').pop(); };

  DP.dirname = function(p) {
    var parts = p.split('/');
    parts.pop();
    return parts.length > 0 ? parts.join('/') + '/' : '';
  };

  DP.escHtml = function(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  DP.escAttr = function(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  };

  DP.showFile = async function(file) {
    if (!file || !DP.currentWorktreePath) return;
    DP.selectedFile = file;
    // Highlight the file in the list
    DP.fileListEl.querySelectorAll('.diff-file').forEach(function (el) {
      el.classList.toggle('selected', el.dataset.file === file);
    });
    await DP.showFileDiff(file, false);
  };

  DP.getSelectedFile = function() {
    return DP.selectedFile;
  };

  // D1: Ahead/behind counts
  DP.updateAheadBehind = async function() {
    if (!DP.currentWorktreePath && !DP.currentSessionName) return;
    var el = document.getElementById('ahead-behind');
    if (!el) return;
    if (DP.currentSessionName) {
      var wts = DP.getSessionWorktrees();
      var totalAhead = 0;
      var totalBehind = 0;
      for (var i = 0; i < wts.length; i++) {
        var wt = wts[i];
        try {
          var result = await window.klaus.git.aheadBehind(wt.path);
          totalAhead += (result.ahead || 0);
          totalBehind += (result.behind || 0);
        } catch (_) {}
      }
      var parts = [];
      if (totalAhead > 0) parts.push('\u2191' + totalAhead);
      if (totalBehind > 0) parts.push('\u2193' + totalBehind);
      el.textContent = parts.join(' ');
      el.title = totalAhead + ' ahead, ' + totalBehind + ' behind across session';
    } else {
      var abPath = DP.currentWorktreePath;
      var applyAheadBehind = function (r) {
        var parts = [];
        if (r.ahead > 0) parts.push('\u2191' + r.ahead);
        if (r.behind > 0) parts.push('\u2193' + r.behind);
        el.textContent = parts.join(' ');
        el.title = (r.ahead || 0) + ' ahead, ' + (r.behind || 0) + ' behind';
      };
      // Stale-while-revalidate: show the last-known counts instantly on a
      // switch, then refetch. Skipped on same-worktree auto-refresh.
      var cachedAB = DP.aheadBehindCache.get(abPath);
      if (cachedAB && DP.renderedAheadBehindPath !== abPath) applyAheadBehind(cachedAB);
      var result = await window.klaus.git.aheadBehind(abPath);
      if (abPath !== DP.currentWorktreePath) return;
      DP.aheadBehindCache.set(abPath, result);
      DP.renderedAheadBehindPath = abPath;
      applyAheadBehind(result);
    }
  };

  // D2: Branch checkout (integrated into mode toggle)
  DP.addCheckoutToBranchSelect = function() {
    var branchLabel = DP.fileListEl.querySelector('.diff-branch-label');
    if (!branchLabel || DP.diffMode !== 'working') return;

    branchLabel.style.cursor = 'pointer';
    branchLabel.title = 'Click to switch branch';
    branchLabel.addEventListener('click', async function () {
      if (DP.branchList.length === 0) {
        var result = await window.klaus.git.branches(DP.currentWorktreePath);
        DP.branchList = result.branches || [];
        DP.remoteList = result.remotes || [];
      }

      var allBranches = DP.branchList.concat(DP.remoteList);
      var choice = prompt('Switch to branch:\n\n' + allBranches.join('\n'));
      if (!choice || !choice.trim()) return;

      var res = await window.klaus.git.checkout(DP.currentWorktreePath, choice.trim());
      if (res.error) {
        window.toast.error('Checkout failed: ' + res.error);
      } else {
        DP.refresh();
        DP.updateAheadBehind();
      }
    });
  };

  // D7: Conflict detection
  DP.checkConflicts = async function() {
    if (!DP.currentWorktreePath) return;
    var result = await window.klaus.git.conflicts(DP.currentWorktreePath);
    if (result.files && result.files.length > 0) {
      var conflictBanner = DP.fileListEl.querySelector('.conflict-banner');
      if (!conflictBanner) {
        conflictBanner = document.createElement('div');
        conflictBanner.className = 'conflict-banner';
        DP.fileListEl.insertBefore(conflictBanner, DP.fileListEl.firstChild);
      }
      conflictBanner.innerHTML = '\u26A0 ' + result.files.length + ' conflicted file' + (result.files.length > 1 ? 's' : '') +
        ' \u2014 <span class="conflict-files">' + result.files.map(DP.escHtml).join(', ') + '</span>' +
        ' <button class="conflict-resolve-btn">Resolve</button>';
      conflictBanner.querySelector('.conflict-resolve-btn').addEventListener('click', function () {
        if (window.ConflictPanel && DP.currentWorktreePath) {
          window.ConflictPanel.show(DP.currentWorktreePath);
        }
      });
    }
  };


})(window.DiffPanel);
