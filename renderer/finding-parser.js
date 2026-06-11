// Shared review-finding parser for both PR review surfaces (pr-review.js,
// pr-panel.js). Previously each kept a hand-synced copy ("lockstep") and they
// still drifted; this is now the single source of truth, loaded by
// index.html AND pr-review.html (pop-out) before either consumer.
//
// Parse strategy, most to least structured (memory: the parser has a history
// of unreliability — the full-text fallback must always survive):
//   1. <FINDINGS>…</FINDINGS> contract: the review template instructs the
//      agent to wrap the findings list in literal markers. Inside the
//      markers, findings split on the `[Severity: …]` anchor; everything
//      before the opening marker is preamble, after the closing marker is
//      postamble. Streaming-safe: a missing closing marker treats the rest
//      of the text as findings-in-progress.
//   2. Legacy split: `[Severity:` anchors over the whole text (models ignore
//      contracts often enough that this stays load-bearing).
//   3. Single-card fallback: no anchors at all → the entire review renders
//      as one preamble card.

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

  function parseReviewFindings(text) {
    if (!text) return { preamble: '', findings: [], postamble: '' };
    text = sanitizeAiTone(text);

    // Stage 1: delimited contract.
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
      return { preamble: preamble, findings: inside.findings, postamble: postamble };
    }

    // Stage 2 + 3: legacy anchors over the whole text / single-card fallback.
    return splitOnSeverity(text);
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
