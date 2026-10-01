require('../setup');
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildImplementPrompt, IMPLEMENT_COMMITTED_MARKER } = require('../../main/state/review-prompts');

test('implement all runs the tests before committing', () => {
  const p = buildImplementPrompt({ mode: 'all', body: '### Finding 1\nfix it' });
  assert.match(p, /### Finding 1\nfix it/);
  assert.doesNotMatch(p, /Do not run tests/);
  assert.match(p, /test suite/i);
  assert.ok(p.indexOf('test suite') < p.indexOf('git add -u'));
  assert.doesNotMatch(p, /DRAFT_PR_COMMENT/);
});

test('implement all commits what was tested, including earlier uncommitted edits', () => {
  const p = buildImplementPrompt({ mode: 'all', body: 'x' });
  assert.match(p, /git add -u/);
  assert.match(p, /earlier\s+Implement runs/);
});

test('implement all leaves the push to Klaussy and signals a commit with the marker', () => {
  const p = buildImplementPrompt({ mode: 'all', body: 'x' });
  assert.doesNotMatch(p, /git push/);
  assert.match(p, /Do not push/);
  assert.ok(p.includes(IMPLEMENT_COMMITTED_MARKER));
});

test('the renderer looks for the same marker the prompt asks for', () => {
  const src = require('fs').readFileSync(require.resolve('../../renderer/pr-review-implement.js'), 'utf8');
  assert.ok(src.includes(IMPLEMENT_COMMITTED_MARKER));
});

test('implement all stops instead of committing when a failure is not its own', () => {
  const p = buildImplementPrompt({ mode: 'all', body: 'x' });
  assert.match(p, /pre-existing/);
  assert.match(p, /do not\s+commit: stop/i);
});

test('single-finding implement still leaves tests and git to the reviewer', () => {
  const p = buildImplementPrompt({ mode: 'one', body: 'fix it' });
  assert.match(p, /Do not run tests, install deps, or commit\/push/);
  assert.ok(!p.includes(IMPLEMENT_COMMITTED_MARKER));
  assert.match(p, /<DRAFT_PR_COMMENT>/);
});

test('repo intel is appended when present', () => {
  const p = buildImplementPrompt({ mode: 'all', body: 'x', intel: 'INTEL BLOCK' });
  assert.ok(p.endsWith('\nINTEL BLOCK'));
});
