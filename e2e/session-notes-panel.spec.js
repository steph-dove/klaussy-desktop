// Task creation needs a pty, so AppState is pointed at a throwaway repo instead.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

/* global document, window */

function seedRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-panel-')));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  const dir = path.join(repo, '.git', 'klaussy-session', 'notes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude-1.md'), [
    '---',
    'agent: claude-code',
    'provider: anthropic',
    'affected_files: ["main/ipc/auth.js", "server.js"]',
    'tags: [ports, breaking_change]',
    '---',
    '# Auth port moved',
    'Mock auth server moved from 3000 to 3005. Anything pointing at 3000 needs updating.',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'gemini-2.md'), [
    '---',
    'agent: gemini',
    'provider: google',
    'tags: [schema]',
    '---',
    '# users.role is an enum now',
    'Was a free-text string; the migration lands on the feature branch.',
  ].join('\n'));
  // Neither note carries a frontmatter timestamp, so order comes from mtime.
  const now = Date.now();
  fs.utimesSync(path.join(dir, 'gemini-2.md'), new Date(now - 300000), new Date(now - 300000));
  fs.utimesSync(path.join(dir, 'claude-1.md'), new Date(now), new Date(now));
  return repo;
}

async function openNotesPanel(mainWindow, worktreePath) {
  await mainWindow.evaluate((wt) => {
    window.AppState.activeTaskId = 'qa-task';
    window.AppState.tasks.set('qa-task', { worktreePath: wt, name: 'qa' });
    // The right-hand panel is hidden until a task opens it, so reveal it directly.
    document.getElementById('diff-panel').classList.add('visible');
    document.querySelectorAll('#diff-tabs .diff-tab').forEach((t) => t.classList.remove('active'));
    const tab = document.querySelector('#diff-tabs .diff-tab[data-tab="notes"]');
    tab.classList.add('active');
    ['changes', 'pr', 'files', 'search', 'history', 'stash', 'plan'].forEach((id) => {
      const el = document.getElementById(id + '-tab-content');
      if (el) el.style.display = 'none';
    });
    document.getElementById('notes-tab-content').style.display = '';
  }, worktreePath);
  await mainWindow.evaluate(() => window.SessionNotesPanel.loadNotes());
}

test('the notes drawer renders notes written by other agents', async ({ mainWindow }) => {
  const errors = [];
  mainWindow.on('pageerror', (err) => errors.push(err.message));
  const repo = seedRepo();

  await openNotesPanel(mainWindow, repo);
  await expect(mainWindow.locator('.session-note-item')).toHaveCount(2);

  const agents = await mainWindow.locator('.session-note-agent').allTextContents();
  expect(agents).toEqual(['claude-code (anthropic)', 'gemini (google)']);

  await expect(mainWindow.locator('.session-note-body').first())
    .toContainText('Mock auth server moved from 3000 to 3005');
  await expect(mainWindow.locator('.session-note-tag').first()).toBeVisible();
  await expect(mainWindow.locator('#session-notes-dir')).toContainText('klaussy-session');

  // Eight tabs overflow a narrow panel, so the bar scrolls rather than clipping
  // a tab out of reach.
  const notesTab = mainWindow.locator('#diff-tabs .diff-tab[data-tab="notes"]');
  await expect(notesTab).toBeVisible();
  const reachable = await mainWindow.evaluate(() => {
    const bar = document.getElementById('diff-tabs');
    const tab = bar.querySelector('.diff-tab[data-tab="notes"]');
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const t = tab.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    return t.right <= b.right + 1 && t.left >= b.left - 1;
  });
  expect(reachable, 'the Notes tab cannot be scrolled into view').toBe(true);
  await notesTab.click();

  await mainWindow.screenshot({ path: 'e2e-artifacts/session-notes-panel.png' });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the drawer explains itself when there are no notes', async ({ mainWindow }) => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-empty-')));
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe' });

  await openNotesPanel(mainWindow, repo);

  await expect(mainWindow.locator('.session-note-item')).toHaveCount(0);
  await expect(mainWindow.locator('#session-notes-list'))
    .toContainText('No active session notes');
  await expect(mainWindow.locator('#btn-session-notes-clear')).toBeDisabled();

  await mainWindow.screenshot({ path: 'e2e-artifacts/session-notes-empty.png' });
});
