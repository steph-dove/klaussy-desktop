// Session context sharing: uncommitted OKF notes under
// <repo>/.git/klaussy-session/notes/, or ~/.klaussy/sessions/<slug>/notes/ off git.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { gitCommonDir } = require('../util/git-repo');

const notesDirCache = new Map(); // worktreePath -> notes dir

// Nothing marks a session over, and a stale note the reader can't tell is
// stale is worse than none, so age is the only reliable expiry.
const NOTE_TTL_MS = 24 * 60 * 60 * 1000;
// Shares the handoff seed with a transcript and a git brief, so notes take a
// slice comparable to session-handoff's MAX_TRANSCRIPT_CHARS.
const MAX_SUMMARY_CHARS = 12000;

// Filenames are agent-supplied, so anything that could climb out of the notes
// dir (or name a device) is flattened rather than escaped.
function sanitizeSegment(value, fallback) {
  const safe = String(value == null ? '' : value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return safe.replace(/^_+$/, '') ? safe : fallback;
}

// Keyed by the *common* git dir: a per-worktree or per-terminal key hands every
// agent a private directory, which is the exact failure this bus exists to avoid.
function resolveSessionNotesDir(worktreePath) {
  const commonDir = typeof worktreePath === 'string' ? gitCommonDir(worktreePath) : null;
  if (commonDir) return path.join(commonDir, 'klaussy-session', 'notes');

  // Off git there is no shared anchor, so scope to the folder itself; hashing
  // the path keeps two unrelated folders with the same basename apart.
  const resolved = worktreePath ? path.resolve(worktreePath) : 'default';
  const digest = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 8);
  const slug = `${sanitizeSegment(path.basename(resolved), 'workspace')}-${digest}`;
  return path.join(os.homedir(), '.klaussy', 'sessions', slug, 'notes');
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

function writeSessionNote(worktreePath, noteData) {
  const dir = ensureSessionNotesDir(worktreePath);
  const timestamp = noteData.timestamp || new Date().toISOString();
  const generatedId = `note-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const id = sanitizeSegment(noteData.id || generatedId, generatedId);
  const filePath = path.join(dir, `${id}.md`);

  const metadata = {
    id,
    session_id: noteData.session_id || 'default',
    agent: noteData.agent || 'unknown',
    provider: noteData.provider || 'unknown',
    worktree: worktreePath || '',
    timestamp,
    affected_files: Array.isArray(noteData.affected_files) ? noteData.affected_files : [],
    tags: Array.isArray(noteData.tags) ? noteData.tags : [],
  };

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

      if (Date.now() - writtenAt > NOTE_TTL_MS) {
        fs.unlinkSync(filePath);
        continue;
      }

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
  const notes = listSessionNotes(worktreePath);
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
};
