/* global window, document, getComputedStyle */

// "Open a directory" mode: a plain folder is not a git repo and is never
// recorded as a project, so these cover the things that broke because of it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('./fixtures');

// A 1x1 transparent PNG — enough for the viewer to render something real.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function buildPlainFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-plain-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Notes\n\nhello\n');
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'plain text\n');
  fs.writeFileSync(path.join(dir, 'shot.png'), PNG_1PX);
  return dir;
}

test('a plain folder stays readable after its task is gone', async ({ mainWindow }) => {
  const folder = buildPlainFolder();
  try {
    const out = await mainWindow.evaluate(async (f) => {
      const opened = await window.klaus.task.openFolder(f, 'shell');
      const listed = await window.klaus.fs.listFiles(f);
      // The tree lists files ungated; closing the task used to revoke the
      // folder's only path-gate root.
      await window.klaus.task.kill(opened.id);
      const reads = {};
      for (const rel of (listed.files || [])) {
        reads[rel] = await window.klaus.fs.readFile(f + '/' + rel);
      }
      return { listed, reads };
    }, folder);

    expect(out.listed.files.sort()).toEqual(['README.md', 'shot.png', 'sub/a.txt']);
    for (const [rel, r] of Object.entries(out.reads)) {
      expect(r.error, `${rel} should still be readable`).toBeFalsy();
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('opening a single file opens its parent folder and names the file', async ({ mainWindow }) => {
  const folder = buildPlainFolder();
  try {
    const result = await mainWindow.evaluate(
      (f) => window.klaus.task.openFolder(f + '/README.md', 'shell'),
      folder,
    );
    expect(result.error).toBeFalsy();
    expect(result.worktreePath).toBe(folder);
    expect(result.openFile).toBe(folder + '/README.md');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('images resolve to a media url; text files do not', async ({ mainWindow }) => {
  const folder = buildPlainFolder();
  try {
    const out = await mainWindow.evaluate(async (f) => {
      await window.klaus.task.openFolder(f, 'shell');
      return {
        png: await window.klaus.fs.mediaUrl(f + '/shot.png'),
        txt: await window.klaus.fs.mediaUrl(f + '/sub/a.txt'),
        outside: await window.klaus.fs.mediaUrl('/etc/hosts'),
      };
    }, folder);

    expect(out.png.error).toBeFalsy();
    expect(out.png.url).toMatch(/^klaussy-qa:\/\//);
    expect(out.txt.error).toBe('not a previewable image');
    // The media scheme must not become a way around the path gate.
    expect(out.outside.error).toBe('path not under an allowed project root');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('the renderer cannot add a path-gate root through recent-paths', async ({ mainWindow }) => {
  // path-gate counts recentPaths.folders as allowed roots, so if the renderer
  // could append to that list it could vouch for any path on disk and read it.
  const out = await mainWindow.evaluate(async () => {
    const added = await window.klaus.repo.recentPathsAdd('folders', '/');
    return {
      added,
      root: await window.klaus.fs.readFile('/etc/hosts'),
      media: await window.klaus.fs.mediaUrl('/etc/hosts'),
    };
  });

  expect(out.added.ok).toBe(false);
  expect(out.root.error).toBe('path not under an allowed project root');
  expect(out.media.error).toBe('path not under an allowed project root');
});

test('the viewer renders an image instead of mojibake', async ({ mainWindow }) => {
  const folder = buildPlainFolder();
  try {
    const out = await mainWindow.evaluate(async (f) => {
      const opened = await window.klaus.task.openFolder(f, 'shell');
      // The viewer reads the active task for its worktree, so make it active.
      if (window.App && window.App.addTaskToUI) {
        window.App.addTaskToUI(opened);
        window.App.switchToTask(opened.id);
      }
      await window.openFileViewer(f + '/shot.png', 'shot.png');
      // Give the async tab creation a beat to land in the DOM.
      await new Promise((r) => setTimeout(r, 1500));
      const body = document.querySelector('.file-viewer-body');
      const img = document.querySelector('.file-media-preview img');
      return {
        mediaMode: !!(body && body.classList.contains('media-mode')),
        imgSrc: img ? img.getAttribute('src') : null,
        naturalWidth: img ? img.naturalWidth : null,
      };
    }, folder);

    expect(out.mediaMode).toBe(true);
    expect(out.imgSrc).toMatch(/^klaussy-qa:\/\//);
    // naturalWidth > 0 means the privileged scheme actually served the bytes.
    expect(out.naturalWidth).toBe(1);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('markdown in a folder gets its Preview toggle and renders', async ({ mainWindow }) => {
  const folder = buildPlainFolder();
  try {
    const out = await mainWindow.evaluate(async (f) => {
      const opened = await window.klaus.task.openFolder(f, 'shell');
      if (window.App && window.App.addTaskToUI) {
        window.App.addTaskToUI(opened);
        window.App.switchToTask(opened.id);
      }
      await window.openFileViewer(f + '/README.md', 'README.md');
      await new Promise((r) => setTimeout(r, 1500));
      const btn = document.querySelector('.file-viewer-preview-btn');
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      const preview = document.querySelector('.file-md-preview');
      const media = document.querySelector('.file-media-preview');
      return {
        btnHidden: btn.hidden,
        previewHtml: preview ? preview.innerHTML : '',
        // Computed, not the attribute: an author `display` overrides [hidden],
        // which is exactly how the image pane came to sit on every tab.
        mediaDisplay: media ? getComputedStyle(media).display : null,
        bodyHasMediaMode: document
          .querySelector('.file-viewer-body')
          .classList.contains('media-mode'),
      };
    }, folder);

    expect(out.btnHidden).toBe(false);
    expect(out.previewHtml).toContain('<h1');
    expect(out.previewHtml).toContain('Notes');
    expect(out.bodyHasMediaMode).toBe(false);
    expect(out.mediaDisplay).toBe('none');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
