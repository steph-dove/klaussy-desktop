require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const {
  ensureSessionNotesDir,
  sessionNotesEnv,
  serializeFrontmatter,
  parseFrontmatter,
  writeSessionNote,
  listSessionNotes,
  buildSessionContextSummary,
  withSessionContext,
  NOTE_FRESH_MS,
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

// The documented example is `tags: [topic]` — unquoted, so not valid JSON, and
// it used to survive as a string and crash the summary on .join().
test('a hand-written note using the documented frontmatter is readable', () => {
  const repo = makeRepo();
  const dir = ensureSessionNotesDir(repo);
  fs.writeFileSync(path.join(dir, 'claude-code-1001.md'), [
    '---',
    'agent: claude-code',
    'provider: anthropic',
    'affected_files: ["main/ipc/auth.js"]',
    'tags: [ports, breaking_change]',
    '---',
    '# Auth port moved',
    'Mock auth server moved from 3000 to 3005.',
  ].join('\n'));

  const [note] = listSessionNotes(repo);
  assert.deepEqual(note.metadata.tags, ['ports', 'breaking_change']);
  assert.deepEqual(note.metadata.affected_files, ['main/ipc/auth.js']);

  const summary = buildSessionContextSummary(repo);
  assert.ok(summary.includes('Tags: ports, breaking_change'));
  assert.ok(summary.includes('Affected files: main/ipc/auth.js'));
  assert.ok(summary.includes('Mock auth server moved from 3000 to 3005.'));
});

test('notes without a timestamp still order newest-first', () => {
  const repo = makeRepo();
  const dir = ensureSessionNotesDir(repo);
  // Neither note carries a timestamp, as the documented frontmatter omits it.
  fs.writeFileSync(path.join(dir, 'older.md'), '---\nagent: a\n---\nfirst\n');
  fs.writeFileSync(path.join(dir, 'newer.md'), '---\nagent: b\n---\nsecond\n');
  const now = Date.now();
  fs.utimesSync(path.join(dir, 'older.md'), new Date(now - 60000), new Date(now - 60000));
  fs.utimesSync(path.join(dir, 'newer.md'), new Date(now), new Date(now));

  assert.deepEqual(listSessionNotes(repo).map((n) => n.id), ['newer', 'older']);
});

test('a malformed metadata field degrades instead of throwing', () => {
  const repo = makeRepo();
  const dir = ensureSessionNotesDir(repo);
  fs.writeFileSync(path.join(dir, 'broken.md'), '---\nagent: x\ntags: not-a-list\n---\nbody\n');

  assert.ok(buildSessionContextSummary(repo).includes('Tags: not-a-list'));
});

test('notes written by one terminal are visible to every other', () => {
  const repo = makeRepo();
  // Relative to now, not fixed dates — a wall-clock timestamp would silently
  // age past the TTL and start failing a day after it was written.
  const now = Date.now();

  writeSessionNote(repo, {
    id: 'note-1',
    session_id: '1',
    agent: 'claude-code',
    provider: 'anthropic',
    title: 'Auth IPC Refactored',
    content: 'Local mock server moved to port 3005.',
    affected_files: ['main/ipc/auth.js'],
    tags: ['auth'],
    timestamp: new Date(now - 120000).toISOString(),
  });
  writeSessionNote(repo, {
    id: 'note-2',
    session_id: '2',
    agent: 'gemini',
    provider: 'google',
    title: 'UI Update',
    content: 'Updated header component to show active session notes.',
    timestamp: new Date(now - 60000).toISOString(),
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

// A klaussy session spans several repos, so its notes are shared by all of them.
test('every repo in one klaussy session shares a channel', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-home-')));
  const api = path.join(root, 'klaussy', 'sessions', 'auth-refactor', 'api');
  const web = path.join(root, 'klaussy', 'sessions', 'auth-refactor', 'web');
  fs.mkdirSync(api, { recursive: true });
  fs.mkdirSync(web, { recursive: true });

  const dir = ensureSessionNotesDir(api);
  try {
    assert.equal(ensureSessionNotesDir(web), dir);

    writeSessionNote(api, { id: 'from-api', content: 'port 3005' });
    assert.deepEqual(listSessionNotes(web).map((n) => n.id), ['from-api']);
    assert.ok(buildSessionContextSummary(web).includes('port 3005'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Two unrelated tasks in the same repo would otherwise read each other's notes
// for as long as the TTL allows.
test('a different klaussy session gets a different channel', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-home-')));
  const one = path.join(root, 'klaussy', 'sessions', 'auth-refactor', 'api');
  const two = path.join(root, 'klaussy', 'sessions', 'billing-fix', 'api');
  fs.mkdirSync(one, { recursive: true });
  fs.mkdirSync(two, { recursive: true });

  const dirOne = ensureSessionNotesDir(one);
  const dirTwo = ensureSessionNotesDir(two);
  try {
    assert.notEqual(dirOne, dirTwo);
    writeSessionNote(one, { id: 'private', content: 'only for auth-refactor' });
    assert.equal(listSessionNotes(two).length, 0);
  } finally {
    fs.rmSync(dirOne, { recursive: true, force: true });
    fs.rmSync(dirTwo, { recursive: true, force: true });
  }
});

test('notes live outside the repo, so nothing is written into .git', () => {
  const repo = makeRepo();
  const dir = ensureSessionNotesDir(repo);
  try {
    assert.ok(dir.startsWith(path.join(os.homedir(), '.klaussy', 'sessions')));
    assert.ok(!fs.existsSync(path.join(repo, '.git', 'klaussy-session')));
    writeSessionNote(repo, { id: 'n', content: 'x' });
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString().trim(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Outside a session the task is the folder itself, so two unrelated folders
// that merely share a basename must not read each other's notes.
test('folders with the same basename get separate channels', () => {
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

// Notes are kept: the drawer shows every one with its age, so an old note is
// history you can read, not something deleted out from under you.
test('an old note is kept and still listed', () => {
  const repo = makeRepo();
  const dir = ensureSessionNotesDir(repo);
  const stale = path.join(dir, 'stale.md');
  fs.writeFileSync(stale, '---\nagent: old\n---\nancient\n');
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, longAgo, longAgo);

  assert.deepEqual(listSessionNotes(repo).map((n) => n.id), ['stale']);
  assert.ok(fs.existsSync(stale), 'notes are never deleted behind your back');
});

test('a note past the freshness window is not injected into prompts', () => {
  const repo = makeRepo();
  const old = new Date(Date.now() - NOTE_FRESH_MS - 60000).toISOString();
  writeSessionNote(repo, { id: 'ancient', content: 'the port moved to 3005', timestamp: old });

  assert.equal(listSessionNotes(repo).length, 1, 'still on disk and in the drawer');
  assert.equal(buildSessionContextSummary(repo), '', 'but not in an agent prompt');
});

test('a note inside the freshness window is injected', () => {
  const repo = makeRepo();
  const recent = new Date(Date.now() - NOTE_FRESH_MS + 3600000).toISOString();
  writeSessionNote(repo, { id: 'recent', content: 'the port moved to 3005', timestamp: recent });

  assert.match(buildSessionContextSummary(repo), /port moved to 3005/);
});

test('the summary drops whole old notes rather than truncating mid-note', () => {
  const repo = makeRepo();
  for (let i = 0; i < 30; i++) {
    writeSessionNote(repo, {
      id: `note-${String(i).padStart(2, '0')}`,
      agent: `agent-${i}`,
      content: 'x'.repeat(1000),
      timestamp: new Date(Date.now() - (30 - i) * 60000).toISOString(),
    });
  }

  const summary = buildSessionContextSummary(repo);
  assert.ok(summary.length < 15000, `summary was ${summary.length} chars`);
  assert.ok(summary.includes('older omitted for length'));
  assert.ok(summary.includes('agent-29'));
  assert.ok(!summary.includes('agent-0\n'));
  assert.ok(summary.trimEnd().endsWith('='), 'summary should end on its footer');
});

test('sessionNotesEnv gives a terminal everything it needs to join the bus', () => {
  const repo = makeRepo();
  const env = sessionNotesEnv(repo, 7);

  assert.equal(env.KLAUSSY_SESSION_NOTES_DIR, ensureSessionNotesDir(repo));
  assert.equal(env.KLAUSSY_SESSION_ID, '7');
  assert.deepEqual(sessionNotesEnv(null, 1), {}, 'no worktree means no env, not a throw');
});

test('withSessionContext prepends notes to a prompt an agent is already given', () => {
  const repo = makeRepo();
  writeSessionNote(repo, { id: 'n1', agent: 'gemini', content: 'Port moved to 3005.' });

  const seeded = withSessionContext(repo, 'Fix the login bug.');
  assert.ok(seeded.includes('Port moved to 3005.'));
  assert.ok(seeded.includes('Fix the login bug.'));
  assert.ok(seeded.indexOf('Port moved to 3005.') < seeded.indexOf('Fix the login bug.'),
    'notes should come before the task');
  assert.ok(/claims to verify/.test(seeded), 'notes should be framed as unverified');
});

// A bare terminal gets no prompt, and no provider can seed context without also
// starting a turn — so with nothing to prepend to, nothing is injected.
test('withSessionContext leaves an empty prompt alone', () => {
  const repo = makeRepo();
  writeSessionNote(repo, { id: 'n1', content: 'something' });

  assert.equal(withSessionContext(repo, ''), '');
  assert.equal(withSessionContext(repo, undefined), undefined);
});

test('withSessionContext returns the prompt untouched when there are no notes', () => {
  const repo = makeRepo();
  assert.equal(withSessionContext(repo, 'Fix the login bug.'), 'Fix the login bug.');
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
