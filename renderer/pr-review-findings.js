// Part of the PrReview surface (window.PrReview); see pr-review.js for the
// core. AI review findings: parse, reconcile, verify, finding cards, summary.
// All cross-references go through the shared `PR` object, so load order
// only needs core (pr-review.js) first; siblings may load in any order.

(function (PR) {

  PR.sanitizeAiTone = PR._FP.sanitizeAiTone;
  PR.parseReviewFindings = PR._FP.parseReviewFindings;
  PR.severityOf = PR._FP.severityOf;

  // Extract `[Location: path/to/file.ts:42 …]` into structured fields.
  // Returns { path, line, snippet } or null. Accepts 0–2 bold asterisks
  // like the severity matcher, and is lenient about trailing "and code…"
  // text after the line number.
  PR.parseLocation = function(text) {
    if (!text) return null;
    var m = text.match(/\*{0,2}\[Location:\s*([^\]]+?)\]\*{0,2}/i);
    if (!m) return null;
    var inner = m[1].trim();
    // Find a `path:line` anchor. Require the path to include a `/` or `.`
    // so we don't accidentally match English like "line: 42". Line must
    // come right after a colon. Optional `-N` after captures a range end
    // (e.g. `reframe.html:1041-1085`).
    var pm = inner.match(/([^\s,;]*[\/.][^\s,;:]*):(\d+)(?:-(\d+))?/);
    if (!pm) return null;
    var snippet = '';
    // Everything after the matched "path:line[-end]" is treated as the
    // snippet hint — the template says "and code_snippet" so strip that
    // prefix.
    var tail = inner.slice(pm.index + pm[0].length).replace(/^\s*(and\s+)?/i, '').trim();
    if (tail) snippet = tail;
    var endLine = pm[3] ? parseInt(pm[3], 10) : null;
    return { path: pm[1], line: parseInt(pm[2], 10), endLine: endLine, snippet: snippet };
  };

  // Extract `[Category: Correctness]` (0–2 bold asterisks, like the others).
  PR.parseCategory = function(text) {
    if (!text) return '';
    var m = text.match(/\*{0,2}\[Category:\s*([^\]|]+?)(?:\s*\|[^\]]*)?\]\*{0,2}/i);
    return m ? m[1].trim() : '';
  };

  // Strip the bracketed metadata header lines ([Severity]/[Location]/[Category])
  // and a standalone Comment: label from a finding's prose — those now render as
  // the severity dot, category tag, and location label, not inline brackets.
  PR.stripFindingHeaders = function(text) {
    if (!text) return text;
    return text
      // [Severity]/[Location]/[Category] brackets, with their surrounding bold
      // markers. Non-anchored + [\s\S] so a bracket the agent split across
      // lines is still removed whole.
      .replace(/\*{0,2}\[(?:Severity|Location|Category)\s*:[\s\S]*?\]\*{0,2}/gi, '')
      .replace(/^[^\S\n]*\*{0,2}Comment\*{0,2}\s*:\s*\*{0,2}[^\S\n]*$/gim, '')
      // Orphaned bold markers left on their own line.
      .replace(/^[^\S\n]*\*{1,3}[^\S\n]*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };

  // Pull the first fenced-code block out of a finding — a more reliable
  // snippet for line-verification than the short inline location hint,
  // because the template tells Claude to quote up to 10 lines of the code.
  PR.firstCodeBlock = function(text) {
    if (!text) return '';
    var m = text.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
    return m ? m[1] : '';
  };

  // Reconcile parsed-finding text with our state's findings list. Parsing
  // happens on every chunk during streaming, so we want to preserve any
  // per-card status (ignored, implementing, implemented) when the same
  // finding text reappears. Keying on the first-line snippet survives
  // chunk boundaries better than full-text equality.
  // Single entry point for (re)parsing the accumulated review text: capture
  // the structured summary (verdict / highest-risk / test coverage) when the
  // JSON contract provides it, then reconcile the finding cards. Called on
  // every stream chunk and on cache load.
  PR.applyReviewParse = function() {
    var parsed = PR.parseReviewFindings(PR.aiReview.finalText);
    if (parsed.summary) PR.aiReview.summary = parsed.summary;
    PR.reconcileFindings(parsed.findings);
  };

  PR.reconcileFindings = function(parsedFindings) {
    var byKey = {};
    PR.aiReview.findings.forEach(function (f) { byKey[f.key] = f; });
    var next = parsedFindings.map(function (pf, idx) {
      // Findings arrive as objects from the parser. Structured (JSON) findings
      // carry real metadata fields; legacy (marker/text) findings carry only
      // `{ structured:false, text }` and we scrape location/severity out of
      // `text` exactly as before.
      var structured = !!(pf && pf.structured);
      var text = (pf && pf.text) || '';
      var key = structured ? PR.structuredFindingKey(pf, idx) : PR.findingKey(text, idx);
      // For structured findings the location is given; for legacy we scrape it.
      var loc = structured
        ? (pf.path && pf.line ? { path: pf.path, line: pf.line, snippet: '' } : null)
        : PR.parseLocation(text);
      var prev = byKey[key];
      if (prev) {
        // Preserve user edits across streaming re-parses: once the user has
        // modified the review block via ✎, don't clobber their text with
        // fresh AI output.
        //
        // `userEdited` = the visible text diverged from the pristine AI text.
        // While the AI is still streaming, its text GROWS each re-parse, so we
        // must keep `originalText` in sync with it — otherwise the first parse
        // freezes the body (originalText) and every later (longer) parse looks
        // like a user edit, leaving a truncated finding. Agents that stream in
        // many small deltas (Gemini) hit this; only a real ✎ edit, which
        // changes `text` WITHOUT touching `originalText`, should diverge them.
        var userEdited = prev.originalText != null && prev.text !== prev.originalText;
        if (!userEdited) {
          prev.text = text;
          prev.originalText = text;
          prev.severity = structured ? pf.severity : PR.severityOf(text);
          if (structured) {
            prev.title = pf.title;
            prev.category = pf.category;
            prev.code = pf.code;
            prev.suggestion = pf.suggestion;
            prev.side = pf.side || 'RIGHT';
          }
          if (loc && !prev.locationVerified) {
            prev.path = loc.path;
            prev.line = loc.line;
            prev.locationRaw = loc;
          }
        } else if (prev.originalText == null) {
          prev.originalText = text;
        }
        return prev;
      }
      return {
        id: 'f-' + Date.now() + '-' + idx + '-' + Math.random().toString(36).slice(2, 6),
        key: key,
        text: text,
        // Pristine copy of the AI's output so the ✎ "Reset to AI text" can
        // restore the original, and so we know whether the user edited.
        originalText: text,
        textEditing: false,
        severity: structured ? pf.severity : PR.severityOf(text),
        // Structured-finding metadata (undefined for legacy findings — the
        // renderer treats their absence as "legacy card").
        structured: structured,
        title: structured ? pf.title : '',
        category: structured ? pf.category : '',
        code: structured ? pf.code : '',
        suggestion: structured ? pf.suggestion : '',
        status: 'open',
        implementId: null,
        implementOut: '',
        implementError: null,
        commentStatus: 'idle', // 'idle' | 'posting' | 'posted' | 'failed'
        commentError: null,
        // Structured location from `[Location: path:line]`. `locationVerified`
        // is true after we confirmed the snippet actually lives at that line
        // (or found the real one nearby). RIGHT-side inline comments are the
        // only mode we support for AI findings — LEFT would only make sense
        // for comments about deleted code, rare for a review.
        path: loc ? loc.path : null,
        line: loc ? loc.line : null,
        side: structured ? (pf.side || 'RIGHT') : 'RIGHT',
        locationRaw: loc,
        locationVerified: false,
        // Post mode: 'inline' if we have a verified file+line (draft review
        // comment), 'issue' if we fall back to a general issue comment.
        // Set by verification; drives the Add-to-PR button behavior.
        postMode: loc ? 'inline' : 'issue',
        // Ask-Claude chat state. Stateless on the backend: each turn sends
        // the full conversation. `chatMessages` is [{role, content}].
        chatOpen: false,
        chatMessages: [],
        chatRequestId: null,
        chatStreaming: '',
        chatError: null,
        // Claude-investigate state. One-shot read-only validation of the
        // finding. `investigateResult` is the final markdown verdict;
        // `investigateStreaming` holds in-flight text.
        investigateId: null,
        investigateStreaming: '',
        investigateResult: '',
        investigateError: null,
        // Draft PR comment produced by Claude implement. Status transitions
        // null → 'pending' (awaiting approval) → 'approved' (pushed onto
        // pendingComments) or 'dismissed'. Approve/Dismiss is per-finding.
        implementDraftComment: '',
        implementDraftStatus: null,
      };
    });
    PR.aiReview.findings = next;
    // Kick off verification asynchronously; it'll repaint when it lands.
    PR.verifyFindingLocations();
  };

  PR.findingKey = function(text, idx) {
    // First non-empty line tends to be unique (it's the title); fall back to
    // the index so keys are still stable for unparseable findings.
    var firstLine = (text || '').split('\n').find(function (l) { return l.trim(); }) || '';
    return idx + '|' + firstLine.slice(0, 80);
  };

  // Stable key for a structured finding. Title + path:line is far more stable
  // across streaming re-parses (and cache reloads) than scraping the first
  // prose line, since the prose body grows chunk by chunk while the title and
  // location are fixed once the object closes.
  PR.structuredFindingKey = function(pf, idx) {
    var anchor = (pf.title || '').slice(0, 80) || (pf.text || '').split('\n')[0].slice(0, 80);
    var loc = pf.path ? pf.path + ':' + (pf.line || '') : '';
    return idx + '|' + anchor + '|' + loc;
  };

  // Normalize a line for fuzzy matching. The snippet in a finding often
  // differs from the file by whitespace/quoting; collapse spaces and drop
  // surrounding markers so we match on the meaningful tokens.
  PR.normalizeLine = function(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  };

  // Best line match across ALL candidate snippets. Searches around the hinted
  // line first (±50). When the [Location] hint is given (which it always is
  // in the AI-review flow), we never accept a "far" match: a confident match
  // must be near the hint OR exactly at the hint line. Otherwise the picker
  // can snap to a tangentially-related snippet that Claude pasted alongside
  // the real code (e.g. a finding about lines 1041-1085 that pastes a call
  // site at line 747 — without this constraint, a unique match at 747 would
  // override the hint and post the comment on the wrong line).
  //
  // Returns { line } if a confident match is found, null otherwise.
  PR.findSnippetLineAcrossCandidates = function(fileContent, hintLine, candidates) {
    var lines = fileContent.split('\n');
    var validCandidates = candidates
      .map(function (s) { return PR.normalizeLine(s); })
      .filter(function (s) { return s && s.length >= 4; });
    if (validCandidates.length === 0) return null;

    // Direct hit: any candidate's text appears on the hint line itself.
    if (hintLine && lines[hintLine - 1] != null) {
      var hintLineContent = PR.normalizeLine(lines[hintLine - 1]);
      for (var c = 0; c < validCandidates.length; c++) {
        if (hintLineContent.indexOf(validCandidates[c]) !== -1) {
          return { line: hintLine };
        }
      }
    }

    // Collect every near match (±50 of hint) across every candidate, then
    // pick the closest. We intentionally do NOT collect far matches when a
    // hint is given — a far match means Claude's [Location] is wrong AND
    // we can recover, but the recovery is too easy to fool when a finding
    // pastes context from multiple parts of the file.
    var near = [];
    for (var ci = 0; ci < validCandidates.length; ci++) {
      var t = validCandidates[ci];
      for (var i = 0; i < lines.length; i++) {
        if (PR.normalizeLine(lines[i]).indexOf(t) === -1) continue;
        var ln = i + 1;
        if (!hintLine) { near.push(ln); continue; }
        if (Math.abs(ln - hintLine) <= 50) near.push(ln);
      }
    }
    if (near.length === 0) return null;
    if (!hintLine) return { line: near[0] };
    near.sort(function (a, b) { return Math.abs(a - hintLine) - Math.abs(b - hintLine); });
    return { line: near[0] };
  };

  // Verify each finding's line number by reading the file inside the
  // review's worktree and checking that the snippet lives at the cited
  // line (or finding the true one nearby). Fire-and-forget: updates the
  // finding state and repaints on completion.
  PR.verifyFindingLocations = function() {
    if (!PR.aiReview.worktreePath) return;
    PR.aiReview.findings.forEach(function (f) {
      if (!f.path || !f.line) return;
      // Re-verify cached findings missing the file snippet — happens for
      // findings cached from a Klaussy version that didn't capture the file
      // content. Skip only when fully verified.
      if (f.locationVerified && f.verifiedSnippet) return;
      if (f._verifyInFlight) return;
      f._verifyInFlight = true;
      window.klaus.pr.readWorktreeFile(PR.aiReview.worktreePath, f.path).then(function (r) {
        f._verifyInFlight = false;
        if (!r || r.error || !r.content) {
          // File missing / unreadable → we can't verify. Leave postMode
          // at 'inline' if the AI gave us a location — submitReview will
          // surface a server-side error if the path is truly bad, which
          // is more diagnostic than a silent fallback.
          f.locationVerifyError = r && r.error ? r.error : 'unreadable';
          PR.repaintAiReviewTab();
          return;
        }
        // Structured findings carry the original code verbatim in `f.code`;
        // legacy findings only have a fenced block pasted into the prose. Use
        // whichever exists as the snippet source.
        var snippet = f.code || PR.firstCodeBlock(f.text) || (f.locationRaw && f.locationRaw.snippet) || '';
        // Build candidate list from the fenced code block lines + the
        // location-hint snippet. Considered together (not in priority order)
        // so a tangential first-line match doesn't pre-empt a more relevant
        // later candidate that would have matched near the hint.
        var candidates = snippet.split('\n').map(function (s) { return s.trim(); }).filter(function (s) {
          return s && s.length >= 4 && !/^[\/*#\-]+$/.test(s);
        });
        if (f.locationRaw && f.locationRaw.snippet) candidates.push(f.locationRaw.snippet);
        var match = PR.findSnippetLineAcrossCandidates(r.content, f.line, candidates);
        if (match) {
          f.line = match.line;
          f.locationVerified = true;
          f.postMode = 'inline';
          // Capture file content at the verified location so the card can
          // render the original code in a fixed position (between headers
          // and Comment). End-line preference: locationRaw range like
          // 1041-1085 → keep some of that context; otherwise a small
          // window around the matched line. Capped at ~12 lines so the
          // card stays compact.
          var endLine = (f.locationRaw && f.locationRaw.endLine) || (match.line + 4);
          var startLine = Math.max(1, match.line - 2);
          if (endLine - startLine > 11) endLine = startLine + 11;
          var allLines = r.content.split('\n');
          var snippetLines = allLines.slice(startLine - 1, endLine);
          f.verifiedSnippet = {
            path: f.path,
            startLine: startLine,
            endLine: startLine + snippetLines.length - 1,
            text: snippetLines.join('\n'),
          };
        } else {
          // No match anywhere in the file — Claude probably hallucinated
          // the location. Fall back to issue-comment mode so "Add to PR"
          // still posts *something* useful rather than a broken inline.
          f.locationVerified = false;
          f.postMode = 'issue';
          f.verifiedSnippet = null;
        }
        PR.repaintAiReviewTab();
        PR.saveAiReviewCache();
      }).catch(function (err) {
        f._verifyInFlight = false;
        f.locationVerifyError = err && err.message ? err.message : String(err);
        PR.repaintAiReviewTab();
      });
    });
  };

  // Whether repo-intel (conventions + import graph from klaussy-repo-conventions) is
  // cached for this PR's repo — surfaced as a chip so the user knows the
  // review prompt is conventions-aware. null = unknown / no worktree yet.
  PR.repoIntelState = { path: null, available: null };

  PR.checkRepoIntel = function(worktreePath) {
    if (!worktreePath) {
      // No worktree (PR switched / not checked out) — don't keep showing the
      // previous repo's chip.
      PR.repoIntelState = { path: null, available: null };
      return;
    }
    if (PR.repoIntelState.path === worktreePath) return;
    PR.repoIntelState.path = worktreePath;
    PR.repoIntelState.available = null;
    window.klaus.task.getRepoIntel(worktreePath).then(function (res) {
      if (PR.repoIntelState.path !== worktreePath) return; // PR switched meanwhile
      var avail = !!(res && res.block);
      if (PR.repoIntelState.available !== avail) {
        PR.repoIntelState.available = avail;
        PR.repaintAiReviewTab();
      }
    }).catch(function (e) {
      console.warn('[pr-review repo-intel]', e);
    });
  };

  PR.repoIntelChip = function() {
    return PR.repoIntelState.available
      ? '<span class="pr-ai-conventions-chip" title="This repo’s conventions, rules, and import graph (klaussy-repo-conventions) are injected into the review prompt">conventions-aware</span>'
      : '';
  };

  PR.renderAiReviewTabCount = function() {
    var openFindings = PR.aiReview.findings.filter(function (f) { return !f.ignored && f.status !== 'implemented'; }).length;
    if (!openFindings && !PR.aiReview.requestId && !PR.aiReview.finalText) return '';
    if (!openFindings) return '';
    return ' <span class="pr-tab-count">' + openFindings + '</span>';
  };

  PR.renderAiReviewTab = function() {
    var localBlock = PR.renderLocalChanges();
    PR.checkRepoIntel((PR.localChanges && PR.localChanges.worktreePath) || PR.aiReview.worktreePath);
    if (!PR.aiReview.requestId && !PR.aiReview.finalText && !PR.aiReview.error && !PR.aiReview.cancelled) {
      return localBlock
        + '<div class="pr-ai-empty">'
          + '<button class="pr-review-btn pr-ai-run" type="button">Run review</button>'
          + PR.repoIntelChip()
          + '<div class="pr-ai-empty-hint">Spawns the selected agent in a worktree to review the PR end to end. ~1\u20133 min for an average PR.</div>'
        + '</div>';
    }

    var status = PR.aiReview.requestId ? 'streaming' : PR.aiReview.error ? 'error' : PR.aiReview.cancelled ? 'cancelled' : 'done';
    var openFindings = PR.aiReview.findings.filter(function (f) { return !f.ignored; });
    var unimplementedOpen = openFindings.filter(function (f) { return f.status !== 'implemented' && f.status !== 'implementing'; });

    var usageStr = PR.aiReview.usage ? PR.formatUsage(PR.aiReview.usage) : '';
    var head = '<div class="pr-ai-head">'
      + '<span class="pr-ai-title">'
        + (PR.aiReview.requestId ? 'Reviewing\u2026'
            : PR.aiReview.error ? 'Failed'
            : PR.aiReview.cancelled && !PR.aiReview.finalText ? 'Cancelled'
            : PR.aiReview.findings.length + ' finding' + (PR.aiReview.findings.length === 1 ? '' : 's'))
      + '</span>'
      + PR.repoIntelChip()
      + (usageStr ? '<span class="pr-ai-usage" title="Reported by the agent for this review run">' + PR.escHtml(usageStr) + '</span>' : '')
      + (PR.aiReview.requestId
          ? '<button class="pr-ai-cancel pr-review-btn" type="button">Cancel</button>'
          : '')
      + (!PR.aiReview.requestId && unimplementedOpen.length > 1
          ? '<button class="pr-ai-implement-all pr-review-btn" type="button"' + (PR.aiReview.implementAllId ? ' disabled' : '') + '>'
              + (PR.aiReview.implementAllId ? 'Implementing all\u2026' : 'Implement all (' + unimplementedOpen.length + ')')
            + '</button>'
          : '')
      + (!PR.aiReview.requestId
          ? '<button class="pr-ai-rerun pr-review-btn" type="button" title="Run a fresh review">Rerun</button>'
          : '')
    + '</div>';

    var progress = (PR.aiReview.requestId || PR.aiReview.implementAllId) && (PR.aiReview.progress.length || PR.aiReview.implementAllProgress.length)
      ? '<div class="pr-ai-progress">'
        + (PR.aiReview.progress.slice(-6).concat(PR.aiReview.implementAllProgress.slice(-6))).map(function (p) {
            return '<span class="pr-ai-progress-chip' + (p.kind === 'system' ? ' system' : '') + '">' + PR.escHtml(p.label) + '</span>';
          }).join('')
      + '</div>'
      : '';

    var implementAllUsageStr = PR.aiReview.implementAllUsage ? PR.formatUsage(PR.aiReview.implementAllUsage) : '';
    var implementAllSummary = PR.aiReview.implementAllSummary
      ? '<div class="pr-ai-implement-all-summary">'
          + PR.escHtml(PR.aiReview.implementAllSummary)
          + (implementAllUsageStr ? '<div class="pr-ai-implement-usage">' + PR.escHtml(implementAllUsageStr) + '</div>' : '')
        + '</div>'
      : '';
    var implementAllError = PR.aiReview.implementAllError
      ? '<div class="pr-ai-implement-all-error">' + PR.escHtml(PR.aiReview.implementAllError) + '</div>'
      : '';

    var body;
    if (PR.aiReview.error) {
      body = '<div class="pr-ai-body error">' + PR.escHtml(PR.aiReview.error) + '</div>';
    } else if (!PR.aiReview.finalText && PR.aiReview.requestId) {
      body = '<div class="pr-ai-body status-pulse">Working\u2026</div>';
    } else if (PR.aiReview.findings.length === 0) {
      // Parser found nothing — show the raw text as one fallback card so the
      // user still sees the review even when the structured shape is off.
      body = '<div class="pr-ai-fallback-card">'
        + '<div class="pr-ai-fallback-head">Review (unparsed)</div>'
        + '<pre class="pr-ai-fallback-body">' + PR.escHtml(PR.sanitizeAiTone(PR.aiReview.finalText || '')) + '</pre>'
      + '</div>';
    } else {
      body = '<div class="pr-ai-findings">'
        + PR.aiReview.findings.map(PR.renderFindingCard).join('')
      + '</div>';
    }

    return '<div class="pr-ai-tab pr-ai-' + status + '">'
      + localBlock + head + PR.renderReviewSummary() + progress + implementAllSummary + implementAllError + body
    + '</div>';
  };

  // Verdict banner from the structured summary: Approve / Request Changes /
  // Block, plus the highest-risk bullets and test-coverage note. Only renders
  // once the review has finished and the JSON contract gave us a summary.
  PR.renderReviewSummary = function() {
    var s = PR.aiReview.summary;
    if (!s || PR.aiReview.requestId) return '';
    if (!s.verdict && (!s.highestRisk || !s.highestRisk.length) && !s.testCoverage) return '';
    var verdictKey = (s.verdict || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-+|-+$/g, '');
    var verdictCls = verdictKey.indexOf('block') === 0 ? 'block'
      : verdictKey.indexOf('request') === 0 || verdictKey.indexOf('changes') !== -1 ? 'changes'
      : verdictKey.indexOf('approve') === 0 ? 'approve'
      : 'neutral';
    var risks = (s.highestRisk || []).filter(Boolean);
    return '<div class="pr-ai-verdict pr-ai-verdict-' + verdictCls + '">'
      + '<div class="pr-ai-verdict-head">'
        + (s.verdict ? '<span class="pr-ai-verdict-badge">' + PR.escHtml(s.verdict) + '</span>' : '')
        + (s.testCoverage ? '<span class="pr-ai-verdict-coverage">Tests: ' + PR.escHtml(s.testCoverage) + '</span>' : '')
      + '</div>'
      + (risks.length
          ? '<ol class="pr-ai-verdict-risks">'
              + risks.map(function (r) { return '<li>' + PR.escHtml(r) + '</li>'; }).join('')
            + '</ol>'
          : '')
    + '</div>';
  };

})(window.PrReview);
