require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const store = new Map();
let storageReads = 0;
global.localStorage = {
  getItem: (k) => { storageReads++; return store.has(k) ? store.get(k) : null; },
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};
global.document = { getElementById: () => null, querySelector: () => null };
global.AppState = { activeTaskId: null, tasks: new Map() };
global.AppUtils = { escHtml: (s) => s };

const calls = { plan: [], design: [], forBranch: 0 };
const held = new Map(); // worktreePath -> resolve, for findPlanFile calls the test wants to hold open
const holdNext = new Set();

global.window = {
  addEventListener: () => {},
  klaus: {
    fs: {
      findPlanFile: (wt) => {
        calls.plan.push(wt);
        if (holdNext.has(wt)) {
          holdNext.delete(wt);
          return new Promise((resolve) => held.set(wt, () => resolve({ error: 'none' })));
        }
        return Promise.resolve({ error: 'none' });
      },
      findDesignFile: (wt) => { calls.design.push(wt); return Promise.resolve({ error: 'none' }); },
      listFiles: () => Promise.resolve({ files: [] }),
      readFile: () => Promise.resolve({ error: 'none' }),
      devLoopEvidence: () => Promise.resolve({ evidence: null, phase: 0 }),
      findQaMedia: () => Promise.resolve({ media: [] }),
      authorizeQaMedia: () => Promise.resolve({ urls: {} }),
    },
    pr: { forBranch: () => { calls.forBranch++; return Promise.resolve({ pr: null }); } },
  },
};
global.DevLoopDetect = require('../../renderer/dev-loop-detect');

require('../../renderer/dev-loop-panel');
const panel = global.window.DevLoopPanel;

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

function loadsOf(wt) {
  return calls.plan.filter((p) => p === wt).length;
}

test.beforeEach(async () => {
  store.clear();
  global.AppState.tasks.clear();
  global.AppState.tasks.set(1, { id: 1, worktreePath: '/wt/a' });
  global.AppState.tasks.set(2, { id: 2, worktreePath: '/wt/b' });
  global.AppState.tasks.set(3, { id: 3, worktreePath: '/wt/plain' });
  global.AppState.activeTaskId = 1;
  panel.startDevLoop(1, 'loop a');
  panel.setWorktree('/wt/a');
  await settle();
});

test('a burst of background reloads runs one load, then one trailing load after the gap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 60_000 });
  panel.setWorktree('/wt/b');
  await settle();
  holdNext.add('/wt/a');
  panel.setWorktree('/wt/a');
  const before = loadsOf('/wt/a');
  for (let i = 0; i < 5; i++) panel.load('/wt/a');
  assert.equal(loadsOf('/wt/a'), before, 'no overlapping load while one is in flight');

  held.get('/wt/a')();
  await settle();
  assert.equal(loadsOf('/wt/a'), before, 'the trailing load waits out the minimum gap');

  t.mock.timers.tick(3000);
  await settle();
  assert.equal(loadsOf('/wt/a'), before + 1, 'exactly one trailing load for the whole burst');
});

test('switching worktrees mid-load discards the old load instead of finishing it', async () => {
  holdNext.add('/wt/a');
  panel.load('/wt/a', true);
  panel.setWorktree('/wt/b');
  await settle();
  const designForA = calls.design.filter((p) => p === '/wt/a').length;

  held.get('/wt/a')();
  await settle();
  assert.equal(calls.design.filter((p) => p === '/wt/a').length, designForA, 'the superseded load stops at its next await');
  assert.ok(calls.design.includes('/wt/b'));
});

test('a redrawn "Write(plan.md)" line reloads the active loop at most once per cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 120_000 });
  const before = calls.plan.length;
  for (let i = 0; i < 50; i++) panel.feedTerminalData(1, '⏺ Write(plan.md)\n');
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(calls.plan.length - before, 1, 'one reload for the whole burst, and not zero');
});

test('a plan line from a background loop does not reload the active worktree', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 180_000 });
  panel.startDevLoop(2, 'loop b');
  global.AppState.activeTaskId = 1;
  panel.setWorktree('/wt/a');
  t.mock.timers.tick(10_000);
  await settle();
  const before = calls.plan.length;
  for (let i = 0; i < 10; i++) panel.feedTerminalData(2, '⏺ Write(plan.md)\n');
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(calls.plan.length, before);
});

test('output from a tab with no loop stops touching storage after the first chunk', () => {
  storageReads = 0;
  for (let i = 0; i < 20; i++) panel.feedTerminalData(3, 'compiling...\n');
  assert.ok(storageReads <= 2, `expected the miss to be cached, saw ${storageReads} reads`);
  assert.equal(panel.getState(3), null);
});

test('a tab that starts a loop later is tracked again', () => {
  panel.feedTerminalData(3, 'compiling...\n');
  panel.startDevLoop(3, 'late loop');
  panel.feedTerminalData(3, '## Phase 4 - QA the change');
  assert.equal(panel.getState(3).currentPhase, 4);
});

test('the branch PR from evidence replaces a stale PR link', async () => {
  const fs = global.window.klaus.fs;
  const original = fs.devLoopEvidence;
  fs.devLoopEvidence = () => Promise.resolve({
    evidence: { prNumber: 42, prUrl: 'https://github.com/o/r/pull/42', qaMedia: 0 },
    phase: 6,
  });
  try {
    const state = panel.getState(1);
    state.prUrl = 'https://github.com/other/repo/pull/7';
    state.prNumber = 7;
    panel.load('/wt/a', true);
    await settle();
    assert.equal(panel.getState(1).prUrl, 'https://github.com/o/r/pull/42');
    assert.equal(panel.getState(1).prNumber, 42);
  } finally {
    fs.devLoopEvidence = original;
  }
});

test('a PR URL printed in the terminal does not replace the PR evidence found', async () => {
  const fs = global.window.klaus.fs;
  const original = fs.devLoopEvidence;
  fs.devLoopEvidence = () => Promise.resolve({
    evidence: { prNumber: 42, prUrl: 'https://github.com/o/r/pull/42', qaMedia: 0 },
    phase: 6,
  });
  try {
    panel.load('/wt/a', true);
    await settle();
    panel.feedTerminalData(1, 'Task from https://github.com/other/repo/pull/7\n');
    assert.equal(panel.getState(1).prUrl, 'https://github.com/o/r/pull/42');
  } finally {
    fs.devLoopEvidence = original;
  }
});
