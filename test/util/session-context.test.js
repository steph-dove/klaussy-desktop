const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  ensureSessionNotesDir,
  serializeFrontmatter,
  parseFrontmatter,
  writeSessionNote,
  listSessionNotes,
  buildSessionContextSummary,
  clearSessionNotes,
} = require('../../main/state/session-context');

test('serializeFrontmatter and parseFrontmatter round-trip', () => {
  const meta = {
    id: 'note-123',
    session_id: 'sess-456',
    agent: 'claude-code',
    provider: 'anthropic',
    affected_files: ['main/ipc/tasks.js', 'preload.js'],
    tags: ['auth', 'breaking_change'],
  };

  const yaml = serializeFrontmatter(meta);
  assert.ok(yaml.startsWith('---'));
  assert.ok(yaml.endsWith('---'));

  const fullContent = `${yaml}\n# Header\n\nThis is the note body.`;
  const parsed = parseFrontmatter(fullContent);

  assert.equal(parsed.metadata.id, 'note-123');
  assert.equal(parsed.metadata.session_id, 'sess-456');
  assert.equal(parsed.metadata.agent, 'claude-code');
  assert.deepEqual(parsed.metadata.affected_files, ['main/ipc/tasks.js', 'preload.js']);
  assert.deepEqual(parsed.metadata.tags, ['auth', 'breaking_change']);
  assert.equal(parsed.body, '# Header\n\nThis is the note body.');
});

test('writeSessionNote and listSessionNotes operate on local temp directory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-sess-test-'));
  const sessionId = 'test-session-1';

  try {
    const note1 = writeSessionNote(tmpDir, sessionId, {
      id: 'note-1',
      agent: 'claude-code',
      provider: 'anthropic',
      title: 'Auth IPC Refactored',
      content: 'Local mock server moved to port 3005.',
      affected_files: ['main/ipc/auth.js'],
      tags: ['auth'],
      timestamp: '2026-08-12T10:00:00.000Z',
    });

    assert.ok(fs.existsSync(note1.filePath));

    const note2 = writeSessionNote(tmpDir, sessionId, {
      id: 'note-2',
      agent: 'gemini',
      provider: 'google',
      title: 'UI Update',
      content: 'Updated header component to show active session notes.',
      affected_files: ['renderer/components/header.jsx'],
      tags: ['ui'],
      timestamp: '2026-08-12T10:05:00.000Z',
    });

    const notes = listSessionNotes(tmpDir, sessionId);
    assert.equal(notes.length, 2);
    assert.equal(notes[0].id, 'note-2'); // Newest first
    assert.equal(notes[1].id, 'note-1');

    const summary = buildSessionContextSummary(tmpDir, sessionId);
    assert.ok(summary.includes('ACTIVE SESSION CONTEXT NOTES (2 notes)'));
    assert.ok(summary.includes('[Agent: gemini (google)]'));
    assert.ok(summary.includes('Local mock server moved to port 3005.'));

    clearSessionNotes(tmpDir, sessionId);
    assert.equal(listSessionNotes(tmpDir, sessionId).length, 0);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('ensureSessionNotesDir constructs expected paths', () => {
  const tmpWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-wt-test-'));
  const gitDir = path.join(tmpWorktree, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  try {
    const dir = ensureSessionNotesDir(tmpWorktree, 'sess-abc');
    assert.equal(dir, path.join(gitDir, 'klaussy-session', 'notes', 'sess-abc'));
    assert.ok(fs.existsSync(dir));
  } finally {
    try { fs.rmSync(tmpWorktree, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
