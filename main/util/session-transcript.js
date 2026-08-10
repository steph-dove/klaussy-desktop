// Works out what a session has newly said, so a thread can mirror it.
//
// A pty carries a repainting screen, not a stream of messages: the same lines
// arrive over and over as the TUI redraws, and there are no turn boundaries.

const { cleanExcerpt } = require('./terminal-excerpt');

// Remembering every line forever would grow without bound; a screen's worth is
// enough to absorb a repaint without suppressing a genuine repetition later.
const RECENT_LINES = 200;
// Discord caps a message at 2000 characters and Slack a section at 3000.
const MAX_POST_CHARS = 1500;
// Below this a "message" is a stray fragment of a redraw, not something said.
const MIN_POST_CHARS = 2;

const state = new Map(); // taskId -> { recent: string[], seen: Set<string> }

function entryFor(taskId) {
  const key = String(taskId);
  let e = state.get(key);
  if (!e) { e = { recent: [], seen: new Set() }; state.set(key, e); }
  return e;
}

function remember(entry, line) {
  entry.recent.push(line);
  entry.seen.add(line);
  while (entry.recent.length > RECENT_LINES) {
    const dropped = entry.recent.shift();
    // Only forget a line once no copy of it remains in the window.
    if (!entry.recent.includes(dropped)) entry.seen.delete(dropped);
  }
}

// The lines this session has produced since the last call. Empty string when
// the screen only repainted what was already sent.
function takeNewOutput(taskId, rawScreen) {
  const entry = entryFor(taskId);
  const cleaned = cleanExcerpt(rawScreen);
  if (!cleaned) return '';

  const fresh = [];
  for (const line of cleaned.split('\n')) {
    const key = line.trim();
    if (!key) {
      // Keep paragraph breaks, but only between lines we're actually sending.
      if (fresh.length && fresh[fresh.length - 1] !== '') fresh.push('');
      continue;
    }
    if (entry.seen.has(key)) continue;
    remember(entry, key);
    fresh.push(line);
  }

  const out = fresh.join('\n').trim();
  if (out.length < MIN_POST_CHARS) return '';
  if (out.length <= MAX_POST_CHARS) return out;
  // Keep the end: that's where the question or conclusion is.
  return '…(earlier output trimmed)\n' + out.slice(-MAX_POST_CHARS);
}

function forgetTask(taskId) {
  state.delete(String(taskId));
}

function _reset() { state.clear(); }

module.exports = { takeNewOutput, forgetTask, _reset, MAX_POST_CHARS };
