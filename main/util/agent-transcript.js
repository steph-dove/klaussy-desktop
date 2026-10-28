// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Reads what an agent actually said from its own session store, rather than
// reconstructing it from a repainting pty where every agent draws differently.
// Each reader takes a cursor and returns only what is new, so a caller can poll;
// providers with no readable store return null and the caller falls back.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { claudeProjectDir } = require('./claude-paths');
const { stringsAt, scan } = require('./protobuf-scan');
const { listSessions } = require('./copilot-sessions');
const { samePath } = require('./platform');

// Enough for a chat message; the caller trims further for platform limits.
const MAX_TEXT = 4000;

// HOME is not set on Windows, and `path.join('', …)` resolves against the cwd
// rather than failing, so these stores would be searched for in the worktree.
function home() {
  return process.env.HOME || os.homedir();
}

function readAppendedLines(file, cursor, { keepBlank = false } = {}) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  // A rewritten (shorter) file means a different session — start over.
  const from = typeof cursor === 'number' && cursor <= stat.size ? cursor : 0;
  if (stat.size === from) return { lines: [], cursor: from };
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(stat.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  // A trailing partial line is left for the next read.
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return { lines: [], cursor: from };
  return {
    lines: keepBlank ? text.slice(0, lastNl).split('\n') : text.slice(0, lastNl).split('\n').filter(Boolean),
    cursor: from + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8'),
  };
}

function parseLines(lines) {
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* partial or non-JSON */ }
  }
  return out;
}

// ---- Claude Code: ~/.claude/projects/<encoded-cwd>/<session>.jsonl ----

function claudeTranscriptPath(worktreePath, sessionId) {
  if (!worktreePath || !sessionId) return '';
  return path.join(claudeProjectDir(worktreePath), `${sessionId}.jsonl`);
}

// Adopting a transcript already under way: take its end without reading, so a
// session that started before this one does not post its history.
function endOf(file) {
  try { return { text: '', cursor: fs.statSync(file).size }; } catch { return null; }
}

function readClaude({ worktreePath, sessionId, cursor, transcriptFile, fromEnd, sinceMs }) {
  // An explicit path wins: Claude Code's own hook payloads carry one, and it
  // saves re-deriving the encoded project directory.
  const file = transcriptFile || claudeTranscriptPath(worktreePath, sessionId);
  if (!file || !fs.existsSync(file)) return null;
  if (fromEnd) return endOf(file);
  const read = readAppendedLines(file, cursor);
  if (!read) return null;

  const parts = [];
  for (const rec of parseLines(read.lines)) {
    if (rec.type !== 'assistant') continue;
    // Resuming appends to the transcript the session already had. Every record
    // is stamped, so what predates this run is dropped by age — skipping the
    // file wholesale would swallow the first thing it goes on to say.
    if (sinceMs && rec.timestamp && Date.parse(rec.timestamp) < sinceMs) continue;
    const content = (rec.message && rec.message.content) || [];
    for (const block of content) {
      // thinking is skipped: it is the agent's scratchpad, not something it said.
      if (block.type === 'text' && block.text && block.text.trim()) {
        parts.push(block.text.trim());
      }
    }
  }
  return { text: parts.join('\n\n').slice(0, MAX_TEXT), cursor: read.cursor };
}

// ---- Codex: ~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl ----

function readCodex({ transcriptFile, cursor, fromEnd }) {
  if (!transcriptFile || !fs.existsSync(transcriptFile)) return null;
  if (fromEnd) return endOf(transcriptFile);
  const read = readAppendedLines(transcriptFile, cursor);
  if (!read) return null;

  const parts = [];
  for (const rec of parseLines(read.lines)) {
    if (rec.type !== 'response_item') continue;
    const p = rec.payload || {};
    if (p.type !== 'message' || p.role !== 'assistant') continue;
    for (const block of p.content || []) {
      const text = block.text || block.output_text;
      if (text && text.trim()) parts.push(text.trim());
    }
  }
  return { text: parts.join('\n\n').slice(0, MAX_TEXT), cursor: read.cursor };
}

