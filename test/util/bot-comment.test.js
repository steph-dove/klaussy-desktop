require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { botCommentBodies, buildReportAndDiff } = require('../../main/util/bot-comment');

function hasKlaussy() {
  try { execFileSync('klaussy', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('each finding gets its own report entry and a one-line file to anchor on', () => {
  const { report, diff } = buildReportAndDiff([
    { severity: 'High', category: 'Correctness', text: '**High · Correctness · `a.js:3`**\n\nIt leaks.' },
    { text: 'No meta at all.' },
  ]);
  assert.equal(report, '**High · Correctness · `f0.txt:1`**\n\nIt leaks.\n\n**Note · General · `f1.txt:1`**\n\nNo meta at all.\n');
  assert.match(diff, /\+\+\+ b\/f0\.txt\n@@ -0,0 \+1,1 @@\n\+x\n/);
  assert.match(diff, /\+\+\+ b\/f1\.txt\n/);
});

test('without klaussy it returns null so the caller falls back', async () => {
  const path = process.env.PATH;
  process.env.PATH = '';
  try {
    assert.equal(await botCommentBodies([{ text: 'It leaks.' }]), null);
  } finally {
    process.env.PATH = path;
  }
});

test('klaussy builds the bot’s comment: the why and the change, then the explanation collapsed', { skip: !hasKlaussy() && 'klaussy not installed' }, async () => {
  const [body] = await botCommentBodies([{
    severity: 'Medium', category: 'Correctness',
    text: 'It skips the last item. Only on the final page.\n\n```js\nfor (i = 0; i < n - 1; i++)\n```\n\nSuggested change:\n\n```suggestion\nconst b = a;\n```',
  }]);
  assert.equal(body, 'It skips the last item.\n\n```suggestion\nconst b = a;\n```\n\n<details>\n<summary></summary>\n\n'
    + 'It skips the last item. Only on the final page.\n\n```js\nfor (i = 0; i < n - 1; i++)\n```\n\n</details>');
});

test('a finding reordered so the change comes first leads with that one sentence', { skip: !hasKlaussy() && 'klaussy not installed' }, async () => {
  const [body] = await botCommentBodies([{ text: 'Take the lock first. Then write.\n\nIt races under load.' }]);
  assert.equal(body, 'Take the lock first.\n\n<details>\n<summary></summary>\n\nTake the lock first. Then write.\n\nIt races under load.\n\n</details>');
});

test('a body klaussy left out is null for that finding only', { skip: process.platform === 'win32' && 'shell stub' }, async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-klaussy-'));
  fs.writeFileSync(path.join(bin, 'klaussy'), '#!/bin/sh\necho \'{"comments":[{"path":"f1.txt","body":"Two."}]}\'\n', { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = bin;
  try {
    assert.deepEqual(await botCommentBodies([{ text: 'One.' }, { text: 'Two.' }]), [null, 'Two.']);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
