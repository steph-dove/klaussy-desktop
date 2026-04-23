// All task-lifecycle IPC: saved sessions, create/checkout/open, list-tasks,
// terminal write/resize, sub-terminals, kill/restart/rename/duplicate,
// notify toggle, dirty-worktree aggregator, transcripts, pop-out, task notes.
//
// runKlausifyInit lives in main.js (moves with bootstrap/app-events.js in
// Phase 4) and is injected via setDeps.

const path = require('path');
const fs = require('fs');
const { execFileSync, execSync } = require('child_process');
const pty = require('node-pty');
const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const { loadConfig, saveConfig } = require('../util/config');
const {
  instances, spawnInWorktree, findLatestSessionId, snapshotSessionIds,
  processIdleDetection, clearIdleTimer, convertInstanceToShell,
  sendToTerminalSubscribers,
} = require('../state/instances');
const { stopCIPolling } = require('../state/ci-poll');
const { getMainWindow, hardenWindow } = require('../state/windows');
const { collectWorktreeState } = require('./git');

// create-task / duplicate-task put worktrees as a sibling of the main repo —
// matches the klausify CLI convention.
function getWorktreeDir(repoPath) {
  return path.join(path.dirname(repoPath), 'klaus-worktrees');
}

let _runKlausifyInit = async () => {};
function setDeps({ runKlausifyInit } = {}) {
  if (runKlausifyInit) _runKlausifyInit = runKlausifyInit;
}

ipcMain.handle('list-saved-sessions', () => {
  const config = loadConfig();
  return config.savedSessions || [];
});

ipcMain.handle('resume-session', (_event, { sessionId, name, worktreePath, branch, mode }) => {
  // Verify the worktree still exists
  if (!fs.existsSync(worktreePath)) {
    return { error: 'Worktree no longer exists: ' + worktreePath };
  }
  const resumeMode = mode || 'claude';
  return spawnInWorktree(name, worktreePath, branch, resumeMode, resumeMode === 'claude' ? sessionId : null);
});

ipcMain.handle('save-ui-state', (_event, state) => {
  const config = loadConfig();
  config.uiState = state;
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('get-ui-state', () => {
  const config = loadConfig();
  return config.uiState || null;
});

ipcMain.handle('get-latest-session', (_event, { worktreePath }) => {
  return findLatestSessionId(worktreePath);
});

ipcMain.handle('clear-saved-sessions', () => {
  const config = loadConfig();
  config.savedSessions = [];
  saveConfig(config);
  return { ok: true };
});

// Remove a single saved session by stable identity (worktreePath + sessionId).
// Renderer used to splice-by-index in a closure, which silently deleted the
// wrong row after any prior dismiss shifted the array.
ipcMain.handle('dismiss-saved-session', (_event, { worktreePath, sessionId }) => {
  const config = loadConfig();
  const before = config.savedSessions || [];
  config.savedSessions = before.filter((s) => {
    if (!s || s.worktreePath !== worktreePath) return true;
    // If the dismissed row carries a sessionId, only drop that exact row;
    // otherwise drop every row for the worktree (shell-only saves).
    if (sessionId) return s.sessionId !== sessionId;
    return false;
  });
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('create-task', async (_event, { name, repoPath, mode, basePath, envVars, baseBranch: requestedBase }) => {
  // Validate repoPath is a git repo
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoPath, stdio: 'pipe' });
  } catch {
    return { error: 'Active project is not a git repository. Remove and re-add the project to initialize git.' };
  }

  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const branch = sanitized;

  // Match klausify CLI convention: worktree as sibling of repo
  const repoBasename = path.basename(repoPath);
  const worktreeDir = basePath || path.dirname(repoPath);
  const worktreePath = path.join(worktreeDir, repoBasename + '-' + sanitized);

  if (fs.existsSync(worktreePath)) {
    return { error: 'Worktree directory already exists: ' + worktreePath };
  }

  // Resolve the base. Caller can pass an explicit branch (chosen from the
  // dropdown); otherwise fall back to origin/HEAD or the usual defaults.
  let baseBranch = (requestedBase || '').trim();
  if (baseBranch) {
    try {
      execFileSync('git', ['rev-parse', '--verify', baseBranch], { cwd: repoPath, stdio: 'pipe' });
    } catch {
      try {
        execFileSync('git', ['branch', baseBranch, 'origin/' + baseBranch], { cwd: repoPath, stdio: 'pipe' });
      } catch (err) {
        return { error: 'Base branch "' + baseBranch + '" not found locally or on origin.' };
      }
    }
  }
  if (!baseBranch) {
    try {
      baseBranch = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', {
        cwd: repoPath, stdio: 'pipe',
      }).toString().trim().replace('origin/', '');
    } catch {
      for (const candidate of ['main', 'master', 'develop']) {
        try {
          execFileSync('git', ['rev-parse', '--verify', candidate], { cwd: repoPath, stdio: 'pipe' });
          baseBranch = candidate;
          break;
        } catch {}
      }
      if (!baseBranch) baseBranch = 'main';
    }
  }

  // Create the worktree (matching klausify CLI: git worktree add ../<repo>-<branch> -b <branch>)
  try {
    execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, baseBranch], {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch (err) {
    return { error: `Failed to create worktree: ${err.stderr ? err.stderr.toString() : err.message}` };
  }

  // Verify the worktree was created in the correct repo
  try {
    const wtTopLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: worktreePath, stdio: 'pipe'
    }).toString().trim();
    console.log(`Worktree created: ${worktreePath} (repo: ${wtTopLevel}, base: ${baseBranch})`);
  } catch {}

  await _runKlausifyInit(worktreePath, baseBranch);
  return spawnInWorktree(name, worktreePath, branch, mode || 'claude', null, envVars);
});

