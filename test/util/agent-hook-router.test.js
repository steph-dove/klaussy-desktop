require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../../main/state/agent-hook-router');
const { instances } = require('../../main/state/instances');

function agent(id, over = {}) {
  return {
    id,
    name: 't' + id,
    alive: true,
    mode: 'claude',
    originalMode: 'claude',
    worktreePath: '/work/proj',
    notifyWebhookEnabled: true,
    pty: { write: () => {} },
    ...over,
  };
}

function reset() {
  for (const [id] of instances) instances.delete(id);
}

test('a hook goes to the session that fired it, named by its session id', () => {
  reset();
  instances.set(1, agent(1, { claudeSessionId: 'sess-a' }));
  instances.set(2, agent(2, { claudeSessionId: 'sess-b' }));
  try {
    assert.equal(router.targetForHook({ cwd: '/work/proj', sessionId: 'sess-b' }).id, 2);
    assert.equal(router.targetForHook({ cwd: '/work/proj', sessionId: 'sess-a' }).id, 1);
  } finally {
    reset();
  }
});

// The hooks live in the worktree, so every Claude running there fires them with
// the same cwd. Guessing sends approval keys to a terminal that never asked.
test('an ambiguous cwd with no session id reaches nothing', () => {
  reset();
  instances.set(1, agent(1));
  instances.set(2, agent(2));
  try {
    assert.equal(router.targetForHook({ cwd: '/work/proj' }), null,
      'two agents in one worktree, so the hook names neither');
  } finally {
    reset();
  }
});

test('cwd alone is enough when only one agent is there', () => {
  reset();
  instances.set(1, agent(1));
  try {
    assert.equal(router.targetForHook({ cwd: '/work/proj' }).id, 1);
    assert.equal(router.targetForHook({ cwd: '/somewhere/else' }), null);
  } finally {
    reset();
  }
});

// A second agent runs as a tab on the task, not as a task of its own, so its
// hooks have to reach its own mirror rather than the agent that owns the task.
test('a hook from a session tab reaches that tab', () => {
  reset();
  const parent = agent(1, { claudeSessionId: 'sess-parent' });
  parent.subTerminals = [{
    subId: 1,
    alive: true,
    mode: 'claude',
    claudeSessionId: 'sess-tab',
    pty: { write: () => {} },
    mirror: { id: '1:1', name: 'tab', worktreePath: '/work/proj', mode: 'claude' },
  }];
  instances.set(1, parent);
  try {
    assert.equal(router.targetForHook({ cwd: '/work/proj', sessionId: 'sess-tab' }).id, '1:1');
    assert.equal(router.targetForHook({ cwd: '/work/proj', sessionId: 'sess-parent' }).id, 1);
    assert.equal(router.targetForHook({ cwd: '/work/proj' }), null,
      'a tab and its task both answer to the cwd, so neither is picked blind');
  } finally {
    reset();
  }
});

test('a shell tab is never a target', () => {
  reset();
  instances.set(1, agent(1, { mode: 'shell', originalMode: 'shell' }));
  try {
    assert.equal(router.targetForHook({ cwd: '/work/proj' }), null);
  } finally {
    reset();
  }
});
