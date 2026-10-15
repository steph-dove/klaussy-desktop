require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');

let syncSpawns = 0;
childProcess.execFileSync = () => { syncSpawns++; throw new Error('sync spawn on the main process'); };
childProcess.execFile = (cmd, args, opts, cb) => {
  if (typeof opts === 'function') cb = opts;
  const err = new Error('gh failed');
  err.stdout = '';
  err.stderr = 'Logged in to github.com account steph-dove (keyring)';
  setImmediate(() => cb(err));
};

const { prForBranch } = require('../../main/util/pr-for-branch');

function fakeGh(responses) {
  const calls = [];
  const gh = async (args, opts) => {
    calls.push({ args, opts });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { stdout: next, stderr: '' };
  };
  return { gh, calls };
}

function ghError(stderr) {
  const err = new Error('Command failed: gh');
  err.stderr = stderr;
  return err;
}

test('a checked-out PR is looked up by number against its base repo', async () => {
  const { gh, calls } = fakeGh([JSON.stringify({ number: 7 })]);
  const result = await prForBranch('/wt', { hint: { prNumber: 7, prBaseOwner: 'up', prBaseRepo: 'stream' }, gh });
  assert.deepEqual(result, { pr: { number: 7 } });
  assert.deepEqual(calls[0].args.slice(0, 3), ['pr', 'view', '7']);
  assert.deepEqual(calls[0].args.slice(-2), ['-R', 'up/stream']);
  assert.equal(calls[0].opts.cwd, '/wt');
});

test('a failed hinted lookup falls back to branch matching', async () => {
  const { gh, calls } = fakeGh([ghError('could not find pull request'), JSON.stringify({ number: 9 })]);
  const result = await prForBranch('/wt', { hint: { prNumber: 7 }, gh });
  assert.deepEqual(result, { pr: { number: 9 } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.slice(0, 3), ['pr', 'view', '--json']);
});

test('a branch with no PR is a plain null, not an error', async () => {
  const { gh } = fakeGh([ghError('no pull requests found for branch "x"')]);
  assert.deepEqual(await prForBranch('/wt', { hint: null, gh }), { pr: null });
});

test('an auth failure is classified without a synchronous gh call', async () => {
  const { gh } = fakeGh([ghError('HTTP 401: Bad credentials')]);
  const before = syncSpawns;
  const result = await prForBranch('/wt', { hint: null, gh });
  assert.equal(result.pr, null);
  assert.equal(result.errorKind, 'auth');
  assert.match(result.error, /steph-dove/);
  assert.equal(result.errorFix, 'gh auth login');
  assert.equal(syncSpawns, before);
});

test('garbage output and a timeout both resolve to an error shape instead of rejecting', async () => {
  const garbled = await prForBranch('/wt', { hint: null, gh: fakeGh(['not json']).gh });
  assert.equal(garbled.pr, null);
  assert.ok(garbled.error);

  const timedOut = new Error('spawn gh ETIMEDOUT');
  const timeout = await prForBranch('/wt', { hint: null, gh: fakeGh([timedOut]).gh });
  assert.equal(timeout.pr, null);
  assert.equal(timeout.errorKind, 'network');
});
