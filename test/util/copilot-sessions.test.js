require('../setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cs = require('../../main/util/copilot-sessions');
const { getProvider } = require('../../main/state/ai-providers');
const { samePath } = require('../../main/util/platform');

function stateDir(sessions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-state-'));
  for (const s of sessions) {
    fs.mkdirSync(path.join(dir, s.id));
    fs.writeFileSync(path.join(dir, s.id, 'workspace.yaml'), `id: ${s.id}\ncwd: ${s.cwd}\nupdated_at: ${s.updated}\n`);
    if (s.events !== false) fs.writeFileSync(path.join(dir, s.id, 'events.jsonl'), '{}\n');
  }
  return dir;
}

test('latestSession: newest session started in this worktree, not the newest overall', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  const dir = stateDir([
    { id: 'old', cwd: wt, updated: '2026-01-01T00:00:00Z' },
    { id: 'mine', cwd: wt, updated: '2026-02-01T00:00:00Z' },
    { id: 'elsewhere', cwd: '/some/other/repo', updated: '2026-03-01T00:00:00Z' },
    { id: 'declined', cwd: wt, updated: '2026-04-01T00:00:00Z', events: false },
  ]);
  assert.equal(cs.latestSession(wt, dir), 'mine');
  assert.equal(cs.latestSession('/nowhere', dir), null);
});

test('findNewSession: skips sessions that existed before the spawn', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  const dir = stateDir([{ id: 'before', cwd: wt, updated: '2026-01-01T00:00:00Z' }]);
  const pre = cs.snapshotSessionIds(dir);
  assert.equal(cs.findNewSession(wt, pre, dir), null);
  fs.mkdirSync(path.join(dir, 'after'));
  fs.writeFileSync(path.join(dir, 'after', 'workspace.yaml'), `id: after\ncwd: ${wt}\nupdated_at: 2026-01-02T00:00:00Z\n`);
  fs.writeFileSync(path.join(dir, 'after', 'events.jsonl'), '{}\n');
  assert.equal(cs.findNewSession(wt, pre, dir).sessionId, 'after');
});

test('yamlScalar: reads quoted paths', () => {
  assert.equal(cs.yamlScalar('cwd: "/a b/c: d"\n', 'cwd'), '/a b/c: d');
  assert.equal(cs.yamlScalar("cwd: '/it''s'\n", 'cwd'), "/it's");
});

// `--continue` resumes Copilot's newest session from any directory.
test('copilot: never falls back to --continue', () => {
  const p = getProvider('copilot');
  assert.equal(p.buildInteractiveCmd('copilot', { resumeLatest: true }), 'copilot');
  assert.equal(p.buildInteractiveCmd('copilot', { resumeSessionId: 'abc' }), 'copilot --resume=abc');
});

test('samePath: Windows paths match regardless of case', () => {
  assert.equal(samePath('c:\\Users\\Me\\repo', 'C:\\users\\me\\Repo', 'win32'), true);
  assert.equal(samePath('C:\\Users\\me\\repo', 'C:\\Users\\me\\other', 'win32'), false);
  assert.equal(samePath('/Users/me/Repo', '/Users/me/repo', 'linux'), false);
});
