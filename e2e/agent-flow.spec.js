// Agent flow with a FAKE agent CLI. Seeds claudePath in config.json BEFORE
// launch (configSeed) so the Claude provider resolves to the fake script at
// spawn time. Seeding (not set-preferences-at-runtime) is deliberate: the
// config write from set-preferences can lose a race with task.create reading
// config, which in CI left the instance falling back to a plain shell (the
// `claude` default isn't installed there). Creating a 'claude' task then
// streams the fake's output through the terminal-data pipeline.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');
const { buildRepo, writeFakeAgent, rm } = require('./helpers');

// Written at collection time so the (static) configSeed can reference its
// absolute path. Cleaned up after the file's tests run.
const BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-fakebin-agentflow-'));
const FAKE_AGENT = writeFakeAgent(BIN_DIR, 'claude');
test.use({ configSeed: { claudePath: FAKE_AGENT, defaultProvider: 'claude' } });

test.afterAll(() => rm(BIN_DIR));

test('agent task spawns the configured CLI and streams its output to the terminal', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repo = buildRepo({ 'README.md': '# agent\n' }, 'agent-base');
  const taskName = `agent-x-${process.pid}-${Date.now()}`;
  const sessionDir = path.join(os.homedir(), 'klaussy', 'sessions', taskName);
  const expectedWorktree = path.join(sessionDir, path.basename(repo));

  let taskId = null;
  try {
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
      setTimeout(() => { unsub(); resolve(buf); }, 12000);
    }), taskId);

    expect(output, `agent terminal output:\n${output}`).toContain('FAKE-AGENT-READY claude');
  } finally {
    if (taskId != null) {
      await mainWindow.evaluate((id) => window.klaus.task.kill(id), taskId).catch(() => {});
    }
    try { execFileSync('git', ['worktree', 'remove', '--force', expectedWorktree], { cwd: repo, stdio: 'pipe' }); } catch {}
    try { execFileSync('git', ['branch', '-D', taskName], { cwd: repo, stdio: 'pipe' }); } catch {}
    rm(repo); rm(sessionDir);
  }
});