// Codex names rollouts by date, not by worktree, so the session is identified by
// the cwd recorded in its opening session_meta record.
function findCodexRollout(worktreePath, sinceMs) {
  const root = path.join(home(), '.codex', 'sessions');
  let best = null;
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) { walk(full, depth + 1); continue; }
      if (!e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (sinceMs && st.mtimeMs < sinceMs) continue;
      if (!best || st.mtimeMs > best.mtimeMs) {
        if (rolloutCwd(full) === worktreePath) best = { file: full, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(root, 0);
  return best ? best.file : '';
}

function rolloutCwd(file) {
  try {
    // session_meta is the first record; read a slice rather than the whole file.
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const first = buf.toString('utf8', 0, n).split('\n')[0];
      const rec = JSON.parse(first);
      return (rec.payload && rec.payload.cwd) || rec.cwd || '';
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

// Cursor replaces its transcript on each rewrite, so callers pass its conversation directory instead.
function bornMs(file) {
  try { const st = fs.statSync(file); return st.birthtimeMs || st.ctimeMs; } catch { return 0; }
}

// A tab's new session is the first created after it started, since the newest written can be
// a sibling's; with none created since, it resumed the newest written.
function pickSession(candidates, sinceMs) {
  if (!candidates.length) return '';
  const fresh = sinceMs ? candidates.filter((c) => c.bornMs >= sinceMs) : [];
  if (fresh.length) return fresh.reduce((a, b) => (b.bornMs < a.bornMs ? b : a)).file;
  // Ties go to the later candidate: finders list sessions oldest first where they can.
  return candidates.reduce((a, b) => (b.mtimeMs >= a.mtimeMs ? b : a)).file;
}

// ---- Copilot: ~/.copilot/session-state/<id>/events.jsonl ----

function readCopilot({ transcriptFile, cursor, fromEnd, sinceMs }) {
  if (!transcriptFile || !fs.existsSync(transcriptFile)) return null;
  if (fromEnd) return endOf(transcriptFile);
  const read = readAppendedLines(transcriptFile, cursor);
  if (!read) return null;

  const parts = [];
  for (const rec of parseLines(read.lines)) {
    if (rec.type !== 'assistant.message') continue;
    // --resume appends to the same file, so what an earlier run said is dropped by age.
    if (sinceMs && rec.timestamp && Date.parse(rec.timestamp) < sinceMs) continue;
    const text = rec.data && rec.data.content;
    if (typeof text === 'string' && text.trim()) parts.push(text.trim());
  }
  return { text: capFromEnd(parts.join('\n\n')), cursor: read.cursor };
}

// Sessions are global, so this worktree's is the newest one whose recorded cwd
// matches and that has been written to since the tab started.
function findCopilotEvents(worktreePath, sinceMs, taken) {
  const candidates = [];
  for (const s of listSessions(worktreePath)) {
    if (taken && taken.has(s.filePath)) continue;
    let st;
    try { st = fs.statSync(s.filePath); } catch { continue; }
    if (sinceMs && st.mtimeMs < sinceMs) continue;
    // Copilot's own updated_at, not the file's mtime, which can tie between sessions.
    candidates.push({ file: s.filePath, bornMs: st.birthtimeMs || st.ctimeMs, mtimeMs: s.updated || st.mtimeMs });
  }
  return pickSession(candidates, sinceMs);
}

// ---- Kimi Code: <session>/agents/main/wire.jsonl ----

function kimiHome() {
  const override = process.env.KIMI_CODE_HOME;
  return (override && override.trim()) || path.join(home(), '.kimi-code');
}

// A reply lands as content.part loop events once its step completes; `think`
// parts are the model's reasoning, not something it said.
function readKimi({ transcriptFile, cursor, fromEnd, sinceMs }) {
  if (!transcriptFile || !fs.existsSync(transcriptFile)) return null;
  if (fromEnd) return endOf(transcriptFile);
  const read = readAppendedLines(transcriptFile, cursor);
  if (!read) return null;

  const parts = [];
  for (const rec of parseLines(read.lines)) {
    if (rec.type !== 'context.append_loop_event') continue;
    if (sinceMs && typeof rec.time === 'number' && rec.time < sinceMs) continue;
    const ev = rec.event || {};
    if (ev.type !== 'content.part' || !ev.part || ev.part.type !== 'text') continue;
    const text = ev.part.text;
    if (typeof text === 'string' && text.trim()) parts.push(text.trim());
  }
  return { text: capFromEnd(parts.join('\n\n')), cursor: read.cursor };
}

// session_index.jsonl is an append log, so the newest session for a workdir is last.
function findKimiWire(worktreePath, sinceMs, taken) {
  let index;
  try { index = fs.readFileSync(path.join(kimiHome(), 'session_index.jsonl'), 'utf8'); } catch { return ''; }
  const candidates = [];
  for (const e of parseLines(index.split('\n').filter(Boolean))) {
    if (!e || typeof e.sessionDir !== 'string' || !samePath(e.workDir, worktreePath)) continue;
    const file = path.join(e.sessionDir, 'agents', 'main', 'wire.jsonl');
    if (taken && taken.has(file)) continue;
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (sinceMs && st.mtimeMs < sinceMs) continue;
    candidates.push({ file, bornMs: st.birthtimeMs || st.ctimeMs, mtimeMs: st.mtimeMs });
  }
  return pickSession(candidates, sinceMs);
}

// ---- Gemini CLI: ~/.gemini/tmp/<project id>/chats/session-*.jsonl ----

function geminiHome() {
  return path.join(process.env.GEMINI_CLI_HOME || home(), '.gemini');
}

function geminiText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
}

// A message is appended again under the same id when its tokens or tool calls
// arrive, so a repeat of something already read is not new speech.
// file -> { offset, said: id -> text }, so a turn parses only what was appended.
const geminiIndex = new Map();

function readGemini({ transcriptFile, cursor, fromEnd, sinceMs }) {
  let size;
  try { size = fs.statSync(transcriptFile).size; } catch { return null; }
  if (fromEnd) return { text: '', cursor: size };
  const from = typeof cursor === 'number' && cursor <= size ? cursor : 0;
  let index = geminiIndex.get(transcriptFile);
  // Starting before what's indexed, or a shorter file, means re-indexing from the top.
  if (!index || from < index.offset || size < index.offset) index = { offset: 0, said: new Map() };
  const read = readAppendedLines(transcriptFile, index.offset);
  if (!read) return null;

  const parts = [];
  let offset = index.offset;
  for (const line of read.lines) {
    const start = offset;
    offset += Buffer.byteLength(line, 'utf8') + 1;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || rec.type !== 'gemini' || !rec.id) continue;
    const text = geminiText(rec.content).trim();
    if (!text || index.said.get(rec.id) === text) continue;
    index.said.set(rec.id, text);
    if (start < from) continue;
    if (sinceMs && rec.timestamp && Date.parse(rec.timestamp) < sinceMs) continue;
    parts.push(text);
  }
  index.offset = read.cursor;
  geminiIndex.set(transcriptFile, index);
  return { text: capFromEnd(parts.join('\n\n')), cursor: read.cursor };
}

function geminiProjectId(worktreePath) {
  let registry;
  try { registry = JSON.parse(fs.readFileSync(path.join(geminiHome(), 'projects.json'), 'utf8')); } catch { return ''; }
  const projects = (registry && registry.projects) || {};
  for (const [root, id] of Object.entries(projects)) {
    if (samePath(root, worktreePath)) return id;
  }
  return '';
}

function findGeminiChat(worktreePath, sinceMs, taken) {
  const id = geminiProjectId(worktreePath);
  if (!id) return '';
  const dir = path.join(geminiHome(), 'tmp', id, 'chats');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return ''; }
  const candidates = [];
  for (const name of names) {
    if (!name.startsWith('session-') || !name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    if (taken && taken.has(file)) continue;
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (sinceMs && st.mtimeMs < sinceMs) continue;
    candidates.push({ file, bornMs: st.birthtimeMs || st.ctimeMs, mtimeMs: st.mtimeMs });
  }
  return pickSession(candidates, sinceMs);
}

// ---- Cursor: ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl ----
//
// Rewritten whole on every checkpoint, so the cursor is a line count.

function cursorProjectSlug(dir) {
  return String(dir).replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function readCursor({ transcriptFile, cursor, fromEnd }) {
  let raw;
  try { raw = fs.readFileSync(transcriptFile, 'utf8'); } catch { return null; }
  // A rewrite caught halfway is shorter than what was read, or ends mid-line;
  // either way the next poll gets the finished file.
  const done = raw.slice(0, raw.lastIndexOf('\n') + 1);
  const lines = done.split('\n').filter(Boolean);
  const from = typeof cursor === 'number' ? cursor : 0;
  if (lines.length < from) return { text: '', cursor: from };
  if (fromEnd) return { text: '', cursor: lines.length };
  const parts = [];
  for (const rec of parseLines(lines.slice(from))) {
    if (rec.role !== 'assistant' || !rec.message) continue;
    for (const part of rec.message.content || []) {
      if (!part || part.type !== 'text' || typeof part.text !== 'string') continue;
      // Reasoning is stored as a [REDACTED] marker, sometimes after real text.
      const text = part.text.replace(/\[REDACTED\]/g, '').trim();
      if (text) parts.push(text);
    }
  }
  return { text: capFromEnd(parts.join('\n\n')), cursor: lines.length };
}

function findCursorTranscript(worktreePath, sinceMs, taken) {
  if (!worktreePath) return '';
  const dir = path.join(home(), '.cursor', 'projects', cursorProjectSlug(path.resolve(worktreePath)), 'agent-transcripts');
  let ids = [];
  try { ids = fs.readdirSync(dir); } catch { return ''; }
  const candidates = [];
  for (const id of ids) {
    const file = path.join(dir, id, `${id}.jsonl`);
    if (taken && taken.has(file)) continue;
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (sinceMs && st.mtimeMs < sinceMs) continue;
    candidates.push({ file, bornMs: bornMs(path.dirname(file)), mtimeMs: st.mtimeMs });
  }
  return pickSession(candidates, sinceMs);
}

// ---- Cline: ~/.cline/data/sessions/<id>/<id>.messages.json ----
//
// The file is rewritten whole, so the cursor is the newest message time read.

function clineSessionsDir() {
  return path.join(home(), '.cline', 'data', 'sessions');
}

function readCline({ transcriptFile, cursor, fromEnd, sinceMs }) {
  let raw;
  try { raw = fs.readFileSync(transcriptFile, 'utf8'); } catch { return null; }
  const after = typeof cursor === 'number' ? cursor : 0;
  let doc;
  // A file caught mid-rewrite is nothing new yet; null would send the turn to the screen scrape.
  try { doc = JSON.parse(raw); } catch { return { text: '', cursor: after }; }
  const messages = (doc && Array.isArray(doc.messages)) ? doc.messages : null;
  if (!messages) return { text: '', cursor: after };
  let last = after;
  const parts = [];
  for (const m of messages) {
    const ts = typeof m.ts === 'number' ? m.ts : 0;
    if (ts > last) last = ts;
    if (fromEnd || m.role !== 'assistant' || ts <= after) continue;
    if (sinceMs && ts < sinceMs) continue;
    for (const part of m.content || []) {
      // thinking is the model's scratchpad and tool_use is a call, not speech.
      if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) parts.push(part.text.trim());
    }
  }
  return { text: capFromEnd(parts.join('\n\n')), cursor: last };
}

function findClineSession(worktreePath, sinceMs, taken) {
  let ids = [];
  try { ids = fs.readdirSync(clineSessionsDir()); } catch { return ''; }
  const candidates = [];
  for (const id of ids) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(clineSessionsDir(), id, `${id}.json`), 'utf8')); } catch { continue; }
    if (!meta || !(samePath(meta.workspace_root, worktreePath) || samePath(meta.cwd, worktreePath))) continue;
    // Cline has no resume, so a session started before the tab is never this tab's.
    const started = Date.parse(meta.started_at || '') || 0;
    if (sinceMs && started < sinceMs) continue;
    const file = meta.messages_path || path.join(clineSessionsDir(), id, `${id}.messages.json`);
    if (taken && taken.has(file)) continue;
    candidates.push({ file, bornMs: started, mtimeMs: started });
  }
  return pickSession(candidates, sinceMs);
}

