require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseSessionIds, listSessionIds, latestSession } = require('../../main/state/kimi-sessions');

// Real ~/.kimi-code/session_index.jsonl record shape (kimi-code 0.29.1 appends
// {sessionId, sessionDir, workDir} on every session create).
const INDEX = [
  '{"sessionId":"s-one","sessionDir":"/h/.kimi-code/sessions/wd_repo_aaaa/s-one","workDir":"/tmp/repo"}',
  '{"sessionId":"s-other","sessionDir":"/h/.kimi-code/sessions/wd_else_bbbb/s-other","workDir":"/tmp/elsewhere"}',
  '{"sessionId":"s-two","sessionDir":"/h/.kimi-code/sessions/wd_repo_aaaa/s-two","workDir":"/tmp/repo"}',
].join('\n') + '\n';

test('parseSessionIds keeps only this worktree, in append order', () => {
  assert.deepEqual(parseSessionIds(INDEX, '/tmp/repo'), ['s-one', 's-two']);
  assert.deepEqual(parseSessionIds(INDEX, '/tmp/elsewhere'), ['s-other']);
  assert.deepEqual(parseSessionIds(INDEX, '/tmp/nothing-here'), []);
});

test('parseSessionIds normalizes the workDir the way kimi does', () => {
  // kimi stores path.resolve(workDir), so a trailing slash or a '.' segment in
  // the query must still match the stored form.
  assert.deepEqual(parseSessionIds(INDEX, '/tmp/repo/'), ['s-one', 's-two']);
  assert.deepEqual(parseSessionIds(INDEX, '/tmp/./repo'), ['s-one', 's-two']);
});

test('parseSessionIds survives junk lines and deletion records', () => {
  const messy = [
    'not json at all',
    '',
    '{"sessionId":"s-gone","deleted":true}',           // deletion record: no workDir
    '{"sessionDir":"/h/x","workDir":"/tmp/repo"}',     // no sessionId
    '{"sessionId":"s-keep","sessionDir":"/h/y","workDir":"/tmp/repo"}',
  ].join('\n');
  assert.deepEqual(parseSessionIds(messy, '/tmp/repo'), ['s-keep']);
});

test('parseSessionIds tolerates empty input', () => {
  assert.deepEqual(parseSessionIds('', '/tmp/repo'), []);
  assert.deepEqual(parseSessionIds(null, '/tmp/repo'), []);
});

test('latestSession reads the index and returns the newest entry', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-home-'));
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), INDEX);

  assert.deepEqual(listSessionIds('/tmp/repo', home), ['s-one', 's-two']);
  assert.equal(latestSession('/tmp/repo', home), 's-two');
  assert.equal(latestSession('/tmp/nothing-here', home), null);

  fs.rmSync(home, { recursive: true, force: true });
});

test('a missing index degrades to no session rather than throwing', () => {
  // Not installed / never run: resume must fall back to `--continue`, not error.
  assert.deepEqual(listSessionIds('/tmp/repo', '/tmp/kimi-home-does-not-exist-xyz'), []);
  assert.equal(latestSession('/tmp/repo', '/tmp/kimi-home-does-not-exist-xyz'), null);
  assert.equal(latestSession('', '/tmp/kimi-home-does-not-exist-xyz'), null);
});
