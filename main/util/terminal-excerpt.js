// Turns a raw TUI capture into something worth reading in a chat message: the
// buffer holds spinner frames, token counters, the input box and echoed
// keystrokes, which bury whatever the agent actually said.

// ⏺ is deliberately absent: it marks the assistant's own message, which is the
// content we're trying to keep.
const CHROME_PATTERNS = [
  /^\s*[✶✳✻✽✢⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, // spinner frames
  /·\s*[↓↑]\s*[\d.]+\s*tokens?/i, // "(8s · ↓425 tokens)"
  /^\s*\?\s*for shortcuts/i,
  /^\s*❯\s*$/, // the empty input box
  /^\s*running stop hook/i,
  /^\s*\d+\s*$/, // stray counter frames like "✳50" once the glyph is gone
];

function isChrome(line) {
  return CHROME_PATTERNS.some((p) => p.test(line));
}

// Typing arrives one character per data chunk, so a repainting TUI can leave a
// column of single letters where a word was typed.
function joinCharacterRuns(lines) {
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    // Three or more is a typed word; one or two are plausibly real content.
    out.push(run.length >= 3 ? run.join('') : run.join('\n'));
    run = [];
  };
  for (const line of lines) {
    if (line.trim().length === 1) run.push(line.trim());
    else { flush(); out.push(line); }
  }
  flush();
  return out;
}

function cleanExcerpt(text) {
  const lines = String(text || '')
    // A bare \r rewrites the current line; keep only what ended up there.
    .replace(/\r(?!\n)/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => !isChrome(l));

  const joined = joinCharacterRuns(lines);

  const out = [];
  for (const line of joined) {
    // A repaint emits the same line many times over.
    if (out.length && out[out.length - 1] === line) continue;
    if (!line.trim() && (!out.length || !out[out.length - 1].trim())) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

// An idle agent keeps painting spinner frames and its input box, which must not
// read as the agent having done something.
function isChromeOnly(text) {
  const lines = String(text || '').split(/[\r\n]+/).filter((l) => l.trim());
  if (!lines.length) return true;
  return lines.every(isChrome);
}

module.exports = { cleanExcerpt, isChromeOnly };
