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

test('resumeAllSavedAgents: every agent past the first comes back as a tab', async () => {
  const spawned = [];
  stubKlaus(spawned);
  const first = await App.resumeAllSavedAgents({
    savedAgents: [
      { mode: 'claude', sessionId: 'a', worktreePath: '/wt', subAgents: [{ mode: 'kimi-code', label: 'Kimi', sessionId: 'k' }] },
      { mode: 'codex', sessionId: 'b', worktreePath: '/wt' },
      { mode: 'shell', sessionId: null, worktreePath: '/wt' },
    ],
  });

  assert.deepEqual(spawned.map((s) => s.mode), ['claude']);
  assert.equal(first.id, 't1');
  assert.deepEqual(first.subAgentsToReopen, [
    { mode: 'kimi-code', label: 'Kimi', sessionId: 'k' },
    { mode: 'codex', label: null, sessionId: 'b' },
    { mode: 'shell', label: null, sessionId: null },
  ]);
});

test('resumeAllSavedAgents: a shell first entry attaches rather than resumes', async () => {
  const spawned = [];
  stubKlaus(spawned);
  await App.resumeAllSavedAgents({ savedAgents: [{ mode: 'shell', worktreePath: '/wt' }] });
  assert.deepEqual(spawned, [{ kind: 'attach', mode: 'shell', worktreePath: '/wt' }]);
});

test('resumeAllSavedAgents: same agent saved twice on one session id is one tab', async () => {
  const spawned = [];
  stubKlaus(spawned);
  const first = await App.resumeAllSavedAgents({
    savedAgents: [
      { mode: 'claude', sessionId: 'a', worktreePath: '/wt' },
      { mode: 'claude', sessionId: 'a', worktreePath: '/wt' },
    ],
  });

  assert.equal(spawned.length, 1);
  assert.equal(first.subAgentsToReopen, undefined);
});

test('resumeSessionWorktree: the worktree\'s other agents come back as tabs', async () => {
  const spawned = [];
  stubKlaus(spawned);
  App.shellUserPicked = false;
  const saved = [
    { mode: 'claude', sessionId: 'a', worktreePath: '/wt' },
    { mode: 'codex', sessionId: 'b', worktreePath: '/wt' },
    { mode: 'claude', sessionId: 'c', worktreePath: '/other' },
  ];
  const first = await App.resumeSessionWorktree({ path: '/wt', branch: 'feat' }, 'feat', saved, 'claude');

  assert.deepEqual(spawned.map((s) => s.mode), ['claude']);
  assert.equal(first.id, 't1');
  assert.deepEqual(first.subAgentsToReopen, [{ mode: 'codex', label: null, sessionId: 'b' }]);
});

test('resumeSessionWorktree: picking an agent hands the session off to that one only', async () => {
  const spawned = [];
  stubKlaus(spawned);
  App.shellUserPicked = true;
  let first;
  try {
    first = await App.resumeSessionWorktree({ path: '/wt', branch: 'feat' }, 'feat', [
      { mode: 'copilot', sessionId: null, worktreePath: '/wt' },
      { mode: 'codex', sessionId: 'b', worktreePath: '/wt' },
    ], 'claude');
  } finally {
    App.shellUserPicked = false;
  }

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].mode, 'claude');
  assert.equal(spawned[0].originalMode, 'copilot');
  assert.equal(first.subAgentsToReopen, undefined);
});

test('resumeSessionWorktree: without a pick every agent resumes in its own CLI', async () => {
  const spawned = [];
  stubKlaus(spawned);
  App.shellUserPicked = false;
  await App.resumeSessionWorktree({ path: '/wt', branch: 'feat' }, 'feat', [
    { mode: 'copilot', sessionId: null, worktreePath: '/wt' },
  ], 'claude');

  assert.deepEqual(spawned.map((s) => s.mode), ['copilot']);
});

test('resumeAllSavedAgents: leaves sub-agent tabs for addTaskToUI to reopen', async () => {
  const spawned = [];
  stubKlaus(spawned);
  const subs = [{ mode: 'copilot', label: 'GitHub Copilot', sessionId: null }];
  const first = await App.resumeAllSavedAgents({
    savedAgents: [{ mode: 'claude', sessionId: 'a', worktreePath: '/wt', subAgents: subs }],
  });

  assert.deepEqual(first.subAgentsToReopen, subs);
});
