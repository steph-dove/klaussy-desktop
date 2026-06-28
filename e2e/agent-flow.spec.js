// Agent flow with a FAKE agent CLI. Points the Claude provider path at a fake
// script (via set-preferences, read at spawn time by binFor), creates a task
// in 'claude' mode, and confirms the agent's output reaches the terminal-data
// stream. Proves the agent-spawn UI path without a real Claude CLI.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');
const { buildRepo, makeBinDir, writeFakeAgent, rm } = require('./helpers');

test('agent task spawns the configured CLI and streams its output to the terminal', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repo = buildRepo({ 'README.md': '# agent\n' }, 'agent-base');
  const binDir = makeBinDir();
  const fakeAgent = writeFakeAgent(binDir, 'claude');

  const taskName = 'agent-x';
  const sessionDir = path.join(os.homedir(), 'klaussy', 'sessions', taskName);
  const expectedWorktree = path.join(sessionDir, path.basename(repo));

  let taskId = null;
  try {
    // binFor() reads config at spawn time, so setting the pref now is enough.
    await mainWindow.evaluate((p) => window.klaus.ui.setPreferences({ claudePath: p }), fakeAgent);

    const result = await mainWindow.evaluate(
      ({ name, repoPath }) => window.klaus.task.create(name, repoPath, 'claude'),
      { name: taskName, repoPath: repo },
    );
    expect(result.error, `create error: ${result.error}`).toBeFalsy();
    taskId = result.id;

    const output = await mainWindow.evaluate((id) => new Promise((resolve) => {
      let buf = '';
      const unsub = window.klaus.terminal.onData(id, (data) => {
        buf += data;
        if (buf.includes('FAKE-AGENT-READY')) { unsub(); resolve(buf); }
      });
      setTimeout(() => { unsub(); resolve(buf); }, 10000);
    }), taskId);

    expect(output, `agent terminal output:\n${output}`).toContain('FAKE-AGENT-READY claude');
  } finally {
    if (taskId != null) {
      await mainWindow.evaluate((id) => window.klaus.task.kill(id), taskId).catch(() => {});
    }
    try { execFileSync('git', ['worktree', 'remove', '--force', expectedWorktree], { cwd: repo, stdio: 'pipe' }); } catch {}
    try { execFileSync('git', ['branch', '-D', taskName], { cwd: repo, stdio: 'pipe' }); } catch {}
    rm(repo); rm(binDir); rm(sessionDir);
  }
});
