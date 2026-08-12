require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const {
  ensureSessionNotesDir,
  serializeFrontmatter,
  parseFrontmatter,
  writeSessionNote,
  listSessionNotes,
  buildSessionContextSummary,
  clearSessionNotes,
} = require('../../main/state/session-context');

// A throwaway repo with one commit, so linked worktrees can be added to it.
function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-sess-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

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

  const parsed = parseFrontmatter(`${yaml}\n# Header\n\nThis is the note body.`);

  assert.equal(parsed.metadata.id, 'note-123');
  assert.equal(parsed.metadata.session_id, 'sess-456');
  assert.equal(parsed.metadata.agent, 'claude-code');
  assert.deepEqual(parsed.metadata.affected_files, ['main/ipc/tasks.js', 'preload.js']);
  assert.deepEqual(parsed.metadata.tags, ['auth', 'breaking_change']);
  assert.equal(parsed.body, '# Header\n\nThis is the note body.');
});

test('notes written by one terminal are visible to every other', () => {
  const repo = makeRepo();

  writeSessionNote(repo, {
    id: 'note-1',
    session_id: '1',
    agent: 'claude-code',
    provider: 'anthropic',
    title: 'Auth IPC Refactored',
    content: 'Local mock server moved to port 3005.',
    affected_files: ['main/ipc/auth.js'],
    tags: ['auth'],
    timestamp: '2026-08-12T10:00:00.000Z',
  });
  writeSessionNote(repo, {
    id: 'note-2',
    session_id: '2',
    agent: 'gemini',
    provider: 'google',
    title: 'UI Update',
    content: 'Updated header component to show active session notes.',
    timestamp: '2026-08-12T10:05:00.000Z',
  });

  const notes = listSessionNotes(repo);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].id, 'note-2'); // newest first
  assert.equal(notes[1].id, 'note-1');

  const summary = buildSessionContextSummary(repo);
  assert.ok(summary.includes('ACTIVE SESSION CONTEXT NOTES (2 notes)'));
  assert.ok(summary.includes('[Agent: gemini (google)]'));
  assert.ok(summary.includes('Local mock server moved to port 3005.'));

  assert.equal(clearSessionNotes(repo), true);
  assert.equal(listSessionNotes(repo).length, 0);
});

// The bus exists to carry notes between agents working the same session, so a
// linked worktree must land on the main repo's channel, not its own git dir.
test('a linked worktree shares the main repo notes channel', () => {
  const repo = makeRepo();
  const linked = path.join(fs.realpathSync(os.tmpdir()), `klaussy-wt-${Date.now()}`);
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature-x', linked], { cwd: repo, stdio: 'pipe' });

  try {
    assert.equal(ensureSessionNotesDir(linked), ensureSessionNotesDir(repo));

    writeSessionNote(repo, { id: 'from-main', content: 'port 3005' });
    const seen = listSessionNotes(linked);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, 'from-main');
    assert.ok(buildSessionContextSummary(linked).includes('port 3005'));
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: repo, stdio: 'pipe' });
  }
});

test('the notes dir hangs off the common git dir', () => {
  const repo = makeRepo();
  assert.equal(ensureSessionNotesDir(repo), path.join(repo, '.git', 'klaussy-session', 'notes'));
  assert.ok(fs.existsSync(ensureSessionNotesDir(repo)));
});

// Off git there is no shared anchor, so two folders that merely share a
// basename must not read each other's notes.
test('non-git folders with the same basename get separate channels', () => {
  const parentA = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-a-'));
  const parentB = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-b-'));
  const a = path.join(parentA, 'app');
  const b = path.join(parentB, 'app');
  fs.mkdirSync(a);
  fs.mkdirSync(b);

  const dirA = ensureSessionNotesDir(a);
  const dirB = ensureSessionNotesDir(b);
  try {
    assert.notEqual(dirA, dirB);
    assert.ok(dirA.startsWith(path.join(os.homedir(), '.klaussy', 'sessions')));
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('a note id cannot escape the notes directory', () => {
  const repo = makeRepo();
  const dir = ensureSessionNotesDir(repo);

  const note = writeSessionNote(repo, { id: '../../../../escaped', content: 'nope' });

  assert.equal(path.dirname(note.filePath), dir);
  assert.ok(!fs.existsSync(path.join(repo, '..', 'escaped.md')));
  assert.equal(listSessionNotes(repo).length, 1);
});

test('clearing notes leaves unrelated files alone', () => {
  const repo = makeRepo();
  const dir = ensureSessionNotesDir(repo);
  const keeper = path.join(dir, 'keep.json');
  fs.writeFileSync(keeper, '{}');
  writeSessionNote(repo, { id: 'note-1', content: 'x' });

  assert.equal(clearSessionNotes(repo), true);
  assert.equal(listSessionNotes(repo).length, 0);
  assert.ok(fs.existsSync(keeper));
});
