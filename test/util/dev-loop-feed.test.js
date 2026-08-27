require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

test('dev loop phase detection: matches explicit phase headers', () => {
  const phaseRegex = /(?:##\s*|(?:Starting|Entering|Moving to|Executing|Beginning|Working on|Now on)\s+)Phase\s*([1-9])(?:\s*[-—:.]\s*|\.|\s+)([^\n\r]*)/gi;

  const validSamples = [
    '## Phase 4 — QA the change',
    'Starting Phase 5: Create PR',
    'Beginning Phase 2 - Implement with TDD',
    'Now on Phase 7. Poll CI and fix failures',
    'Executing Phase 3: Local review',
  ];

  const expected = [4, 5, 2, 7, 3];

  validSamples.forEach((sample, idx) => {
    phaseRegex.lastIndex = 0;
    const match = phaseRegex.exec(sample);
    assert.ok(match, `Expected match for ${sample}`);
    assert.equal(parseInt(match[1], 10), expected[idx]);
  });

  // Prompt sentences or static text should NOT match:
  const nonActionSamples = [
    'In this task we will go through Phase 1 then Phase 2 then Phase 3',
    'Follow these 9 phases methodically in order',
  ];
  nonActionSamples.forEach((sample) => {
    phaseRegex.lastIndex = 0;
    const match = phaseRegex.exec(sample);
    assert.equal(match, null, `Should not match static text: ${sample}`);
  });
});

test('dev loop phase detection: matches done and active checklist items while ignoring pending', () => {
  const doneTodoRegex = /\[([xX✓])\]\s*(?:Phase\s*)?([1-9])(?:\s*[-—:.]\s*|\.|\s+)([^\n\r]*)/gi;
  const activeTodoRegex = /\[([>•~]|in[ _-]progress|running)\]\s*(?:Phase\s*)?([1-9])(?:\s*[-—:.]\s*|\.|\s+)([^\n\r]*)/gi;

  const samples = [
    '- [x] Phase 1 — Plan',
    '- [x] 2. Implement',
    '- [ ] Phase 4 — QA',
    '* [✓] Phase 3: Local review',
    '- [>] Phase 5: Open PR',
    '- [in_progress] Phase 6: Re-review',
  ];

  const donePhases = [];
  const activePhases = [];

  samples.forEach((sample) => {
    doneTodoRegex.lastIndex = 0;
    const doneMatch = doneTodoRegex.exec(sample);
    if (doneMatch) {
      donePhases.push(parseInt(doneMatch[2], 10));
    }
    activeTodoRegex.lastIndex = 0;
    const activeMatch = activeTodoRegex.exec(sample);
    if (activeMatch) {
      activePhases.push(parseInt(activeMatch[2], 10));
    }
  });

  assert.deepEqual(donePhases, [1, 2, 3]);
  assert.deepEqual(activePhases, [5, 6]);
});

test('dev loop phase detection: matches real agent stream output patterns', () => {
  const qaOutput = 'Capturing artifacts for the PR – a scroll-through recording plus stills.';
  const prDraftOutput = '• Creating the pull request for branch feat/owl';
  const prCreatedOutput = 'https://github.com/org/repo/pull/123';
  const ciChecksOutput = 'gh pr checks';

  assert.ok(/(?:Capturing artifacts for the PR|scroll-through recording|Playwright screen recording)/i.test(qaOutput));
  assert.ok(/(?:gh pr create\b|Creating (?:the )?pull request|Opening (?:the )?PR\b)/i.test(prDraftOutput));
  assert.ok(/https:\/\/(?:github\.com|gitlab\.com)\/([^\s\n\r/]+)\/([^\s\n\r/]+)\/(?:pull|merge_requests)\/(\d+)/i.test(prCreatedOutput));
  assert.ok(/(?:gh pr checks|polling CI checks)/i.test(ciChecksOutput));
});
