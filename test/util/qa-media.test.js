require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { findQaMediaFiles } = require('../../main/ipc/files');

// QA folders are named after the branch, so the fixture needs a real branch.
function makeRepo(dir, branch) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

function downloads(name) {
  return path.join(os.homedir(), 'Downloads', name);
}

test('findQaMediaFiles: discovers screenshots in e2e-artifacts and Downloads', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-qa-test-'));
  const worktreeDir = makeRepo(path.join(tempRoot, 'my-repo'), 'feat-test');
  const e2eDir = path.join(worktreeDir, 'e2e-artifacts');
  const srcAssetsDir = path.join(worktreeDir, 'src', 'assets');
  const downloadsDir = downloads('my-repo-feat-test');

  fs.mkdirSync(e2eDir, { recursive: true });
  fs.mkdirSync(srcAssetsDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });

  fs.writeFileSync(path.join(e2eDir, '01-login-screen.png'), 'fake-png-data');
  fs.writeFileSync(path.join(e2eDir, 'flow-recording.mp4'), 'fake-video-data');
  fs.writeFileSync(path.join(downloadsDir, '02-checkout-success.png'), 'fake-png-data-2');

  // General non-QA assets that MUST be excluded
  fs.writeFileSync(path.join(worktreeDir, 'brand-mark.png'), 'logo-data');
  fs.writeFileSync(path.join(worktreeDir, 'icon.svg'), 'svg-icon');
  fs.writeFileSync(path.join(srcAssetsDir, 'button-bg.png'), 'bg-data');

  try {
    const results = await findQaMediaFiles(worktreeDir);

    const names = results.map((r) => r.name).sort();
    assert.deepEqual(names, ['01-login-screen.png', '02-checkout-success.png', 'flow-recording.mp4']);

    assert.equal(results.find((r) => r.name === 'flow-recording.mp4').type, 'video');
    assert.equal(results.find((r) => r.name === '01-login-screen.png').type, 'image');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  }
});

test('findQaMediaFiles: ignores svg icons and project static assets', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-qa-assets-'));
  const worktreeDir = path.join(tempRoot, 'my-app');
  const publicDir = path.join(worktreeDir, 'public');

  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, 'icon.svg'), '<svg></svg>');
  fs.writeFileSync(path.join(worktreeDir, 'favicon.ico'), 'ico');
  fs.writeFileSync(path.join(publicDir, 'banner.jpg'), 'jpg');

  try {
    const results = await findQaMediaFiles(worktreeDir);
    assert.equal(results.length, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('findQaMediaFiles: detects root screenshots matching QA naming pattern', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-qa-root-'));
  const worktreeDir = path.join(tempRoot, 'my-app');
  fs.mkdirSync(worktreeDir, { recursive: true });

  fs.writeFileSync(path.join(worktreeDir, 'qa-screenshot-dashboard.png'), 'img');
  fs.writeFileSync(path.join(worktreeDir, 'random-image.png'), 'img');

  try {
    const results = await findQaMediaFiles(worktreeDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'qa-screenshot-dashboard.png');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('findQaMediaFiles: discovers screenshots in Downloads/klaussy-qa-<branch>', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-qa-branch-'));
  const worktreeDir = makeRepo(path.join(tempRoot, 'my-feature-repo'), 'new-feature');
  const downloadsDir = downloads('klaussy-qa-new-feature');

  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.writeFileSync(path.join(downloadsDir, '01-feature-loaded.png'), 'png');
  fs.writeFileSync(path.join(downloadsDir, 'walkthrough.mp4'), 'mp4');

  try {
    const results = await findQaMediaFiles(worktreeDir);
    const names = results.map((r) => r.name).sort();
    assert.deepEqual(names, ['01-feature-loaded.png', 'walkthrough.mp4']);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  }
});

test('findQaMediaFiles: another branch QA folder is not picked up', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-qa-sibling-'));
  const worktreeDir = makeRepo(path.join(tempRoot, 'my-repo'), 'feat-mine');
  const mine = downloads('my-repo-feat-mine');
  const theirs = downloads('my-repo-feat-theirs');
  const looseKlaussy = downloads('klaussy-qa-some-other-branch');

  for (const d of [mine, theirs, looseKlaussy]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(mine, 'mine.png'), 'png');
  fs.writeFileSync(path.join(theirs, 'theirs.png'), 'png');
  fs.writeFileSync(path.join(looseKlaussy, 'unrelated.png'), 'png');

  try {
    const results = await findQaMediaFiles(worktreeDir);
    assert.deepEqual(results.map((r) => r.name), ['mine.png']);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    for (const d of [mine, theirs, looseKlaussy]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('findQaMediaFiles: media older than the branch is left behind', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-qa-stale-'));
  const worktreeDir = makeRepo(path.join(tempRoot, 'my-repo'), 'feat-reused');
  const downloadsDir = downloads('my-repo-feat-reused');

  fs.mkdirSync(downloadsDir, { recursive: true });
  const stale = path.join(downloadsDir, 'last-run.png');
  const fresh = path.join(downloadsDir, 'this-run.png');
  fs.writeFileSync(stale, 'png');
  fs.writeFileSync(fresh, 'png');

  // Same folder, same branch name, but from a session a week ago.
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  fs.utimesSync(stale, weekAgo / 1000, weekAgo / 1000);

  try {
    const results = await findQaMediaFiles(worktreeDir);
    assert.deepEqual(results.map((r) => r.name), ['this-run.png']);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  }
});

test('findQaMediaFiles: handles null or empty worktree gracefully', async () => {
  const r1 = await findQaMediaFiles(null);
  assert.deepEqual(r1, []);

  const r2 = await findQaMediaFiles('');
  assert.deepEqual(r2, []);
});