// Create worktree from an existing branch
ipcMain.handle('checkout-branch', async (_event, { repoPath, branch, mode, basePath, envVars }) => {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoPath, stdio: 'pipe' });
  } catch {
    return { error: 'Not a git repository: ' + repoPath };
  }

  const sanitized = branch.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const repoBasename = path.basename(repoPath);
  const worktreeDir = basePath || path.dirname(repoPath);
  const worktreePath = path.join(worktreeDir, repoBasename + '-' + sanitized);

  if (fs.existsSync(worktreePath)) {
    return { error: 'Worktree directory already exists: ' + worktreePath };
  }

  try {
    // Check if it's a local branch already
    try {
      execFileSync('git', ['rev-parse', '--verify', branch], { cwd: repoPath, stdio: 'pipe' });
    } catch {
      // If not local, create tracking branch from origin
      execFileSync('git', ['branch', branch, 'origin/' + branch], { cwd: repoPath, stdio: 'pipe' });
    }
    execFileSync('git', ['worktree', 'add', worktreePath, branch], {
      cwd: repoPath, stdio: 'pipe',
    });
  } catch (err) {
    return { error: 'Failed to create worktree: ' + (err.stderr ? err.stderr.toString() : err.message) };
  }

  await _runKlausifyInit(worktreePath);
  const name = sanitized;
  return spawnInWorktree(name, worktreePath, branch, mode || 'claude', null, envVars);
});

// Attach to an existing worktree directory
ipcMain.handle('attach-worktree', async (_event, { worktreePath, mode }) => {
  // Validate it's a git worktree / repo
  try {
    execSync('git rev-parse --git-dir', { cwd: worktreePath, stdio: 'pipe' });
  } catch {
    return { error: 'Selected directory is not a git repository or worktree.' };
  }

  // Get branch name for display
  let branch = '';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: worktreePath,
      stdio: 'pipe',
    }).toString().trim();
  } catch {}

  const name = path.basename(worktreePath);
  return spawnInWorktree(name, worktreePath, branch, mode || 'claude');
});

