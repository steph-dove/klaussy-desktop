/* global window, document, MutationObserver */
// These are used inside page.evaluate callbacks (renderer context); the e2e
// eslint override is node-only.
//
// Live artifact/preview pane: HTML/SVG in a sandboxed iframe, Markdown inline,
// refreshing on save and external writes. Needs a real worktree for layout +
// file-root access (same setup shape as ui-diff-tabs.spec.js).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

const HTML = '<!doctype html><html><body><h1 id="hi">Hello Artifact</h1></body></html>';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>';
const MD = '# Heading One\n\nSome **bold** text.\n';

function buildBaseRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-artifact-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'README.md'), '# base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

// Create a task/worktree, open the diff panel against it, and start the file
// watcher. Returns the worktree path and a cleanup fn.
async function openWorktree(win) {
  await suppressOllamaOverlay(win);
  const repo = buildBaseRepo();
  const taskName = `artifact-${process.pid}-${Date.now()}`;
  const sessionDir = path.join(os.homedir(), 'klaussy', 'sessions', taskName);
  const worktree = path.join(sessionDir, path.basename(repo));

  const result = await win.evaluate(
    ({ name, repoPath }) => window.klaus.task.create(name, repoPath, 'shell'),
    { name: taskName, repoPath: repo },
  );
  expect(result.error, `create-task error: ${result.error}`).toBeFalsy();

  await win.evaluate((wt) => window.DiffPanel.show(wt), result.worktreePath);
  await expect(win.locator('#diff-panel')).toBeVisible();
  await win.evaluate((wt) => window.klaus.fs.watchWorktree(wt), result.worktreePath);

  const cleanup = async () => {
    await win.evaluate((wt) => window.klaus.fs.unwatchWorktree(wt), result.worktreePath).catch(() => {});
    await win.evaluate((id) => window.klaus.task.kill(id), result.id).catch(() => {});
    try { execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repo, stdio: 'pipe' }); } catch {}
    try { execFileSync('git', ['branch', '-D', taskName], { cwd: repo, stdio: 'pipe' }); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  };
  return { worktree: result.worktreePath, cleanup };
}

// The Ollama consent modal pops asynchronously in a fresh CI profile and, as a
// full-screen overlay, swallows every click.
async function suppressOllamaOverlay(win) {
  await win.evaluate(() => {
    const kill = () => {
      const o = document.getElementById('ollama-consent-overlay');
      if (o) o.remove();
    };
    kill();
    new MutationObserver(kill).observe(document.documentElement, { childList: true, subtree: true });
  });
}

async function openInViewer(win, filePath, name) {
  await win.evaluate(({ p, n }) => window.openFileViewer(p, n), { p: filePath, n: name });
  await win.waitForSelector('.file-viewer-split-btn', { state: 'visible' });
}

test.describe('artifact preview', () => {
  test('classify recognizes html/svg/markdown and rejects others', async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    const got = await mainWindow.evaluate(() => ({
      html: window.ArtifactPreview.classify('a.html'),
      svg: window.ArtifactPreview.classify('a.svg'),
      md: window.ArtifactPreview.classify('a.md'),
      js: window.ArtifactPreview.classify('a.js'),
    }));
    expect(got).toEqual({ html: 'html', svg: 'svg', md: 'markdown', js: null });
  });

  test('HTML renders in a sandboxed iframe; toggling off tears it down', async ({ mainWindow }) => {
    await expect(mainWindow.locator('#btn-new-task')).toBeVisible();
    const { worktree, cleanup } = await openWorktree(mainWindow);
    try {
      const htmlPath = path.join(worktree, 'artifact.html');
      fs.writeFileSync(htmlPath, HTML);
      await openInViewer(mainWindow, htmlPath, 'artifact.html');

      const splitBtn = mainWindow.locator('.file-viewer-split-btn');
      await expect(splitBtn).toBeVisible();
      await splitBtn.click();

      const frame = mainWindow.locator('.file-artifact-preview iframe.artifact-iframe');
      await expect(frame).toBeVisible();
      // Sandboxed to scripts only — never allow-same-origin, which would let
      // the artifact reach the app's origin and defeat the isolation.
      await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
      expect(await frame.getAttribute('srcdoc')).toContain('Hello Artifact');

      await splitBtn.click();
      await expect(frame).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });

  test('SVG renders wrapped in the iframe; Markdown renders inline', async ({ mainWindow }) => {
    await expect(mainWindow.locator('#btn-new-task')).toBeVisible();
    const { worktree, cleanup } = await openWorktree(mainWindow);
    try {
      const svgPath = path.join(worktree, 'icon.svg');
      fs.writeFileSync(svgPath, SVG);
      await openInViewer(mainWindow, svgPath, 'icon.svg');
      await mainWindow.locator('.file-viewer-split-btn').click();

      const frame = mainWindow.locator('.file-artifact-preview iframe.artifact-iframe');
      await expect(frame).toBeVisible();
      const srcdoc = await frame.getAttribute('srcdoc');
      expect(srcdoc).toContain('<svg');
      expect(srcdoc).toContain('align-items:center'); // centering wrapper

      const mdPath = path.join(worktree, 'doc.md');
      fs.writeFileSync(mdPath, MD);
      await openInViewer(mainWindow, mdPath, 'doc.md');
      await mainWindow.locator('.file-viewer-split-btn').click();

      const pane = mainWindow.locator('.file-artifact-preview.artifact-markdown');
      await expect(pane).toBeVisible();
      await expect(pane.locator('h1')).toHaveText('Heading One');
      await expect(pane.locator('strong')).toHaveText('bold');
      // Markdown renders as inline sanitized HTML, not an iframe.
      await expect(mainWindow.locator('.file-artifact-preview iframe')).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });

  test('preview refreshes on save and on external write', async ({ mainWindow }) => {
    await expect(mainWindow.locator('#btn-new-task')).toBeVisible();
    const { worktree, cleanup } = await openWorktree(mainWindow);
    try {
      const htmlPath = path.join(worktree, 'live.html');
      fs.writeFileSync(htmlPath, HTML);
      await openInViewer(mainWindow, htmlPath, 'live.html');
      await mainWindow.locator('.file-viewer-split-btn').click();

      const frame = mainWindow.locator('.file-artifact-preview iframe.artifact-iframe');
      await expect(frame).toHaveAttribute('srcdoc', /Hello Artifact/);

      // (1) Save path: edit through the model API (avoids flaky Monaco DOM
      // typing), then Save. The preview reflects the saved buffer.
      await mainWindow.evaluate(async (p) => {
        const monaco = await window.MonacoReady;
        const target = monaco.Uri.file(p).toString();
        const model = monaco.editor.getModels().find((m) => m.uri.toString() === target);
        model.setValue('<!doctype html><body><h1>Saved Artifact</h1></body>');
      }, htmlPath);
      await mainWindow.locator('.file-viewer-save-btn').click();
      await expect(frame).toHaveAttribute('srcdoc', /Saved Artifact/);

      // (2) External-write path: an agent rewrites the file on disk. The
      // watcher reloads the clean buffer and the preview follows.
      fs.writeFileSync(htmlPath, '<!doctype html><body><h1>Agent Wrote This</h1></body>');
      await expect(frame).toHaveAttribute('srcdoc', /Agent Wrote This/, { timeout: 15000 });
    } finally {
      await cleanup();
    }
  });
});