// ---- aider (the Ollama provider): <git root>/.aider.chat.history.md ----
//
// Markdown, appended: `#### ` lines are the user, `> ` chunks are aider's own
// output, and everything else is the model's reply, written once it's done.

function readAider({ transcriptFile, cursor, fromEnd, worktreePath }) {
  if (!transcriptFile || !aiderHistoryIsSafe(transcriptFile, worktreePath)) return null;
  if (fromEnd) return endOf(transcriptFile);
  // Blank lines are what tell the reply's own quotes from aider's output.
  const read = readAppendedLines(transcriptFile, cursor, { keepBlank: true });
  if (!read) return null;

  const lines = read.lines;
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#### ') || line.startsWith('# aider chat started at ')) { kept.push(''); continue; }
    if (line.startsWith('> ')) {
      const end = aiderQuoteEnd(lines, i);
      if (end !== -1) { i = end; continue; }
    }
    kept.push(line);
  }
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: capFromEnd(text), cursor: read.cursor };
}

// aider prefixes only the first line of its output and ends it on a hard break, blank lines
// and all; a quote in the model's reply meets another `> ` or `#### ` line first.
function aiderQuoteEnd(lines, start) {
  if (lines[start].endsWith('  ')) return start;
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.startsWith('> ') || line.startsWith('#### ') || line.startsWith('# aider chat started at ')) return -1;
    if (line.endsWith('  ')) return j;
  }
  return -1;
}

