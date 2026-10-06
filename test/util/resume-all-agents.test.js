const test = require('node:test');
const assert = require('node:assert/strict');

// app-functions-1.js is pure definitions, so a stub `window` is enough to load
// it (same approach as app-utils.test.js).
global.window = global.window || {};
global.document = global.document || { getElementById: () => null };
require('../../renderer/app-functions-1');
const App = global.window.App;

function stubKlaus(spawned) {
  let n = 0;
  global.window.klaus = {
    session: {
      resume(s) {
        n++;
        spawned.push({ kind: 'resume', mode: s.mode, originalMode: s.originalMode, sessionId: s.sessionId, worktreePath: s.worktreePath });
        return Promise.resolve({ id: 't' + n, mode: s.mode, worktreePath: s.worktreePath });
      },
    },
    task: {
      attachWorktree(worktreePath, mode) {
        n++;
        spawned.push({ kind: 'attach', mode, worktreePath });
        return Promise.resolve({ id: 't' + n, mode, worktreePath });
      },
    },
  };
}

// Regression: the extra agents were spawned in the main process but never
// handed to the renderer, so they ran with no terminal on screen.
test('resumeAllSavedAgents: hands every agent past the first to onExtra', async () => {
  const spawned = [];
  stubKlaus(spawned);
  const extras = [];
  const first = await App.resumeAllSavedAgents({
    savedAgents: [
      { mode: 'claude', sessionId: 'a', worktreePath: '/wt' },
      { mode: 'codex', sessionId: 'b', worktreePath: '/wt' },
      { mode: 'shell', sessionId: null, worktreePath: '/wt' },
    ],
  }, (t) => extras.push(t));

  assert.equal(spawned.length, 3);
  assert.equal(first.id, 't1');
  assert.deepEqual(extras.map((t) => t.id), ['t2', 't3']);
  assert.equal(spawned[2].kind, 'attach'); // shell entries attach, not resume
});

test('resumeAllSavedAgents: same agent saved twice on one session id is one tab', async () => {
  const spawned = [];
  stubKlaus(spawned);
  const extras = [];
  await App.resumeAllSavedAgents({
    savedAgents: [
      { mode: 'claude', sessionId: 'a', worktreePath: '/wt' },
      { mode: 'claude', sessionId: 'a', worktreePath: '/wt' },
    ],
  }, (t) => extras.push(t));

  assert.equal(spawned.length, 1);
  assert.equal(extras.length, 0);
});

test('resumeSessionWorktree: resumes every saved agent for the worktree', async () => {
  const spawned = [];
  stubKlaus(spawned);
  App.shellUserPicked = false;
  const extras = [];
  const saved = [
    { mode: 'claude', sessionId: 'a', worktreePath: '/wt' },
    { mode: 'codex', sessionId: 'b', worktreePath: '/wt' },
    { mode: 'claude', sessionId: 'c', worktreePath: '/other' },
  ];
  const first = await App.resumeSessionWorktree({ path: '/wt', branch: 'feat' }, 'feat', saved, 'claude', (t) => extras.push(t));

  assert.deepEqual(spawned.map((s) => s.mode), ['claude', 'codex']);
  assert.equal(first.id, 't1');
  assert.deepEqual(extras.map((t) => t.id), ['t2']);
});

test('resumeSessionWorktree: picking an agent hands the session off to that one only', async () => {
  const spawned = [];
  stubKlaus(spawned);
  App.shellUserPicked = true;
  const extras = [];
  try {
    await App.resumeSessionWorktree({ path: '/wt', branch: 'feat' }, 'feat', [
      { mode: 'copilot', sessionId: null, worktreePath: '/wt' },
      { mode: 'codex', sessionId: 'b', worktreePath: '/wt' },
    ], 'claude', (t) => extras.push(t));
  } finally {
    App.shellUserPicked = false;
  }

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].mode, 'claude');
  assert.equal(spawned[0].originalMode, 'copilot');
  assert.equal(extras.length, 0);
});

test('resumeSessionWorktree: without a pick every agent resumes in its own CLI', async () => {
  const spawned = [];
  stubKlaus(spawned);
  App.shellUserPicked = false;
  await App.resumeSessionWorktree({ path: '/wt', branch: 'feat' }, 'feat', [
    { mode: 'copilot', sessionId: null, worktreePath: '/wt' },
  ], 'claude', () => {});

  assert.deepEqual(spawned.map((s) => s.mode), ['copilot']);
});

test('resumeAllSavedAgents: leaves sub-agent tabs for addTaskToUI to reopen', async () => {
  const spawned = [];
  stubKlaus(spawned);
  const subs = [{ mode: 'copilot', label: 'GitHub Copilot', sessionId: null }];
  const first = await App.resumeAllSavedAgents({
    savedAgents: [{ mode: 'claude', sessionId: 'a', worktreePath: '/wt', subAgents: subs }],
  }, () => {});

  assert.deepEqual(first.subAgentsToReopen, subs);
});
