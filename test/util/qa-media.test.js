require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { findQaMediaFiles } = require('../../main/ipc/files');

test('findQaMediaFiles: discovers screenshots in e2e-artifacts and Downloads', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-qa-test-'));
  const worktreeDir = path.join(tempRoot, 'my-repo');
  const e2eDir = path.join(worktreeDir, 'e2e-artifacts');
  const srcAssetsDir = path.join(worktreeDir, 'src', 'assets');
  const downloadsDir = path.join(os.homedir(), 'Downloads', 'my-repo-feat-test');

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

    const names = results.map(r => r.name).sort();
    assert.deepEqual(names, ['01-login-screen.png', '02-checkout-success.png', 'flow-recording.mp4']);

    const video = results.find(r => r.name === 'flow-recording.mp4');
    assert.equal(video.type, 'video');

    const image = results.find(r => r.name === '01-login-screen.png');
    assert.equal(image.type, 'image');
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
  const worktreeDir = path.join(tempRoot, 'my-feature-repo');
  const downloadsDir = path.join(os.homedir(), 'Downloads', 'klaussy-qa-new-feature');

  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });

  fs.writeFileSync(path.join(downloadsDir, '01-feature-loaded.png'), 'png');
  fs.writeFileSync(path.join(downloadsDir, 'walkthrough.mp4'), 'mp4');

  try {
    const results = await findQaMediaFiles(worktreeDir);
    const names = results.map(r => r.name).sort();
    assert.deepEqual(names, ['01-feature-loaded.png', 'walkthrough.mp4']);
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