// The file lives in the checkout, so a branch can commit it as a symlink to
// something outside the repo that keeps growing (shell history); that is never
// read, and it's rechecked on every read in case it was swapped after binding.
function aiderHistoryIsSafe(file, worktreePath) {
  try {
    if (!fs.lstatSync(file).isFile()) return false;
    return !worktreePath || samePath(path.dirname(fs.realpathSync(file)), worktreePath);
  } catch { return false; }
}

function findAiderHistory(worktreePath, sinceMs, taken) {
  const file = path.join(worktreePath || '', '.aider.chat.history.md');
  // Two aider tabs in one worktree write the same file and can't be told apart.
  if (!worktreePath || (taken && taken.has(file))) return '';
  return aiderHistoryIsSafe(file, worktreePath) ? file : '';
}

// ---- Antigravity: ~/.gemini/antigravity-cli/conversations/<id>.db ----
//
// Rows are protobuf with no published schema, so this path was read off the
// wire and can change under us; a miss falls back rather than posting whatever
// bytes sit at that offset.
const AGY_SPEECH_STEP = 15;
const AGY_SPEECH_FIELD = '20.1';
const AGY_DIR = path.join(home(), '.gemini', 'antigravity-cli', 'conversations');
const AGY_BRAIN_DIR = path.join(home(), '.gemini', 'antigravity-cli', 'brain');

