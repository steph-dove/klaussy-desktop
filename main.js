const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, execFileSync, execFile } = require('child_process');
const pty = require('node-pty');

let mainWindow;
const allWindows = new Set();
const instances = new Map(); // id -> { name, worktreePath, pty, branch }
let nextId = 1;
let isQuitting = false;

// Persist repo path in a simple JSON file in userData
function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  // Merge with current on-disk config to prevent races from wiping fields
  try {
    const existing = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
    config = Object.assign(existing, config);
  } catch {}
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

function getWorktreeDir(repoPath) {
  return path.join(path.dirname(repoPath), 'klaus-worktrees');
}

function createWindow(opts) {
  opts = opts || {};
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Klaussy',
    icon: path.join(__dirname, 'icon.icns'),
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  var url = path.join(__dirname, 'renderer', 'index.html');
  if (opts.secondary) {
    win.loadFile(url, { query: { secondary: '1' } });
  } else {
    win.loadFile(url);
  }
  allWindows.add(win);
  win.on('closed', () => { allWindows.delete(win); });

  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = win;
  }

  return win;
}

app.whenReady().then(() => {
  // Set dock icon on macOS using PNG (avoids icon cache issues with .icns)
  if (process.platform === 'darwin' && app.dock) {
    const { nativeImage } = require('electron');
    const iconPath = path.join(__dirname, 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      app.dock.setIcon(icon);
    }
  }

  // Custom menu without Edit menu paste (we handle it ourselves in the renderer)
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => { createWindow({ secondary: true }); },
        },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'close' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  createWindow();

  // Periodically save sessions in case quit events don't fire
  setInterval(() => {
    if (!isQuitting && instances.size > 0) {
      try { saveSessions(); } catch {}
    }
  }, 10000);
});

function shutdownAndSave() {
  if (!isQuitting) {
    isQuitting = true;
    try { saveSessions(); } catch {}
  }
  for (const [, inst] of instances) {
    try { inst.pty.kill(); } catch {}
  }
}

app.on('window-all-closed', () => {
  if (allWindows.size === 0) {
    shutdownAndSave();
    app.quit();
  }
});

app.on('before-quit', () => {
  // Notify all renderers to save UI state
  for (const win of allWindows) {
    if (!win.isDestroyed()) win.webContents.send('app-before-quit');
  }
  shutdownAndSave();
});

app.on('will-quit', () => {
  shutdownAndSave();
});

function saveSessions() {
  // Only overwrite savedSessions if there are active instances;
  // otherwise keep whatever was previously saved
  if (instances.size === 0) return;

  const config = loadConfig();
  const sessions = [];
  for (const [, inst] of instances) {
    const saveMode = inst.originalMode || inst.mode;
    const sessionId = saveMode === 'claude' ? findLatestSessionId(inst.worktreePath) : null;
    sessions.push({
      sessionId: sessionId,
      name: inst.name,
      worktreePath: inst.worktreePath,
      branch: inst.branch,
      mode: saveMode,
      savedAt: new Date().toISOString(),
    });
  }
  config.savedSessions = sessions;
  saveConfig(config);
}

