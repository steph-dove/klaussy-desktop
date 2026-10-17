require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { claudeProjectDir } = require('../../main/util/claude-paths');
const {
  instances, detectClaudeSessionId, findLatestSessionId, snapshotSessionIds, assignDetectedSessionIds,
  describeInstanceSession,
} = require('../../main/state/instances');
const router = require('../../main/state/agent-hook-router');

let n = 0;
function worktree() {
  return '/work/resume-' + (++n);
}

// The first record carrying an entrypoint is how Claude marks an interactive
// session ('cli') apart from a `claude -p` run ('sdk-cli').
function writeTranscript(wt, id, entrypoint) {
  const dir = claudeProjectDir(wt);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'queue-operation' }),
    JSON.stringify({ type: 'user', entrypoint, sessionId: id }),
  ].join('\n') + '\n');
  return file;
}

function agent(id, wt, over = {}) {
  return {
    id, name: 't' + id, alive: true, mode: 'claude', originalMode: 'claude',
    worktreePath: wt, notifyWebhookEnabled: false, pty: { write: () => {} }, ...over,
  };
}

function reset() {
  for (const [id] of instances) instances.delete(id);
}

test('a fresh tab is not paired with a headless review run in its worktree', () => {
  const wt = worktree();
  const inst = agent(1, wt, { preSpawnSessionIds: snapshotSessionIds(wt) });
  writeTranscript(wt, 'aaa-headless', 'sdk-cli');
  writeTranscript(wt, 'bbb-interactive', 'cli');
  assert.equal(detectClaudeSessionId(inst, new Set()), 'bbb-interactive');
});

test('the latest-session fallback skips headless runs', () => {
  const wt = worktree();
  writeTranscript(wt, 'real-convo', 'cli');
  const later = writeTranscript(wt, 'review-run', 'sdk-cli');
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(later, t, t);
  assert.equal(findLatestSessionId(wt), 'real-convo');
});

test('a headless run is still spotted when its prompt pushes the entrypoint past the first chunk', () => {
  const wt = worktree();
  writeTranscript(wt, 'real-convo', 'cli');
  const dir = claudeProjectDir(wt);
  const big = path.join(dir, 'big-review.jsonl');
  fs.writeFileSync(big, [
    JSON.stringify({ type: 'queue-operation', content: 'x'.repeat(200 * 1024) }),
    JSON.stringify({ type: 'user', entrypoint: 'sdk-cli' }),
  ].join('\n') + '\n');
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(big, t, t);
  assert.equal(findLatestSessionId(wt), 'real-convo');
});

test('a resumed tab keeps its id when new transcripts appear in the worktree', () => {
  const wt = worktree();
  writeTranscript(wt, 'resumed-id', 'cli');
  const inst = agent(1, wt, { claudeSessionId: 'resumed-id', preSpawnSessionIds: snapshotSessionIds(wt), spawnTime: 1 });
  writeTranscript(wt, 'someone-elses', 'cli');
  assignDetectedSessionIds([inst]);
  assert.equal(inst.claudeSessionId, 'resumed-id');
});

test('a tab with no id yet still gets the new transcript', () => {
  const wt = worktree();
  const inst = agent(1, wt, { preSpawnSessionIds: snapshotSessionIds(wt), spawnTime: 1 });
  writeTranscript(wt, 'its-session', 'cli');
  assignDetectedSessionIds([inst]);
  assert.equal(inst.claudeSessionId, 'its-session');
});

test('after /clear, the next hook moves the tab to the new session', () => {
  reset();
  const wt = worktree();
  writeTranscript(wt, '1e0b8c3d-6a2b-4b4c-8d7e-9f0a1b2c3d4e', 'cli');
  const file = writeTranscript(wt, '2f1c9d4e-7a3b-4c5d-9e8f-0a1b2c3d4e5f', 'cli');
  const inst = agent(1, wt, { claudeSessionId: '1e0b8c3d-6a2b-4b4c-8d7e-9f0a1b2c3d4e' });
  instances.set(1, inst);
  try {
    router.handleClaudeHook({ hook_event_name: 'Stop', cwd: wt, session_id: '2f1c9d4e-7a3b-4c5d-9e8f-0a1b2c3d4e5f', transcript_path: file });
    assert.equal(inst.claudeSessionId, '2f1c9d4e-7a3b-4c5d-9e8f-0a1b2c3d4e5f');
  } finally {
    reset();
  }
});

test('a hook from a headless run in the same worktree leaves the tab alone', () => {
  reset();
  const wt = worktree();
  writeTranscript(wt, 'the-tab', 'cli');
  const file = writeTranscript(wt, 'review-run', 'sdk-cli');
  const inst = agent(1, wt, { claudeSessionId: 'the-tab' });
  instances.set(1, inst);
  try {
    router.handleClaudeHook({ hook_event_name: 'Stop', cwd: wt, session_id: 'review-run', transcript_path: file });
    assert.equal(inst.claudeSessionId, 'the-tab');
  } finally {
    reset();
  }
});

test('a Claude sub-tab finds its own new transcript, not an older one or a headless run', () => {
  const claude = require('../../main/state/ai-providers').getProvider('claude');
  const wt = worktree();
  writeTranscript(wt, 'old-convo', 'cli');
  const snap = claude.snapshotSessions(wt);
  writeTranscript(wt, 'review-run', 'sdk-cli');
  writeTranscript(wt, 'sub-tab-convo', 'cli');
  assert.equal(claude.findNewSession(wt, snap).sessionId, 'sub-tab-convo');
});

