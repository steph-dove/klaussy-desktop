// Session context sharing: uncommitted OKF notes under
// <repo>/.git/klaussy-session/notes/, or ~/.klaussy/sessions/<slug>/notes/ off git.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { gitCommonDir } = require('../util/git-repo');

const notesDirCache = new Map(); // worktreePath -> notes dir

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
      let val = trimmed.slice(2).trim();
      try { val = JSON.parse(val); } catch { /* leave as string */ }
      metadata[currentKey].push(val);
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) {
      const key = trimmed.slice(0, colonIdx).trim();
      const valStr = trimmed.slice(colonIdx + 1).trim();
      currentKey = key;

      if (!valStr) {
        metadata[key] = [];
      } else {
        let parsedVal = valStr;
        try { parsedVal = JSON.parse(valStr); } catch { /* leave as string */ }
        metadata[key] = parsedVal;
      }
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
      notes.push({
        id: metadata.id || file.replace(/\.md$/, ''),
        filePath,
        metadata,
        body,
      });
    } catch {
      // skip unparseable files
    }
  }

  notes.sort((a, b) => {
    const timeA = new Date(a.metadata.timestamp || 0).getTime();
    const timeB = new Date(b.metadata.timestamp || 0).getTime();
    return timeB - timeA;
  });

  return notes;
}

/** Flattens the notes into a text block small enough to prepend to an agent prompt. */
function buildSessionContextSummary(worktreePath) {
  const notes = listSessionNotes(worktreePath);
  if (!notes.length) return '';

  const header = `=== ACTIVE SESSION CONTEXT NOTES (${notes.length} note${notes.length === 1 ? '' : 's'}) ===\n`;
  const items = notes.map((n, i) => {
    const meta = n.metadata || {};
    const agentInfo = meta.agent ? `[Agent: ${meta.agent}${meta.provider ? ` (${meta.provider})` : ''}]` : '';
    const filesInfo = meta.affected_files && meta.affected_files.length ? `\nAffected files: ${meta.affected_files.join(', ')}` : '';
    const tagsInfo = meta.tags && meta.tags.length ? `\nTags: ${meta.tags.join(', ')}` : '';
    return `--- Note ${i + 1} (${meta.timestamp || 'recent'}) ${agentInfo} ---${filesInfo}${tagsInfo}\n${n.body}`;
  });

  return `${header}${items.join('\n\n')}\n=============================================`;
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
  serializeFrontmatter,
  parseFrontmatter,
  writeSessionNote,
  listSessionNotes,
  buildSessionContextSummary,
  clearSessionNotes,
};
