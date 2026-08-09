// Deterministic humanizer applied to every outbound PR comment body just
// before it's posted to GitHub. Strips the most reliable agent tells and
// trims filler so comments read like a person wrote them. No LLM (the project
// bans `claude -p` and an interactive PTY can't gate a silent post), so this
// is intentionally conservative: high-confidence, meaning-preserving edits
// only. Code is never touched.
//
// This is a port of klaussy-agents' `src/klaussy/humanize.py`, which owns the
// rules. Keep the two in lockstep: same patterns, same order, same tests.
//
// Returns the humanized string; passes non-strings through unchanged.

const { execFileSync } = require('child_process');

// Sentence-initial filler openers, stripped at the start of the text or a line
// (so we don't cut mid-sentence), and the following word is re-capitalized.
// Two families: chatbot "note that" scaffolding, and editorializing verdict
// openers ("Personally", "Honestly", ...) that prime a dismissive read.
const OPENERS = '(?:It(?:\'?s| is) worth noting that|It(?:\'?s| is) important to note that'
  + '|It(?:\'?s| is) worth mentioning that|It(?:\'?s| is) important to remember that'
  + '|I noticed that|I wanted to point out that'
  + '|I want to (?:point out|note|mention|flag) that|Please note that'
  + '|Just to (?:note|mention)|Worth noting,?|Note that'
  + '|Actually|Personally|Honestly|Frankly|Quite frankly|To be honest'
  + '|In my (?:honest )?opinion|IMO|IMHO|If you ask me'
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

// Sentence-initial "Actually," is handled by the opener list; these cover the
// mid-sentence and trailing uses. The adjective is only dropped after a
// determiner that doesn't inflect, so "an actual bug" is left to the prompt.
const ACTUALLY_TRAIL = /(?<=\w)[ \t]*,?[ \t]*\bactually\b(?=[ \t]*(?:[.,;:!?)\]]|$|\n))/gi;
const ACTUALLY_MID = /(?<=\w)[ \t]+actually\b/gi;
// "... works. Actually it does." — mid-line sentence starts, which the opener
// list (anchored to the start of a line) never sees.
const ACTUALLY_SENTENCE = /([.!?][ \t]+)actually\b[ \t,]*(\w)/gi;
// The word after "actual" must be its noun: a verb, conjunction, or preposition
// there means "the actual" was the noun ("compare the actual to the expected").
const ACTUAL_ADJ = /\b(the|this|that|these|those|its|their|our|your|my|no|each|any|every|some|all)[ \t]+actual[ \t]+(?!(?:is|was|are|were|be|been|and|or|to|vs\.?|versus|of|in|on|at|for|with|from|than|but|so|because)\b)(?=\w)/gi;

// Stiff phrasings with one short equivalent that reads the same in every
// sentence. Anything whose replacement depends on the surrounding clause ("a
// number of", "in terms of") stays prompt-side, where a model can judge it.
const PHRASINGS = [
  [/\butilize\b/gi, 'use'],
  [/\butilizes\b/gi, 'uses'],
  [/\butilizing\b/gi, 'using'],
  [/\bleverage\b/gi, 'use'],
  [/\bleverages\b/gi, 'uses'],
  [/\bleveraging\b/gi, 'using'],
  [/\bin order to\b/gi, 'to'],
  [/\bcould potentially\b/gi, 'could'],
  [/\bmay potentially\b/gi, 'may'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bin the event that\b/gi, 'if'],
  [/\bprior to\b/gi, 'before'],
  [/\bsubsequent to\b/gi, 'after'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bwith regards? to\b/gi, 'about'],
  [/\b(?:is|are) able to\b/gi, 'can'],
  [/\b(?:was|were) able to\b/gi, 'could'],
  [/\bhas the ability to\b/gi, 'can'],
  [/\bhave the ability to\b/gi, 'can'],
];

// Capitalize `replacement` iff `matched` was, so line-initial hits keep their capital.
function matchCase(matched, replacement) {
  if (matched[0] === matched[0].toUpperCase() && matched[0] !== matched[0].toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function scrubProse(s) {
  // Em / en dashes — the single strongest tell. A dash between two numbers is a
  // range ("35–50 min"), so it collapses to a plain hyphen; spacing it out would
  // read as a subtraction or a dropped clause.
  s = s.replace(/(?<=\d)\s*[–—]\s*(?=\d)/g, '-');
  s = s.replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, ' - ');
  // Drop overused AI emojis.
  s = s.replace(/[🚀✨🔑💡🎯😊🙏]/gu, '');
  // Drop trailing scaffolding sentences/lines.
  s = s.replace(new RegExp('(?:^|\\n)\\s*' + SCAFFOLD + '\\s*$', 'gi'), '');
  // Drop standalone praise lines, then strip praise that leads into content.
  s = s.replace(PRAISE_LINE, '$1');
  s = s.replace(PRAISE_LEAD, function (_m, pre, ch) { return pre + ch.toUpperCase(); });
  // Drop standalone bot-thanks, then strip bot-thanks that leads into content.
  s = s.replace(new RegExp('(^|\\n)[ \\t]*' + THANK_BOT + '[ \\t,!.?]*(?=\\n|$)', 'gi'), '$1');
  s = s.replace(new RegExp('(^|\\n)[ \\t]*' + THANK_BOT + '[ \\t,!.?]*(\\w)', 'gi'),
    function (_m, pre, ch) { return pre + ch.toUpperCase(); });
  // Drop standalone apologies, then strip apologies that lead into content.
  s = s.replace(new RegExp('(^|\\n)[ \\t]*' + APOLOGIES + '[ \\t,!.?]*(?=\\n|$)', 'gi'), '$1');
  s = s.replace(new RegExp('(^|\\n)[ \\t]*' + APOLOGIES + '[ \\t,!.?]*(\\w)', 'gi'),
    function (_m, pre, ch) { return pre + ch.toUpperCase(); });
  // Strip filler openers at the start of the text or a line; recapitalize.
  s = s.replace(new RegExp('(^|\\n)[ \\t]*' + OPENERS + '[ \\t,]+(\\w)', 'gi'),
    function (_m, pre, ch) { return pre + ch.toUpperCase(); });
  // Drop "actually" (trailing first, so its comma goes with it) and "actual".
  s = s.replace(ACTUALLY_SENTENCE, function (_m, pre, ch) { return pre + ch.toUpperCase(); });
  s = s.replace(ACTUALLY_TRAIL, '');
  s = s.replace(ACTUALLY_MID, '');
  s = s.replace(ACTUAL_ADJ, function (_m, det) { return det + ' '; });
  for (const [pattern, replacement] of PHRASINGS) {
    s = s.replace(pattern, function (m) { return matchCase(m, replacement); });
  }
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
