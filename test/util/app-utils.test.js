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

function withPlatform(platform, fn) {
  const prev = global.window.klaus;
  global.window.klaus = { ui: { platform } };
  try { fn(); } finally { global.window.klaus = prev; }
}

function key(opts) {
  return Object.assign({ metaKey: false, ctrlKey: false, shiftKey: false, key: '', code: '' }, opts);
}

test('isAppShortcut: Cmd+key on macOS, not Ctrl', () => {
  withPlatform('darwin', () => {
    assert.equal(AppUtils.isAppShortcut(key({ metaKey: true, key: 'k' }), 'k'), true);
    assert.equal(AppUtils.isAppShortcut(key({ ctrlKey: true, key: 'k' }), 'k'), false);
    assert.equal(AppUtils.isAppShortcut(key({ metaKey: true, key: 'K', shiftKey: true }), 'k'), true);
  });
});

test('isAppShortcut: Ctrl+Shift+key elsewhere, so plain Ctrl+key stays with the shell', () => {
  withPlatform('linux', () => {
    assert.equal(AppUtils.isAppShortcut(key({ ctrlKey: true, shiftKey: true, key: 'K' }), 'k'), true);
    assert.equal(AppUtils.isAppShortcut(key({ ctrlKey: true, key: 'k' }), 'k'), false);
    assert.equal(AppUtils.isAppShortcut(key({ metaKey: true, key: 'k' }), 'k'), false);
  });
});

test('isAppShortcut: multi-character keys match on physical key code', () => {
  withPlatform('win32', () => {
    assert.equal(AppUtils.isAppShortcut(key({ ctrlKey: true, shiftKey: true, key: '?', code: 'Slash' }), 'Slash'), true);
    assert.equal(AppUtils.isAppShortcut(key({ ctrlKey: true, shiftKey: true, key: '+', code: 'Equal' }), 'Equal'), true);
  });
});

test('shortcutLabel: platform-specific modifier text', () => {
  withPlatform('darwin', () => assert.equal(AppUtils.shortcutLabel('k'), '⌘K'));
  withPlatform('linux', () => assert.equal(AppUtils.shortcutLabel('Slash'), 'Ctrl+Shift+/'));
});