// step_payload comes back as a Buffer, or as the byte list SQLite hands over
// for a blob bound from JS.
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value).split(',').map(Number));
}

function openDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

// The workspace a conversation belongs to, as a file:// URI in its metadata.
function antigravityWorkspace(file) {
  let db;
  try {
    db = openDb(file);
    const row = db.prepare("select data from trajectory_metadata_blob where id='main'").get();
    if (!row) return '';
    for (const parts of scan(toBuffer(row.data)).values()) {
      for (const b of parts) {
        const s = b.toString('utf8');
        if (s.startsWith('file://')) return decodeURIComponent(s.slice('file://'.length));
      }
    }
    return '';
  } catch { return ''; }
  finally { if (db) try { db.close(); } catch { /* already closed */ } }
}

// Returns { file, exact }. `exact` means the conversation named this worktree
// itself; anything else is the unclaimed-newest guess below, which the caller
// must keep re-resolving rather than settling on.
//
// `taken` holds the files other live sessions are already reading, so two
// sessions can never mirror one conversation into two different chat threads.
function findAntigravityConversation(worktreePath, sinceMs, taken) {
  let entries = [];
  try { entries = fs.readdirSync(AGY_DIR); } catch { return { file: '', exact: false }; }
  let matched = null;
  let unclaimed = null;
  for (const name of entries) {
    if (!name.endsWith('.db')) continue;
    const full = path.join(AGY_DIR, name);
    if (taken && taken.has(full)) continue;
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    // Only conversations touched since this session started can be its own.
    if (sinceMs && st.mtimeMs < sinceMs) continue;
    const workspace = antigravityWorkspace(full);
    // A conversation naming someone else's worktree is someone else's, however
    // recently it was written.
    if (workspace && workspace !== worktreePath) continue;
    if (workspace === worktreePath) {
      if (!matched || st.mtimeMs > matched.mtimeMs) matched = { file: full, mtimeMs: st.mtimeMs };
    } else if (!unclaimed || st.mtimeMs > unclaimed.mtimeMs) {
      unclaimed = { file: full, mtimeMs: st.mtimeMs };
    }
  }
  if (matched) return { file: matched.file, exact: true };
  // A conversation only records its workspace once it settles, so a live one has
  // nothing to match on yet — hence the guess at the newest that names nobody.
  return { file: (unclaimed || {}).file || '', exact: false };
}

