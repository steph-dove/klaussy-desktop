require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

// We can test the phase extraction and keyword matching logic
test('dev loop phase detection: matches explicit phase headers', () => {
  const phaseRegex = /(?:##\s*|Starting\s+|Entering\s+|Moving to\s+|Executing\s+|Beginning\s+)?Phase\s*([1-9])(?:\s*[-—:.]\s*|\.|\s+)([^\n\r]*)/gi;

  const samples = [
    '## Phase 4 — QA the change',
    'Phase 4: QA & Evidence Recording',
    'Starting Phase 5: Create PR',
    'Phase 2 - Implement with TDD',
    'Phase 7. Poll CI and fix failures',
  ];

  const expected = [4, 4, 5, 2, 7];

  samples.forEach((sample, idx) => {
    phaseRegex.lastIndex = 0;
    const match = phaseRegex.exec(sample);
    assert.ok(match, `Expected match for ${sample}`);
    assert.equal(parseInt(match[1], 10), expected[idx]);
  });
});

test('dev loop phase detection: matches todo checklist items', () => {
  const todoRegex = /\[([ xX✓])\]\s*(?:Phase\s*)?([1-9])(?:\s*[-—:.]\s*|\.|\s+)([^\n\r]*)/gi;

  const samples = [
    '- [x] Phase 1 — Plan',
    '- [x] 2. Implement',
    '- [ ] Phase 4 — QA',
    '* [✓] Phase 3: Local review',
  ];

  const results = [];
  samples.forEach((sample) => {
    todoRegex.lastIndex = 0;
    const match = todoRegex.exec(sample);
    if (match) {
      const isDone = match[1] === 'x' || match[1] === 'X' || match[1] === '✓';
      const num = parseInt(match[2], 10);
      results.push({ num, isDone });
    }
  });

  assert.deepEqual(results, [
    { num: 1, isDone: true },
    { num: 2, isDone: true },
    { num: 4, isDone: false },
    { num: 3, isDone: true },
  ]);
});

test('dev loop phase detection: matches real agent stream output patterns', () => {
  const qaOutput = '• QA is clean across every section. Capturing artifacts for the PR – a scroll-through recording plus stills.';
  const prDraftOutput = '• Pushed. Drafting the PR body.\nWriting /private/tmp/.../scratchpad/pr-body.md';
  const prCreatedOutput = 'https://github.com/org/repo/pull/123';
  const ciChecksOutput = 'gh pr checks --watch';

  assert.ok(/(?:QA is clean|Capturing artifacts for the PR|scroll-through recording)/i.test(qaOutput));
  assert.ok(/(?:Drafting (?:the )?PR body|pr-body\.md)/i.test(prDraftOutput));
  assert.ok(/https:\/\/(?:github\.com|gitlab\.com)\/([^\s\n\r/]+)\/([^\s\n\r/]+)\/(?:pull|merge_requests)\/(\d+)/i.test(prCreatedOutput));
  assert.ok(/(?:gh pr checks|polling CI)/i.test(ciChecksOutput));
});
