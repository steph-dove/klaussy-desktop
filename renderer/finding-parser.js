// Shared review-finding parser for both PR review surfaces (pr-review.js,
// pr-panel.js). Previously each kept a hand-synced copy ("lockstep") and they
// still drifted; this is now the single source of truth, loaded by
// index.html AND pr-review.html (pop-out) before either consumer.
//
// Parse strategy, most to least structured (memory: the parser has a history
// of unreliability — the full-text fallback must always survive):
//   0. <FINDINGS_JSON> contract: the review template asks the agent to emit a
//      single JSON object ({findings:[…], summary:{…}}) wrapped in literal
//      markers, optionally inside a ```json fence. This is the preferred path
//      because each finding arrives as real fields (severity, path, line,
//      title, body, suggestion) instead of being regex-scraped out of prose.
//      Streaming-safe: while the JSON is still arriving we recover whatever
//      complete finding objects exist so far and ignore the truncated tail.
//   1. <FINDINGS>…</FINDINGS> contract: older marker format. Inside the
//      markers, findings split on the `[Severity: …]` anchor; everything
//      before the opening marker is preamble, after the closing marker is
//      postamble. Streaming-safe: a missing closing marker treats the rest
//      of the text as findings-in-progress.
//   2. Legacy split: `[Severity:` anchors over the whole text (models ignore
//      contracts often enough that this stays load-bearing).
//   3. Single-card fallback: no anchors at all → the entire review renders
//      as one preamble card.
//
// Findings are always returned as objects with a `structured` flag. JSON
// findings carry real metadata fields; marker/text findings carry only
// `{ structured:false, text }` and the renderer scrapes location/severity
// out of `text` exactly as before. Only pr-review.js consumes `.findings`.

