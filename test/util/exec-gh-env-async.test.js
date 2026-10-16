require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');

const asyncCalls = [];
const syncCalls = [];
let gitFails = false;
let releaseGit = null;
let releaseAuth = null;
let authToken = 'tok-';

childProcess.execFile = (cmd, args, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  asyncCalls.push([cmd, ...args, opts && opts.cwd]);
  const reply = () => {
    if (cmd === 'git') {
      if (gitFails) return cb(new Error('not a git repository'));
      return cb(null, { stdout: `git@github.com:${opts.cwd.split('/').pop()}/repo.git\n`, stderr: '' });
    }
    if (cmd === 'gh' && args[0] === 'auth') return cb(null, { stdout: authToken + args[args.length - 1] + '\n', stderr: '' });
    return cb(null, { stdout: JSON.stringify({ env: opts.env.GH_TOKEN || null }), stderr: '' });
  };
  if (cmd === 'git' && releaseGit === 'hold') { releaseGit = reply; return; }
  if (cmd === 'gh' && args[0] === 'auth' && releaseAuth === 'hold') { releaseAuth = reply; return; }
  setImmediate(reply);
};
childProcess.execFileSync = (cmd, args, opts) => {
  syncCalls.push([cmd, ...args, opts && opts.cwd]);
  if (cmd === 'git') return Buffer.from(`https://github.com/${opts.cwd.split('/').pop()}/repo.git`);
  return Buffer.from('tok-' + args[args.length - 1]);
};

const { ghExecP, ghEnvForRepo, ownerFromRemoteUrl, resolveGhEnvP, clearGhTokenCache } = require('../../main/util/exec');

function count(list, cmd, cwd) {
  return list.filter((c) => c[0] === cmd && (cwd === undefined || c[c.length - 1] === cwd)).length;
}

test('ownerFromRemoteUrl reads ssh, https and GitHub Enterprise remotes', () => {
  assert.equal(ownerFromRemoteUrl('git@github.com:steph-dove/klaussy.git\n'), 'steph-dove');
  assert.equal(ownerFromRemoteUrl('https://github.com/Klaussy-Agents/repo.git'), 'Klaussy-Agents');
  assert.equal(ownerFromRemoteUrl('https://github.corp.example/team/repo'), 'team');
  assert.equal(ownerFromRemoteUrl('not a remote'), null);
  assert.equal(ownerFromRemoteUrl(undefined), null);
});

test('ghExecP resolves its token without any synchronous spawn', async () => {
  const before = syncCalls.length;
  const { stdout } = await ghExecP(['pr', 'view'], { cwd: '/wt/owner-a' });
  assert.deepEqual(JSON.parse(stdout), { env: 'tok-owner-a' });
  assert.equal(syncCalls.length, before);
});

test('repeat ghExecP calls on a worktree reuse the cached owner and token', async () => {
  await ghExecP(['pr', 'view'], { cwd: '/wt/owner-b' });
  await ghExecP(['run', 'list'], { cwd: '/wt/owner-b' });
  assert.equal(count(asyncCalls, 'git', '/wt/owner-b'), 1);
  assert.equal(asyncCalls.filter((c) => c[0] === 'gh' && c[1] === 'auth' && c[4] === 'owner-b').length, 1);
});

test('concurrent lookups for one worktree share a single git spawn', async () => {
  releaseGit = 'hold';
  const a = resolveGhEnvP({ cwd: '/wt/owner-c' });
  const b = resolveGhEnvP({ cwd: '/wt/owner-c' });
  await new Promise((r) => setImmediate(r));
  assert.equal(count(asyncCalls, 'git', '/wt/owner-c'), 1);
  releaseGit();
  releaseGit = null;
  assert.deepEqual(await a, { GH_TOKEN: 'tok-owner-c' });
  assert.deepEqual(await b, { GH_TOKEN: 'tok-owner-c' });
});

test('a worktree with no readable remote resolves to {} and retries once origin exists', async () => {
  gitFails = true;
  try {
    const authBefore = asyncCalls.filter((c) => c[0] === 'gh').length;
    assert.deepEqual(await resolveGhEnvP({ cwd: '/wt/not-a-repo' }), {});
    assert.equal(asyncCalls.filter((c) => c[0] === 'gh').length, authBefore);
  } finally {
    gitFails = false;
  }
  assert.deepEqual(await resolveGhEnvP({ cwd: '/wt/not-a-repo' }), { GH_TOKEN: 'tok-not-a-repo' });
  assert.equal(count(asyncCalls, 'git', '/wt/not-a-repo'), 2, 'a failed lookup is not cached');
});

test('the sync ghEnvForRepo reuses an owner the async path already cached', () => {
  const before = count(syncCalls, 'git');
  assert.deepEqual(ghEnvForRepo('/wt/owner-a'), { GH_TOKEN: 'tok-owner-a' });
  assert.equal(count(syncCalls, 'git'), before);
});

test('a token lookup that straddles a login does not re-cache the old token', async () => {
  clearGhTokenCache();
  await resolveGhEnvP({ cwd: '/wt/owner-d' });
  clearGhTokenCache();
  authToken = 'old-';
  releaseAuth = 'hold';
  const stale = resolveGhEnvP({ cwd: '/wt/owner-d' });
  await new Promise((r) => setImmediate(r));
  const finishStale = releaseAuth;
  releaseAuth = null;
  try {
    clearGhTokenCache();
    authToken = 'fresh-';
    assert.deepEqual(await resolveGhEnvP({ cwd: '/wt/owner-d' }), { GH_TOKEN: 'fresh-owner-d' },
      'a caller after the clear does not join the lookup that started before it');

    authToken = 'old-';
    finishStale();
    assert.deepEqual(await stale, { GH_TOKEN: 'old-owner-d' });
    authToken = 'never-';
    assert.deepEqual(await resolveGhEnvP({ cwd: '/wt/owner-d' }), { GH_TOKEN: 'fresh-owner-d' },
      'the late stale result was not written over the fresh token');
  } finally {
    authToken = 'tok-';
  }
});

test('a re-pointed origin is picked up once the 30s owner cache lapses', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await resolveGhEnvP({ cwd: '/wt/owner-e' });
  await resolveGhEnvP({ cwd: '/wt/owner-e' });
  assert.equal(count(asyncCalls, 'git', '/wt/owner-e'), 1, 'cached inside the window');
  t.mock.timers.tick(31_000);
  await resolveGhEnvP({ cwd: '/wt/owner-e' });
  assert.equal(count(asyncCalls, 'git', '/wt/owner-e'), 2, 're-read after the window');
});