function antigravityJsonlPath(transcriptFile) {
  if (!transcriptFile) return '';
  if (transcriptFile.endsWith('.jsonl') && fs.existsSync(transcriptFile)) return transcriptFile;
  const id = path.basename(transcriptFile, '.db');
  const jsonlPath = path.join(AGY_BRAIN_DIR, id, '.system_generated', 'logs', 'transcript.jsonl');
  if (fs.existsSync(jsonlPath)) return jsonlPath;
  const fullPath = path.join(AGY_BRAIN_DIR, id, '.system_generated', 'logs', 'transcript_full.jsonl');
  if (fs.existsSync(fullPath)) return fullPath;
  return '';
}

// Both Antigravity stores accumulate and their index is monotonic, so the cursor
// is that index, tagged with the reader that issued it: a jsonl position read as
// a row id skips or replays arbitrarily.
function stepCursor(kind, index) { return `${kind}:${index}`; }

// The index this reader last posted, or -1 when the cursor came from the other
// one (or from nothing yet), which means start from the beginning.
function stepIndexFrom(kind, cursor) {
  const s = String(cursor == null ? '' : cursor);
  const sep = s.indexOf(':');
  if (sep === -1 || s.slice(0, sep) !== kind) return -1;
  const n = Number(s.slice(sep + 1));
  return Number.isFinite(n) ? n : -1;
}

// Keeps the end rather than the start: the question and the numbered options a
// chat reply has to answer with are at the bottom of a turn.
function capFromEnd(text) {
  if (text.length <= MAX_TEXT) return text;
  return '…\n' + text.slice(-MAX_TEXT);
}

// Tool output carried on a MODEL step: file content, not something it said.
const AGY_TOOL_OUTPUT = /^Created At: \d{4}-/;
const AGY_SPOKEN_TYPES = new Set(['PLANNER_RESPONSE', 'ASK_QUESTION', 'GENERIC']);

// A question the agent puts to the user is not prose on the record: it is an
// ask_question tool call whose `questions` argument is itself a JSON string.
function questionsFromCall(call) {
  if (!call || call.name !== 'ask_question' || !call.args) return [];
  const raw = call.args.questions || call.args.question;
  if (!raw) return [];
  let list = raw;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return [String(raw).trim()]; }
  }
  const out = [];
  for (const q of Array.isArray(list) ? list : [list]) {
    if (typeof q === 'string') { out.push(q.trim()); continue; }
    if (!q || !q.question) continue;
    // The options are numbered the way the terminal numbers them, so an answer
    // typed back in chat means the same thing in both places.
    const options = Array.isArray(q.options)
      ? q.options.map((o, i) => `${i + 1}. ${o}`).join('\n')
      : '';
    out.push(options ? `${q.question}\n\n${options}` : String(q.question).trim());
  }
  return out;
}

