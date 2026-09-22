/* global window, document, getComputedStyle, WheelEvent, setTimeout, Date */

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

// A real 16x16 h264 clip, so the video case can assert it actually decoded
// rather than that an element exists with a src.
const MP4_TINY = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAN0bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAMgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAp90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAADIAAAEAAABAAAAAAIXbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAACgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABwm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAYJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAMg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAHcQAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAFAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAOGN0dHMAAAAAAAAABQAAAAEAAAQAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAUAAAABAAAAKHN0c3oAAAAAAAAAAAAAAAUAAALKAAAADAAAAAwAAAAMAAAADAAAABRzdGNvAAAAAAAAAAEAAAOkAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMQAAAAhmcmVlAAADAm1kYXQAAAKuBgX//6rcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MjUgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAUZYiEADP//t8y+BTNxYnOzIBcnpcAAAAIQZokbEK//sAAAAAIQZ5CeIX/wYEAAAAIAZ5hdEK/xIAAAAAIAZ5jakK/xIE=',
  'base64',
);

function buildPlainFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-plain-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Notes\n\nhello\n');
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'plain text\n');
  fs.writeFileSync(path.join(dir, 'shot.png'), PNG_1PX);
  fs.writeFileSync(path.join(dir, 'clip.mp4'), MP4_TINY);
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

    expect(out.listed.files.sort()).toEqual(['README.md', 'clip.mp4', 'shot.png', 'sub/a.txt']);
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
    expect(out.txt.error).toBe('not a previewable image or video');
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

test('a video plays in the viewer instead of reaching Monaco', async ({ mainWindow }) => {
  const folder = buildPlainFolder();
  try {
    const out = await mainWindow.evaluate(async (f) => {
      const opened = await window.klaus.task.openFolder(f, 'shell');
      if (window.App && window.App.addTaskToUI) {
        window.App.addTaskToUI(opened);
        window.App.switchToTask(opened.id);
      }
      await window.openFileViewer(f + '/clip.mp4', 'clip.mp4');
      const video = await new Promise((resolve) => {
        const deadline = Date.now() + 8000;
        (function poll() {
          const v = document.querySelector('.file-media-preview video');
          // readyState >= 1 means metadata decoded, so the privileged scheme
          // really served playable bytes.
          if ((v && v.readyState >= 1) || Date.now() > deadline) return resolve(v);
          setTimeout(poll, 150);
        })();
      });
      return {
        hasVideo: !!video,
        videoWidth: video ? video.videoWidth : null,
        controls: video ? video.controls : null,
        editorText: (document.querySelector('.file-editor-monaco') || {}).textContent || '',
      };
    }, folder);

    expect(out.hasVideo).toBe(true);
    expect(out.videoWidth).toBe(16);
    expect(out.controls).toBe(true);
    expect(out.editorText).not.toContain('ftyp');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('an image zooms and the status bar tracks it', async ({ mainWindow }) => {
  const folder = buildPlainFolder();
  try {
    const out = await mainWindow.evaluate(async (f) => {
      const opened = await window.klaus.task.openFolder(f, 'shell');
      if (window.App && window.App.addTaskToUI) {
        window.App.addTaskToUI(opened);
        window.App.switchToTask(opened.id);
      }
      await window.openFileViewer(f + '/shot.png', 'shot.png');
      await new Promise((r) => setTimeout(r, 1500));
      const img = document.querySelector('.file-media-preview img');
      const label = document.querySelector('.statusbar-zoom');
      const fit = { zoomed: img.classList.contains('zoomed'), label: label.textContent };

      img.click(); // fit -> 100%
      const actual = { zoomed: img.classList.contains('zoomed'), label: label.textContent };

      const pane = document.querySelector('.file-media-preview');
      pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
      const zoomedIn = { width: img.style.width, label: label.textContent };

      img.click(); // back to fit
      return { fit, actual, zoomedIn, backToFit: label.textContent };
    }, folder);

    expect(out.fit).toEqual({ zoomed: false, label: 'Fit' });
    expect(out.actual).toEqual({ zoomed: true, label: '100%' });
    expect(out.zoomedIn.label).toBe('110%');
    expect(out.zoomedIn.width).toBe('1.1px'); // a 1px source at 1.1x
    expect(out.backToFit).toBe('Fit');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
