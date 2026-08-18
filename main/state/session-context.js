// Session context sharing: uncommitted OKF notes under
// ~/.klaussy/sessions/<channel>/notes/, one channel per klaussy session.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { klaussySessionDir } = require('../util/git-repo');

const notesDirCache = new Map(); // worktreePath -> notes dir

// Notes are never deleted (the drawer shows each one's age), so this window
// gates prompt injection only, where an agent mid-task cannot tell a
// three-week-old claim from a current one.
const NOTE_FRESH_MS = 72 * 60 * 60 * 1000;
// OKF requires `type` and nothing else, so a note carrying just this is
// already conformant (okf.md).
const NOTE_TYPE = 'session-note';
const DAY_MS = 24 * 60 * 60 * 1000;
// Shares the handoff seed with a transcript and a git brief, so notes take a
// slice comparable to session-handoff's MAX_TRANSCRIPT_CHARS.
const MAX_SUMMARY_CHARS = 12000;

// Filenames are agent-supplied, so anything that could climb out of the notes
// dir (or name a device) is flattened rather than escaped.
function sanitizeSegment(value, fallback) {
  const safe = String(value == null ? '' : value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return safe.replace(/^_+$/, '') ? safe : fallback;
}

// A session spans several repos with a git dir each, so its one shared channel
// cannot live under any single repo's .git.
function sessionChannel(worktreePath) {
  const session = klaussySessionDir(worktreePath);
  if (session) return `session-${sanitizeSegment(session.name, 'unnamed')}`;

  // Not a session worktree, so the task IS the folder. Hash the path so two
  // unrelated folders sharing a basename stay apart.
  const resolved = worktreePath ? path.resolve(worktreePath) : 'default';
  const digest = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 8);
  return `${sanitizeSegment(path.basename(resolved), 'workspace')}-${digest}`;
}

function resolveSessionNotesDir(worktreePath) {
  return path.join(os.homedir(), '.klaussy', 'sessions', sessionChannel(worktreePath), 'notes');
}

function ensureSessionNotesDir(worktreePath) {
  const key = worktreePath || '';
  let targetDir = notesDirCache.get(key);
  if (!targetDir) {
    targetDir = resolveSessionNotesDir(worktreePath);
    notesDirCache.set(key, targetDir);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  return targetDir;
}

// Returns {} rather than throwing so a notes-dir problem can never stop a
// terminal from spawning.
function sessionNotesEnv(worktreePath, terminalId) {
  if (!worktreePath) return {};
  try {
    const env = { KLAUSSY_SESSION_NOTES_DIR: ensureSessionNotesDir(worktreePath) };
    if (terminalId != null) env.KLAUSSY_SESSION_ID = String(terminalId);
    return env;
  } catch (err) {
    console.warn('[session-context] notes dir unavailable:', err && err.message);
    return {};
  }
}

function serializeFrontmatter(meta) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${JSON.stringify(item)}`);
      }
    } else if (typeof value === 'object') {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(String(value))}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// Notes are hand-written by agents, so a flow sequence arrives as often
// unquoted (`tags: [ports]`) as valid JSON (`tags: ["ports"]`).
function parseScalar(raw) {
  try { return JSON.parse(raw); } catch { /* not JSON — keep reading */ }
  const flow = raw.match(/^\[(.*)\]$/s);
  if (!flow) return raw;
  return flow[1].split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { metadata: {}, body: content.trim() };
  }

  const rawYaml = match[1];
  const body = match[2].trim();
  const metadata = {};

  let currentKey = null;
  for (const line of rawYaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- ') && currentKey) {
      if (!Array.isArray(metadata[currentKey])) {
        metadata[currentKey] = [];
      }
      metadata[currentKey].push(parseScalar(trimmed.slice(2).trim()));
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) {
      const key = trimmed.slice(0, colonIdx).trim();
      const valStr = trimmed.slice(colonIdx + 1).trim();
      currentKey = key;

      metadata[key] = valStr ? parseScalar(valStr) : [];
    }
  }

  return { metadata, body };
}

// OKF's expiry is a date and the window it describes is not, so round up: a date
// rounded down calls a note stale while the window still treats it as live.
function staleAfter(timestamp) {
  const at = new Date(timestamp).getTime();
  if (!at) return '';
  return new Date(at + NOTE_FRESH_MS + DAY_MS).toISOString().slice(0, 10);
}

// A note may declare its own expiry, including one written by a tool that is not
// klaussy; an absent or unparseable date just falls through to the window.
function declaredStale(metadata, now) {
  const raw = metadata && metadata.stale_after;
  if (!raw) return false;
  const day = new Date(`${String(raw).slice(0, 10)}T00:00:00Z`).getTime();
  return !!day && now >= day;
}

function writeSessionNote(worktreePath, noteData) {
  const dir = ensureSessionNotesDir(worktreePath);
  const timestamp = noteData.timestamp || new Date().toISOString();
  const generatedId = `note-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const id = sanitizeSegment(noteData.id || generatedId, generatedId);
  const filePath = path.join(dir, `${id}.md`);

  const metadata = {
    type: noteData.type || NOTE_TYPE,
    id,
    session_id: noteData.session_id || 'default',
    agent: noteData.agent || 'unknown',
    provider: noteData.provider || 'unknown',
    worktree: worktreePath || '',
    timestamp,
    stale_after: staleAfter(timestamp),
    affected_files: Array.isArray(noteData.affected_files) ? noteData.affected_files : [],
    tags: Array.isArray(noteData.tags) ? noteData.tags : [],
  };
  if (noteData.title) metadata.title = noteData.title;

  const titleHeader = noteData.title ? `# ${noteData.title}\n\n` : '';
  const bodyText = noteData.content || noteData.body || '';
  const fullContent = `${serializeFrontmatter(metadata)}\n${titleHeader}${bodyText}`.trim() + '\n';

  fs.writeFileSync(filePath, fullContent, 'utf8');

  return {
    id,
    filePath,
    metadata,
    title: noteData.title || '',
    body: bodyText,
  };
}