// `thinking` is never included: it is the agent's scratchpad, not its answer.
function agySpeech(rec) {
  const out = [];
  const content = typeof rec.content === 'string' ? rec.content.trim() : '';
  if (content && !AGY_TOOL_OUTPUT.test(content)) out.push(content);
  for (const call of Array.isArray(rec.tool_calls) ? rec.tool_calls : []) {
    out.push(...questionsFromCall(call));
  }
  return out.filter(Boolean);
}

// Structured text the CLI writes for itself, so it beats the protobuf rows
// below, which were read off the wire and can change under us.
function readAntigravityJsonl(file, cursor, fromEnd) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const records = parseLines(raw.split('\n').filter(Boolean));
  if (!records.length) return { text: '', cursor: cursor || stepCursor('j', -1) };

  const from = stepIndexFrom('j', cursor);
  const parts = [];
  let last = from;
  let spoken = 0;
  for (const rec of records) {
    const index = Number(rec.step_index);
    if (!Number.isFinite(index)) continue;
    if (rec.source !== 'MODEL' || !AGY_SPOKEN_TYPES.has(rec.type)) continue;
    spoken += 1;
    if (index > last) last = index;
    if (fromEnd || index <= from) continue;
    for (const said of agySpeech(rec)) {
      if (parts[parts.length - 1] !== said) parts.push(said);
    }
  }
  // Records parsed but none was the agent speaking: the shape has moved under
  // us, which is not the same as the agent having said nothing.
  if (!spoken) return null;
  return { text: fromEnd ? '' : capFromEnd(parts.join('\n\n')), cursor: stepCursor('j', last) };
}

function readAntigravitySqlite(file, cursor, fromEnd) {
  let db;
  try {
    db = openDb(file);
    const from = stepIndexFrom('s', cursor);
    const rows = db.prepare(
      'select idx, step_payload from steps where step_type = ? and idx > ? order by idx',
    ).all(AGY_SPEECH_STEP, from);
    if (!rows.length) return { text: '', cursor: stepCursor('s', from) };

    let last = from;
    const parts = [];
    for (const row of rows) {
      last = row.idx;
      if (fromEnd) continue;
      for (const said of stringsAt(toBuffer(row.step_payload), AGY_SPEECH_FIELD)) {
        const t = said.trim();
        if (t && parts[parts.length - 1] !== t) parts.push(t);
      }
    }
    // Rows at the speech step, but nothing readable at the field path: the wire
    // format has moved. Fall back rather than reporting silence forever.
    if (!fromEnd && !parts.length) {
      console.warn(`[agent-transcript] antigravity: ${rows.length} step-${AGY_SPEECH_STEP} rows, nothing at field ${AGY_SPEECH_FIELD}`);
      return null;
    }
    return { text: fromEnd ? '' : capFromEnd(parts.join('\n\n')), cursor: stepCursor('s', last) };
  } catch (err) {
    console.warn('[agent-transcript] antigravity read failed:', err.message);
    return null;
  } finally {
    if (db) try { db.close(); } catch { /* already closed */ }
  }
}

// `fromEnd` adopts the turn on record without posting it: a conversation picked
// up mid-flight must not repeat what was said before this session claimed it.
function readAntigravity({ transcriptFile, cursor, fromEnd }) {
  if (!transcriptFile) return null;
  const jsonlFile = antigravityJsonlPath(transcriptFile);
  if (jsonlFile) return readAntigravityJsonl(jsonlFile, cursor, fromEnd);
  if (!fs.existsSync(transcriptFile)) return null;
  return readAntigravitySqlite(transcriptFile, cursor, fromEnd);
}