function findLatestSessionId(worktreePath) {
  // Claude stores sessions in ~/.claude/projects/<encoded-path>/*.jsonl
  const claudeDir = path.join(process.env.HOME, '.claude', 'projects');
  const encodedPath = worktreePath.replace(/\//g, '-');
  const projectDir = path.join(claudeDir, encodedPath);

  try {
    if (!fs.existsSync(projectDir)) return null;
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        sessionId: f.replace('.jsonl', ''),
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    return files.length > 0 ? files[0].sessionId : null;
  } catch {
    return null;
  }
}

// ---- IPC Handlers ----

// ---- Session Persistence ----

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

ipcMain.handle('select-repo', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
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

ipcMain.handle('create-task', async (_event, { name, repoPath, mode, basePath }) => {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const branch = `task/${sanitized}`;
  const worktreeDir = basePath || getWorktreeDir(repoPath);
  const worktreePath = path.join(worktreeDir, sanitized);

  // Ensure worktree directory exists
  fs.mkdirSync(worktreeDir, { recursive: true });

  // Get the default branch to branch from
  let baseBranch;
  try {
    baseBranch = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', {
      cwd: repoPath,
      stdio: 'pipe',
    }).toString().trim().replace('origin/', '');
  } catch {
    baseBranch = 'main';
  }

  // Create the worktree
  try {
    execSync(`git worktree add -b "${branch}" "${worktreePath}" "${baseBranch}"`, {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch (err) {
    return { error: `Failed to create worktree: ${err.message}` };
  }

  return spawnInWorktree(name, worktreePath, branch, mode || 'claude');
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
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select existing worktree directory',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

function spawnInWorktree(name, worktreePath, branch, mode, resumeSessionId) {
  const id = nextId++;
  const userShell = process.env.SHELL || '/bin/zsh';

  // 'claude' mode launches claude code, 'shell' mode launches a login shell
  let claudeCmd;
  if (mode === 'shell') {
    claudeCmd = null;
  } else if (resumeSessionId) {
    claudeCmd = `claude --resume ${resumeSessionId}`;
  } else {
    claudeCmd = 'claude';
  }

  const args = claudeCmd ? ['-l', '-c', claudeCmd] : ['-l'];
  const ptyProc = pty.spawn(userShell, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: worktreePath,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  const instance = { id, name, worktreePath, branch, mode, originalMode: mode, pty: ptyProc, alive: true, popoutWindows: new Set() };
  instances.set(id, instance);

  ptyProc.onData((data) => {
    for (const win of allWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-data-${id}`, data);
    }
    for (const win of instance.popoutWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-data-${id}`, data);
    }
  });

  ptyProc.onExit(({ exitCode }) => {
    // If this was a Claude session, auto-convert to shell in-place (but not during quit)
    if (instance.mode === 'claude' && !isQuitting) {
      convertInstanceToShell(instance);
      return;
    }
    instance.alive = false;
    for (const win of allWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-exit-${id}`, exitCode);
    }
    for (const win of instance.popoutWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-exit-${id}`, exitCode);
    }
  });

  return { id, name, worktreePath, branch, mode };
}

function convertInstanceToShell(inst) {
  const id = inst.id;
  const userShell = process.env.SHELL || '/bin/zsh';
  const ptyProc = pty.spawn(userShell, ['-l'], {
    name: 'xterm-256color',
    cols: inst.pty.cols || 120,
    rows: inst.pty.rows || 30,
    cwd: inst.worktreePath,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  inst.pty = ptyProc;
  inst.alive = true;
  inst.mode = 'shell';

  ptyProc.onData((data) => {
    for (const win of allWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-data-${id}`, data);
    }
    for (const win of inst.popoutWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-data-${id}`, data);
    }
  });

  ptyProc.onExit(() => {
    inst.alive = false;
    for (const win of allWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-exit-${id}`);
    }
    for (const win of inst.popoutWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-exit-${id}`);
    }
  });

  // Notify all windows that this task is now a shell
  for (const win of allWindows) {
    if (!win.isDestroyed()) win.webContents.send('task-converted-to-shell', { id });
  }
}

ipcMain.handle('list-tasks', () => {
  return Array.from(instances.values()).map(({ id, name, worktreePath, branch, mode, alive }) => ({
    id, name, worktreePath, branch, mode, alive,
  }));
});

ipcMain.on('write-terminal', (_event, { id, data }) => {
  const inst = instances.get(id);
  if (inst && inst.alive) {
    inst.pty.write(data);
  }
});

ipcMain.on('resize-terminal', (_event, { id, cols, rows }) => {
  const inst = instances.get(id);
  if (inst && inst.alive) {
    try { inst.pty.resize(cols, rows); } catch {}
  }
});

ipcMain.handle('kill-task', (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  try { inst.pty.kill(); } catch {}
  inst.alive = false;

  // Never delete worktrees or branches — only kill the process
  instances.delete(id);
  return { ok: true };
});

// Restart Claude in an existing worktree (after process exit)
ipcMain.handle('restart-task', (_event, { id, cols, rows }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  // Kill the current shell pty — its exit handler won't auto-convert
  // because mode will be 'shell' at this point
  try { inst.pty.kill(); } catch {}

  // Resume as Claude
  const userShell = process.env.SHELL || '/bin/zsh';
  const latestSession = findLatestSessionId(inst.worktreePath);
  const claudeCmd = latestSession ? `claude --resume ${latestSession}` : 'claude';
  inst.mode = 'claude';

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

  ptyProc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`terminal-data-${id}`, data);
    }
    for (const win of inst.popoutWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-data-${id}`, data);
    }
  });

  // When this Claude exits, auto-convert to shell again
  ptyProc.onExit(() => {
    if (inst.mode === 'claude') {
      convertInstanceToShell(inst);
    } else {
      inst.alive = false;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(`terminal-exit-${id}`);
      }
    }
  });

  return { ok: true };
});

// Open URL in default browser
ipcMain.handle('open-external', (_event, { url }) => {
  shell.openExternal(url);
});

// ---- Phase 1: Git Status & Diff ----

ipcMain.handle('git-status', async (_event, { worktreePath }) => {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath, stdio: 'pipe' }).toString().trim();
    const files = status.split('\n').filter(Boolean).map(line => {
      const xy = line.substring(0, 2);
      const file = line.substring(3);
      // staged if index column (x) has a status letter
      const staged = xy[0] !== ' ' && xy[0] !== '?';
      return { status: xy, staged, file };
    });
    // Split files that are both staged and unstaged (e.g., "MM")
    const expanded = [];
    for (const f of files) {
      if (f.status[0] !== ' ' && f.status[0] !== '?' && f.status[1] !== ' ' && f.status[1] !== '?') {
        // Both staged and unstaged changes
        expanded.push({ status: f.status[0] + ' ', staged: true, file: f.file });
        expanded.push({ status: ' ' + f.status[1], staged: false, file: f.file });
      } else {
        expanded.push(f);
      }
    }
    return { branch, files: expanded };
  } catch (err) {
    return { error: err.message, branch: '', files: [] };
  }
});

ipcMain.handle('git-diff', async (_event, { worktreePath, file, staged }) => {
  try {
    const args = ['diff'];
    if (staged) args.push('--cached');
    if (file) args.push('--', file);
    const diff = execFileSync('git', args, { cwd: worktreePath, stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 }).toString();
    return { diff };
  } catch (err) {
    return { diff: '', error: err.message };
  }
});

// ---- Branch Diff Mode ----

ipcMain.handle('git-branches', async (_event, { worktreePath }) => {
  try {
    const local = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const remote = execFileSync('git', ['branch', '-r', '--format=%(refname:short)'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const branches = local.split('\n').filter(Boolean);
    const remotes = remote.split('\n').filter(Boolean).filter(b => !b.includes('HEAD'));
    return { branches, remotes };
  } catch (err) {
    return { branches: [], remotes: [], error: err.message };
  }
});

ipcMain.handle('git-branch-files', async (_event, { worktreePath, baseBranch }) => {
  try {
    // Use merge-base to find the branch point, then diff against working tree
    const mergeBase = execFileSync('git', ['merge-base', baseBranch, 'HEAD'], { cwd: worktreePath, stdio: 'pipe' }).toString().trim();
    const output = execFileSync('git', ['diff', '--name-status', mergeBase], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const files = output.split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      return { status: parts[0], file: parts.slice(1).join('\t') };
    });
    return { files, mergeBase };
  } catch (err) {
    return { files: [], error: err.message };
  }
});

ipcMain.handle('git-branch-diff', async (_event, { worktreePath, baseBranch, file }) => {
  try {
    const mergeBase = execFileSync('git', ['merge-base', baseBranch, 'HEAD'], { cwd: worktreePath, stdio: 'pipe' }).toString().trim();
    const args = ['diff', mergeBase];
    if (file) args.push('--', file);
    const diff = execFileSync('git', args, { cwd: worktreePath, stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 }).toString();
    return { diff };
  } catch (err) {
    return { diff: '', error: err.message };
  }
});

// ---- Phase 2: Git Operations ----

ipcMain.handle('git-stage', async (_event, { worktreePath, files }) => {
  try {
    execFileSync('git', ['add', '--'].concat(files), { cwd: worktreePath, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-unstage', async (_event, { worktreePath, files }) => {
  try {
    execFileSync('git', ['reset', 'HEAD', '--'].concat(files), { cwd: worktreePath, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-discard', async (_event, { worktreePath, files }) => {
  try {
    for (const file of files) {
      try {
        execFileSync('git', ['checkout', '--', file], { cwd: worktreePath, stdio: 'pipe' });
      } catch {
        // Might be untracked — remove it
        execFileSync('git', ['clean', '-f', '--', file], { cwd: worktreePath, stdio: 'pipe' });
      }
    }
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-commit', async (_event, { worktreePath, message }) => {
  try {
    execFileSync('git', ['commit', '-m', message], { cwd: worktreePath, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-push', async (_event, { worktreePath }) => {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath, stdio: 'pipe' }).toString().trim();
    execFileSync('git', ['push', '-u', 'origin', branch], { cwd: worktreePath, stdio: 'pipe', timeout: 30000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('create-pr', async (_event, { worktreePath, title, body }) => {
  try {
    const result = execFileSync('gh', ['pr', 'create', '--title', title, '--body', body || ''], { cwd: worktreePath, stdio: 'pipe', timeout: 30000 }).toString().trim();
    return { url: result };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- Phase 3: Multi-Project ----

ipcMain.handle('list-projects', () => {
  const config = loadConfig();
  return config.projects || [];
});

ipcMain.handle('add-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a git repository',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const projectPath = result.filePaths[0];

  try {
    execSync('git rev-parse --git-dir', { cwd: projectPath, stdio: 'pipe' });
  } catch {
    dialog.showErrorBox('Not a git repository', `${projectPath} is not a git repository.`);
    return null;
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

ipcMain.handle('list-worktrees', () => {
  const config = loadConfig();
  const repoPath = config.repoPath;
  if (!repoPath) return [];

  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: repoPath,
      stdio: 'pipe',
    }).toString();

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

    // Filter out bare worktrees and add active status
    const activePaths = new Set(Array.from(instances.values()).map(i => i.worktreePath));
    return worktrees
      .filter(w => !w.bare)
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

// ---- Phase 4: Pop-Out Windows ----

ipcMain.handle('pop-out-task', (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  const popout = new BrowserWindow({
    width: 800,
    height: 600,
    title: `Klaussy \u2014 ${inst.name}`,
    icon: path.join(__dirname, 'icon.icns'),
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  popout.loadFile(path.join(__dirname, 'renderer', 'popout.html'));

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

// ---- Phase 5: Theme ----

ipcMain.handle('get-theme', () => {
  const config = loadConfig();
  return config.theme || { preset: 'dark' };
});

ipcMain.handle('set-theme', (_event, { theme }) => {
  const config = loadConfig();
  config.theme = theme;
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('get-system-theme', () => {
  return nativeTheme.shouldUseDarkColors;
});

// Listen for system theme changes and forward to renderer
nativeTheme.on('updated', () => {
  for (const win of allWindows) {
    if (!win.isDestroyed()) win.webContents.send('system-theme-changed', nativeTheme.shouldUseDarkColors);
  }
});

// ---- Explain Diff ----

ipcMain.handle('explain-diff', async (_event, { worktreePath, file, hunk }) => {
  const prompt = `Explain this specific code concisely. What does it do and why might it have been written this way?\n\nFile: ${file}\n\nSelected code:\n\`\`\`\n${hunk}\n\`\`\``;
  return new Promise((resolve) => {
    const child = execFile('claude', ['-p', prompt], {
      cwd: worktreePath,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: stderr || err.message });
      } else {
        resolve({ explanation: stdout.trim() });
      }
    });
  });
});

