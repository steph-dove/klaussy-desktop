// Agent-backed editor/diff AI features driven through a FAKE agent CLI.
// Both window.klaus.ai.* surfaces here spawn the default provider (claude) via
// spawnClaudeStream in text mode — outputMode 'passthrough', so the fake's raw
// stdout is streamed verbatim to the renderer as chunks. We point claudePath at
// the fake (binFor reads config at spawn time) and tag its output via
// FAKE_AGENT_OUTPUT so we can assert the agent's text actually lands in the UI:
//   (1) commit message — Changes tab → ✨ #btn-claude-commit-msg → #commit-message
//   (2) explain-diff   — select diff text → Explain FAB → .diff-explanation-body
// Proves the agent-spawn → stream → render path for both features without a real
// Claude CLI. (No assertion on prompt fidelity — the fake ignores its args.)

const os = require('os');
const { test, expect } = require('./fixtures');
const { buildRepo, makeBinDir, writeFakeAgent, git, rm } = require('./helpers');

// Static at collection time (extraEnv is read when the spec is loaded). The
// fake agent echoes this after its FAKE-AGENT-READY banner; we match on it so a
// stray banner from some other path can't pass the assertion.
const TAG = `FAKE-AI-${process.pid}`;
test.use({ extraEnv: { FAKE_AGENT_OUTPUT: TAG } });

test('✨ commit message: fake agent output streams into #commit-message', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();

  const repo = buildRepo({ 'a.txt': 'one\n' }, 'commitmsg');
  const binDir = makeBinDir();
  const fakeAgent = writeFakeAgent(binDir, 'claude');

  try {
    // Stage a real change so `git diff --cached` (read by the handler) is non-empty.
    git(repo, 'config', 'user.email', 'e2e@klaussy.test');
    git(repo, 'config', 'user.name', 'e2e');
    require('fs').writeFileSync(repo + '/a.txt', 'one\ntwo\n');
    git(repo, 'add', 'a.txt');

    // binFor / defaultAgentProvider both read config at spawn time.
    await mainWindow.evaluate((p) => window.klaus.ui.setPreferences({ claudePath: p, defaultProvider: 'claude' }), fakeAgent);

    // Open the diff panel on the repo and reveal the commit area, then drive the
    // real sparkle button.
    await mainWindow.evaluate((wt) => window.DiffPanel.show(wt), repo);
    await expect(mainWindow.locator('#diff-panel')).toHaveClass(/visible/);

    await mainWindow.locator('#btn-commit').click();
    await expect(mainWindow.locator('#commit-area')).toBeVisible();

    await mainWindow.locator('#btn-claude-commit-msg').click();

    await expect
      .poll(() => mainWindow.locator('#commit-message').inputValue(), { timeout: 15000 })
      .toContain(TAG);
    const value = await mainWindow.locator('#commit-message').inputValue();
    expect(value, `commit message:\n${value}`).toContain('FAKE-AGENT-READY claude');
  } finally {
    rm(repo);
    rm(binDir);
  }
});

test('explain-diff: selecting diff text + Explain streams the agent output inline', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();

  const repo = buildRepo({ 'app.js': 'const x = 1;\nconst y = 2;\nconst z = 3;\n' }, 'explain');
  const binDir = makeBinDir();
  const fakeAgent = writeFakeAgent(binDir, 'claude');

  try {
    // Unstaged modification → a real working-tree diff to render and select.
    require('fs').writeFileSync(repo + '/app.js', 'const x = 1;\nconst y = 22;\nconst z = 3;\n');

    await mainWindow.evaluate((p) => window.klaus.ui.setPreferences({ claudePath: p, defaultProvider: 'claude' }), fakeAgent);

    // Reveal the panel and populate the file list WITHOUT DiffPanel.show() — that
    // path installs an fs watcher whose refresh can re-render #diff-view during
    // explain setup and orphan the inline explanation element. refresh() alone
    // binds the file-list clicks and starts no watcher/interval.
    await mainWindow.evaluate((wt) => {
      window.DiffPanel.currentWorktreePath = wt;
      window.DiffPanel.panelEl.classList.add('visible');
      return window.DiffPanel.refresh();
    }, repo);
    await expect(mainWindow.locator('#diff-panel')).toHaveClass(/visible/);

    // Click the changed file in the list to render its diff (.diff-line rows).
    const fileRow = mainWindow.locator('#diff-file-list .diff-file[data-file="app.js"]');
    await expect(fileRow).toBeVisible();
    await fileRow.click();
    await expect(mainWindow.locator('#diff-view .diff-line').first()).toBeVisible();

    // Select text inside a rendered diff line and notify the selection handler.
    // This is the real wiring: a non-collapsed selection inside #diff-content
    // reveals the Explain FAB.
    await mainWindow.evaluate(() => {
      const code = document.querySelector('#diff-view .diff-line .diff-code');
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    // Selection → FAB visibility is the user-facing trigger.
    await expect(mainWindow.locator('#explain-selection-btn')).toBeVisible();

    // Fire the real Explain handler. We click() the button programmatically
    // rather than via the mouse because the FAB is absolutely positioned off the
    // current selection rect (can sit at a negative offset) — the click event
    // still flows through the actual #explain-selection-btn handler.
    await mainWindow.evaluate(() => document.getElementById('explain-selection-btn').click());

    const body = mainWindow.locator('.diff-explanation .diff-explanation-body');
    await expect(body).toBeVisible();
    await expect(body).toContainText(TAG, { timeout: 15000 });
    await expect(body).toContainText('FAKE-AGENT-READY claude');
  } finally {
    rm(repo);
    rm(binDir);
  }
});