// ---- opencode: <data home>/opencode/opencode.db ----
//
// A message row carries the role, its parts carry the text, and `part.rowid` is
// monotonic, so it doubles as the cursor.
function opencodeDbPath() {
  const { authFilePath } = require('../state/opencode-config');
  return path.join(path.dirname(authFilePath()), 'opencode.db');
}

// The source is one string so a change of session repoints the cursor the same
// way a change of file does for the readers backed by one.
function opencodeSource(sessionId) {
  return `${opencodeDbPath()}#${sessionId}`;
}

function findOpencodeSession(worktreePath, sinceMs) {
  const dbPath = opencodeDbPath();
  if (!worktreePath || !fs.existsSync(dbPath)) return '';
  let db;
  try {
    db = openDb(dbPath);
    const row = db.prepare(
      'select id from session where directory = ? and time_updated >= ? order by time_updated desc limit 1',
    ).get(worktreePath, Number(sinceMs) || 0);
    return row ? row.id : '';
  } catch (err) {
    console.warn('[agent-transcript] opencode session lookup failed:', err.message);
    return '';
  } finally {
    if (db) try { db.close(); } catch { /* already closed */ }
  }
}

function readOpencode({ transcriptFile, cursor, fromEnd }) {
  const sep = String(transcriptFile || '').lastIndexOf('#');
  if (sep === -1) return null;
  const dbPath = transcriptFile.slice(0, sep);
  const sessionId = transcriptFile.slice(sep + 1);
  if (!sessionId || !fs.existsSync(dbPath)) return null;

  const from = Number(cursor) || 0;
  let db;
  try {
    db = openDb(dbPath);
    const rows = db.prepare(
      `select p.rowid as seq, p.data as part_data, m.data as message_data
         from part p join message m on m.id = p.message_id
        where p.session_id = ? and p.rowid > ?
        order by p.rowid`,
    ).all(sessionId, from);
    if (!rows.length) return { text: '', cursor: from };

    let last = from;
    const parts = [];
    for (const row of rows) {
      last = row.seq;
      if (fromEnd) continue;
      let message = {};
      let part = {};
      try { message = JSON.parse(row.message_data); } catch { continue; }
      try { part = JSON.parse(row.part_data); } catch { continue; }
      // A turn of pure tool calls is silence, not a read failure.
      if (message.role !== 'assistant' || part.type !== 'text') continue;
      const text = String(part.text || '').trim();
      if (text && parts[parts.length - 1] !== text) parts.push(text);
    }
    return { text: fromEnd ? '' : capFromEnd(parts.join('\n\n')), cursor: last };
  } catch (err) {
    console.warn('[agent-transcript] opencode read failed:', err.message);
    return null;
  } finally {
    if (db) try { db.close(); } catch { /* already closed */ }
  }
}

const READERS = {
  claude: readClaude, codex: readCodex, antigravity: readAntigravity, opencode: readOpencode,
  copilot: readCopilot, kimi: readKimi, gemini: readGemini, cline: readCline, ollama: readAider, cursor: readCursor,
};

function hasReader(providerId) {
  return Object.prototype.hasOwnProperty.call(READERS, providerId);
}

// Returns { text, cursor } for whatever the agent has said since `cursor`, or
// null when this provider has no readable store (caller falls back to the pty).
function readNewMessages(providerId, opts = {}) {
  const reader = READERS[providerId];
  if (!reader) return null;
  try {
    return reader(opts);
  } catch (err) {
    console.warn(`[agent-transcript] ${providerId} read failed:`, err.message);
    return null;
  }
}

module.exports = {
  readNewMessages,
  hasReader,
  claudeTranscriptPath,
  findCodexRollout,
  findCopilotEvents,
  findKimiWire,
  findGeminiChat,
  findClineSession,
  findCursorTranscript,
  cursorProjectSlug,
  bornMs,
  pickSession,
  findAiderHistory,
  findAntigravityConversation,
  findOpencodeSession,
  opencodeSource,
  antigravityWorkspace,
  MAX_TEXT,
};
