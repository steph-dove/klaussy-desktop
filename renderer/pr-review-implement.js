// Part of the PrReview surface (window.PrReview); see pr-review.js for the
// core. Implement runs + AI-review streaming events + draft comments.
// All cross-references go through the shared `PR` object, so load order
// only needs core (pr-review.js) first; siblings may load in any order.

(function (PR) {

  PR.handleAiEvent = function(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === 'assistant' && ev.message && ev.message.content) {
      ev.message.content.forEach(function (block) {
        if (block.type === 'text' && block.text) {
          PR.aiReview.finalText = block.text;
        } else if (block.type === 'tool_use' && block.name) {
          var hint = '';
          if (block.input) {
            if (block.input.command) hint = String(block.input.command).slice(0, 50);
            else if (block.input.file_path) hint = String(block.input.file_path).split('/').pop();
            else if (block.input.pattern) hint = String(block.input.pattern).slice(0, 30);
            else if (block.input.description) hint = String(block.input.description).slice(0, 40);
          }
          PR.aiReview.progress.push({ kind: 'tool', label: block.name + (hint ? ': ' + hint : '') });
        }
      });
    } else if (ev.type === 'result') {
      if (ev.result) PR.aiReview.finalText = ev.result;
      // Capture usage so we can show the user what this run cost on their
      // own Anthropic account. Klaussy doesn't bill — we just surface what
      // claude already reports.
      PR.aiReview.usage = PR.extractUsage(ev);
    } else if (ev.type === 'system' && ev.subtype) {
      PR.aiReview.progress.push({ kind: 'system', label: ev.subtype });
    }
  };

  // Pull usage + cost out of a stream-json `result` event into a small,
  // renderer-friendly shape. Returns null if the event doesn't carry it.
  PR.extractUsage = function(ev) {
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
  };

  PR.formatUsage = function(u) {
    if (!u) return '';
    var bits = [];
    if (typeof u.cost === 'number') bits.push('$' + u.cost.toFixed(u.cost < 0.01 ? 4 : 2));
    if (u.inputTokens || u.outputTokens) bits.push((u.inputTokens || 0).toLocaleString() + ' in / ' + (u.outputTokens || 0).toLocaleString() + ' out');
    if (u.durationMs) bits.push((u.durationMs / 1000).toFixed(1) + 's');
    return bits.join(' \u00b7 ');
  };

  // Strip the <DRAFT_PR_COMMENT>…</DRAFT_PR_COMMENT> block claude emits in
  // single-finding mode out of the implement summary, returning both the
  // cleaned text and the draft body.
  PR.extractDraftCommentFromText = function(text) {
    var src = text || '';
    var m = src.match(/<DRAFT_PR_COMMENT>([\s\S]*?)<\/DRAFT_PR_COMMENT>/);
    if (m) {
      return {
        text: (src.slice(0, m.index) + src.slice(m.index + m[0].length)).trim(),
        draft: m[1].trim(),
      };
    }
    // Truncated mid-stream / cancelled before the close marker: drop the
    // dangling opener so the raw marker doesn't leak into the visible
    // implement summary.
    var openIdx = src.indexOf('<DRAFT_PR_COMMENT>');
    if (openIdx !== -1) {
      return { text: src.slice(0, openIdx).trim(), draft: null };
    }
    return { text: src, draft: null };
  };

  // Unified entry point for every implement flow (single finding from a
  // finding card, single finding from a conversation thread, batch "all").
  // Spawns an interactive `claude` in a PTY, mounts an xterm.js so the user
  // can answer Bash/MCP permission prompts, and routes the JSONL-derived
  // structured events back to the caller's mode-specific state updates.
  //
  // opts:
  //   mode             — 'one' | 'all' (passed through to the IPC, controls
  //                      the prompt template in claude-stream-ipc.js)
  //   body             — the finding text(s) to apply
  //   repaint()        — re-renders the surface that shows progress
  //   onAssistantText? — latest assistant text block (for summary / draft)
  //   onUsage?         — usage totals for this turn
  //   onTool?          — chip-shaped { kind: 'tool', label }
  //   onDone?          — fired on stop_reason=end_turn (or manual "mark done")
  //   onError?         — IPC error / unexpected PTY exit
  //   onCancelled?     — user cancelled mid-run
  PR.startImplementRun = function(opts) {
    if (PR.implRunIsLive()) return;
    // Carry over the persistent terminal but drop the finalized implRun
    // so the new run's status/repaint isn't shadowed by the old one.
    if (PR.implRun) { PR.cleanupImplementRun(); PR.implRun = null; }
    var requestId = (opts.mode === 'all' ? 'impla-' : 'impl-')
      + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    // Reuse the persistent xterm. If it doesn't exist yet, create it now
    // (and the first mount in mountImplementTerminalIfActive will call
    // terminal.open against the Terminal-tab host).
    var rt = PR.ensureReviewTerminal();

    // Banner so successive runs are scannable in scrollback.
    var bodyPreview = (opts.body || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    var label = (opts.mode === 'all' ? 'Implement all' : 'Implement')
      + (bodyPreview ? ': ' + bodyPreview : '');
    PR.writeRunSeparator(label);

    PR.implRun = {
      requestId: requestId,
      mode: opts.mode,
      status: 'running',
      finalized: false,
      repaint: opts.repaint,
      onAssistantText: opts.onAssistantText,
      onUsage: opts.onUsage,
      onTool: opts.onTool,
      onDone: opts.onDone,
      onError: opts.onError,
      onCancelled: opts.onCancelled,
      unsubData: null,
      unsubEvent: null,
      unsubDone: null,
    };

    // Wire output streams BEFORE the spawn so we don't miss the first
    // bytes claude writes (typically a banner + prompt echo).
    PR.implRun.unsubData = window.klaus.pr.onReviewImplementData(requestId, function (chunk) {
      if (!PR.implRun || PR.implRun.requestId !== requestId) return;
      try { rt.terminal.write(chunk); rt.hasContent = true; } catch (_) {}
    });
    PR.implRun.unsubEvent = window.klaus.pr.onReviewImplementEvent(requestId, function (ev) {
      if (!PR.implRun || PR.implRun.requestId !== requestId) return;
      if (ev.kind === 'tool') {
        var hint = ev.hint ? String(ev.hint).split('/').pop().slice(0, 40) : '';
        if (PR.implRun.onTool) PR.implRun.onTool({ kind: 'tool', label: ev.name + (hint ? ': ' + hint : '') });
        if (PR.implRun.repaint) PR.implRun.repaint();
      } else if (ev.kind === 'text') {
        if (PR.implRun.onAssistantText) PR.implRun.onAssistantText(ev.text);
        if (PR.implRun.repaint) PR.implRun.repaint();
      } else if (ev.kind === 'usage') {
        if (PR.implRun.onUsage) PR.implRun.onUsage(ev.usage);
        if (PR.implRun.repaint) PR.implRun.repaint();
      } else if (ev.kind === 'end_turn') {
        PR.finalizeImplementRun('done');
      }
    });
    PR.implRun.unsubDone = window.klaus.pr.onReviewImplementDone(requestId, function (data) {
      if (!PR.implRun || PR.implRun.requestId !== requestId) return;
      // If we already finalized via end_turn, the PTY exit is just
      // cleanup — don't downgrade the status.
      if (PR.implRun.finalized) { PR.cleanupImplementRun(); return; }
      var signal = data && data.signal;
      if (PR.implRun.status === 'cancelled' || signal === 'SIGTERM' || signal === 'SIGKILL') {
        PR.finalizeImplementRun('cancelled');
      } else {
        PR.finalizeImplementRun('error', 'The agent exited without finishing the turn');
      }
    });

    opts.repaint();

    // Implement with the current global default agent (the one shown on the
    // Review split button / Preferences). opts.provider lets a caller override.
    var implProvider = opts.provider || (window.AgentSplit && AgentSplit.getAgent());
    window.klaus.pr.reviewImplementStart(requestId, opts.mode, opts.body, implProvider).then(function (r) {
      if (!PR.implRun || PR.implRun.requestId !== requestId) return;
      if (r && r.cancelled) {
        PR.finalizeImplementRun('cancelled'); // user declined the trust prompt
      } else if (r && r.error) {
        PR.finalizeImplementRun('error', r.error);
      } else if (r && r.worktreePath) {
        PR.aiReview.worktreePath = r.worktreePath;
      }
    });
  };

  PR.finalizeImplementRun = function(finalStatus, errMsg) {
    if (!PR.implRun || PR.implRun.finalized) return;
    PR.implRun.finalized = true;
    PR.implRun.status = finalStatus;
    if (finalStatus === 'done' && PR.implRun.onDone) PR.implRun.onDone();
    else if (finalStatus === 'error' && PR.implRun.onError) PR.implRun.onError(errMsg || 'Implementation failed');
    else if (finalStatus === 'cancelled' && PR.implRun.onCancelled) PR.implRun.onCancelled();
    if (PR.implRun.repaint) PR.implRun.repaint();
    PR.refreshLocalChanges();
    // Ask the main process to terminate the PTY in case it's still alive
    // (e.g. claude's interactive prompt is hanging after end_turn). Cancel
    // is idempotent — if the PTY already exited it's a no-op.
    try { window.klaus.pr.reviewImplementCancel(PR.implRun.requestId); } catch (_) {}
    // The chat session's output was suppressed while this run owned the
    // terminal (subscribeChat drops bytes when implRunIsLive). Now that the run
    // is done, nudge the chat PTY with a resize so its TUI repaints a fresh
    // frame at the bottom instead of waiting for the user's next keystroke.
    PR.nudgeChatRedraw();
  };

  // Force the chat TUI to repaint by toggling its PTY size (two SIGWINCHes).
  // Used after an implement run releases the shared terminal. No-op when there's
  // no live chat session or the terminal tab isn't on screen.
  PR.nudgeChatRedraw = function() {
    if (!PR.chatRun || PR.chatRun.status !== 'running' || !PR.chatRun.chatKey) return;
    if (PR.activeTab !== 'terminal' || !PR.reviewTerminal) return;
    var t = PR.reviewTerminal.terminal;
    var cols = t.cols, rows = t.rows;
    if (!cols || !rows) return;
    try {
      window.klaus.pr.reviewTchatResize(PR.chatRun.chatKey, Math.max(2, cols - 1), rows);
      setTimeout(function () {
        if (PR.chatRun && PR.chatRun.chatKey) {
          try { window.klaus.pr.reviewTchatResize(PR.chatRun.chatKey, cols, rows); } catch (_) {}
        }
      }, 60);
    } catch (_) {}
  };

  PR.cleanupImplementRun = function() {
    if (!PR.implRun) return;
    if (PR.implRun.unsubData) PR.implRun.unsubData();
    if (PR.implRun.unsubEvent) PR.implRun.unsubEvent();
    if (PR.implRun.unsubDone) PR.implRun.unsubDone();
    PR.implRun.unsubData = null;
    PR.implRun.unsubEvent = null;
    PR.implRun.unsubDone = null;
    // The xterm belongs to reviewTerminal (not implRun) and is reused
    // across runs — only disposeReviewTerminal touches it.
  };

  PR.dismissImplementRun = function() {
    PR.cleanupImplementRun();
    PR.implRun = null;
    PR.disposeReviewTerminal();
    PR.repaintForImplRun();
  };

  // True only while a run is actively executing (PTY alive, no end_turn
  // yet) — used as the guard for "can the user start a new Implement?".
  // Done/error/cancelled runs are kept around so their final status
  // renders, but they don't block a fresh run from appending to the
  // same terminal.
  PR.implRunIsLive = function() {
    return !!(PR.implRun && PR.implRun.status === 'running');
  };

  PR.cancelImplementRun = function() {
    if (!PR.implRun) return;
    PR.implRun.status = 'cancelled';
    if (PR.implRun.repaint) PR.implRun.repaint();
    try { window.klaus.pr.reviewImplementCancel(PR.implRun.requestId); } catch (_) {}
    // The actual finalize fires when the PTY exits — main process sends
    // Ctrl+C first, then SIGTERM after a 2s grace period.
  };

  PR.startImplement = function(f) {
    if (PR.implRunIsLive()) return;
    if (f.implementDraftStatus === 'approved') {
      // Clear the queued draft comment so a redo doesn't accumulate stale
      // pendingComments entries alongside the new one.
      PR.pendingComments = PR.pendingComments.filter(function (c) {
        return !(c.fromImplementDraft && c.fromFindingId === f.id);
      });
    }
    f.implementOut = '';
    f.implementError = null;
    f.implementDraftComment = '';
    f.implementDraftStatus = null;
    f.status = 'implementing';
    PR.switchToTerminalTab();
    PR.startImplementRun({
      mode: 'one',
      body: f.text,
      repaint: PR.repaintForImplRun,
      onAssistantText: function (text) { f.implementOut = text; },
      onUsage: function (u) { f.usage = u; },
      onDone: function () {
        var parsed = PR.extractDraftCommentFromText(f.implementOut);
        f.implementOut = parsed.text;
        if (parsed.draft) {
          f.implementDraftComment = parsed.draft;
          f.implementDraftStatus = 'pending';
        }
        f.status = 'implemented';
        f.implementId = null;
        PR.saveAiReviewCache();
      },
      onError: function (msg) {
        f.status = 'failed';
        f.implementError = msg;
        f.implementId = null;
        PR.saveAiReviewCache();
      },
      onCancelled: function () {
        f.status = 'open';
        f.implementId = null;
        PR.saveAiReviewCache();
      },
    });
    // Track the in-flight request on the finding so the per-card "Cancel"
    // button and the Rerun handler can find it via aiReview.findings.
    if (PR.implRun) f.implementId = PR.implRun.requestId;
  };

  // Does the pendingComments list already hold a draft sourced from this
  // finding? Keyed by finding id stored on the pending entry so the
  // "Added to draft / Remove draft" button can toggle correctly.
  PR.pendingCommentExistsForFinding = function(findingId) {
    return PR.pendingComments.some(function (c) { return c.fromFindingId === findingId; });
  };

  // Add-to-PR and Copy send only the text under a finding's "Suggested change:"
  // label. Reads live f.text (pencil edits flow through); no label sends all.
  PR.findingSuggestionText = function(f) {
    var text = (f && f.text) || '';
    var m = text.match(/(?:^|\n)[ \t]*Suggested change:[ \t]*\n*/i);
    return m ? text.slice(m.index + m[0].length).trim() : text.trim();
  };

  // Add a finding to the pending review. Both paths STAGE into pendingComments
  // (nothing posts until Submit review): verified findings draft inline,
  // unverified ones as an issueComment draft posted after the review.
  PR.postFindingAsComment = function(f) {
    // Toggle-off: clicking a drafted finding pulls its draft back out. Match
    // only the entry this button created (leave any implement draft in place).
    if (PR.pendingCommentDraftExistsForFinding(f.id)) {
      PR.pendingComments = PR.pendingComments.filter(function (c) {
        return !(c.fromFindingId === f.id && !c.fromImplementDraft);
      });
      PR.repaintAiReviewTab();
      PR.saveAiReviewCache();
      if (PR.lastState) PR.render(PR.lastState);
      return;
    }

    // Just the suggested change, staged as the reviewer's own words (no bot
    // attribution). Body/severity/location stay on the card as reference.
    var attributedBody = PR.findingSuggestionText(f);
    var entry = {
      id: 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      fromFindingId: f.id,
      body: attributedBody,
    };
    if (f.postMode === 'inline' && f.locationVerified && f.path && f.line) {
      entry.path = f.path;
      entry.line = f.line;
      entry.side = f.side || 'RIGHT';
    } else {
      entry.issueComment = true;
    }
    PR.pendingComments.push(entry);
    PR.repaintAiReviewTab();
    PR.saveAiReviewCache();
    if (PR.lastState) PR.render(PR.lastState);
  };

  // A finding has an Add-to-PR draft queued (as opposed to an implement draft).
  PR.pendingCommentDraftExistsForFinding = function(findingId) {
    return PR.pendingComments.some(function (c) {
      return c.fromFindingId === findingId && !c.fromImplementDraft;
    });
  };

  // Approve a Claude-implement draft comment: push it onto pendingComments
  // so it'll post when the user submits the review. Inline when we have a
  // verified path+line, otherwise queued as an issue-comment variant
  // (pr-submit-review posts those after the inline review goes up).
  PR.approveImplementDraft = function(f) {
    if (!f.implementDraftComment) return;
    // Don't double-queue if already approved.
    if (PR.pendingComments.some(function (c) { return c.fromImplementDraft && c.fromFindingId === f.id; })) {
      f.implementDraftStatus = 'approved';
      PR.repaintAiReviewTab();
      PR.saveAiReviewCache();
      return;
    }
    var entry = {
      id: 'pending-impl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      fromFindingId: f.id,
      fromImplementDraft: true,
      body: f.implementDraftComment,
    };
    if (f.locationVerified && f.path && f.line) {
      entry.path = f.path;
      entry.line = f.line;
      entry.side = f.side || 'RIGHT';
    } else {
      entry.issueComment = true;
    }
    PR.pendingComments.push(entry);
    f.implementDraftStatus = 'approved';
    PR.repaintAiReviewTab();
    PR.saveAiReviewCache();
    if (PR.lastState) PR.render(PR.lastState);
  };

  PR.removeImplementDraft = function(f) {
    PR.pendingComments = PR.pendingComments.filter(function (c) {
      return !(c.fromImplementDraft && c.fromFindingId === f.id);
    });
    f.implementDraftStatus = 'pending';
    PR.repaintAiReviewTab();
    PR.saveAiReviewCache();
    if (PR.lastState) PR.render(PR.lastState);
  };

  // Copy the same suggested-change text Add-to-PR posts, so paste matches send.
  PR.copyFindingAsMarkdown = async function(f) {
    try {
      await navigator.clipboard.writeText(PR.findingSuggestionText(f));
      f.copyStatus = 'copied';
      PR.repaintAiReviewTab();
      setTimeout(function () {
        f.copyStatus = null;
        PR.repaintAiReviewTab();
      }, 1500);
    } catch (err) {
      console.error('clipboard write failed', err);
      f.copyStatus = 'failed';
      PR.repaintAiReviewTab();
      setTimeout(function () { f.copyStatus = null; PR.repaintAiReviewTab(); }, 2000);
    }
  };

  // Kick off a chat turn. Appends the user's message, spawns Claude with
  // the finding body + full transcript, streams the response into
  // f.chatStreaming, then commits it as an assistant message on done.
  PR.startChat = async function(f, userMessage) {
    if (f.chatRequestId) return;
    var requestId = 'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    f.chatMessages = (f.chatMessages || []).concat([{ role: 'user', content: userMessage }]);
    f.chatRequestId = requestId;
    f.chatStreaming = '';
    f.chatError = null;
    PR.repaintAiReviewTab();

    var buffered = '';
    var unsubData = window.klaus.pr.onReviewChatData(requestId, function (chunk) {
      if (f.chatRequestId !== requestId) return;
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
              if (block.type === 'text' && block.text) f.chatStreaming = block.text;
            });
          } else if (ev.type === 'result' && ev.result) {
            f.chatStreaming = ev.result;
          }
        } catch (_) {}
      }
      PR.repaintAiReviewTab();
    });
    window.klaus.pr.onReviewChatDone(requestId, function (result) {
      if (unsubData) unsubData();
      if (f.chatRequestId !== requestId) return;
      f.chatRequestId = null;
      if (result && result.error) {
        f.chatError = result.error;
      } else if (result && result.cancelled) {
        // Commit whatever streamed before the cancel so the user keeps the
        // partial response; Claude doesn't get a second chance at the turn.
        if (f.chatStreaming) {
          f.chatMessages.push({ role: 'assistant', content: f.chatStreaming });
        }
      } else {
        f.chatMessages.push({ role: 'assistant', content: f.chatStreaming || '' });
      }
      f.chatStreaming = '';
      PR.repaintAiReviewTab();
      PR.saveAiReviewCache();
    });

    // Send the full transcript so Claude has the arc of the conversation.
    // findingId is passed so the agent's dedupeKey survives across PR loads
    // (otherwise rehydration after navigation can't find the running agent).
    window.klaus.pr.reviewChatStart(requestId, f.text, f.chatMessages, f.id).then(function (r) {
      if (r && r.error) {
        if (unsubData) unsubData();
        f.chatRequestId = null;
        f.chatError = r.error;
        // Roll back the user message we optimistically appended — easier
        // than disabling Send until the IPC resolves.
        f.chatMessages = f.chatMessages.slice(0, -1);
        PR.repaintAiReviewTab();
      }
    });
  };

  // After findings are reconciled, scan the registry for any chat agent
  // still streaming for this PR. If we find one, rebind it to its finding so
  // the streaming bubble shows up again on return.
  PR.rehydrateChatAgents = function() {
    if (!PR.lastState || !PR.lastState.number) return;
    if (!PR.aiReview.findings || !PR.aiReview.findings.length) return;
    if (!window.klaus || !window.klaus.agents) return;
    window.klaus.agents.list().then(function (list) {
      if (!list || !list.length) return;
      var prefix = 'pr-review-chat:' + PR.lastState.number + ':';
      list.forEach(function (agent) {
        if (agent.kind !== 'pr-review-chat' || agent.status !== 'running') return;
        if (!agent.dedupeKey || agent.dedupeKey.indexOf(prefix) !== 0) return;
        var fid = agent.dedupeKey.slice(prefix.length);
        var f = PR.aiReview.findings.find(function (x) { return x.id === fid; });
        if (!f || f.chatRequestId === agent.id) return;
        PR.attachChatAgentToFinding(f, agent);
      });
    });
  };

  PR.attachChatAgentToFinding = function(f, agent) {
    f.chatRequestId = agent.id;
    f.chatStreaming = '';
    f.chatError = null;
    PR.repaintAiReviewTab();

    var buffered = '';
    var unsubData = window.klaus.pr.onReviewChatData(agent.id, function (chunk) {
      if (f.chatRequestId !== agent.id) return;
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
              if (block.type === 'text' && block.text) f.chatStreaming = block.text;
            });
          } else if (ev.type === 'result' && ev.result) {
            f.chatStreaming = ev.result;
          }
        } catch (_) {}
      }
      PR.repaintAiReviewTab();
    });
    window.klaus.pr.onReviewChatDone(agent.id, function (result) {
      if (unsubData) unsubData();
      if (f.chatRequestId !== agent.id) return;
      f.chatRequestId = null;
      if (result && result.error) {
        f.chatError = result.error;
      } else if (result && result.cancelled) {
        if (f.chatStreaming) f.chatMessages.push({ role: 'assistant', content: f.chatStreaming });
      } else {
        f.chatMessages.push({ role: 'assistant', content: f.chatStreaming || '' });
      }
      f.chatStreaming = '';
      PR.repaintAiReviewTab();
      PR.saveAiReviewCache();
    });
  };

  // ---- Conversation-tab Claude actions ----

  // Build the prompt context for a conv-comment Claude run. Includes the
  // commenter's body and (for review-thread comments) the file/line plus
  // diff hunk so claude doesn't have to guess where to look.
  PR.buildConvPromptBody = function(s) {
    var ctx = (s && s.ctx) || {};
    var parts = [];
    if (ctx.kind === 'review' && ctx.path) parts.push('Anchored at: ' + ctx.path);
    if (ctx.hunk && ctx.hunk.trim()) parts.push('Diff hunk:\n```\n' + ctx.hunk + '\n```');
    parts.push('Reviewer comment:\n\n' + (ctx.body || ''));
    return parts.join('\n\n');
  };

  PR.startConvInvestigate = function(dbid) {
    var s = PR.convClaudeState[dbid];
    if (!s || s.investigateId) return;
    var requestId = 'cinv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    s.investigateId = requestId;
    s.investigateStreaming = '';
    s.investigateResult = '';
    s.investigateError = null;
    PR.repaintConversationTab();

    var buffered = '';
    var unsubData = window.klaus.pr.onReviewInvestigateData(requestId, function (chunk) {
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
              if (block.type === 'text' && block.text) s.investigateStreaming = block.text;
            });
          } else if (ev.type === 'result' && ev.result) {
            s.investigateStreaming = ev.result;
          }
        } catch (_) {}
      }
      PR.repaintConversationTab();
    });
    window.klaus.pr.onReviewInvestigateDone(requestId, function (result) {
      if (unsubData) unsubData();
      if (s.investigateId !== requestId) return;
      s.investigateId = null;
      if (result && result.error) {
        s.investigateError = result.error;
      } else if (result && result.cancelled) {
        if (s.investigateStreaming) s.investigateResult = s.investigateStreaming;
      } else {
        s.investigateResult = s.investigateStreaming || '';
      }
      s.investigateStreaming = '';
      PR.repaintConversationTab();
    });

    window.klaus.pr.reviewInvestigateStart(requestId, PR.buildConvPromptBody(s)).then(function (r) {
      if (r && r.error) {
        if (unsubData) unsubData();
        s.investigateId = null;
        s.investigateError = r.error;
        PR.repaintConversationTab();
      }
    });
  };

  PR.startConvImplement = function(dbid) {
    var s = PR.convClaudeState[dbid];
    if (!s || PR.implRunIsLive()) return;
    s.implementOut = '';
    s.implementError = null;
    s.implementDraft = '';
    s.implementDraftStatus = null;
    PR.repaintConversationTab();

    // The xterm itself mounts in the Terminal tab; the conv card just
    // mirrors progress text. Repaint all three surfaces so the user can
    // switch tabs freely and see consistent state.
    var repaintAll = function () { PR.repaintAiReviewTab(); PR.repaintConversationTab(); PR.repaintTerminalTab(); };

    PR.switchToTerminalTab();
    PR.startImplementRun({
      mode: 'one',
      body: PR.buildConvPromptBody(s),
      repaint: repaintAll,
      onAssistantText: function (text) { s.implementOut = text; },
      onDone: function () {
        var parsed = PR.extractDraftCommentFromText(s.implementOut);
        s.implementOut = parsed.text;
        if (parsed.draft) {
          s.implementDraft = parsed.draft;
          s.implementDraftStatus = 'pending';
        }
        s.implementId = null;
      },
      onError: function (msg) {
        s.implementError = msg;
        s.implementId = null;
      },
      onCancelled: function () {
        s.implementId = null;
      },
    });
    if (PR.implRun) s.implementId = PR.implRun.requestId;
  };

  // Approve and post the implement draft. Inline thread comments → reply
  // via pr-reply-to-review-comment; issue comments → addIssueComment.
  // Refreshes threads on success so the new comment appears in the feed.
  PR.approveConvImplementDraft = async function(dbid, btn) {
    var s = PR.convClaudeState[dbid];
    if (!s || !s.implementDraft) return;
    if (s.draftPosting) return;
    var card = btn && btn.closest('.pr-conv-claude-draft');
    var ta = card && card.querySelector('.pr-conv-claude-draft-input');
    var body = ta ? ta.value.trim() : s.implementDraft.trim();
    if (!body) return;
    s.implementDraft = body;
    s.draftPosting = true;
    s.draftError = null;
    PR.repaintConversationTab();

    var ctx = s.ctx || {};
    var result;
    try {
      if (ctx.kind === 'review' && ctx.replyParentId) {
        result = await window.klaus.pr.replyToReviewComment(ctx.replyParentId, body);
      } else {
        result = await window.klaus.pr.addIssueComment(body);
      }
    } catch (err) {
      result = { error: (err && err.message) ? err.message : String(err) };
    }

    s.draftPosting = false;
    if (result && result.error) {
      s.draftError = result.error;
      PR.repaintConversationTab();
      return;
    }
    s.implementDraftStatus = 'approved';
    PR.repaintConversationTab();
    try { await window.klaus.pr.refreshThreads(); } catch (_) {}
  };

  // Kick off a Claude-investigate run. Single-shot read-only: claude reads
  // the code in the worktree and returns a Verdict/Reasoning/Recommendation
  // block. Stores the result on f.investigateResult for the panel to render.
  PR.startInvestigate = function(f) {
    if (f.investigateId) return;
    var requestId = 'inv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    f.investigateId = requestId;
    f.investigateStreaming = '';
    f.investigateResult = '';
    f.investigateError = null;
    PR.repaintAiReviewTab();

    var buffered = '';
    var unsubData = window.klaus.pr.onReviewInvestigateData(requestId, function (chunk) {
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
              if (block.type === 'text' && block.text) f.investigateStreaming = block.text;
            });
          } else if (ev.type === 'result' && ev.result) {
            f.investigateStreaming = ev.result;
          }
        } catch (_) {}
      }
      PR.repaintAiReviewTab();
    });
    window.klaus.pr.onReviewInvestigateDone(requestId, function (result) {
      if (unsubData) unsubData();
      if (f.investigateId !== requestId) return;
      f.investigateId = null;
      if (result && result.error) {
        f.investigateError = result.error;
      } else if (result && result.cancelled) {
        // Keep whatever streamed before cancel so the user sees partial progress.
        if (f.investigateStreaming) f.investigateResult = f.investigateStreaming;
      } else {
        f.investigateResult = f.investigateStreaming || '';
      }
      f.investigateStreaming = '';
      PR.repaintAiReviewTab();
      PR.saveAiReviewCache();
    });

    window.klaus.pr.reviewInvestigateStart(requestId, f.text).then(function (r) {
      if (r && r.error) {
        if (unsubData) unsubData();
        f.investigateId = null;
        f.investigateError = r.error;
        PR.repaintAiReviewTab();
      }
    });
  };

  PR.startImplementAll = function() {
    if (PR.implRunIsLive()) return;
    var pending = PR.aiReview.findings.filter(function (f) {
      return !f.ignored && f.status !== 'implemented' && f.status !== 'implementing';
    });
    if (pending.length === 0) return;

    pending.forEach(function (f) { f.status = 'implementing'; });
    PR.aiReview.implementAllProgress = [{ kind: 'system', label: 'Implementing ' + pending.length + ' findings\u2026' }];
    PR.aiReview.implementAllError = null;
    PR.aiReview.implementAllSummary = null;
    PR.aiReview.implementAllUsage = null;

    var combined = pending.map(function (f, i) {
      return '### Finding ' + (i + 1) + '\n' + f.text;
    }).join('\n\n');

    PR.switchToTerminalTab();
    PR.startImplementRun({
      mode: 'all',
      body: combined,
      repaint: PR.repaintForImplRun,
      onAssistantText: function (text) { PR.aiReview.implementAllSummary = text; },
      onUsage: function (u) { PR.aiReview.implementAllUsage = u; },
      onTool: function (chip) { PR.aiReview.implementAllProgress.push(chip); },
      onDone: function () {
        pending.forEach(function (f) {
          f.status = 'implemented';
          f.implementOut = PR.aiReview.implementAllSummary || '';
          f.implementId = null;
        });
        PR.aiReview.implementAllId = null;
        PR.saveAiReviewCache();
      },
      onError: function (msg) {
        PR.aiReview.implementAllError = msg;
        pending.forEach(function (f) {
          f.status = 'failed';
          f.implementError = msg;
          f.implementId = null;
        });
        PR.aiReview.implementAllId = null;
        PR.saveAiReviewCache();
      },
      onCancelled: function () {
        pending.forEach(function (f) {
          if (f.status === 'implementing') f.status = 'open';
          f.implementId = null;
        });
        PR.aiReview.implementAllId = null;
        PR.saveAiReviewCache();
      },
    });
    // Tracker for the Rerun button + the disabled state of the
    // "Implement all" button while a run is in flight.
    if (PR.implRun) PR.aiReview.implementAllId = PR.implRun.requestId;
  };

  PR.bindFileList = function() {
    PR.hostEl.querySelectorAll('.pr-review-file').forEach(function (row) {
      row.addEventListener('click', function () {
        PR.selectedFile = row.dataset.file;
        if (PR.lastState) PR.render(PR.lastState);
      });
    });
  };

  // ---- G4: draft review comments ----

  // Map the current text selection to a GitHub line-comment range. Mirrors
  // the diff-panel's F5 logic: pool the touched diff-line elements by side
  // (RIGHT if any addition/context touched, else LEFT) and collapse to
  // first/last line. Returns null if nothing usable is selected.
  PR.computeCommentRange = function() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    var diffArea = PR.hostEl.querySelector('.pr-review-diff');
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
      path: PR.selectedFile,
      side: side,
      line: last,
      startLine: first !== last ? first : null,
      startSide: first !== last ? side : null,
      anchorEl: touched[touched.length - 1],
    };
  };

  PR.openCommentComposer = function(range) {
    if (!range || !range.path) return;
    window.getSelection().removeAllRanges();
    // Only one composer at a time — and it's modal-ish for the active range.
    var existing = PR.hostEl.querySelector('.pr-comment-composer');
    if (existing) existing.remove();

    var label = range.startLine
      ? range.path + ':L' + range.startLine + '-L' + range.line
      : range.path + ':L' + range.line;

    var composer = document.createElement('div');
    composer.className = 'pr-comment-composer';
    composer.innerHTML =
      '<div class="pr-comment-composer-head">'
        + '<span>Draft comment on <code>' + PR.escHtml(label) + '</code></span>'
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
      PR.pendingComments.push({
        id: 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        path: range.path,
        line: range.line,
        side: range.side,
        startLine: range.startLine,
        startSide: range.startSide,
        body: body,
      });
      close();
      if (PR.lastState) PR.render(PR.lastState);
    });
  };

  PR.removePendingComment = function(id) {
    PR.pendingComments = PR.pendingComments.filter(function (c) { return c.id !== id; });
    if (PR.lastState) PR.render(PR.lastState);
  };

  PR.renderPendingCount = function() {
    return PR.pendingComments.length;
  };

  PR.injectPendingComments = function() {
    if (!PR.selectedFile) return;
    var forFile = PR.pendingComments.filter(function (c) { return c.path === PR.selectedFile; });
    if (forFile.length === 0) return;
    var diffPre = PR.hostEl.querySelector('.pr-review-diff-pre');
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
          + '<span class="pr-pending-summary">' + PR.escHtml(PR.firstTwoLines(c.body)) + '</span>'
          + '<button class="pr-pending-remove" type="button" title="Discard draft">&times;</button>'
        + '</div>'
        + '<div class="pr-pending-body">' + PR.renderCommentBody(c.body) + '</div>';
      after.insertAdjacentElement('afterend', el);
      el.querySelector('.pr-pending-remove').addEventListener('click', function () {
        PR.removePendingComment(c.id);
      });
    });
  };

  // GitHub forbids APPROVE / REQUEST_CHANGES on your own PR — only a plain
  // COMMENT review is allowed. True when the active PR's author is the
  // signed-in gh user (author known from meta; user from the once-per-mount
  // currentUser fetch). Defaults to false if either is unknown, so we never
  // wrongly hide the options for someone else's PR.
  PR.isOwnPullRequest = function() {
    var meta = (PR.lastState && PR.lastState.meta) || {};
    var author = meta.author && meta.author.login;
    return !!(author && PR.currentUserLogin && author === PR.currentUserLogin);
  };

  PR.openSubmitReviewDialog = function() {
    if (PR.pendingComments.length === 0) {
      if (!confirm('No pending comments. Submit review anyway (summary only)?')) return;
    }
    var ownPr = PR.isOwnPullRequest();
    var selfDisabled = ownPr ? ' disabled' : '';
    var selfHint = ownPr ? 'GitHub doesn’t allow this on your own PR' : '';
    var overlay = document.createElement('div');
    overlay.className = 'pr-submit-overlay';
    overlay.innerHTML =
      '<div class="pr-submit-dialog">'
        + '<div class="pr-submit-head">Submit review</div>'
        + '<div class="pr-submit-count">' + PR.pendingComments.length
          + ' pending comment' + (PR.pendingComments.length === 1 ? '' : 's') + '</div>'
        + '<textarea class="pr-submit-body" placeholder="Overall summary (optional)" rows="4"></textarea>'
        + '<div class="pr-submit-events">'
          + '<label class="pr-submit-event"><input type="radio" name="pr-event" value="COMMENT" checked /> <span class="pr-submit-event-label">Comment</span><span class="pr-submit-event-hint">Submit without approval</span></label>'
          + '<label class="pr-submit-event' + (ownPr ? ' disabled' : '') + '"><input type="radio" name="pr-event" value="APPROVE"' + selfDisabled + ' /> <span class="pr-submit-event-label">Approve</span><span class="pr-submit-event-hint">' + (ownPr ? selfHint : 'Submit feedback and approve') + '</span></label>'
          + '<label class="pr-submit-event' + (ownPr ? ' disabled' : '') + '"><input type="radio" name="pr-event" value="REQUEST_CHANGES"' + selfDisabled + ' /> <span class="pr-submit-event-label">Request changes</span><span class="pr-submit-event-hint">' + (ownPr ? selfHint : 'Submit feedback that must be addressed') + '</span></label>'
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
      if (event === 'COMMENT' && !body && PR.pendingComments.length === 0) {
        errEl.style.display = '';
        errEl.textContent = 'Add a summary or at least one line comment.';
        return;
      }
      sendBtn.disabled = true;
      sendBtn.textContent = 'Submitting\u2026';
      var result = await window.klaus.pr.submitReview({ event: event, body: body, comments: PR.pendingComments });
      if (result.error) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Submit review';
        errEl.style.display = '';
        errEl.textContent = result.error;
        return;
      }
      PR.pendingComments = [];
      close();
      // Pull in the newly-posted threads so they replace the drafts inline.
      await window.klaus.pr.refreshThreads();
    });
  };

  // ---- G3: inline review threads ----

  PR.injectInlineThreads = function(threadsByPath) {
    if (!PR.selectedFile) return;
    var fileThreads = threadsByPath[PR.selectedFile] || [];
    if (fileThreads.length === 0) return;
    var diffPre = PR.hostEl.querySelector('.pr-review-diff-pre');
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
      var panel = PR.renderThreadPanel(thread);
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
          + outdated.map(PR.renderThreadPanel).join('')
        + '</div>');
    }

    PR.bindThreadControls();
  };

  PR.renderThreadPanel = function(thread) {
    var comments = (thread.comments && thread.comments.nodes) || [];
    var resolvedCls = thread.isResolved ? ' resolved collapsed' : '';
    var outdatedCls = thread.isOutdated ? ' outdated' : '';
    var firstAuthor = comments[0] && comments[0].author ? comments[0].author.login : 'unknown';
    var summary = comments[0] ? PR.firstTwoLines(comments[0].body) : '';

    var commentsHtml = comments.map(function (c) {
      var author = (c.author && c.author.login) || 'unknown';
      var when = c.createdAt ? new Date(c.createdAt).toLocaleString() : '';
      return '<div class="pr-inline-comment">'
        + '<div class="pr-inline-comment-head">'
          + '<span class="pr-inline-author">' + PR.escHtml(author) + '</span>'
          + '<span class="pr-inline-when">' + PR.escHtml(when) + '</span>'
        + '</div>'
        + '<div class="pr-inline-comment-body">' + PR.renderCommentBody(c.body) + '</div>'
      + '</div>';
    }).join('');

    return '<div class="pr-inline-thread' + resolvedCls + outdatedCls + '" data-thread-id="' + PR.escHtml(thread.id) + '">'
      + '<div class="pr-inline-thread-head">'
        + '<span class="pr-inline-thread-chevron">\u25B8</span>'
        + '<span class="pr-inline-thread-summary">'
          + (thread.isResolved ? '<span class="pr-inline-thread-badge resolved">resolved</span>' : '')
          + (thread.isOutdated ? '<span class="pr-inline-thread-badge outdated">outdated</span>' : '')
          + '<span class="pr-inline-thread-author">' + PR.escHtml(firstAuthor) + '</span>'
          + '<span class="pr-inline-thread-preview">' + PR.escHtml(summary) + '</span>'
          + '<span class="pr-inline-thread-count">' + comments.length + '</span>'
        + '</span>'
      + '</div>'
      + '<div class="pr-inline-thread-body">' + commentsHtml + '</div>'
    + '</div>';
  };

})(window.PrReview);
