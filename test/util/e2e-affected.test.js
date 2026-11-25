const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../../scripts/e2e-affected');

test('mentions: ids as selectors or quoted, globals, klaus APIs, channels', () => {
  assert.ok(a.mentions("page.locator('#btn-new-task')", '#btn-new-task'));
  assert.ok(a.mentions("getElementById('commit-area')", '#commit-area'));
  assert.ok(!a.mentions("'#btn-new-task-x'", '#btn-new-task'));
  assert.ok(a.mentions('window.DiffPanel.show(wt)', 'window.DiffPanel'));
  assert.ok(a.mentions('window.klaus.ui.setPreferences({})', 'api:ui.setPreferences'));
  assert.ok(!a.mentions('window.klaus.ui.setPreferencesX()', 'api:ui.setPreferences'));
  assert.ok(a.mentions("invoke('pr-merge', {})", 'ch:pr-merge'));
});

test('preload: channels map to their window.klaus paths, nested namespaces included', () => {
  const apis = a.preloadApis();
  assert.ok(apis.get('set-preferences').has('ui.setPreferences'));
  assert.ok(apis.get('session-context:list-notes').has('task.sessionContext.listNotes'));
  assert.ok(apis.size > 200);
});

test('segments and handlersUsing follow a helper through another helper to its handler', () => {
  const src = [
    "const { a, b: bee } = require('./x');",
    'function isId(v) { return a(v); }',
    'function check(v) { return isId(v); }',
    "ipcMain.handle('uses-check', () => check(1));",
    "ipcMain.handle('unrelated', () => bee());",
    'module.exports = { check };',
  ].join('\n');
  const segs = a.segments(src);
  assert.deepEqual(segs[0].names, ['a', 'bee']);
  assert.ok(segs[5].exports);
  assert.deepEqual(a.handlersUsing(segs, ['isId']), ['uses-check']);
  assert.deepEqual(a.handlersUsing(segs, ['bee']), ['unrelated']);
  assert.deepEqual(a.importNames("const { x, y: z } = require('../q');"), ['x', 'z']);
});

test('affected: a spec runs itself, docs and unit tests run nothing, fixtures run everything', () => {
  const specs = a.affected(['e2e/terminal.spec.js', 'docs/browser-mode.md', 'test/util/x.test.js']);
  assert.deepEqual([...specs.reasons.keys()], ['e2e/terminal.spec.js']);
  assert.deepEqual(specs.runAll, []);
  assert.deepEqual(a.affected(['e2e/fixtures.js']).runAll, ['e2e/fixtures.js']);
  const none = a.affected(['web/helper.js', 'main/bootstrap/auto-updater.js', 'e2e/terminal.spec.js']);
  // The spec still runs, so the other two were skipped rather than the whole call failing.
  assert.deepEqual([...none.reasons.keys()], ['e2e/terminal.spec.js']);
  assert.deepEqual(none.runAll, []);
});

test('affected: a deleted app file or a renderer helper with nothing to follow runs everything', () => {
  assert.match(a.affected(['main/ipc/no-such-file.js']).runAll[0], /deleted/);
  assert.match(a.affected(['renderer/main-window-a11y.js']).runAll[0], /owns no ids/);
});

test('affected: a script runs everything only if the app or a spec loads it', () => {
  assert.deepEqual(a.affected(['scripts/release-mac.js']).runAll, []);
  assert.deepEqual([...a.affected(['scripts/screenshot.js']).reasons.keys()], ['e2e/screenshot-script.spec.js']);
});

test('requires resolve the way Node does, and bindings keep their aliases', () => {
  assert.equal(a.resolveRequire('main/ipc/git.js', '../util/git-arg'), 'main/util/git-arg.js');
  assert.equal(a.resolveRequire('main/ipc/git.js', '../util/git-arg.js'), 'main/util/git-arg.js');
  assert.equal(a.resolveRequire('main/ipc/x.js', '../nowhere'), 'main/nowhere/index.js');
  const b = a.requireBindings('main/ipc/pr-review-checks.js').find((r) => r.target === 'main/util/git-arg.js');
  assert.deepEqual(b.names, [['gitRef', 'gitRef']]);
});

test('names with $ are matched as whole words', () => {
  const segs = a.segments(["const $x = 1;", "ipcMain.handle('a', () => $x);", "ipcMain.handle('b', () => a$x);"].join('\n'));
  assert.deepEqual(a.handlersUsing(segs, ['$x']), ['a']);
});

test('affected: a renderer file reaches the specs that use its elements', () => {
  const r = a.affected(['renderer/preferences.html']);
  assert.ok(r.reasons.has('e2e/preferences.spec.js'), [...r.reasons.keys()].join(' '));
});
