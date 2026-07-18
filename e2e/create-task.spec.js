// create-task: end-to-end worktree creation. Validates that the IPC
// creates a real git worktree on the requested base branch, creates a
// new branch with the sanitized task name, and spawns an instance the
// terminal-data pipeline can talk to.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { test, expect } = require('./fixtures');

function buildBaseRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-base-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'README.md'), '# base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

function gitOut(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

test('create-task spawns a worktree on a new branch', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repo = buildBaseRepo();
  // Default layout (see create-task in main/ipc/tasks.js): one folder per
  // session holding each repo's worktree — ~/klaussy/sessions/<session>/<repo>.
  // The session name is the sanitized task name (unchanged for 'feature-x').
  const repoBasename = path.basename(repo);
  const taskName = 'feature-x';
  const sessionDir = path.join(os.homedir(), 'klaussy', 'sessions', taskName);
  const expectedWorktree = path.join(sessionDir, repoBasename);

  let taskId = null;
  try {
    const result = await mainWindow.evaluate(
      ({ name, repoPath }) => window.klaus.task.create(name, repoPath, 'shell'),
      { name: taskName, repoPath: repo },
    );

    expect(result.error, `create-task error: ${result.error}`).toBeFalsy();
    expect(result.id).toBeDefined();
    expect(result.worktreePath).toBe(expectedWorktree);
    expect(result.branch).toBe(taskName);
    taskId = result.id;

    // Worktree directory exists and is a real git worktree on the new branch.
    expect(fs.existsSync(expectedWorktree)).toBe(true);
    expect(gitOut(expectedWorktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(taskName);

    // Spawned instance is reachable via the terminal pipeline.
    const tasks = await mainWindow.evaluate(() => window.klaus.task.list());
    expect(tasks.find((t) => t.id === taskId)).toBeTruthy();
  } finally {
    if (taskId != null) {
      await mainWindow.evaluate((id) => window.klaus.task.kill(id), taskId).catch(() => {});
    }
    // git worktree remove + delete branch, then drop the temp repo and the
    // session folder (which holds the worktree under ~/klaussy/sessions).
    try { execFileSync('git', ['worktree', 'remove', '--force', expectedWorktree], { cwd: repo, stdio: 'pipe' }); } catch {}
    try { execFileSync('git', ['branch', '-D', taskName], { cwd: repo, stdio: 'pipe' }); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('create-task preserves the session name casing in the branch', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repo = buildBaseRepo();
  // Mixed-case name: the branch (and session folder) must keep the exact
  // casing the user typed — "FEAT-Bar", never lowercased to "feat-bar".
  const repoBasename = path.basename(repo);
  const taskName = 'FEAT-Bar';
  const sessionDir = path.join(os.homedir(), 'klaussy', 'sessions', taskName);
  const expectedWorktree = path.join(sessionDir, repoBasename);

  let taskId = null;
  try {
    const result = await mainWindow.evaluate(
      ({ name, repoPath }) => window.klaus.task.create(name, repoPath, 'shell'),
      { name: taskName, repoPath: repo },
    );

    expect(result.error, `create-task error: ${result.error}`).toBeFalsy();
    expect(result.branch).toBe(taskName);
    expect(result.worktreePath).toBe(expectedWorktree);
    taskId = result.id;

    // Real git branch keeps the casing too (not just the returned value).
    expect(gitOut(expectedWorktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(taskName);
  } finally {
    if (taskId != null) {
      await mainWindow.evaluate((id) => window.klaus.task.kill(id), taskId).catch(() => {});
    }
    try { execFileSync('git', ['worktree', 'remove', '--force', expectedWorktree], { cwd: repo, stdio: 'pipe' }); } catch {}
    try { execFileSync('git', ['branch', '-D', taskName], { cwd: repo, stdio: 'pipe' }); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

function buildBaseRepoWithBrokenOrigin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-base-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'README.md'), '# base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', 'https://github.com/invalid/invalid.git');
  return dir;
}

test('create-task keeps the chosen agent and prints error if freshening fails', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const repo = buildBaseRepoWithBrokenOrigin();
  const repoBasename = path.basename(repo);
  const taskName = 'feat-fail-freshen';
  const sessionDir = path.join(os.homedir(), 'klaussy', 'sessions', taskName);
  const expectedWorktree = path.join(sessionDir, repoBasename);

  let taskId = null;
  try {
    const result = await mainWindow.evaluate(
      ({ name, repoPath }) => window.klaus.task.create(name, repoPath, 'claude', undefined, 'main'),
      { name: taskName, repoPath: repo },
    );

    expect(result.id).toBeDefined();
    taskId = result.id;
    // Freshen failure is non-fatal: keep the agent (downgrading mislabeled tabs "Shell").
    expect(result.mode).toBe('claude');
    expect(result.warning).toContain('Could not fetch latest');

    // Subscribe and verify the warning is printed in the terminal
    const output = await mainWindow.evaluate((id) => new Promise((resolve) => {
      let buf = '';
      const unsub = window.klaus.terminal.onData(id, (data) => {
        buf += data;
        if (buf.includes('Failed to freshen base branch')) {
          unsub();
          resolve(buf);
        }
      });
      // Safety timeout
      setTimeout(() => { unsub(); resolve(buf); }, 5000);
    }), taskId);

    expect(output).toContain('Failed to freshen base branch from origin');
    expect(output).toContain('Could not fetch latest');
  } finally {
    if (taskId != null) {
      await mainWindow.evaluate((id) => window.klaus.task.kill(id), taskId).catch(() => {});
    }
    try { execFileSync('git', ['worktree', 'remove', '--force', expectedWorktree], { cwd: repo, stdio: 'pipe' }); } catch {}
    try { execFileSync('git', ['branch', '-D', taskName], { cwd: repo, stdio: 'pipe' }); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

