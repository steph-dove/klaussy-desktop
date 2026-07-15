// Deterministic humanizer applied to every outbound PR comment body just
// before it's posted to GitHub. Strips the most reliable agent tells and
// trims filler so comments read like a person wrote them. No LLM (the project
// bans `claude -p` and an interactive PTY can't gate a silent post), so this
// is intentionally conservative: high-confidence, meaning-preserving edits
// only. Code is never touched.
//
// Returns the humanized string; passes non-strings through unchanged.

const { execFileSync } = require('child_process');

// Sentence-initial filler openers. Stripped only at the start of the text or a
// line (so we don't cut mid-sentence), and the following word is re-capitalized.
const OPENERS = '(?:It\'?s worth noting that|It\'?s important to note that'
  + '|It\'?s worth mentioning that|It\'?s important to remember that'
  + '|I noticed that|I wanted to point out that'
  + '|I want to (?:point out|note|mention|flag) that|Please note that'
  + '|Just to (?:note|mention)|Worth noting,?|Note that'
  + '|At the end of the day|Generally speaking|Now,? more than ever'
  + '|Furthermore|Moreover|Additionally|Consequently|Nevertheless|Indeed)';

// Fixed praise phrases that lead a comment ("Great catch", "Nice find") — a
// reliable AI tell. Free-form ranking praise stays prompt-side to avoid cutting
// legitimate prose ("the most important issue here").
const PRAISE = '(?:(?:Great|Nice|Good|Excellent|Fantastic|Awesome|Wonderful|Solid'
  + '|Strong|Fair)[ \\t]+(?:catch|find|point|call|callout|call-out'
  + '|observation|spot|work)|Well spotted|Good eye|Nice one|Spot on)';

const PRAISE_LINE = new RegExp('(^|\\n)[ \\t]*' + PRAISE + '[ \\t]*[.!]*[ \\t]*(?=\\n|$)', 'gi');
const PRAISE_LEAD = new RegExp('(^|\\n)[ \\t]*' + PRAISE + '[ \\t]*[,.:!]+[ \\t]*(\\w)', 'gi');

// Thanking bots for review or comments. Stripped at the start of the text or a line.
const THANK_BOT = '(?:Thanks|Thank you)(?:\\s+(?:for the review|for the feedback|for pointing this out|for the comment))?\\s*,?\\s*@?[-\\w]*(?:bots?|actions?|cov|guard|lgtm|sonar|copilot|renovate)\\b';

// Sentence-initial apologies. Stripped at the start of the text or a line.
const APOLOGIES = '(?:My apologies|Sorry (?:about that|for the oversight|for the confusion)|Apologies for the (?:oversight|confusion|mistake))';

// Trailing chatbot scaffolding lines that add nothing to a review comment.
const SCAFFOLD = '(?:Let me know if[^\\n]*|Hope (?:this|that) helps[^\\n]*'
  + '|I hope (?:this|that) helps[^\\n]*|Feel free to[^\\n]*'
  + '|Happy to help[^\\n]*|Let me know your thoughts[^\\n]*)';

function scrubProse(s) {
  // Em / en dashes — the single strongest tell.
  s = s.replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, ' - ');
  // Drop overused AI emojis.
  s = s.replace(/[🚀✨🔑💡🎯😊🙏]/gu, '');
  // Drop trailing scaffolding sentences/lines.
  s = s.replace(new RegExp('(?:^|\\n)\\s*' + SCAFFOLD + '\\s*$', 'gi'), '');
  // Strip filler openers at the start of the text or a line; recapitalize.
  s = s.replace(new RegExp('(^|\\n)[ \\t]*' + OPENERS + '[ \\t,]+(\\w)', 'gi'),
    function (_m, pre, ch) { return pre + ch.toUpperCase(); });
  // Drop standalone praise lines, then strip praise that leads into content.
  s = s.replace(PRAISE_LINE, '$1');
  s = s.replace(PRAISE_LEAD, function (_m, pre, ch) { return pre + ch.toUpperCase(); });
  // Strip thanking bots followed by text; recapitalize.
  s = s.replace(new RegExp('(^|\\n)[ \\t]*' + THANK_BOT + '[ \\t,!.?]*(\\w)', 'gi'),
    function (_m, pre, ch) { return pre + ch.toUpperCase(); });
  // Strip thanking bots at the end of a line or text.
  s = s.replace(new RegExp('(^|\\n)[ \\t]*' + THANK_BOT + '[ \\t,!.?]*$', 'gi'), '');
  // Strip apologies followed by text; recapitalize.
  s = s.replace(new RegExp('(^|\\n)[ \\t]*' + APOLOGIES + '[ \\t,!.?]*(\\w)', 'gi'),
    function (_m, pre, ch) { return pre + ch.toUpperCase(); });
  // Strip apologies at the end of a line or text.
  s = s.replace(new RegExp('(^|\\n)[ \\t]*' + APOLOGIES + '[ \\t,!.?]*$', 'gi'), '');
  // Safe lexicon replacements: leverage/utilize -> use.
  s = s.replace(/\butilize\b/gi, 'use')
       .replace(/\butilizes\b/gi, 'uses')
       .replace(/\butilizing\b/gi, 'using')
       .replace(/\bleverage\b/gi, 'use')
       .replace(/\bleverages\b/gi, 'uses')
       .replace(/\bleveraging\b/gi, 'using');
  // A few safe, unambiguous tightenings.
  s = s.replace(/\bin order to\b/gi, 'to')
    .replace(/\bcould potentially\b/gi, 'could')
    .replace(/\bmay potentially\b/gi, 'may');
  // Tidy whitespace introduced by the removals.
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+(\n)/g, '$1');
  return s;
}

// Built-in JS port of the scrubber — the fallback when the canonical CLI
// isn't reachable.
function humanizeCommentJs(input) {
  if (typeof input !== 'string' || !input) return input;
  // Preserve fenced and inline code: only the even segments are prose.
  const fenceParts = input.split(/(```[\s\S]*?```)/g);
  for (let i = 0; i < fenceParts.length; i += 2) {
    const inline = fenceParts[i].split(/(`[^`\n]*`)/g);
    for (let j = 0; j < inline.length; j += 2) inline[j] = scrubProse(inline[j]);
    fenceParts[i] = inline.join('');
  }
  return fenceParts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

// Humanize an outbound comment body just before posting. Prefers the canonical
// `klaussy humanize` CLI — it's the source of truth, kept in lockstep with
// klaussy-agents, so its scrubbing rules stay current as users upgrade. Falls
// back to the built-in JS port when klaussy isn't installed / on PATH / errors.
// Runs at the app's post chokepoint, so it applies regardless of which agent
// wrote the comment.
function humanizeComment(input) {
  if (typeof input !== 'string' || !input) return input;
  try {
    const out = execFileSync('klaussy', ['humanize'], {
      input,
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (typeof out === 'string' && out.length) return out.replace(/\n{3,}/g, '\n\n').trim();
  } catch { /* CLI missing / offline / error — use the built-in port */ }
  return humanizeCommentJs(input);
}

module.exports = { humanizeComment, humanizeCommentJs };