test('a main tab does not adopt a transcript a sub-tab already owns', () => {
  const wt = worktree();
  const inst = agent(1, wt, { preSpawnSessionIds: snapshotSessionIds(wt), spawnTime: 1 });
  writeTranscript(wt, 'sub-owned', 'cli');
  assignDetectedSessionIds([inst], new Set(['sub-owned']));
  assert.equal(inst.claudeSessionId, undefined);
});

test('a transcript with no entrypoint yet is not adopted until it says what it is', () => {
  const wt = worktree();
  const inst = agent(1, wt, { preSpawnSessionIds: snapshotSessionIds(wt) });
  const dir = claudeProjectDir(wt);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'just-created.jsonl'), '');
  assert.equal(detectClaudeSessionId(inst, new Set()), null);
  assert.equal(findLatestSessionId(wt), null);
});

test('a transcript with no entrypoint is read again only once it grows', () => {
  const { isHeadlessTranscript } = require('../../main/util/claude-entrypoint');
  const wt = worktree();
  const dir = claudeProjectDir(wt);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'growing.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'queue-operation' }) + '\n');
  const realOpen = fs.openSync;
  let opens = 0;
  fs.openSync = (...a) => { opens++; return realOpen(...a); };
  try {
    isHeadlessTranscript(file);
    isHeadlessTranscript(file);
    assert.equal(opens, 1);
    fs.appendFileSync(file, JSON.stringify({ type: 'user', entrypoint: 'sdk-cli' }) + '\n');
    assert.equal(isHeadlessTranscript(file), true);
  } finally {
    fs.openSync = realOpen;
  }
});

test('a hook naming a session a sub-tab owns leaves the main tab alone', () => {
  reset();
  const wt = worktree();
  const mainId = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d';
  const subId = '4b3c2d1e-0f9a-4b8c-9d7e-6f5a4b3c2d1e';
  writeTranscript(wt, mainId, 'cli');
  const file = writeTranscript(wt, subId, 'cli');
  const inst = agent(1, wt, { claudeSessionId: mainId, subTerminals: [{ alive: true, mode: 'claude', sessionId: subId }] });
  instances.set(1, inst);
  try {
    router.handleClaudeHook({ hook_event_name: 'Stop', cwd: wt, session_id: subId, transcript_path: file });
    assert.equal(inst.claudeSessionId, mainId);
  } finally {
    reset();
  }
});

test('a hook session id that is not a UUID is never stored', () => {
  reset();
  const wt = worktree();
  const mainId = '5c4d3e2f-1a0b-4c9d-8e7f-6a5b4c3d2e1f';
  const bad = 'x; rm -rf ~';
  writeTranscript(wt, mainId, 'cli');
  const file = writeTranscript(wt, 'bad', 'cli');
  const inst = agent(1, wt, { claudeSessionId: mainId });
  instances.set(1, inst);
  try {
    router.handleClaudeHook({ hook_event_name: 'Stop', cwd: wt, session_id: bad, transcript_path: file });
    assert.equal(inst.claudeSessionId, mainId);
  } finally {
    reset();
  }
});

test('a closed tab is described well enough to reopen it with its agents', () => {
  const wt = worktree();
  writeTranscript(wt, 'main-convo', 'cli');
  const inst = agent(1, wt, {
    branch: 'feat', repoPath: '/repo', mode: 'shell', devLoop: true,
    subTerminals: [
      { mode: 'codex', label: 'Codex', alive: true, sessionId: 'codex-1' },
      { mode: 'shell', alive: true },
      { mode: 'gemini', alive: false, sessionId: 'gone' },
    ],
  });
  const rec = describeInstanceSession(inst);
  // A converted tab reopens as the agent that started it, on its latest transcript.
  assert.equal(rec.mode, 'claude');
  assert.equal(rec.sessionId, 'main-convo');
  assert.equal(rec.worktreePath, wt);
  assert.equal(rec.branch, 'feat');
  assert.equal(rec.repoPath, '/repo');
  assert.equal(rec.devLoop, true);
  assert.deepEqual(rec.subAgents, [{ mode: 'codex', label: 'Codex', sessionId: 'codex-1' }]);
});

test('a shell tab is described as a shell with no session to resume', () => {
  const rec = describeInstanceSession(agent(2, worktree(), { mode: 'shell', originalMode: 'shell' }));
  assert.equal(rec.mode, 'shell');
  assert.equal(rec.sessionId, null);
});

test('a closing tab’s sub-agent does not adopt the main agent’s transcript', () => {
  const claude = require('../../main/state/ai-providers').getProvider('claude');
  const wt = worktree();
  const sub = { mode: 'claude', label: 'Claude 2', alive: true, sessionId: null, preSpawnSessions: claude.snapshotSessions(wt) };
  writeTranscript(wt, 'main-convo', 'cli');
  const rec = describeInstanceSession(agent(3, wt, { subTerminals: [sub] }));
  assert.equal(rec.sessionId, 'main-convo');
  assert.deepEqual(rec.subAgents, [{ mode: 'claude', label: 'Claude 2', sessionId: null }]);
});
