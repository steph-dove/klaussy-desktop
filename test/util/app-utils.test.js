const test = require('node:test');
const assert = require('node:assert/strict');

// utils.js reads the preload bridge only inside functions, so a stub `window`
// is enough to load it (same approach as finding-parser.test.js).
global.window = global.window || {};
require('../../renderer/utils');
const AppUtils = global.window.AppUtils;

// Regression: when an agent CLI exits, the main process converts the pty in
// place and sets mode='shell', which relabelled the tab "Shell" and lost the
// task's identity.

test('exitedAgent: recovers the agent that exited', () => {
  assert.equal(AppUtils.exitedAgent({ mode: 'shell', resumeAgent: 'claude' }), 'claude');
  assert.equal(AppUtils.exitedAgent({ mode: 'shell', resumeAgent: 'codex' }), 'codex');
});

test('exitedAgent: a task started as a shell stays a shell', () => {
  assert.equal(AppUtils.exitedAgent({ mode: 'shell' }), null);
  assert.equal(AppUtils.exitedAgent({ mode: 'shell', resumeAgent: null }), null);
  // 'shell' is never a meaningful resume target, so it must not label the tab.
  assert.equal(AppUtils.exitedAgent({ mode: 'shell', resumeAgent: 'shell' }), null);
});

test('exitedAgent: a live agent is not exited', () => {
  assert.equal(AppUtils.exitedAgent({ mode: 'claude' }), null);
  // Resume relaunches the agent but leaves resumeAgent set, so a live mode has
  // to win over it.
  assert.equal(AppUtils.exitedAgent({ mode: 'claude', resumeAgent: 'claude' }), null);
});

test('exitedAgent: tolerates a missing task', () => {
  assert.equal(AppUtils.exitedAgent(null), null);
  assert.equal(AppUtils.exitedAgent(undefined), null);
});
