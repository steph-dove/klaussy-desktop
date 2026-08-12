// Uncommitted, real-time session context sharing state manager.
// Manages local, uncommitted OKF notes in .git/klaussy-session/notes/<sessionId>/
// or ~/.klaussy/sessions/<sessionId>/notes/.

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Resolve directory path for session context notes.
 * Prefers worktree's .git/klaussy-session/notes/<sessionId> if git root exists,
 * otherwise falls back to ~/.klaussy/sessions/<sessionId>/notes/.
 */
function ensureSessionNotesDir(worktreePath, sessionId) {
  const safeSessionId = (sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  let targetDir = '';

  if (worktreePath && typeof worktreePath === 'string') {
    const gitDir = path.join(worktreePath, '.git');
    try {
      if (fs.existsSync(gitDir)) {
        // Handle git worktree where .git can be a file pointing to main .git dir
        const stat = fs.statSync(gitDir);
        if (stat.isDirectory()) {
          targetDir = path.join(gitDir, 'klaussy-session', 'notes', safeSessionId);
        } else if (stat.isFile()) {
          // In a git worktree, .git is a file containing `gitdir: /path/to/main/.git/worktrees/...`
          const content = fs.readFileSync(gitDir, 'utf8').trim();
          const match = content.match(/^gitdir:\s*(.+)$/i);
          if (match && match[1]) {
            const resolvedGitDir = path.resolve(worktreePath, match[1]);
            targetDir = path.join(resolvedGitDir, 'klaussy-session', 'notes', safeSessionId);
          }
        }
      }
    } catch {
      // Fall back on error
    }
  }

  if (!targetDir) {
    targetDir = path.join(os.homedir(), '.klaussy', 'sessions', safeSessionId, 'notes');
  }

  fs.mkdirSync(targetDir, { recursive: true });
  return targetDir;
}

/**
 * Format an object into a YAML frontmatter string.
 */
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

/**
 * Parse Markdown file containing YAML frontmatter.
 */
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

/**
 * Write an OKF session note to disk.
 */
function writeSessionNote(worktreePath, sessionId, noteData) {
  const dir = ensureSessionNotesDir(worktreePath, sessionId);
  const timestamp = noteData.timestamp || new Date().toISOString();
  const id = noteData.id || `note-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const filename = `${id}.md`;
  const filePath = path.join(dir, filename);

  const metadata = {
    id,
    session_id: sessionId || 'default',
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

/**
 * List all active session notes for a given session/worktree.
 */
function listSessionNotes(worktreePath, sessionId) {
  const dir = ensureSessionNotesDir(worktreePath, sessionId);
  if (!fs.existsSync(dir)) return [];

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

/**
 * Build a concise text summary of active session notes for injection into agent prompts.
 */
function buildSessionContextSummary(worktreePath, sessionId) {
  const notes = listSessionNotes(worktreePath, sessionId);
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

/**
 * Clear all notes for a session.
 */
function clearSessionNotes(worktreePath, sessionId) {
  try {
    const dir = ensureSessionNotesDir(worktreePath, sessionId);
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
    return true;
  } catch {
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