// ---- PR Interaction ----

ipcMain.handle('pr-for-branch', async (_event, { worktreePath }) => {
  try {
    const result = execFileSync('gh', [
      'pr', 'view', '--json',
      'number,title,state,body,url,headRefName,baseRefName,additions,deletions,reviewDecision,comments,reviews'
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 15000 }).toString();
    return { pr: JSON.parse(result) };
  } catch (err) {
    const msg = (err.stderr ? err.stderr.toString() : err.message) || '';
    if (msg.includes('no pull requests found') || msg.includes('Could not resolve')) {
      return { pr: null };
    }
    return { pr: null, error: msg };
  }
});

ipcMain.handle('pr-review-comments', async (_event, { worktreePath, prNumber }) => {
  try {
    // Get inline review comments via gh api
    const repoResult = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const repo = JSON.parse(repoResult).nameWithOwner;
    const comments = execFileSync('gh', ['api', 'repos/' + repo + '/pulls/' + prNumber + '/comments'], {
      cwd: worktreePath, stdio: 'pipe', timeout: 15000
    }).toString();
    return { comments: JSON.parse(comments) };
  } catch (err) {
    return { comments: [], error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('pr-add-comment', async (_event, { worktreePath, prNumber, body }) => {
  try {
    execFileSync('gh', ['pr', 'comment', String(prNumber), '--body', body], {
      cwd: worktreePath, stdio: 'pipe', timeout: 15000
    });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('pr-review', async (_event, { worktreePath, prNumber, event, body }) => {
  try {
    const args = ['pr', 'review', String(prNumber), '--' + event];
    if (body) args.push('--body', body);
    execFileSync('gh', args, { cwd: worktreePath, stdio: 'pipe', timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- Phase 7: File Viewer ----

ipcMain.handle('read-file', async (_event, { filePath }) => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { content, ext: path.extname(filePath).slice(1) };
  } catch (err) {
    return { error: err.message };
  }
});
