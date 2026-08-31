require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

// The panel is a browser IIFE; a null element from every DOM lookup keeps its
// render paths inert.
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};
global.document = { getElementById: () => null, querySelector: () => null };
global.AppState = { activeTaskId: null, tasks: new Map() };
global.AppUtils = { escHtml: (s) => s };
global.window = { addEventListener: () => {} };
global.DevLoopDetect = require('../../renderer/dev-loop-detect');

require('../../renderer/dev-loop-panel');
const panel = global.window.DevLoopPanel;

const OWL_OUTPUT = '## Phase 4 - QA the change';

test.beforeEach(() => store.clear());

test('a plain session that trips a phase regex does not sprout a dev loop', () => {
  // "gh pr create" is the phase-5 milestone, and any session may run it.
  panel.feedTerminalData(501, 'gh pr create --title fix\n');
  panel.feedTerminalData(501, OWL_OUTPUT);
  assert.equal(panel.getState(501), null);
  assert.equal(store.size, 0, 'nothing should be persisted for a session with no loop');
});

test('a started loop still tracks its phases', () => {
  panel.startDevLoop(502, 'ship the parser fix');
  panel.feedTerminalData(502, OWL_OUTPUT);
  assert.equal(panel.getState(502).currentPhase, 4);
});

test('a loop in one session does not put its bar on the others', () => {
  global.AppState.tasks.set(601, { id: 601, worktreePath: '/wt/owl' });
  global.AppState.tasks.set(602, { id: 602, worktreePath: '/wt/plain' });
  global.AppState.activeTaskId = 601;
  try {
    panel.startDevLoop(601, 'ship the parser fix');
    assert.equal(panel.getState(601).devLoop, true);
    assert.equal(panel.getState(602), null, 'the other session has no loop of its own');
  } finally {
    global.AppState.tasks.clear();
    global.AppState.activeTaskId = null;
  }
});

// Ids restart at 1 every launch, so a brand-new session inherited whatever loop
// once held its number — which is how two fresh sessions both opened as loops.
test('a recycled task id does not inherit the last run\'s loop', () => {
  store.set('klaussy-devloop:1', JSON.stringify({
    taskId: '1', taskDescription: 'last month\'s loop', devLoop: true,
    worktreePath: '/wt/old-session', currentPhase: 5, phaseStatuses: {}, qaArtifacts: [],
  }));
  global.AppState.tasks.set(1, { id: 1, worktreePath: '/wt/brand-new' });
  try {
    assert.equal(panel.getState(1), null);
  } finally {
    global.AppState.tasks.clear();
  }
});

test('a loop persisted before the flag is not trusted', () => {
  store.set('klaussy-devloop:503', JSON.stringify({
    taskId: '503', taskDescription: 'ship the parser fix', currentPhase: 3, phaseStatuses: {}, qaArtifacts: [],
  }));
  global.AppState.tasks.set(503, { id: 503, worktreePath: '/wt/legacy' });
  try {
    assert.equal(panel.getState(503), null);
  } finally {
    global.AppState.tasks.clear();
  }
});

// The flag lives on the task too, so a restart that renumbers ids — or a resume
// on a machine whose browser store never saw this loop — still comes back a loop.
test('a session flagged as a dev loop is one even with nothing persisted', () => {
  global.AppState.tasks.set(801, { id: 801, name: 'owl', worktreePath: '/wt/owl', devLoop: true });
  global.AppState.tasks.set(802, { id: 802, name: 'plain', worktreePath: '/wt/plain' });
  try {
    assert.equal(panel.getState(801).devLoop, true);
    assert.equal(panel.getState(802), null);
  } finally {
    global.AppState.tasks.clear();
  }
});

// The old saveState stamped the worktree key from whichever session was active,
// so a real loop's state landed under a plain session's worktree.
test('a loop recovered by worktree must have been running in that worktree', () => {
  global.AppState.tasks.set(701, { id: 701, worktreePath: '/wt/plain' });
  store.set('klaussy-devloop-wt:/wt/plain', JSON.stringify({
    taskId: '700', taskDescription: 'someone else\'s loop', devLoop: true,
    worktreePath: '/wt/owl', currentPhase: 3, phaseStatuses: {}, qaArtifacts: [],
  }));
  try {
    assert.equal(panel.getState(701), null);
  } finally {
    global.AppState.tasks.clear();
  }
});

test('a loop is recovered by worktree when its task id changed across a restart', () => {
  global.AppState.tasks.set(702, { id: 702, worktreePath: '/wt/owl' });
  store.set('klaussy-devloop-wt:/wt/owl', JSON.stringify({
    taskId: '700', taskDescription: 'ship the parser fix', devLoop: true,
    worktreePath: '/wt/owl', currentPhase: 3, phaseStatuses: {}, qaArtifacts: [],
  }));
  try {
    assert.equal(panel.getState(702).currentPhase, 3);
  } finally {
    global.AppState.tasks.clear();
  }
});
