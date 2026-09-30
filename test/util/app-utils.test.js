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

test('isAppShortcut: rejects extra modifiers and wrong codes', () => {
  withPlatform('darwin', () => {
    assert.equal(AppUtils.isAppShortcut(key({ metaKey: true, ctrlKey: true, key: 'k' }), 'k'), false);
    assert.equal(AppUtils.isAppShortcut(key({ metaKey: true, altKey: true, key: 'k' }), 'k'), false);
  });
  withPlatform('linux', () => {
    assert.equal(AppUtils.isAppShortcut(key({ ctrlKey: true, shiftKey: true, metaKey: true, key: 'K' }), 'k'), false);
    assert.equal(AppUtils.isAppShortcut(key({ ctrlKey: true, shiftKey: true, key: '/', code: 'Period' }), 'Slash'), false);
  });
  // AltGr on Windows reports as Ctrl+Alt.
  withPlatform('win32', () => {
    assert.equal(AppUtils.isAppShortcut(key({ ctrlKey: true, shiftKey: true, altKey: true, key: '?', code: 'Slash' }), 'Slash'), false);
  });
});

test('isAppShortcut: macOS matches the printed character, not the physical key', () => {
  withPlatform('darwin', () => {
    // German layout: "-" sits on code Slash.
    assert.equal(AppUtils.isAppShortcut(key({ metaKey: true, key: '-', code: 'Slash' }), 'Minus'), true);
    assert.equal(AppUtils.isAppShortcut(key({ metaKey: true, key: '-', code: 'Slash' }), 'Slash'), false);
    assert.equal(AppUtils.isAppShortcut(key({ metaKey: true, key: '+', code: 'NumpadAdd' }), 'Equal'), true);
  });
});

test('isAppShortcut: opts.shift pins Shift on macOS only', () => {
  withPlatform('darwin', () => {
    assert.equal(AppUtils.isAppShortcut(key({ metaKey: true, shiftKey: true, key: 'K' }), 'k', { shift: false }), false);
    assert.equal(AppUtils.isAppShortcut(key({ metaKey: true, key: 'k' }), 'k', { shift: true }), false);
  });
  withPlatform('linux', () => {
    assert.equal(AppUtils.isAppShortcut(key({ ctrlKey: true, shiftKey: true, key: 'K' }), 'k', { shift: false }), true);
  });
});

test('isClearShortcut: Cmd+Shift+K on macOS only', () => {
  withPlatform('darwin', () => {
    assert.equal(AppUtils.isClearShortcut(key({ metaKey: true, shiftKey: true, key: 'K' })), true);
    assert.equal(AppUtils.isClearShortcut(key({ metaKey: true, key: 'k' })), false);
  });
  withPlatform('linux', () => assert.equal(AppUtils.isClearShortcut(key({ ctrlKey: true, shiftKey: true, key: 'K' })), false));
});

test('isAnyAppShortcut: global shortcuts are kept from the shell, palette with Shift on macOS is not', () => {
  withPlatform('darwin', () => {
    assert.equal(AppUtils.isAnyAppShortcut(key({ metaKey: true, key: 'g' })), true);
    assert.equal(AppUtils.isAnyAppShortcut(key({ metaKey: true, shiftKey: true, key: 'K' })), false);
  });
  withPlatform('linux', () => assert.equal(AppUtils.isAnyAppShortcut(key({ ctrlKey: true, key: 'g' })), false));
});

test('isMac: falls back to navigator.platform without the preload bridge', () => {
  const prevKlaus = global.window.klaus;
  const desc = Object.getOwnPropertyDescriptor(global, 'navigator');
  global.window.klaus = undefined;
  try {
    Object.defineProperty(global, 'navigator', { value: { platform: 'MacIntel' }, configurable: true });
    assert.equal(AppUtils.isMac(), true);
    Object.defineProperty(global, 'navigator', { value: { platform: 'Win32' }, configurable: true });
    assert.equal(AppUtils.isMac(), false);
  } finally {
    if (desc) Object.defineProperty(global, 'navigator', desc); else delete global.navigator;
    global.window.klaus = prevKlaus;
  }
});

test('shortcutLabel: platform-specific modifier text', () => {
  withPlatform('darwin', () => {
    assert.equal(AppUtils.shortcutLabel('k'), '⌘K');
    assert.equal(AppUtils.shortcutLabel('Minus'), '⌘\u2212');
    assert.equal(AppUtils.shortcutLabel('Digit0'), '⌘0');
    assert.equal(AppUtils.clearShortcutLabel(), '⌘⇧K');
  });
  withPlatform('linux', () => {
    assert.equal(AppUtils.shortcutLabel('Slash'), 'Ctrl+Shift+/');
    assert.equal(AppUtils.shortcutLabel('Minus'), 'Ctrl+Shift+\u2212');
    assert.equal(AppUtils.shortcutLabel('Digit0'), 'Ctrl+Shift+0');
    assert.equal(AppUtils.clearShortcutLabel(), 'Ctrl+L');
  });
});
