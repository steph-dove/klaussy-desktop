require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');

const providers = require('../../main/state/ai-providers');
const agy = providers.getProvider('antigravity');

const WT_A = path.resolve('/wt/a');
const A_URI = pathToFileURL(WT_A).href;
const B_URI = pathToFileURL(path.resolve('/wt/b')).href;

// The provider resolves its store under $HOME, so a temp home gives each test a
// conversation store of its own.
function withStore(rows, fn) {
  const prev = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
  const dir = path.join(home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
  if (rows) {
    const db = new DatabaseSync(path.join(dir, 'conversation_summaries.db'));
    db.exec('create table conversation_summaries (conversation_id text, workspace_uris text, last_modified_time text)');
    const insert = db.prepare('insert into conversation_summaries values (?, ?, ?)');
    for (const r of rows) insert.run(r.id, JSON.stringify(r.workspaces), r.at);
    db.close();
  }
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// agy reattaches to a workspace's existing conversation, so the id cannot be
// spotted as a file that appeared after spawn — it comes from the workspace.
test('the conversation is the one recorded against this worktree', () => {
  withStore([
    { id: 'other-conv', workspaces: [B_URI], at: '2026-08-24 10:00:00+00:00' },
    { id: 'mine-conv', workspaces: [A_URI], at: '2026-08-24 09:00:00+00:00' },
  ], () => {
    const found = agy.findNewSession(WT_A, new Set());
    assert.equal(found.sessionId, 'mine-conv');
    assert.match(found.filePath, /conversations[\\/]mine-conv\.db$/);
  });
});

test('the most recent conversation wins when a worktree has several', () => {
  withStore([
    { id: 'stale', workspaces: [A_URI], at: '2026-08-20 10:00:00+00:00' },
    { id: 'current', workspaces: [A_URI], at: '2026-08-24 10:00:00+00:00' },
  ], () => {
    assert.equal(agy.findNewSession(WT_A, new Set()).sessionId, 'current');
  });
});

test('a worktree agy has never run in has no conversation', () => {
  withStore([{ id: 'c', workspaces: [B_URI], at: '2026-08-24 10:00:00+00:00' }], () => {
    assert.equal(agy.findNewSession(WT_A, new Set()), null);
  });
});

// agy may not be installed at all, and its store is written while it runs.
test('an absent or unreadable store yields no session rather than throwing', () => {
  withStore(null, () => {
    assert.equal(agy.findNewSession(WT_A, new Set()), null);
  });
});

test('a multi-workspace conversation matches on any of its roots', () => {
  withStore([
    { id: 'multi', workspaces: [B_URI, A_URI], at: '2026-08-24 10:00:00+00:00' },
  ], () => {
    assert.equal(agy.findNewSession(WT_A, new Set()).sessionId, 'multi');
  });
});

test('--conversation resumes an exact id, --continue is the fallback', () => {
  assert.match(agy.buildInteractiveCmd('agy', { resumeSessionId: 'abc' }), /--conversation abc/);
  assert.match(agy.buildInteractiveCmd('agy', { resumeLatest: true }), /--continue/);
  const fresh = agy.buildInteractiveCmd('agy', {});
  assert.doesNotMatch(fresh, /--conversation|--continue/);
});
