// Project + worktree management: select-repo, get-repo, list-branches,
// and the list-projects/add/remove/switch suite, plus list-worktrees +
// hide-worktree and the new-window opener.

const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { ipcMain, dialog } = require('electron');
const { loadConfig, saveConfig } = require('../util/config');
const { execFileP } = require('../util/exec');
const { getMainWindow, createWindow } = require('../state/windows');
const { instances } = require('../state/instances');

ipcMain.handle('select-repo', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select the git repository to manage',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const repoPath = result.filePaths[0];

  // Validate it's a git repo
  try {
    execSync('git rev-parse --git-dir', { cwd: repoPath, stdio: 'pipe' });
  } catch {
    dialog.showErrorBox('Not a git repository', `${repoPath} is not a git repository.`);
    return null;
  }

  const config = loadConfig();
  config.repoPath = repoPath;
  saveConfig(config);
  return repoPath;
});

ipcMain.handle('get-repo', () => {
  const config = loadConfig();
  if (config.repoPath) return config.repoPath;
  // Fall back to first project if repoPath is missing
  if (config.projects && config.projects.length > 0) {
    config.repoPath = config.projects[0].path;
    saveConfig(config);
    return config.repoPath;
  }
  return null;
});

// List branches for a repo (local + remote, excluding those already checked out in worktrees)
ipcMain.handle('list-branches', async (_event, { repoPath }) => {
  try {
    await execFileP('git', ['rev-parse', '--git-dir'], { cwd: repoPath });
  } catch {
    return { error: 'Not a git repository: ' + repoPath };
  }

  // Get branches already checked out in worktrees
  let worktreeBranches = new Set();
  try {
    const { stdout: wtList } = await execFileP('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    for (const line of wtList.split('\n')) {
      if (line.startsWith('branch ')) {
        worktreeBranches.add(line.replace('branch refs/heads/', ''));
      }
    }
  } catch {}

  let branches = [];
  try {
    const { stdout } = await execFileP('git', ['branch', '-a', '--format', '%(refname:short)\t%(objectname:short)\t%(committerdate:relative)'], {
      cwd: repoPath,
    });
    const raw = stdout.trim();
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const [ref, hash, date] = line.split('\t');
      // Skip HEAD pointers and branches already in worktrees
      if (ref.includes('/HEAD')) continue;
      // For remote branches, strip origin/ prefix for the local name
      let localName = ref;
      let isRemote = false;
      if (ref.startsWith('origin/')) {
        localName = ref.replace('origin/', '');
        isRemote = true;
      }
      if (worktreeBranches.has(localName)) continue;
      branches.push({ ref, localName, hash, date, isRemote });
    }
  } catch (err) {
    return { error: 'Failed to list branches: ' + (err.stderr ? err.stderr.toString() : err.message) };
  }

  // Deduplicate: prefer local over remote
  const seen = new Map();
  for (const b of branches) {
    if (!seen.has(b.localName) || !b.isRemote) {
      seen.set(b.localName, b);
    }
  }

  // Resolve the default branch (origin/HEAD target). Falls back to the usual
  // suspects if the symbolic ref isn't set on the remote.
  let defaultBranch = '';
  try {
    defaultBranch = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', {
      cwd: repoPath, stdio: 'pipe',
    }).toString().trim().replace('origin/', '');
  } catch {
    for (const candidate of ['main', 'master', 'develop']) {
      try {
        execFileSync('git', ['rev-parse', '--verify', candidate], { cwd: repoPath, stdio: 'pipe' });
        defaultBranch = candidate;
        break;
      } catch {}
    }
  }

  return { branches: Array.from(seen.values()), defaultBranch };
});

ipcMain.handle('list-projects', () => {
  const config = loadConfig();
  return config.projects || [];
});

// Renderer now hands us a path directly (from its paste/drag picker) to
// avoid dialog.showOpenDialog entirely — the native NSOpenPanel can hang
// on macOS when the scopedbookmarksagent XPC daemon is unresponsive.
ipcMain.handle('add-project', async (_event, arg) => {
  const projectPath = arg && arg.folderPath;
  if (!projectPath) return null;

  let isGitRepo = false;
  try {
    execSync('git rev-parse --git-dir', { cwd: projectPath, stdio: 'pipe' });
    isGitRepo = true;
  } catch {}

  if (!isGitRepo) {
    const { response } = await dialog.showMessageBox(getMainWindow(), {
      type: 'question',
      buttons: ['Initialize Git', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Not a git repository',
      message: `"${path.basename(projectPath)}" is not a git repository.`,
      detail: 'Would you like to initialize it with git? This will run "git init" in the selected directory.',
    });
    if (response !== 0) return null;
    try {
      execSync('git init', { cwd: projectPath, stdio: 'pipe' });
    } catch (err) {
      dialog.showErrorBox('Git init failed', err.message);
      return null;
    }
  }

  const config = loadConfig();
  if (!config.projects) config.projects = [];
  const name = path.basename(projectPath);
  if (!config.projects.find(p => p.path === projectPath)) {
    config.projects.push({ name, path: projectPath });
  }
  config.repoPath = projectPath;
  saveConfig(config);
  return { name, path: projectPath };
});

ipcMain.handle('remove-project', (_event, { projectPath }) => {
  const config = loadConfig();
  config.projects = (config.projects || []).filter(p => p.path !== projectPath);
  if (config.repoPath === projectPath) {
    config.repoPath = config.projects[0]?.path || null;
  }
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('switch-project', (_event, { projectPath }) => {
  const config = loadConfig();
  config.repoPath = projectPath;
  saveConfig(config);
  return { ok: true };
});

// ---- Multi-Window ----

ipcMain.handle('new-window', () => {
  createWindow({ secondary: true });
  return { ok: true };
});

ipcMain.handle('list-worktrees', async () => {
  const config = loadConfig();
  const repoPath = config.repoPath;
  if (!repoPath) return [];

  // Verify it's a git repo before listing worktrees
  try {
    await execFileP('git', ['rev-parse', '--git-dir'], { cwd: repoPath });
  } catch {
    return [];
  }

  try {
    const { stdout: output } = await execFileP('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
    });

    const worktrees = [];
    let current = {};
    output.split('\n').forEach(line => {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current);
        current = { path: line.substring(9) };
      } else if (line.startsWith('branch ')) {
        current.branch = line.substring(7).replace('refs/heads/', '');
      } else if (line === 'bare') {
        current.bare = true;
      } else if (line === '') {
        if (current.path) worktrees.push(current);
        current = {};
      }
    });
    if (current.path) worktrees.push(current);

    // Filter out bare and hidden worktrees, add active status
    const activePaths = new Set(Array.from(instances.values()).map(i => i.worktreePath));
    const hidden = new Set(config.hiddenWorktrees || []);
    return worktrees
      .filter(w => !w.bare && !hidden.has(w.path))
      .map(w => ({
        path: w.path,
        name: path.basename(w.path),
        branch: w.branch || '',
        active: activePaths.has(w.path),
      }));
  } catch {
    return [];
  }
});

ipcMain.handle('hide-worktree', (_event, { worktreePath }) => {
  const config = loadConfig();
  if (!config.hiddenWorktrees) config.hiddenWorktrees = [];
  if (!config.hiddenWorktrees.includes(worktreePath)) {
    config.hiddenWorktrees.push(worktreePath);
  }
  saveConfig(config);
  return { ok: true };
});