function listSessionNotes(worktreePath) {
  const dir = ensureSessionNotesDir(worktreePath);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  const notes = [];

  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const { metadata, body } = parseFrontmatter(content);
      // The documented frontmatter carries no timestamp, so mtime is what keeps
      // newest-first ordering meaningful.
      const stamped = new Date(metadata.timestamp || 0).getTime();
      const writtenAt = stamped || fs.statSync(filePath).mtimeMs;

      notes.push({
        id: metadata.id || file.replace(/\.md$/, ''),
        filePath,
        metadata,
        body,
        writtenAt,
      });
    } catch {
      // skip unparseable / already-removed files
    }
  }

  notes.sort((a, b) => b.writtenAt - a.writtenAt);

  return notes;
}

// A hand-written field may arrive as a bare string, which would crash .join().
function formatList(value) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '';
  return value ? String(value) : '';
}

/** Flattens the notes into a text block small enough to prepend to an agent prompt. */
function buildSessionContextSummary(worktreePath) {
  // Only the fresh ones: an old note stays readable in the drawer, where its
  // age is on screen, but must not reach an agent's prompt as current fact.
  const now = Date.now();
  const cutoff = now - NOTE_FRESH_MS;
  const notes = listSessionNotes(worktreePath)
    .filter((n) => n.writtenAt >= cutoff && !declaredStale(n.metadata, now));
  if (!notes.length) return '';

  const items = notes.map((n, i) => {
    const meta = n.metadata || {};
    const agentInfo = meta.agent ? `[Agent: ${meta.agent}${meta.provider ? ` (${meta.provider})` : ''}]` : '';
    const files = formatList(meta.affected_files);
    const tags = formatList(meta.tags);
    const filesInfo = files ? `\nAffected files: ${files}` : '';
    const tagsInfo = tags ? `\nTags: ${tags}` : '';
    const when = meta.timestamp || new Date(n.writtenAt).toISOString();
    return `--- Note ${i + 1} (${when}) ${agentInfo} ---${filesInfo}${tagsInfo}\n${n.body}`;
  });

  // Drop whole notes from the oldest end rather than truncating mid-note, which
  // would hand the reader a sentence with no way to tell it was cut.
  const kept = [];
  let budget = MAX_SUMMARY_CHARS;
  for (const item of items) {
    if (item.length > budget) break;
    budget -= item.length;
    kept.push(item);
  }
  if (!kept.length) kept.push(`${items[0].slice(0, MAX_SUMMARY_CHARS)}\n[note truncated]`);

  const dropped = notes.length - kept.length;
  const header = `=== ACTIVE SESSION CONTEXT NOTES (${kept.length} note${kept.length === 1 ? '' : 's'}`
    + `${dropped > 0 ? `, ${dropped} older omitted for length` : ''}) ===\n`;

  return `${header}${kept.join('\n\n')}\n=============================================`;
}

// Prompt-carrying spawns only: no provider can seed context without also
// starting a turn, so a bare terminal would open by talking to itself.
function withSessionContext(worktreePath, prompt) {
  if (!prompt || !prompt.trim()) return prompt;
  let notes = '';
  try {
    notes = buildSessionContextSummary(worktreePath);
  } catch (err) {
    console.warn('[session-context] summary failed:', err && err.message);
  }
  if (!notes) return prompt;
  return `${notes}\n\nThe notes above are what other agents in this session reported.`
    + ' Treat them as claims to verify, not established fact — they may be stale or'
    + ` describe work on another branch.\n\nYour task:\n\n${prompt}`;
}

function clearSessionNotes(worktreePath) {
  try {
    const dir = ensureSessionNotesDir(worktreePath);
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      fs.unlinkSync(path.join(dir, f));
    }
    return true;
  } catch (err) {
    console.warn('[session-context] clear failed:', err && err.message);
    return false;
  }
}

module.exports = {
  ensureSessionNotesDir,
  sessionNotesEnv,
  serializeFrontmatter,
  parseFrontmatter,
  writeSessionNote,
  listSessionNotes,
  buildSessionContextSummary,
  withSessionContext,
  clearSessionNotes,
  NOTE_FRESH_MS,
};
