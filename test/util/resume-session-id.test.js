require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { claudeProjectDir } = require('../../main/util/claude-paths');
const {
  instances, detectClaudeSessionId, findLatestSessionId, snapshotSessionIds, assignDetectedSessionIds,
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
  writeTranscript(wt, 'before-clear', 'cli');
  const file = writeTranscript(wt, 'after-clear', 'cli');
  const inst = agent(1, wt, { claudeSessionId: 'before-clear' });
  instances.set(1, inst);
  try {
    router.handleClaudeHook({ hook_event_name: 'Stop', cwd: wt, session_id: 'after-clear', transcript_path: file });
    assert.equal(inst.claudeSessionId, 'after-clear');
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
