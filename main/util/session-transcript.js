// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Works out what a session has newly said, so a thread can mirror it.
//
// A pty carries a repainting screen, not a stream of messages: the same lines
// arrive over and over as the TUI redraws, and there are no turn boundaries.

const { Terminal } = require('@xterm/headless');
const { cleanExcerpt } = require('./terminal-excerpt');

// Remembering every line forever would grow without bound; a screen's worth is
// enough to absorb a repaint without suppressing a genuine repetition later.
const RECENT_LINES = 200;
// Discord caps a message at 2000 characters and Slack a section at 3000.
const MAX_POST_CHARS = 1500;
// Below this a "message" is a stray fragment of a redraw, not something said.
const MIN_POST_CHARS = 2;
// Lines an inline TUI scrolls off between two turns still need to be read.
const SCROLLBACK_LINES = 500;

// taskId -> { recent, seen, onScreen: Set<string>, term }
const state = new Map();

function entryFor(taskId) {
  const key = String(taskId);
  let e = state.get(key);
  if (!e) { e = { recent: [], seen: new Set(), onScreen: new Set(), term: null }; state.set(key, e); }
  return e;
}

// Stripping a TUI's cursor moves leaves redraw fragments; emulating the screen leaves what the user sees.
// A screen started after the agent already drew (the bell turned on mid-session)
// only gets the cells that change from then on; its first read is a baseline.
function feedScreen(taskId, data, cols, rows, { midSession = false } = {}) {
  const entry = entryFor(taskId);
  const c = cols > 0 ? cols : 120;
  const r = rows > 0 ? rows : 30;
  if (!entry.term) {
    entry.term = new Terminal({ cols: c, rows: r, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
    entry.baseline = midSession;
  } else if (entry.term.cols !== c || entry.term.rows !== r) {
    entry.term.resize(c, r);
  }
  entry.term.write(data);
}

// Rejoins soft-wrapped rows: a row short of the edge broke at a space; a full one keeps its own spacing.
function renderScreen(term) {
  const buf = term.buffer.active;
  const lines = [];
  let prevFull = true;
  for (let i = 0; i < buf.length; i++) {
    const row = buf.getLine(i);
    if (!row) continue;
    const raw = row.translateToString(false);
    const text = raw.replace(/\s+$/, '');
    if (row.isWrapped && lines.length) lines[lines.length - 1] += prevFull ? text : ' ' + text.trimStart();
    else lines.push(text);
    prevFull = text.length === raw.length;
  }
  return lines.join('\n');
}

// xterm doesn't reflow the row holding the cursor, so the same line can come
// back with its spacing changed by a resize.
function keyOf(line) {
  return line.replace(/\s+/g, '');
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

// New lines since the last call; `rawScreen` is used only before feedScreen starts a screen.
function takeNewOutput(taskId, rawScreen) {
  const entry = entryFor(taskId);
  const cleaned = entry.term
    ? cleanExcerpt(renderScreen(entry.term), { rendered: true })
    : cleanExcerpt(rawScreen);
  if (!cleaned) return '';

  // Whatever was on the previous screen was already accounted for, however
  // long ago it was sent: re-reading the whole buffer must not repost it.
  const previous = entry.onScreen;
  entry.onScreen = new Set();
  const fresh = [];
  for (const line of cleaned.split('\n')) {
    const key = keyOf(line);
    if (!key) {
      // Keep paragraph breaks, but only between lines we're actually sending.
      if (fresh.length && fresh[fresh.length - 1] !== '') fresh.push('');
      continue;
    }
    entry.onScreen.add(key);
    if (entry.baseline || previous.has(key) || entry.seen.has(key)) continue;
    remember(entry, key);
    fresh.push(line);
  }

  if (entry.baseline && entry.term) {
    entry.baseline = false;
    return '';
  }
  const out = fresh.join('\n').trim();
  if (out.length < MIN_POST_CHARS) return '';
  if (out.length <= MAX_POST_CHARS) return out;
  // Keep the end: that's where the question or conclusion is.
  return '…(earlier output trimmed)\n' + out.slice(-MAX_POST_CHARS);
}

// What the session's screen shows now, for a notification quoting its tail;
// '' until feedScreen has started one.
function screenText(taskId) {
  const entry = state.get(String(taskId));
  const text = entry && entry.term ? renderScreen(entry.term) : '';
  return text.trim() ? text : '';
}

// The bell went off and the screen stops being fed; what was sent stays known.
function dropScreen(taskId) {
  const entry = state.get(String(taskId));
  if (!entry || !entry.term) return;
  entry.term.dispose();
  entry.term = null;
}

function forgetTask(taskId) {
  const key = String(taskId);
  const entry = state.get(key);
  if (entry && entry.term) entry.term.dispose();
  state.delete(key);
}

function _reset() {
  for (const key of [...state.keys()]) forgetTask(key);
}

// Writes are parsed asynchronously; tests wait for them before reading.
function _flush(taskId) {
  const entry = state.get(String(taskId));
  return new Promise((resolve) => (entry && entry.term ? entry.term.write('', resolve) : resolve()));
}

module.exports = { takeNewOutput, feedScreen, screenText, dropScreen, forgetTask, _reset, _flush, MAX_POST_CHARS };
