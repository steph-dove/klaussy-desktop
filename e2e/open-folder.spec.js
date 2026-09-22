/* global window, document, getComputedStyle, WheelEvent, setTimeout, Date, clearTimeout */

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

// A real 4s 32x32 h264 clip with a short GOP, so the video cases can assert
// a decode AND a seek to a specific time rather than an element existing.
const MP4_TINY = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAQsbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAD6AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAA1d0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAA+gAAAIAAABAAAAAALPbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAoABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACem1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAjpzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAIABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2UlsBEAAAAMAQAAABQPEiWWAAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAC9uAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAoAAAEAAAAADBzdHNzAAAAAAAAAAgAAAABAAAABgAAAAsAAAAQAAAAFQAAABoAAAAfAAAAJAAAAEhjdHRzAAAAAAAAAAcAAAANAAAIAAAAAAEAAAwAAAAAAQAABAAAAAANAAAIAAAAAAEAAAwAAAAAAQAABAAAAAAKAAAIAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAKAAAAAEAAAC0c3RzegAAAAAAAAAAAAAAKAAABGIAAAAtAAAANgAAAD0AAAA3AAAB7wAAACkAAAA6AAAAPgAAACoAAAHpAAAAIwAAADwAAABPAAAADAAAAd0AAAAnAAAAOQAAADwAAAA5AAAB4gAAACYAAAA8AAAAOAAAADMAAAHcAAAAIgAAADkAAABRAAAADAAAAdoAAAAkAAAAOQAAADYAAAA9AAAB3AAAACEAAAA0AAAAKAAAACkAAAAUc3RjbwAAAAAAAAABAAAEXAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjMuMS4xMDEAAAAIZnJlZQAAF79tZGF0AAACqgYF//+m3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTUga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NSByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAw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',
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
    expect(out.videoWidth).toBe(32);
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

test('a video seeks to a requested time', async ({ mainWindow }) => {
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
          if ((v && v.readyState >= 1) || Date.now() > deadline) return resolve(v);
          setTimeout(poll, 150);
        })();
      });
      if (!video) return { duration: null };

      // Seeking is what needs the server to honour Range; without a 206 the
      // player reports the source unseekable and currentTime snaps back to 0.
      const seeked = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 8000);
        video.addEventListener('seeked', () => { clearTimeout(timer); resolve(true); }, { once: true });
        video.currentTime = 2.5;
      });

      return {
        duration: video.duration,
        seekable: video.seekable.length > 0 ? video.seekable.end(0) : 0,
        seeked,
        currentTime: video.currentTime,
      };
    }, folder);

    expect(out.duration).toBeGreaterThan(3);
    expect(out.seekable).toBeGreaterThan(3);
    expect(out.seeked).toBe(true);
    expect(out.currentTime).toBeGreaterThan(2);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
