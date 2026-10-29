// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Condenses a mirrored agent turn to what someone reading chat on a phone acts
// on: what happened, and what the agent needs from them.

// Below this a turn already reads at a glance, and a model round trip only delays it.
const SHORT_CHARS = 400;
const SHORT_LINES = 6;
const MAX_INPUT_CHARS = 12000;
const MAX_SUMMARY_CHARS = 900;
const FALLBACK_CHARS = 600;

function isShort(text) {
  const t = String(text || '').trim();
  return t.length <= SHORT_CHARS && t.split('\n').length <= SHORT_LINES;
}

// The end of a turn is where an agent asks its question, so a long one keeps its tail.
function clipInput(text) {
  const t = String(text || '').trim();
  if (t.length <= MAX_INPUT_CHARS) return t;
  const head = t.slice(0, MAX_INPUT_CHARS / 4);
  const tail = t.slice(-(MAX_INPUT_CHARS * 3) / 4);
  return `${head}\n[…]\n${tail}`;
}

function summaryPrompt(text, agentName) {
  return `Below is what the coding agent ${agentName || 'Agent'} just printed in a terminal. Rewrite it as a short chat message for the developer who owns the session. They will read it on their phone and won't read anything long.

Rules:
- If the agent is asking a question, waiting for a decision or approval, or is blocked, start with "Needs you:" and say exactly what it needs, keeping any options it offered as a numbered list with their original numbers.
- Otherwise start with one or two sentences on what it did or found.
- Then, only if there are any, up to 4 short bullets of action items for the developer.
- At most 80 words. Plain Markdown. No headings, no preamble, no sign-off.
- Use only what is in the output. Don't invent files, results or next steps.

=== AGENT OUTPUT ===
${clipInput(text)}`;
}

// Models wrap answers in fences or announce them; neither belongs in the post.
function cleanSummary(raw) {
  let s = String(raw || '').trim();
  const fenced = s.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fenced) s = fenced[1].trim();
  s = s.replace(/^(?:here(?:'s| is)[^\n]*:\s*\n+)/i, '').trim();
  if (s.length > MAX_SUMMARY_CHARS) s = `${s.slice(0, MAX_SUMMARY_CHARS).trimEnd()}…`;
  return s;
}

// With no summarizer to hand, the last paragraphs are where the question is.
function fallbackExcerpt(text) {
  const t = String(text || '').trim();
  if (t.length <= FALLBACK_CHARS) return t;
  const tail = t.slice(-FALLBACK_CHARS);
  const cut = tail.indexOf('\n');
  const start = cut >= 0 && cut < FALLBACK_CHARS / 2 ? tail.slice(cut + 1) : tail;
  return `…${start.trimStart()}\n\n_Full output in Klaussy._`;
}

// Never rejects: a failed or empty summary falls back to the turn's tail.
async function condenseTurn(text, { summarize, agentName, mode } = {}) {
  const t = String(text || '').trim();
  if (isShort(t)) return t;
  if (typeof summarize !== 'function') return fallbackExcerpt(t);
  let out = '';
  try { out = cleanSummary(await summarize(summaryPrompt(t, agentName), mode)); } catch { out = ''; }
  return out || fallbackExcerpt(t);
}

module.exports = { condenseTurn, isShort, summaryPrompt, cleanSummary, fallbackExcerpt, clipInput };
