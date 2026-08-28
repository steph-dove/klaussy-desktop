require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const detect = require('../../renderer/dev-loop-detect');

const ESC = String.fromCharCode(27);

function phases(text) {
  return detect.detect(text).advances.map((a) => a.phase);
}

test('explicit phase headers advance the loop', () => {
  const samples = {
    '## Phase 4 - QA the change': 4,
    'Starting Phase 5: Create PR': 5,
    'Beginning Phase 2 - Implement with TDD': 2,
    'Now on Phase 7. Poll CI and fix failures': 7,
    'Executing Phase 3: Local review': 3,
  };
  for (const [sample, expected] of Object.entries(samples)) {
    assert.ok(phases(sample).includes(expected), sample);
  }
});

test('prose that merely mentions phases does not advance the loop', () => {
  const samples = [
    'In this task we will go through Phase 1 then Phase 2 then Phase 3',
    'Follow these 9 phases methodically in order',
  ];
  for (const sample of samples) {
    assert.deepEqual(phases(sample), [], sample);
  }
});

// Mirrors PHASES in renderer/dev-loop-panel.js. The resume prompt echoes a
// phase name straight back into the PTY, so a name that reads as a milestone
// would advance the loop just for being resumed.
const PHASE_NAMES = [
  'Plan & Discovery',
  'Implementation',
  'Local Review & Humanize',
  'QA & Evidence Recording',
  'Create PR (Humanized)',
  'Re-review Remote PR',
  'Pull & Fix CI Failures',
  'Pull & Resolve Review Comments',
  'Notify when Green (Merge Gate)',
];

test('the resume prompt does not advance the loop it is resuming', () => {
  PHASE_NAMES.forEach((name, idx) => {
    const prompt = 'Resume the autonomous Dev Loop for this task starting at Phase ' +
      (idx + 1) + ' (' + name + '). Continue executing through all remaining phases to completion.';
    assert.deepEqual(phases(prompt), [], prompt);
  });
});

test('a completed checklist item opens the phase after it', () => {
  assert.deepEqual(phases('- [x] Phase 1 - Plan'), [2]);
  assert.deepEqual(phases('* [✓] Phase 3: Local review'), [4]);
  // Bare ordinals are how agents usually number their own todo lists.
  assert.deepEqual(phases('- [x] 2. Implement'), [3]);
});

test('finishing the last phase closes it instead of advancing past 9', () => {
  const result = detect.detect('- [x] Phase 9 - Land the owl');
  assert.deepEqual(result.advances, []);
  assert.deepEqual(result.completions, [9]);
});

test('an in-progress checklist item advances to that phase', () => {
  assert.deepEqual(phases('- [>] Phase 5: Open PR'), [5]);
  assert.deepEqual(phases('- [in_progress] Phase 6: Re-review'), [6]);
});

test('a pending checklist item does not advance the loop', () => {
  assert.deepEqual(phases('- [ ] Phase 4 - QA'), []);
});

test('a checked item that merely starts with a digit is not a phase', () => {
  // Regression: "3 tests added" once read as Phase 3 and jumped the loop to QA.
  const samples = [
    '- [x] 3 tests added for the parser',
    '- [x] 2 files changed',
    '- [x] 5 findings resolved',
    '- [x] 630 tests passing',
  ];
  for (const sample of samples) {
    assert.deepEqual(phases(sample), [], sample);
  }
});

test('milestone phrases map to their phase, furthest along winning', () => {
  assert.ok(phases('Capturing artifacts for the PR plus a scroll-through recording').includes(4));
  assert.ok(phases('Creating the pull request for branch feat/owl').includes(5));
  assert.ok(phases('gh pr checks').includes(7));
  assert.ok(phases('All CI checks green').includes(9));
  assert.deepEqual(phases('Starting implementation, then gh pr checks'), [7]);
});

test('a PR link is captured with its number', () => {
  const result = detect.detect('opened https://github.com/org/repo/pull/123 for review');
  assert.equal(result.prUrl, 'https://github.com/org/repo/pull/123');
  assert.equal(result.prNumber, '123');
});

test('a written plan flags the docs on disk as worth re-reading', () => {
  assert.equal(detect.detect('Wrote 40 lines to docs/plan.md').planWritten, true);
  assert.ok(phases('Wrote 40 lines to docs/plan.md').includes(2));
  assert.equal(detect.detect('reading the plan').planWritten, false);
});

test('QA media is collected while app assets are ignored', () => {
  const result = detect.detect('saved e2e/qa-run.mp4 and qa/screenshot-1.png');
  assert.deepEqual(result.artifacts.map((a) => a.name), ['qa-run.mp4', 'screenshot-1.png']);
  assert.deepEqual(result.artifacts.map((a) => a.type), ['video', 'image']);

  assert.deepEqual(detect.detect('renderer/icons/logo.png').artifacts, []);
  assert.deepEqual(detect.detect('node_modules/pkg/demo.png').artifacts, []);
});

test('ANSI escapes are stripped before matching', () => {
  assert.deepEqual(phases(ESC + '[32m## Phase 4 - QA' + ESC + '[0m'), [4]);
  assert.equal(detect.stripAnsi(ESC + '[1mbold' + ESC + '[0m'), 'bold');
});