// Browse for a directory (used by the existing worktree tab)
ipcMain.handle('browse-directory', async () => {
  const result = await dialog.showOpenDialog(getMainWindow(), {
    title: 'Select existing worktree directory',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Open a plain directory (not a git worktree). Git-dependent panels will
// degrade gracefully because `branch` is empty — auto-fetch and CI polling
// explicitly skip instances without a branch.
ipcMain.handle('open-folder', async (_event, { folderPath, mode }) => {
  if (!folderPath) {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Select folder to open',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    folderPath = result.filePaths[0];
  }
  try {
    if (!fs.statSync(folderPath).isDirectory()) {
      return { error: 'Not a directory: ' + folderPath };
    }
  } catch {
    return { error: 'Folder does not exist: ' + folderPath };
  }
  const name = path.basename(folderPath) || 'folder';
  return spawnInWorktree(name, folderPath, '', mode || 'claude');
});

ipcMain.handle('list-tasks', () => {
  return Array.from(instances.values()).map(({ id, name, worktreePath, branch, mode, alive }) => ({
    id, name, worktreePath, branch, mode, alive,
  }));
});

ipcMain.on('write-terminal', (_event, { id, data, subId }) => {
  const inst = instances.get(id);
  if (!inst) return;
  if (subId !== undefined && subId > 0) {
    const sub = inst.subTerminals.find(s => s.subId === subId);
    if (sub && sub.alive) sub.pty.write(data);
  } else if (inst.alive) {
    inst.pty.write(data);
  }
});

ipcMain.on('resize-terminal', (_event, { id, cols, rows, subId }) => {
  const inst = instances.get(id);
  if (!inst) return;
  if (subId !== undefined && subId > 0) {
    const sub = inst.subTerminals.find(s => s.subId === subId);
    if (sub && sub.alive) { try { sub.pty.resize(cols, rows); } catch {} }
  } else if (inst.alive) {
    try { inst.pty.resize(cols, rows); } catch {}
  }
});

ipcMain.handle('add-sub-terminal', (_event, { taskId, label }) => {
  const inst = instances.get(taskId);
  if (!inst) return { error: 'Instance not found' };

  const subId = inst.nextSubId++;
  const userShell = process.env.SHELL || '/bin/zsh';
  const ptyProc = pty.spawn(userShell, ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: inst.worktreePath,
    env: { ...process.env, TERM: 'xterm-256color', ...(inst.extraEnv || {}) },
  });

  const sub = { subId, label: label || 'Shell', pty: ptyProc, alive: true };
  inst.subTerminals.push(sub);

  ptyProc.onData((data) => {
    sendToTerminalSubscribers(`terminal-data-${taskId}-${subId}`, data);
  });

  ptyProc.onExit(() => {
    sub.alive = false;
    sendToTerminalSubscribers(`terminal-exit-${taskId}-${subId}`);
  });

  return { subId, label: sub.label };
});

ipcMain.handle('kill-sub-terminal', (_event, { taskId, subId }) => {
  const inst = instances.get(taskId);
  if (!inst) return { error: 'Instance not found' };
  const idx = inst.subTerminals.findIndex(s => s.subId === subId);
  if (idx === -1) return { error: 'Sub-terminal not found' };
  const sub = inst.subTerminals[idx];
  try { sub.pty.kill(); } catch {}
  inst.subTerminals.splice(idx, 1);
  return { ok: true };
});

ipcMain.handle('kill-task', (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  // Mark BEFORE kill(): pty.kill is async, and the onExit handler checks
  // this flag to skip the Claude→shell auto-convert branch. Without it,
  // killing a Claude task would spawn an orphan shell with no instances
  // entry — nothing could find or stop it after this point.
  inst.killed = true;
  clearIdleTimer(inst);
  stopCIPolling(id);
  try { inst.pty.kill(); } catch {}
  // Kill all sub-terminals
  for (const sub of (inst.subTerminals || [])) {
    try { sub.pty.kill(); } catch {}
  }
  inst.alive = false;

  // Never delete worktrees or branches — only kill the process
  instances.delete(id);
  return { ok: true };
});

// Restart Claude in an existing worktree (after process exit)
ipcMain.handle('restart-task', (_event, { id, cols, rows }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  // Mark restarting BEFORE kill(): pty.kill is async and the stale exit
  // handler would otherwise race with the new-pty assignment below — in
  // particular if the instance was still in claude mode, the old-pty's
  // onExit would spawn a convert-shell and overwrite inst.pty right after
  // we set it on line below.
  inst.restarting = true;
  try { inst.pty.kill(); } catch {}

  // Resume as Claude — prefer this instance's tracked session so multiple
  // terminals on the same worktree don't collide on the "latest" .jsonl.
  const userShell = process.env.SHELL || '/bin/zsh';
  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  const resumeId = inst.claudeSessionId || findLatestSessionId(inst.worktreePath);
  const claudeCmd = resumeId ? `${claudeBin} --resume ${resumeId}` : claudeBin;
  inst.mode = 'claude';
  inst.spawnTime = Date.now();
  inst.preSpawnSessionIds = snapshotSessionIds(inst.worktreePath);
  inst.claudeSessionId = resumeId || null;

  const args = ['-l', '-c', claudeCmd];
  const ptyProc = pty.spawn(userShell, args, {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 30,
    cwd: inst.worktreePath,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  inst.pty = ptyProc;
  inst.alive = true;
  inst.recentOutput = '';
  inst.notifiedIdle = false;
  // New pty is live; clear the restart guard so this one's natural exit
  // (or future restarts) behave normally.
  inst.restarting = false;

  ptyProc.onData((data) => {
    processIdleDetection(inst, data);
    sendToTerminalSubscribers(`terminal-data-${id}`, data);
  });

  // When this Claude exits, auto-convert to shell again
  ptyProc.onExit(() => {
    clearIdleTimer(inst);
    if (inst.mode === 'claude') {
      convertInstanceToShell(inst);
    } else {
      inst.alive = false;
      sendToTerminalSubscribers(`terminal-exit-${id}`);
    }
  });

  return { ok: true };
});

ipcMain.handle('set-notify-enabled', (_event, { id, enabled }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };
  inst.notifyEnabled = enabled;
  const config = loadConfig();
  if (!config.notifyPrefs) config.notifyPrefs = {};
  config.notifyPrefs[inst.name] = enabled;
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('get-notify-enabled', (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return true;
  return inst.notifyEnabled !== false;
});

ipcMain.handle('rename-task', (_event, { id, newName }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };
  inst.name = newName;
  return { ok: true };
});

// ---- Duplicate Task (A6) ----

ipcMain.handle('duplicate-task', async (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  const config = loadConfig();
  const repoPath = config.repoPath;
  if (!repoPath) return { error: 'No repo configured' };

  const baseName = inst.name + '-copy';
  const sanitized = baseName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const branch = `task/${sanitized}`;
  const worktreeDir = getWorktreeDir(repoPath);
  const worktreePath = path.join(worktreeDir, sanitized);

  fs.mkdirSync(worktreeDir, { recursive: true });

  // Branch from the same branch as the source
  const sourceBranch = inst.branch || 'main';

  try {
    execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, sourceBranch], {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch (err) {
    return { error: `Failed to create worktree: ${err.message}` };
  }

  await _runKlausifyInit(worktreePath, sourceBranch);
  const mode = config.defaultMode || 'claude';
  return spawnInWorktree(baseName, worktreePath, branch, mode);
});

ipcMain.handle('list-all-dirty-worktrees', async () => {
  return Promise.all(Array.from(instances.values()).map(collectWorktreeState));
});

ipcMain.handle('get-worktree-state', async (_event, { taskId }) => {
  const task = instances.get(taskId);
  if (!task) return null;
  return collectWorktreeState(task);
});

// E2: Export session transcript
//
// The dialog-selected path is held main-side in `pendingTranscripts` rather
// than round-tripping through the renderer. Previously the renderer could
// hand any path back to `write-transcript` (including /etc/hosts) because
// main had no way to verify the path actually came from a dialog.
const pendingTranscripts = new Map(); // instanceId -> expected file path
ipcMain.handle('export-transcript', async (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  const result = await dialog.showSaveDialog(getMainWindow(), {
    title: 'Export Session Transcript',
    defaultPath: path.join(app.getPath('documents'), inst.name + '-transcript.txt'),
    filters: [{ name: 'Text', extensions: ['txt'] }, { name: 'Markdown', extensions: ['md'] }],
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  pendingTranscripts.set(id, result.filePath);
  // The transcript content will arrive from the renderer (xterm buffer)
  // via `write-transcript` below — it MUST pass the same id, not the path.
  return { ok: true };
});

ipcMain.handle('write-transcript', (_event, { id, content }) => {
  const expected = pendingTranscripts.get(id);
  if (!expected) return { error: 'No pending transcript for this task' };
  pendingTranscripts.delete(id);
  try {
    fs.writeFileSync(expected, content, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('pop-out-task', (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  const popout = new BrowserWindow({
    width: 800,
    height: 600,
    title: `Klaussy \u2014 ${inst.name}`,
    icon: path.join(__dirname, '..', '..', 'icon.icns'),
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(popout);

  popout.loadFile(path.join(__dirname, '..', '..', 'renderer', 'popout.html'));

  inst.popoutWindows.add(popout);

  popout.webContents.once('did-finish-load', () => {
    popout.webContents.send('popout-init', {
      id: inst.id, name: inst.name,
      worktreePath: inst.worktreePath, branch: inst.branch, mode: inst.mode,
    });
  });

  popout.on('closed', () => {
    inst.popoutWindows.delete(popout);
  });

  return { ok: true };
});

ipcMain.handle('get-task-note', async (_event, { taskName }) => {
  const config = loadConfig();
  return { note: (config.taskNotes && config.taskNotes[taskName]) || '' };
});

ipcMain.handle('set-task-note', async (_event, { taskName, note }) => {
  const config = loadConfig();
  if (!config.taskNotes) config.taskNotes = {};
  config.taskNotes[taskName] = note;
  saveConfig(config);
  return { ok: true };
});
module.exports = { setDeps };
