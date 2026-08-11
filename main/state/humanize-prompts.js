// Prompts for the multi-pass humanize flow; the deterministic scrubber
// (humanize-comment.js) is the last pass and runs in-process.
//
// Separate passes because with every rule in play at once only the safe
// mechanical ones survive, and voice and length lose. Rules come from the repo's
// scaffolded humanize skill when there is one; the fallback below mirrors
// klaussy 0.25.0's block, so keep it in sync with `klaussy humanize --rules`.

const fs = require('fs');
const path = require('path');

// Section headers in klaussy's HUMANIZE_BLOCK. Each pass takes only its own
// sections; slicing by header keeps this working as the block's wording changes.
const SECTIONS = {
  voice: '**Voice: say it out loud.**',
  shape: '**Shape: the smallest thing that carries the point.**',
  answer: '**Answer what was asked, then stop.**',
  mechanical: "**Don't (mechanical tells).**",
  civil: '**Stay civil while you cut.**',
};

const FALLBACK_RULES = `**Voice: say it out loud.** The target is a competent engineer typing this once, in a hurry, who isn't going to read it back.

- Write what you'd say standing at their desk.
- Use contractions.
- Verbs, not noun phrases: "this validates the token", not "this performs validation of the token".
- Name the thing doing the work: "the retry loop eats the 429", not "error handling may result in suppression of the status".
- Short common words: before not prior to, if not in the event that, can not is able to, use not utilize.
- Fragments are fine. One idea per sentence.
- Type it once and don't polish it. The last tell is evenness: every sentence complete, every paragraph the same shape. Let it be uneven.
- Have a stance. First person and an opinion read as a person; a neutral summary reads as generated.
- No em-dashes or en-dashes in prose. Use a comma or rewrite.

**Shape: the smallest thing that carries the point.**

- A thread reply is one sentence. A single review comment is one to three.
- Lead with the change, not the discovery. Someone who reads one sentence should already be able to act.
- Prose by default. No headings, tables, or bold field labels.
- Three sentences to a paragraph.
- No bookends. Don't restate the request, don't summarize what you just said.
- Keep the concrete parts: a suggested diff, a command, a file:line, a version number.

**Answer what was asked, then stop.**

- No closing principle. Don't end by restating your decision as a general rule.
- No mechanism they didn't ask for. If a paragraph doesn't change what the reader does next, cut it.
- Grant a point in four words, or not at all. Never manufacture the agreement.

**Stay civil while you cut.**

- Critique the work, never the person.
- Don't mirror the thread's tone. Answer as if it had been phrased civilly.`;

// Pull one section out of a rules blob: from its header to the next header.
function section(rules, key) {
  const header = SECTIONS[key];
  const start = rules.indexOf(header);
  if (start === -1) return '';
  const rest = Object.values(SECTIONS)
    .map((h) => rules.indexOf(h, start + header.length))
    .filter((i) => i !== -1);
  const end = rest.length ? Math.min(...rest) : rules.length;
  return rules.slice(start, end).trim();
}

// The repo's own humanize skill, if klaussy scaffolded one. Same lookup shape as
// findRepoReviewSkill: match the `-humanize` suffix rather than rebuilding the
// sanitized repo name.
function findRepoHumanizeSkill(worktreePath) {
  if (!worktreePath) return null;
  try {
    const skillsDir = path.join(worktreePath, '.claude', 'skills');
    for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.endsWith('-humanize')) continue;
      const p = path.join(skillsDir, e.name, 'SKILL.md');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* no .claude/skills — use the built-in rules */ }
  return null;
}

function loadRules(worktreePath) {
  const skillPath = findRepoHumanizeSkill(worktreePath);
  if (skillPath) {
    try {
      const text = fs.readFileSync(skillPath, 'utf-8');
      // Only trust it if the sections we slice are actually present.
      if (text.includes(SECTIONS.voice) && text.includes(SECTIONS.shape)) return text;
    } catch { /* unreadable — fall through */ }
  }
  return FALLBACK_RULES;
}

// Pass 1: content only. Deleting, never restyling — a pass that rewrites here
// spends its attention on wording and stops cutting.
function cutPrompt(rules, { question } = {}) {
  const asked = question
    ? `The text answers this:\n${question}\n\nCut anything that doesn't answer it.\n\n`
    : 'There is no explicit question. Cut anything that does not carry a decision, a fact the reader needs, or a concrete next step.\n\n';
  return `Cut this text down to what earns its place. Delete whole sentences and paragraphs. `
    + `Keep every sentence you keep WORD FOR WORD: this pass does not improve wording, and rewriting here means you stop cutting. `
    + `Never touch code, identifiers, or anything inside backticks or fences. Output only the kept text.\n\n`
    + asked
    + section(rules, 'answer') + '\n\n' + section(rules, 'shape');
}

// Pass 2: register only. Facts are frozen so the cut pass's decisions stand.
function voicePrompt(rules) {
  return `Rewrite this in the voice below. Every fact that goes in comes out: add no claims, drop none, `
    + `soften or strengthen none. If a sentence looks worth deleting, leave it, that decision was already made. `
    + `Never reword code, identifiers, or anything inside backticks or fences. Output only the rewritten text.\n\n`
    + section(rules, 'voice') + '\n\n' + section(rules, 'civil');
}

// Pass 3: the guard. The pass that changed the meaning can't be the one grading
// it, so this compares against the original the user started from.
function checkPrompt(original) {
  return `Compare the rewrite against the original below, claim by claim, and fix any drift. Look for:\n\n`
    + `- ADDED: anything asserted the original didn't say, a hedge that became a certainty, or agreement the author never gave.\n`
    + `- DROPPED: a load-bearing noun, number, identifier, file path, or version. "We invalidated on every write" losing "the cache" is a failure even though it reads fine.\n`
    + `- REVERSED: a concession that became a refusal, "may race" that became "races", a point that changed sides.\n\n`
    + `Restore the original's meaning in the rewrite's voice. Do not re-expand it: fixing drift means putting back meaning, not words. `
    + `Output only the corrected text, nothing else.\n\n`
    + `--- ORIGINAL ---\n${original}\n--- END ORIGINAL ---`;
}

module.exports = {
  FALLBACK_RULES,
  SECTIONS,
  section,
  findRepoHumanizeSkill,
  loadRules,
  cutPrompt,
  voicePrompt,
  checkPrompt,
};
