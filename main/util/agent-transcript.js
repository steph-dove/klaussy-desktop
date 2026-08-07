// Reads what an agent actually said from its own session store, rather than
// reconstructing it from a repainting pty where every agent draws differently.
// Each reader takes a cursor and returns only what is new, so a caller can poll;
// providers with no readable store return null and the caller falls back.

const fs = require('fs');
const path = require('path');
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

function readClaude({ worktreePath, sessionId, cursor, transcriptFile }) {
  // An explicit path wins: Claude Code's own hook payloads carry one, and it
  // saves re-deriving the encoded project directory.
  const file = transcriptFile || claudeTranscriptPath(worktreePath, sessionId);
  if (!file || !fs.existsSync(file)) return null;
  const read = readAppendedLines(file, cursor);
  if (!read) return null;

  const parts = [];
  for (const rec of parseLines(read.lines)) {
    if (rec.type !== 'assistant') continue;
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

function readCodex({ transcriptFile, cursor }) {
  if (!transcriptFile || !fs.existsSync(transcriptFile)) return null;
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

function findAntigravityConversation(worktreePath, sinceMs) {
  let entries = [];
  try { entries = fs.readdirSync(AGY_DIR); } catch { return ''; }
  let matched = null;
  let newest = null;
  for (const name of entries) {
    if (!name.endsWith('.db')) continue;
    const full = path.join(AGY_DIR, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    // Only conversations touched since this session started can be its own.
    if (sinceMs && st.mtimeMs < sinceMs) continue;
    if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs: st.mtimeMs };
    if (antigravityWorkspace(full) === worktreePath
      && (!matched || st.mtimeMs > matched.mtimeMs)) {
      matched = { file: full, mtimeMs: st.mtimeMs };
    }
  }
  // A conversation only records its workspace once it settles, so a live one has
  // none to match on — hence the fallback to the newest touched since we spawned.
  return (matched || newest || {}).file || '';
}

// The cursor is the last step index read, since rows are appended in order.
function readAntigravity({ transcriptFile, cursor }) {
  if (!transcriptFile || !fs.existsSync(transcriptFile)) return null;
  let db;
  try {
    db = openDb(transcriptFile);
    const rows = db.prepare(
      'select idx, step_payload from steps where step_type = ? and idx > ? order by idx',
    ).all(AGY_SPEECH_STEP, Number(cursor) || 0);

    const parts = [];
    let last = Number(cursor) || 0;
    for (const row of rows) {
      last = row.idx;
      for (const text of stringsAt(toBuffer(row.step_payload), AGY_SPEECH_FIELD)) {
        const t = text.trim();
        // The same turn is stored more than once as it streams.
        if (t && parts[parts.length - 1] !== t) parts.push(t);
      }
    }
    return { text: parts.join('\n\n').slice(0, MAX_TEXT), cursor: last };
  } catch (err) {
    console.warn('[agent-transcript] antigravity read failed:', err.message);
    return null;
  } finally {
    if (db) try { db.close(); } catch { /* already closed */ }
  }
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