window.FindingParser = (function () {
  // Strip em/en dashes outside of fenced and inline code. Em dash is the
  // single strongest AI tell and the prompt rule alone is unreliable; this
  // is the belt to the prompt's suspenders. Idempotent — safe to call on
  // every parse during streaming.
  function sanitizeAiTone(text) {
    if (!text) return text;
    var fenceParts = text.split(/(```[\s\S]*?```)/g);
    for (var i = 0; i < fenceParts.length; i += 2) {
      var inlineParts = fenceParts[i].split(/(`[^`\n]*`)/g);
      for (var j = 0; j < inlineParts.length; j += 2) {
        inlineParts[j] = inlineParts[j]
          .replace(/\s*—\s*/g, ', ')
          .replace(/\s*–\s*/g, ' - ');
      }
      fenceParts[i] = inlineParts.join('');
    }
    return fenceParts.join('');
  }

  // Split anchor: line start, then any combination of common markdown
  // leaders (ATX header `###`, bullet `-`/`*`/`+`, numbered list `1.`,
  // blockquote `>`), then 0–2 leading asterisks, then `[Severity:`.
  // Claude routinely decorates findings with its own headers even though the
  // template doesn't ask for them.
  var SPLIT_RE = /(?=^[\s>]*(?:#{1,6}\s+)?(?:[-*+]\s+)?(?:\d+[.)]\s+)?\*{0,2}\[Severity:)/m;

  // Drop empty or junk entries: every real finding must actually start with
  // a severity marker, have some body beyond that marker, and not be just a
  // separator (`---`, empty lines, etc.).
  function filterJunk(findings) {
    return findings.filter(function (f) {
      if (!f) return false;
      if (!/\*{0,2}\[Severity:/i.test(f)) return false;
      var lines = f.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      if (lines.length === 0) return false;
      var meaningful = lines.filter(function (l) {
        if (/^\*?\*?\[[^\]]+\]\*?\*?$/.test(l)) return false; // bare [X] marker
        if (/^-{3,}$/.test(l)) return false;                  // ---
        if (/^={3,}$/.test(l)) return false;                  // ===
        return true;
      });
      return meaningful.length > 0;
    });
  }

  // Split a chunk of text on severity anchors. Returns { preamble, findings,
  // postamble } where postamble starts at a final "**Overall verdict:**".
  function splitOnSeverity(text) {
    var parts = text.split(SPLIT_RE);
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
    return { preamble: preamble, findings: filterJunk(findings), postamble: postamble };
  }

  // Wrap a legacy (marker/text) finding string in the common object shape so
  // every code path returns the same kind of thing. The renderer still scrapes
  // location and severity out of `.text` for these.
  function legacyFinding(text) { return { structured: false, text: text }; }

  // ---- Stage 0: structured JSON contract ----

  // Pull complete top-level `{…}` objects out of a (possibly truncated) JSON
  // array body. String-aware brace matching so braces inside string values
  // (code snippets) don't throw off the depth count. A trailing incomplete
  // object is simply dropped — that's what makes streaming safe.
  function extractObjectSources(body) {
    var objs = [];
    var depth = 0, start = -1, inStr = false, esc = false;
    for (var i = 0; i < body.length; i++) {
      var ch = body[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; }
      else if (ch === '{') { if (depth === 0) start = i; depth++; }
      else if (ch === '}') { depth--; if (depth === 0 && start !== -1) { objs.push(body.slice(start, i + 1)); start = -1; } }
    }
    return objs;
  }

  function coerceSeverity(s) {
    var v = String(s == null ? '' : s).trim().toLowerCase();
    if (v === 'critical') return 'blocker';
    if (v === 'info' || v === 'note' || v === 'nitpick') return 'nit';
    if (v === 'warning') return 'warn';
    return v;
  }

  // Whether a `suggestion` value should render as a fenced code block rather
  // than prose. Most suggestions are a written sentence ("Guard the null case
  // before dereferencing") and must stay prose — so this defaults to false and
  // only fires on signals that almost never occur in an English sentence.
  // Notably it does NOT treat a bare newline, lone `()`/`<>`/`=`, or the
  // English words if/return/function/const as code — those produced constant
  // false positives that boxed ordinary sentences.
  function looksLikeCode(s) {
    if (!s) return false;
    if (/```/.test(s)) return true;                 // agent already fenced it
    if (/[{}]|=>|===|!==/.test(s)) return true;     // braces, arrows, strict-eq
    // A declaration or assignment line: `const x = …`, `foo.bar = …`.
    if (/^\s*(const|let|var|function|class|import|export)\s/m.test(s)) return true;
    if (/^\s*[\w$][\w$.[\]]*\s*=\s*\S/m.test(s)) return true;
    // A control-flow statement line — caught only when the line also carries
    // code punctuation before any sentence punctuation, so "If x is null,
    // return early." stays prose while "if (!user) return null;" is code.
    if (/^\s*(if|for|while|switch|else|return|throw|await)\b[^.!?\n]*[(){};=]/m.test(s)) return true;
    return false;
  }

  // The text that actually posts to the PR: the prose body, then an optional
  // "Suggested change" block. No severity/location/category headers — those
  // are card metadata, not comment content. Keeping them out is what makes the
  // posted comment read like a person wrote it.
  function composeFindingText(obj) {
    var body = String(obj.body == null ? '' : obj.body).trim();
    var suggestion = String(obj.suggestion == null ? '' : obj.suggestion).trim();
    if (!suggestion) return body;
    var block = looksLikeCode(suggestion)
      ? '```\n' + suggestion.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```$/, '') + '\n```'
      : suggestion;
    return (body ? body + '\n\n' : '') + 'Suggested change:\n\n' + block;
  }

  function normalizeJsonFinding(obj) {
    if (!obj || typeof obj !== 'object') return null;
    var text = composeFindingText(obj);
    var title = String(obj.title == null ? '' : obj.title).trim();
    if (!text.trim() && !title) return null;
    var line = null;
    if (typeof obj.line === 'number' && isFinite(obj.line)) line = obj.line;
    else if (typeof obj.line === 'string' && /^\d+$/.test(obj.line.trim())) line = parseInt(obj.line, 10);
    var side = String(obj.side == null ? '' : obj.side).trim().toUpperCase();
    if (side !== 'LEFT' && side !== 'RIGHT') side = 'RIGHT';
    return {
      structured: true,
      text: text,
      title: title,
      severity: coerceSeverity(obj.severity),
      category: String(obj.category == null ? '' : obj.category).trim(),
      path: obj.path ? String(obj.path).trim() : null,
      line: line,
      side: side,
      code: String(obj.code == null ? '' : obj.code),
      suggestion: String(obj.suggestion == null ? '' : obj.suggestion),
    };
  }

  function normalizeSummary(s) {
    if (!s || typeof s !== 'object') return null;
    var risks = Array.isArray(s.highestRisk) ? s.highestRisk
              : Array.isArray(s.highest_risk) ? s.highest_risk : [];
    var verdict = String(s.verdict == null ? '' : s.verdict).trim();
    var coverage = String((s.testCoverage != null ? s.testCoverage : s.test_coverage) || '').trim();
    if (!verdict && !risks.length && !coverage) return null;
    return { verdict: verdict, highestRisk: risks.map(String), testCoverage: coverage };
  }

  // Locate the <FINDINGS_JSON> block, tolerate an optional ```json fence and
  // truncated/streaming content. Returns { findings:[normalized], summary } or
  // null when there's no recoverable JSON contract.
  function parseJsonContract(text) {
    var open = text.indexOf('<FINDINGS_JSON>');
    if (open === -1) return null;
    var rest = text.slice(open + '<FINDINGS_JSON>'.length);
    var close = rest.indexOf('</FINDINGS_JSON>');
    var inner = close !== -1 ? rest.slice(0, close) : rest;
    // Strip a leading ```json fence and a trailing ``` (closing fence may not
    // have streamed in yet).
    inner = inner.replace(/^\s*```[a-zA-Z0-9_-]*\s*/, '');
    var fenceEnd = inner.lastIndexOf('```');
    if (fenceEnd !== -1) inner = inner.slice(0, fenceEnd);
    inner = inner.trim();
    if (!inner) return { findings: [], summary: null };

    var rawFindings = null;
    var summary = null;
    try {
      var parsed = JSON.parse(inner);
      if (Array.isArray(parsed)) {
        rawFindings = parsed;
      } else if (parsed && typeof parsed === 'object') {
        rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
        summary = parsed.summary || null;
      }
    } catch (_) {
      // Streaming / truncated: recover whatever complete finding objects exist.
      var arrKey = inner.indexOf('"findings"');
      var scanFrom = arrKey !== -1 ? inner.indexOf('[', arrKey) : inner.indexOf('[');
      if (scanFrom !== -1) {
        rawFindings = [];
        var sources = extractObjectSources(inner.slice(scanFrom));
        for (var i = 0; i < sources.length; i++) {
          try { rawFindings.push(JSON.parse(sources[i])); } catch (_e) {}
        }
      }
      // Recover the sibling "summary" object too, so a parse failure in the
      // findings array doesn't also drop the (intact) verdict banner.
      var sumKey = inner.indexOf('"summary"');
      if (sumKey !== -1) {
        var sumBrace = inner.indexOf('{', sumKey);
        if (sumBrace !== -1) {
          var sumSources = extractObjectSources(inner.slice(sumBrace));
          if (sumSources.length) {
            try { summary = JSON.parse(sumSources[0]); } catch (_e2) {}
          }
        }
      }
    }
    if (!rawFindings) return null;
    var findings = rawFindings.map(normalizeJsonFinding).filter(Boolean);
    return { findings: findings, summary: normalizeSummary(summary) };
  }

  function parseReviewFindings(text) {
    var empty = { preamble: '', findings: [], postamble: '', structured: false, summary: null };
    if (!text) return empty;
    text = sanitizeAiTone(text);

    // Stage 0: structured JSON contract (preferred).
    var json = parseJsonContract(text);
    if (json && json.findings.length) {
      return {
        preamble: text.slice(0, text.indexOf('<FINDINGS_JSON>')).trim(),
        findings: json.findings,
        postamble: '',
        structured: true,
        summary: json.summary,
      };
    }

    // Stage 1: delimited <FINDINGS> contract.
    var open = text.indexOf('<FINDINGS>');
    if (open !== -1) {
      var close = text.indexOf('</FINDINGS>', open);
      var inner = close !== -1 ? text.slice(open + '<FINDINGS>'.length, close)
                               : text.slice(open + '<FINDINGS>'.length);
      var outerPre = text.slice(0, open).trim();
      var outerPost = close !== -1 ? text.slice(close + '</FINDINGS>'.length).trim() : '';
      var inside = splitOnSeverity(inner);
      var preamble = [outerPre, inside.preamble].filter(Boolean).join('\n\n');
      var postamble = [inside.postamble, outerPost].filter(Boolean).join('\n\n');
      // A marker section with zero parsed findings still falls back cleanly:
      // everything lands in preamble/postamble and renders as text.
      return { preamble: preamble, findings: inside.findings.map(legacyFinding), postamble: postamble, structured: false, summary: null };
    }

    // Stage 2 + 3: legacy anchors over the whole text / single-card fallback.
    var legacy = splitOnSeverity(text);
    return { preamble: legacy.preamble, findings: legacy.findings.map(legacyFinding), postamble: legacy.postamble, structured: false, summary: null };
  }

  function severityOf(findingText) {
    // Accept `[Severity: …]` with 0–2 stars on either side, matching however
    // the AI ended up formatting it.
    var m = (findingText || '').match(/\*{0,2}\[Severity:\s*([^\]|]+)(?:\|[^\]]*)?\]\*{0,2}/);
    return m ? m[1].trim().toLowerCase() : '';
  }

  return {
    sanitizeAiTone: sanitizeAiTone,
    parseReviewFindings: parseReviewFindings,
    severityOf: severityOf,
  };
})();
