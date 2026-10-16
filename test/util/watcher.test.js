require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { WATCH_IGNORE_RE, emitDelay } = require('../../main/state/watcher');

test('test and build output that churns during QA is ignored', () => {
  for (const rel of [
    'test-results/run-1/video.webm',
    'playwright-report/data/trace.zip',
    'web/coverage/lcov.info',
    '.venv/lib/site.py',
    'pkg/node_modules/a/index.js',
    '.git/index.lock',
  ]) {
    assert.ok(WATCH_IGNORE_RE.test(rel), `${rel} should be ignored`);
  }
});

test('source, docs and git state still reach subscribers', () => {
  for (const rel of ['src/a.js', 'plan.md', 'src/coverage.js', 'docs/test-results.md', '.git/index', '.git/HEAD']) {
    assert.ok(!WATCH_IGNORE_RE.test(rel), `${rel} should be watched`);
  }
});

test('an isolated change emits after the 200ms debounce', () => {
  assert.equal(emitDelay(10_000, 0), 200);
  assert.equal(emitDelay(10_000, 5_000), 200);
});

test('a change right after an emit waits out the one-second gap', () => {
  assert.equal(emitDelay(10_300, 10_000), 700);
  assert.equal(emitDelay(10_900, 10_000), 200);
});
