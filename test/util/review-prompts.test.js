require('../setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildReviewPrompt } = require('../../main/state/review-prompts');

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
