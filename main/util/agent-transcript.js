// Reads what an agent actually said from its own session store, rather than
// reconstructing it from a repainting pty where every agent draws differently.
// Each reader takes a cursor and returns only what is new, so a caller can poll;
// providers with no readable store return null and the caller falls back.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { claudeProjectDir } = require('./claude-paths');
const { stringsAt, scan } = require('./protobuf-scan');

// Enough for a chat message; the caller trims further for platform limits.
const MAX_TEXT = 4000;

function readAppendedLines(file, cursor) {
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
    lines: text.slice(0, lastNl).split('\n').filter(Boolean),
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
  const root = path.join(process.env.HOME || '', '.codex', 'sessions');
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

// ---- Antigravity: ~/.gemini/antigravity-cli/conversations/<id>.db ----
//
// Rows are protobuf with no published schema, so this path was read off the
// wire and can change under us; a miss falls back rather than posting whatever
// bytes sit at that offset.
const AGY_SPEECH_STEP = 15;
const AGY_SPEECH_FIELD = '20.1';
const AGY_DIR = path.join(process.env.HOME || '', '.gemini', 'antigravity-cli', 'conversations');
const AGY_BRAIN_DIR = path.join(process.env.HOME || '', '.gemini', 'antigravity-cli', 'brain');

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

// Antigravity keeps only the turn in progress: the jsonl log and the steps table
// are both rewritten each reply and idx restarts at 0, so a position is
// meaningless. The cursor names the last turn posted, by its content.
function turnId(kind, stamp, text) {
  const digest = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
  return `${kind}:${stamp || ''}:${digest}`;
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
  const parts = [];
  let stamp = '';
  for (const rec of parseLines(raw.split('\n').filter(Boolean))) {
    if (rec.source !== 'MODEL' || !AGY_SPOKEN_TYPES.has(rec.type)) continue;
    if (rec.created_at) stamp = rec.created_at;
    for (const said of agySpeech(rec)) {
      if (parts[parts.length - 1] !== said) parts.push(said);
    }
  }
  const text = parts.join('\n\n').slice(0, MAX_TEXT);
  const id = turnId('j', stamp, text);
  if (fromEnd || !text || id === cursor) return { text: '', cursor: id };
  return { text, cursor: id };
}

function readAntigravitySqlite(file, cursor, fromEnd) {
  let db;
  try {
    db = openDb(file);
    const rows = db.prepare(
      'select idx, step_payload from steps where step_type = ? order by idx',
    ).all(AGY_SPEECH_STEP);

    const parts = [];
    for (const row of rows) {
      for (const said of stringsAt(toBuffer(row.step_payload), AGY_SPEECH_FIELD)) {
        const t = said.trim();
        if (t && parts[parts.length - 1] !== t) parts.push(t);
      }
    }
    const text = parts.join('\n\n').slice(0, MAX_TEXT);
    const id = turnId('s', '', text);
    if (fromEnd || !text || id === cursor) return { text: '', cursor: id };
    return { text, cursor: id };
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

const READERS = { claude: readClaude, codex: readCodex, antigravity: readAntigravity };

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
  findAntigravityConversation,
  antigravityWorkspace,
  MAX_TEXT,
};
