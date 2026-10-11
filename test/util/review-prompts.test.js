require('../setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildReviewPrompt, REVIEW_ALLOWED_TOOLS } = require('../../main/state/review-prompts');

function makeWorktree(skills) {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'review-prompts-'));
  for (const [name, { alias, body }] of Object.entries(skills)) {
    const dir = path.join(wt, '.claude', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    const description = alias ? `Does things. Also known as \`${alias}\`.` : 'Does things.';
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  }
  return wt;
}

const SIBLINGS = {
  'acme-address-review': { alias: 'klaussy-address-review', body: 'ADDRESS_REVIEW_BODY' },
  'acme-self-review': { alias: 'klaussy-self-review', body: 'SELF_REVIEW_BODY' },
};

test('picks the review skill over address-review and self-review', () => {
  const wt = makeWorktree({ ...SIBLINGS, 'acme-review': { alias: 'klaussy-review', body: 'REVIEW_BODY' } });
  const p = buildReviewPrompt({ worktreePath: wt, baseRef: 'abc123' });
  assert.match(p, /REVIEW_BODY/);
  assert.doesNotMatch(p, /ADDRESS_REVIEW_BODY|SELF_REVIEW_BODY/);
});

test('picks the review skill by name when the skills predate the alias', () => {
  const wt = makeWorktree({
    'acme-address-review': { body: 'ADDRESS_REVIEW_BODY' },
    'acme-self-review': { body: 'SELF_REVIEW_BODY' },
    'acme-review': { body: 'REVIEW_BODY' },
  });
  const p = buildReviewPrompt({ worktreePath: wt, baseRef: 'abc123' });
  assert.match(p, /REVIEW_BODY/);
  assert.doesNotMatch(p, /ADDRESS_REVIEW_BODY|SELF_REVIEW_BODY/);
});

test('finds the alias in a SKILL.md with CRLF line endings', () => {
  const wt = makeWorktree({
    'a-review': { body: 'DECOY_BODY' },
    'acme-review': { alias: 'klaussy-review', body: 'REVIEW_BODY' },
  });
  const file = path.join(wt, '.claude', 'skills', 'acme-review', 'SKILL.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(/\n/g, '\r\n'));
  const p = buildReviewPrompt({ worktreePath: wt, baseRef: 'abc123' });
  assert.match(p, /REVIEW_BODY/);
  assert.doesNotMatch(p, /DECOY_BODY/);
  assert.doesNotMatch(p, /name: acme-review/);
});

test('falls back to the built-in template when only sibling -review skills exist', () => {
  const wt = makeWorktree(SIBLINGS);
  const p = buildReviewPrompt({ worktreePath: wt, baseRef: 'abc123' });
  assert.doesNotMatch(p, /ADDRESS_REVIEW_BODY|SELF_REVIEW_BODY/);
  assert.match(p, /<FINDINGS_JSON>/);
});

test('the repo-aware review never stops to ask the user', () => {
  const wt = makeWorktree({ 'acme-review': { alias: 'klaussy-review', body: 'REVIEW_BODY' } });
  const p = buildReviewPrompt({ worktreePath: wt, baseRef: 'abc123' });
  assert.match(p, /non-interactive/i);
  assert.match(p, /review local HEAD/i);
});

test('both AI review handlers let the run use the klaussy commands the skill needs', () => {
  for (const cmd of ['klaussy', 'python3 -m klaussy', 'python -m klaussy']) {
    assert.ok(REVIEW_ALLOWED_TOOLS.includes(`Bash(${cmd} base:*)`), cmd);
    assert.ok(REVIEW_ALLOWED_TOOLS.includes(`Bash(${cmd} review-prep:*)`), cmd);
  }
  const src = fs.readFileSync(require.resolve('../../main/ipc/claude-stream-ipc.js'), 'utf8');
  for (const channel of ['pr-review-ai-start', 'pr-ai-review-start']) {
    const start = src.indexOf(`ipcMain.handle('${channel}'`);
    const body = src.slice(start, src.indexOf('ipcMain.handle(', start + 1));
    assert.match(body, /allowedTools: REVIEW_ALLOWED_TOOLS/, channel);
  }
});
