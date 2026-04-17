const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, execFileSync, execFile } = require('child_process');
const pty = require('node-pty');

let mainWindow;
const allWindows = new Set();
const instances = new Map(); // id -> { name, worktreePath, pty, branch }
let nextId = 1;
let isQuitting = false;

// E1: Log ring buffer
const LOG_MAX = 500;
const logBuffer = [];
const origConsoleLog = console.log;
const origConsoleError = console.error;
const origConsoleWarn = console.warn;

function captureLog(level, args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  logBuffer.push({ time: new Date().toISOString(), level, msg });
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
}

console.log = function (...args) { captureLog('log', args); origConsoleLog.apply(console, args); };
console.error = function (...args) { captureLog('error', args); origConsoleError.apply(console, args); };
console.warn = function (...args) { captureLog('warn', args); origConsoleWarn.apply(console, args); };

// Also capture uncaught errors
process.on('uncaughtException', (err) => {
  captureLog('error', ['Uncaught:', err.stack || err.message]);
  origConsoleError.call(console, 'Uncaught:', err);
});

process.on('unhandledRejection', (reason) => {
  captureLog('error', ['Unhandled rejection:', String(reason)]);
  origConsoleError.call(console, 'Unhandled rejection:', reason);
});

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

// Resolve the correct gh auth token for a given repo directory.
// Matches the remote owner (e.g. "steph-dove") to a logged-in gh account.
const ghTokenCache = new Map(); // remote owner -> token

function ghEnvForRepo(repoDir) {
  try {
    // Get the remote URL
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoDir, stdio: 'pipe',
    }).toString().trim();

    // Extract owner from SSH or HTTPS remote
    // ssh: git@github.com:owner/repo.git  https: https://github.com/owner/repo.git
    let owner;
    const sshMatch = remoteUrl.match(/github\.com[:/]([^/]+)\//);
    if (sshMatch) owner = sshMatch[1];
    if (!owner) return {};

    if (ghTokenCache.has(owner)) {
      const cached = ghTokenCache.get(owner);
      if (cached) return { GH_TOKEN: cached };
      return {};
    }

    // Try to get a token for this owner from gh auth
    try {
      const token = execFileSync('gh', ['auth', 'token', '--user', owner], {
        stdio: 'pipe', timeout: 5000,
      }).toString().trim();
      if (token) {
        ghTokenCache.set(owner, token);
        return { GH_TOKEN: token };
      }
    } catch {}

    ghTokenCache.set(owner, null);
    return {};
  } catch {
    return {};
  }
}

function ghExec(args, opts) {
  const env = ghEnvForRepo(opts.cwd);
  return execFileSync('gh', args, {
    ...opts,
    env: { ...process.env, ...env },
  });
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

  // Start auto-fetch background interval
  startAutoFetch();
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

  // Group claude instances by worktree so we can disambiguate when multiple
  // terminals share a worktree. Each instance owns its own session .jsonl.
  const claudeByWorktree = new Map();
  for (const [, inst] of instances) {
    const saveMode = inst.originalMode || inst.mode;
    if (saveMode !== 'claude') continue;
    if (!claudeByWorktree.has(inst.worktreePath)) claudeByWorktree.set(inst.worktreePath, []);
    claudeByWorktree.get(inst.worktreePath).push(inst);
  }

  // For each worktree, resolve instance session IDs by picking .jsonl files
  // that (a) weren't present at that instance's spawn and (b) haven't already
  // been claimed by another instance on the same worktree. This covers fresh
  // spawns (detect picks up the new file) and resumes where Claude forks the
  // session into a new .jsonl (detect supersedes the initial resume id).
  for (const [, insts] of claudeByWorktree) {
    insts.sort((a, b) => (a.spawnTime || 0) - (b.spawnTime || 0));
    const claimed = new Set();
    for (const inst of insts) {
      const detected = detectClaudeSessionId(inst, claimed);
      if (detected) inst.claudeSessionId = detected;
      if (inst.claudeSessionId) claimed.add(inst.claudeSessionId);
    }
  }

  const config = loadConfig();
  const sessions = [];
  for (const [, inst] of instances) {
    const saveMode = inst.originalMode || inst.mode;
    const sessionId = saveMode === 'claude'
      ? (inst.claudeSessionId || findLatestSessionId(inst.worktreePath))
      : null;
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

function listSessionFiles(worktreePath) {
  const claudeDir = path.join(process.env.HOME, '.claude', 'projects');
  const encodedPath = worktreePath.replace(/\//g, '-');
  const projectDir = path.join(claudeDir, encodedPath);
  try {
    if (!fs.existsSync(projectDir)) return [];
    return fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const st = fs.statSync(path.join(projectDir, f));
        return {
          name: f,
          sessionId: f.replace('.jsonl', ''),
          mtime: st.mtimeMs,
          ctime: st.ctimeMs,
        };
      });
  } catch {
    return [];
  }
}

function snapshotSessionIds(worktreePath) {
  return new Set(listSessionFiles(worktreePath).map(f => f.sessionId));
}

// Find the session id for a freshly-spawned claude instance: pick the .jsonl
// that didn't exist at spawn and isn't claimed by another instance. Prefer the
// oldest-created "new" file so concurrent spawns pair up in spawn order.
function detectClaudeSessionId(inst, claimed) {
  const preSpawn = inst.preSpawnSessionIds || new Set();
  const files = listSessionFiles(inst.worktreePath)
    .filter(f => !preSpawn.has(f.sessionId))
    .filter(f => !claimed || !claimed.has(f.sessionId))
    .sort((a, b) => a.ctime - b.ctime);
  return files.length > 0 ? files[0].sessionId : null;
}

function findLatestSessionId(worktreePath) {
  const files = listSessionFiles(worktreePath).sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].sessionId : null;
}

// ---- Idle / Prompt Detection (A1) ----

const IDLE_TIMEOUT_MS = 15000;
const NOTIFY_COOLDOWN_MS = 30000;
const ROLLING_BUFFER_SIZE = 500;

const PROMPT_PATTERNS = [
  /\(y\/n\)\s*$/i,
  /\(Y\/n\)\s*$/,
  /\(yes\/no\)\s*$/i,
  /Do you want to proceed/i,
  /Press Enter to continue/i,
  /Allow\s.*\?/i,
  /❯\s*$/,
];

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]/g, '');
}

function isAnyWindowFocused() {
  for (const win of allWindows) {
    if (!win.isDestroyed() && win.isFocused()) return true;
  }
  for (const [, inst] of instances) {
    for (const win of inst.popoutWindows) {
      if (!win.isDestroyed() && win.isFocused()) return true;
    }
  }
  return false;
}

function sendIdleNotification(inst, reason) {
  if (!inst.notifyEnabled) return;
  if (Date.now() - inst.lastNotifyTime < NOTIFY_COOLDOWN_MS) return;
  if (isAnyWindowFocused()) return;

  const notification = new Notification({
    title: `Klaussy — ${inst.name}`,
    body: reason,
    silent: false,
  });

  notification.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('notification-clicked', { id: inst.id });
    }
  });

  notification.show();
  inst.lastNotifyTime = Date.now();
}

function processIdleDetection(inst, data) {
  if (inst.mode !== 'claude') return;

  inst.lastDataTime = Date.now();
  inst.notifiedIdle = false;

  // Update rolling buffer
  const stripped = stripAnsi(data);
  inst.recentOutput = (inst.recentOutput + stripped).slice(-ROLLING_BUFFER_SIZE);

  // Reset quiet timer
  if (inst.quietTimer) clearTimeout(inst.quietTimer);
  inst.quietTimer = setTimeout(() => {
    if (inst.alive && inst.mode === 'claude' && !inst.notifiedIdle) {
      inst.notifiedIdle = true;
      sendIdleNotification(inst, 'Claude has been idle for 15s');
    }
  }, IDLE_TIMEOUT_MS);

  // Check prompt patterns against recent output tail
  const tail = inst.recentOutput.slice(-200);
  for (const pattern of PROMPT_PATTERNS) {
    if (pattern.test(tail)) {
      sendIdleNotification(inst, 'Claude is waiting for input');
      break;
    }
  }
}

function initIdleDetectionFields(inst) {
  const config = loadConfig();
  inst.notifyEnabled = config.notifyPrefs?.[inst.name] !== false;
  inst.lastDataTime = 0;
  inst.quietTimer = null;
  inst.notifiedIdle = false;
  inst.lastNotifyTime = 0;
  inst.recentOutput = '';
}

function clearIdleTimer(inst) {
  if (inst.quietTimer) {
    clearTimeout(inst.quietTimer);
    inst.quietTimer = null;
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

ipcMain.handle('create-task', async (_event, { name, repoPath, mode, basePath, envVars }) => {
  // Validate repoPath is a git repo
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoPath, stdio: 'pipe' });
  } catch {
    return { error: 'Active project is not a git repository. Remove and re-add the project to initialize git.' };
  }

  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const branch = `${sanitized}`;

  // Match klausify CLI convention: worktree as sibling of repo
  // e.g. /projects/myrepo -> /projects/myrepo-fix-login
  const repoBasename = path.basename(repoPath);
  const worktreeDir = basePath || path.dirname(repoPath);
  const worktreePath = path.join(worktreeDir, repoBasename + '-' + sanitized);

  // Check worktree doesn't already exist
  if (fs.existsSync(worktreePath)) {
    return { error: 'Worktree directory already exists: ' + worktreePath };
  }

  // Get the default branch to branch from
  let baseBranch;
  try {
    baseBranch = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', {
      cwd: repoPath,
      stdio: 'pipe',
    }).toString().trim().replace('origin/', '');
  } catch {
    // Try common branch names
    for (const candidate of ['main', 'master', 'develop']) {
      try {
        execFileSync('git', ['rev-parse', '--verify', candidate], { cwd: repoPath, stdio: 'pipe' });
        baseBranch = candidate;
        break;
      } catch {}
    }
    if (!baseBranch) baseBranch = 'main';
  }

  // Create the worktree (matching klausify CLI: git worktree add ../<repo>-<branch> -b <branch>)
  try {
    execSync(`git worktree add -b "${branch}" "${worktreePath}" "${baseBranch}"`, {
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

  await runKlausifyInit(worktreePath, baseBranch);
  return spawnInWorktree(name, worktreePath, branch, mode || 'claude', null, envVars);
});

// List branches for a repo (local + remote, excluding those already checked out in worktrees)
ipcMain.handle('list-branches', async (_event, { repoPath }) => {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoPath, stdio: 'pipe' });
  } catch {
    return { error: 'Not a git repository: ' + repoPath };
  }

  // Get branches already checked out in worktrees
  let worktreeBranches = new Set();
  try {
    const wtList = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath, stdio: 'pipe' }).toString();
    for (const line of wtList.split('\n')) {
      if (line.startsWith('branch ')) {
        worktreeBranches.add(line.replace('branch refs/heads/', ''));
      }
    }
  } catch {}

  let branches = [];
  try {
    const raw = execFileSync('git', ['branch', '-a', '--format', '%(refname:short)\t%(objectname:short)\t%(committerdate:relative)'], {
      cwd: repoPath, stdio: 'pipe'
    }).toString().trim();
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
  return { branches: Array.from(seen.values()) };
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

  await runKlausifyInit(worktreePath);
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
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select existing worktree directory',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

let klausifyAvailable = null; // null = unchecked, true/false after first check

function checkKlausifyInstalled() {
  if (klausifyAvailable !== null) return klausifyAvailable;
  try {
    execFileSync('klausify', ['--version'], { stdio: 'pipe', timeout: 5000 });
    klausifyAvailable = true;
  } catch {
    klausifyAvailable = false;
  }
  return klausifyAvailable;
}

async function promptKlausifyInstall() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Install with pipx', 'Skip'],
    defaultId: 0,
    cancelId: 1,
    title: 'klausify not found',
    message: 'klausify CLI is not installed.',
    detail: 'klausify sets up Claude Code boilerplate (CLAUDE.md, etc.) for each new worktree.\n\nInstall it now with pipx?',
  });
  if (response !== 0) return false;
  try {
    execSync('pipx install klausify', { stdio: 'pipe', timeout: 60000 });
    klausifyAvailable = true;
    return true;
  } catch (err) {
    dialog.showErrorBox('Installation failed', 'Could not install klausify:\n' + (err.stderr ? err.stderr.toString() : err.message) + '\n\nTry manually: pipx install klausify');
    return false;
  }
}

async function runKlausifyInit(worktreePath, baseBranch) {
  if (!checkKlausifyInstalled()) {
    const installed = await promptKlausifyInstall();
    if (!installed) return;
  }
  try {
    const args = ['init', '--repo', worktreePath, '--skip-enrich'];
    if (baseBranch) args.push('--base-branch', baseBranch);
    execFileSync('klausify', args, { stdio: 'pipe', timeout: 30000 });
    console.log('klausify init completed for', worktreePath);
  } catch (err) {
    console.warn('klausify init failed (non-fatal):', err.message);
  }
}

function spawnInWorktree(name, worktreePath, branch, mode, resumeSessionId, extraEnv) {
  const id = nextId++;
  const userShell = process.env.SHELL || '/bin/zsh';

  // 'claude' mode launches claude code, 'shell' mode launches a login shell
  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  let claudeCmd;
  if (mode === 'shell') {
    claudeCmd = null;
  } else if (resumeSessionId) {
    claudeCmd = `${claudeBin} --resume ${resumeSessionId}`;
  } else {
    claudeCmd = claudeBin;
  }

  const args = claudeCmd ? ['-l', '-c', claudeCmd] : ['-l'];
  const ptyProc = pty.spawn(userShell, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: worktreePath,
    env: { ...process.env, TERM: 'xterm-256color', ...(extraEnv || {}) },
  });

  const instance = {
    id, name, worktreePath, branch, mode, originalMode: mode,
    pty: ptyProc, alive: true, popoutWindows: new Set(), extraEnv: extraEnv || {},
    subTerminals: [], nextSubId: 1,
    spawnTime: Date.now(),
    preSpawnSessionIds: mode === 'claude' ? snapshotSessionIds(worktreePath) : new Set(),
    claudeSessionId: mode === 'claude' ? (resumeSessionId || null) : null,
  };
  initIdleDetectionFields(instance);
  instances.set(id, instance);

  ptyProc.onData((data) => {
    processIdleDetection(instance, data);
    for (const win of allWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-data-${id}`, data);
    }
    for (const win of instance.popoutWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-data-${id}`, data);
    }
  });

  ptyProc.onExit(({ exitCode }) => {
    clearIdleTimer(instance);
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

  // Start CI polling for this task
  startCIPolling(id, worktreePath, branch);

  return { id, name, worktreePath, branch, mode };
}

function convertInstanceToShell(inst) {
  sendIdleNotification(inst, 'Claude has exited');
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

// ---- Sub-terminal Multiplexing (Feature 5) ----

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
    for (const win of allWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-data-${taskId}-${subId}`, data);
    }
  });

  ptyProc.onExit(() => {
    sub.alive = false;
    for (const win of allWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-exit-${taskId}-${subId}`);
    }
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

  // Kill the current shell pty — its exit handler won't auto-convert
  // because mode will be 'shell' at this point
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

  ptyProc.onData((data) => {
    processIdleDetection(inst, data);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`terminal-data-${id}`, data);
    }
    for (const win of inst.popoutWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-data-${id}`, data);
    }
  });

  // When this Claude exits, auto-convert to shell again
  ptyProc.onExit(() => {
    clearIdleTimer(inst);
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

// ---- Idle Notification Toggle ----

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

// ---- About Info (A7) ----

ipcMain.handle('get-about-info', async () => {
  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  let claudeVersion = 'not found';
  try {
    claudeVersion = execFileSync(claudeBin, ['--version'], { stdio: 'pipe', timeout: 5000 }).toString().trim();
  } catch {}
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    claudePath: claudeBin,
    claudeVersion,
  };
});

// ---- Rename Task (A4) ----

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
    execSync(`git worktree add -b "${branch}" "${worktreePath}" "${sourceBranch}"`, {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch (err) {
    return { error: `Failed to create worktree: ${err.message}` };
  }

  await runKlausifyInit(worktreePath, sourceBranch);
  const mode = config.defaultMode || 'claude';
  return spawnInWorktree(baseName, worktreePath, branch, mode);
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
    const result = ghExec(['pr', 'create', '--title', title, '--body', body || ''], { cwd: worktreePath, stdio: 'pipe', timeout: 30000 }).toString().trim();
    return { url: result };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- Phase D: Git Gaps ----

// D1: Fetch & Pull
ipcMain.handle('git-fetch', async (_event, { worktreePath }) => {
  try {
    execFileSync('git', ['fetch', '--prune'], { cwd: worktreePath, stdio: 'pipe', timeout: 30000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-pull', async (_event, { worktreePath }) => {
  try {
    const output = execFileSync('git', ['pull'], { cwd: worktreePath, stdio: 'pipe', timeout: 30000 }).toString().trim();
    return { ok: true, output };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-ahead-behind', async (_event, { worktreePath }) => {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath, stdio: 'pipe' }).toString().trim();
    const upstream = execFileSync('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd: worktreePath, stdio: 'pipe' }).toString().trim();
    const counts = execFileSync('git', ['rev-list', '--left-right', '--count', upstream + '...HEAD'], { cwd: worktreePath, stdio: 'pipe' }).toString().trim();
    const parts = counts.split(/\s+/);
    return { behind: parseInt(parts[0], 10) || 0, ahead: parseInt(parts[1], 10) || 0 };
  } catch {
    return { behind: 0, ahead: 0 };
  }
});

// D2: Branch checkout
ipcMain.handle('git-checkout', async (_event, { worktreePath, branch }) => {
  try {
    execFileSync('git', ['checkout', branch], { cwd: worktreePath, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// D3: Stash
ipcMain.handle('git-stash-push', async (_event, { worktreePath, message }) => {
  try {
    const args = ['stash', 'push'];
    if (message) args.push('-m', message);
    execFileSync('git', args, { cwd: worktreePath, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-stash-pop', async (_event, { worktreePath, index }) => {
  try {
    const args = ['stash', 'pop'];
    if (index !== undefined) args.push('stash@{' + index + '}');
    execFileSync('git', args, { cwd: worktreePath, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-stash-list', async (_event, { worktreePath }) => {
  try {
    const output = execFileSync('git', ['stash', 'list', '--format=%gd\t%s'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const stashes = output.split('\n').filter(Boolean).map(function (line) {
      const parts = line.split('\t');
      return { ref: parts[0], message: parts.slice(1).join('\t') };
    });
    return { stashes };
  } catch (err) {
    return { stashes: [], error: err.message };
  }
});

// D4: Commit history
ipcMain.handle('git-log', async (_event, { worktreePath, count }) => {
  try {
    const output = execFileSync('git', ['log', '--format=%H\t%h\t%an\t%ar\t%s', '-' + (count || 50)], {
      cwd: worktreePath, stdio: 'pipe',
    }).toString();
    const commits = output.split('\n').filter(Boolean).map(function (line) {
      const p = line.split('\t');
      return { hash: p[0], short: p[1], author: p[2], date: p[3], subject: p[4] };
    });
    return { commits };
  } catch (err) {
    return { commits: [], error: err.message };
  }
});

ipcMain.handle('git-show', async (_event, { worktreePath, hash }) => {
  try {
    const diff = execFileSync('git', ['show', '--format=', hash], {
      cwd: worktreePath, stdio: 'pipe', maxBuffer: 10 * 1024 * 1024,
    }).toString();
    return { diff };
  } catch (err) {
    return { diff: '', error: err.message };
  }
});

// D5: Blame
ipcMain.handle('git-blame', async (_event, { worktreePath, file }) => {
  try {
    const output = execFileSync('git', ['blame', '--porcelain', file], {
      cwd: worktreePath, stdio: 'pipe', maxBuffer: 10 * 1024 * 1024,
    }).toString();
    // Parse porcelain blame into per-line annotations
    const lines = [];
    let current = {};
    const commits = {};
    output.split('\n').forEach(function (line) {
      const headerMatch = line.match(/^([0-9a-f]{40}) (\d+) (\d+)/);
      if (headerMatch) {
        current = { hash: headerMatch[1], origLine: parseInt(headerMatch[2]), finalLine: parseInt(headerMatch[3]) };
        return;
      }
      if (line.startsWith('author ')) {
        if (!commits[current.hash]) commits[current.hash] = {};
        commits[current.hash].author = line.substring(7);
      }
      if (line.startsWith('author-time ')) {
        if (!commits[current.hash]) commits[current.hash] = {};
        commits[current.hash].time = parseInt(line.substring(12));
      }
      if (line.startsWith('summary ')) {
        if (!commits[current.hash]) commits[current.hash] = {};
        commits[current.hash].summary = line.substring(8);
      }
      if (line.startsWith('\t')) {
        lines.push({
          line: current.finalLine,
          hash: current.hash.substring(0, 8),
          author: commits[current.hash]?.author || '',
          summary: commits[current.hash]?.summary || '',
          time: commits[current.hash]?.time || 0,
        });
      }
    });
    return { lines };
  } catch (err) {
    return { lines: [], error: err.message };
  }
});

// D7: Conflict detection
ipcMain.handle('git-conflicts', async (_event, { worktreePath }) => {
  try {
    const output = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd: worktreePath, stdio: 'pipe',
    }).toString();
    const files = output.split('\n').filter(Boolean);
    return { files };
  } catch {
    return { files: [] };
  }
});

// ---- Phase E: Reliability / Diagnostics ----

// E1: Log viewer
ipcMain.handle('get-logs', () => {
  return logBuffer.slice();
});

// E2: Export session transcript
ipcMain.handle('export-transcript', async (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Session Transcript',
    defaultPath: path.join(app.getPath('documents'), inst.name + '-transcript.txt'),
    filters: [{ name: 'Text', extensions: ['txt'] }, { name: 'Markdown', extensions: ['md'] }],
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  // The transcript will be sent from the renderer (xterm buffer)
  return { filePath: result.filePath };
});

ipcMain.handle('write-transcript', (_event, { filePath, content }) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// E3: Per-task env vars — stored in create-task and passed to pty spawn
// The create-task handler already exists; we extend the modal to pass env/cwd
// and store them on the instance. The spawn functions already use worktreePath as cwd.

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

  let isGitRepo = false;
  try {
    execSync('git rev-parse --git-dir', { cwd: projectPath, stdio: 'pipe' });
    isGitRepo = true;
  } catch {}

  if (!isGitRepo) {
    const { response } = await dialog.showMessageBox(mainWindow, {
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

ipcMain.handle('list-worktrees', () => {
  const config = loadConfig();
  const repoPath = config.repoPath;
  if (!repoPath) return [];

  // Verify it's a git repo before listing worktrees
  try {
    execSync('git rev-parse --git-dir', { cwd: repoPath, stdio: 'pipe' });
  } catch {
    return [];
  }

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

// ---- Preferences Window (B1-B4) ----

let prefsWindow = null;

ipcMain.handle('open-preferences', () => {
  if (prefsWindow && !prefsWindow.isDestroyed()) {
    prefsWindow.focus();
    return { ok: true };
  }

  prefsWindow = new BrowserWindow({
    width: 520,
    height: 560,
    title: 'Preferences',
    icon: path.join(__dirname, 'icon.icns'),
    backgroundColor: '#1a1a2e',
    resizable: true,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  prefsWindow.loadFile(path.join(__dirname, 'renderer', 'preferences.html'));
  prefsWindow.on('closed', () => { prefsWindow = null; });
  return { ok: true };
});

ipcMain.handle('get-preferences', () => {
  const config = loadConfig();
  return {
    fontFamily: config.fontFamily || "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    fontSize: config.fontSize || 13,
    lineHeight: config.lineHeight || 1.2,
    cursorStyle: config.cursorStyle || 'block',
    claudePath: config.claudePath || '',
    defaultMode: config.defaultMode || 'claude',
    theme: config.theme || { preset: 'dark' },
    keybindings: config.keybindings || {},
    autoFetchInterval: config.autoFetchInterval || 60000,
  };
});

ipcMain.handle('set-preferences', (_event, prefs) => {
  const config = loadConfig();
  if (prefs.fontFamily !== undefined) config.fontFamily = prefs.fontFamily;
  if (prefs.fontSize !== undefined) config.fontSize = prefs.fontSize;
  if (prefs.lineHeight !== undefined) config.lineHeight = prefs.lineHeight;
  if (prefs.cursorStyle !== undefined) config.cursorStyle = prefs.cursorStyle;
  if (prefs.claudePath !== undefined) config.claudePath = prefs.claudePath;
  if (prefs.defaultMode !== undefined) config.defaultMode = prefs.defaultMode;
  if (prefs.theme !== undefined) config.theme = prefs.theme;
  if (prefs.keybindings !== undefined) config.keybindings = prefs.keybindings;
  if (prefs.autoFetchInterval !== undefined) {
    config.autoFetchInterval = prefs.autoFetchInterval;
    startAutoFetch(); // Reset the auto-fetch timer
  }
  saveConfig(config);

  // Broadcast to all windows so they can apply changes live
  for (const win of allWindows) {
    if (!win.isDestroyed()) win.webContents.send('preferences-changed', prefs);
  }
  return { ok: true };
});

ipcMain.handle('get-claude-info', async () => {
  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  try {
    const version = execFileSync(claudeBin, ['--version'], { stdio: 'pipe', timeout: 5000 }).toString().trim();
    return { path: claudeBin, version };
  } catch {
    return { path: claudeBin, version: 'not found' };
  }
});

// ---- File Tree & Search (C1-C3) ----

ipcMain.handle('list-files', async (_event, { worktreePath }) => {
  try {
    const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: worktreePath, stdio: 'pipe', maxBuffer: 5 * 1024 * 1024,
    }).toString();
    const files = output.split('\n').filter(Boolean);
    return { files };
  } catch (err) {
    return { files: [], error: err.message };
  }
});

ipcMain.handle('search-files', async (_event, { worktreePath, query }) => {
  try {
    const args = ['grep', '-n', '--no-color', '-I', '-r', '--max-count=5', query];
    const output = execFileSync('git', args, {
      cwd: worktreePath, stdio: 'pipe', maxBuffer: 5 * 1024 * 1024, timeout: 10000,
    }).toString();
    const results = [];
    output.split('\n').filter(Boolean).forEach(function (line) {
      var match = line.match(/^([^:]+):(\d+):(.*)$/);
      if (match) {
        results.push({ file: match[1], line: parseInt(match[2], 10), text: match[3] });
      }
    });
    // Cap at 100 results
    return { results: results.slice(0, 100) };
  } catch (err) {
    // git grep returns exit code 1 when no matches found
    if (err.status === 1) return { results: [] };
    return { results: [], error: err.message };
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

// ---- PR Comment AI Review ----

ipcMain.handle('pr-ai-review-comment', async (_event, { worktreePath, prTitle, prBody, commentAuthor, commentBody, filePath, diffHunk }) => {
  let context = `PR Title: ${prTitle}\n`;
  if (prBody) context += `PR Description: ${prBody}\n`;
  if (filePath) context += `File: ${filePath}\n`;
  if (diffHunk) context += `Code context:\n\`\`\`\n${diffHunk}\n\`\`\`\n`;

  const prompt = `You are reviewing a PR comment. Analyze whether the comment raises a valid concern, and draft a concise reply.

${context}
Comment by ${commentAuthor}:
"${commentBody}"

Respond in this exact format:
VALIDITY: [Valid / Partially Valid / Not Valid] — one sentence explaining why.
SUGGESTED REPLY:
[Your drafted reply to post on the PR. Be professional, concise, and constructive. If the concern is valid, acknowledge it and describe how you'll address it. If not, explain why politely.]`;

  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  return new Promise((resolve) => {
    execFile(claudeBin, ['-p', prompt], {
      cwd: worktreePath,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: stderr || err.message });
      } else {
        resolve({ review: stdout.trim() });
      }
    });
  });
});

// ---- PR Threaded Reply ----

ipcMain.handle('pr-reply-to-comment', async (_event, { worktreePath, prNumber, commentId, body }) => {
  try {
    const repoResult = ghExec(['repo', 'view', '--json', 'nameWithOwner'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const repo = JSON.parse(repoResult).nameWithOwner;
    ghExec(['api', '-X', 'POST',
      'repos/' + repo + '/pulls/' + prNumber + '/comments',
      '-F', 'in_reply_to=' + commentId,
      '-f', 'body=' + body,
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- PR Interaction ----

ipcMain.handle('pr-for-branch', async (_event, { worktreePath }) => {
  try {
    const result = ghExec([
      'pr', 'view', '--json',
      'number,title,state,body,url,headRefName,baseRefName,additions,deletions,reviewDecision,comments,reviews'
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 15000 }).toString();
    return { pr: JSON.parse(result) };
  } catch (err) {
    const msg = (err.stderr ? err.stderr.toString() : err.message) || '';
    if (msg.includes('no pull requests found')) {
      return { pr: null };
    }
    if (msg.includes('Could not resolve')) {
      return { pr: null, error: 'Cannot access this repository. Check that `gh` is authenticated with the correct GitHub account.' };
    }
    return { pr: null, error: msg };
  }
});

ipcMain.handle('pr-checks', async (_event, { worktreePath, prNumber }) => {
  try {
    const out = ghExec(
      ['pr', 'checks', String(prNumber), '--json', 'name,state,bucket,link,workflow,description'],
      { cwd: worktreePath, stdio: 'pipe', timeout: 15000 }
    ).toString();
    return { checks: JSON.parse(out) };
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : err.message;
    // `gh pr checks` exits non-zero when checks are failing — the JSON still
    // prints to stdout. Try to recover from err.stdout before giving up.
    if (err.stdout) {
      try { return { checks: JSON.parse(err.stdout.toString()) }; } catch {}
    }
    // "no checks reported" is not an error
    if (msg && /no checks reported/i.test(msg)) {
      return { checks: [] };
    }
    return { checks: [], error: msg };
  }
});

ipcMain.handle('pr-review-comments', async (_event, { worktreePath, prNumber }) => {
  try {
    // Get inline review comments via gh api
    const repoResult = ghExec(['repo', 'view', '--json', 'nameWithOwner'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const repo = JSON.parse(repoResult).nameWithOwner;
    const comments = ghExec(['api', 'repos/' + repo + '/pulls/' + prNumber + '/comments'], {
      cwd: worktreePath, stdio: 'pipe', timeout: 15000
    }).toString();
    return { comments: JSON.parse(comments) };
  } catch (err) {
    return { comments: [], error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('pr-add-comment', async (_event, { worktreePath, prNumber, body }) => {
  try {
    ghExec(['pr', 'comment', String(prNumber), '--body', body], {
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
    ghExec(args, { cwd: worktreePath, stdio: 'pipe', timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- Merge Conflict Resolution (Feature 1) ----

ipcMain.handle('read-conflict-file', async (_event, { worktreePath, file }) => {
  try {
    const content = fs.readFileSync(path.join(worktreePath, file), 'utf-8');
    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-resolved-file', async (_event, { worktreePath, file, content }) => {
  try {
    fs.writeFileSync(path.join(worktreePath, file), content, 'utf-8');
    execFileSync('git', ['add', file], { cwd: worktreePath, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- .env File Viewer/Editor (Feature 12) ----

ipcMain.handle('list-env-files', async (_event, { worktreePath }) => {
  try {
    const entries = fs.readdirSync(worktreePath);
    const envFiles = entries.filter(f => /^\.env/.test(f) && fs.statSync(path.join(worktreePath, f)).isFile());
    return { files: envFiles };
  } catch (err) {
    return { files: [], error: err.message };
  }
});

ipcMain.handle('read-env-file', async (_event, { worktreePath, filename }) => {
  // Security: prevent path traversal
  if (filename.includes('/') || filename.includes('\\') || !filename.startsWith('.env')) {
    return { error: 'Invalid filename' };
  }
  try {
    const content = fs.readFileSync(path.join(worktreePath, filename), 'utf-8');
    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-env-file', async (_event, { worktreePath, filename, content }) => {
  // Security: prevent path traversal
  if (filename.includes('/') || filename.includes('\\') || !filename.startsWith('.env')) {
    return { error: 'Invalid filename' };
  }
  try {
    fs.writeFileSync(path.join(worktreePath, filename), content, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// ---- CI/CD Status (Feature 3) ----

const ciPollingIntervals = new Map(); // taskId -> intervalId

function startCIPolling(id, worktreePath, branch) {
  stopCIPolling(id);
  const poll = () => {
    try {
      const output = ghExec([
        'run', 'list', '--branch', branch, '--limit', '5',
        '--json', 'status,conclusion,name,url,createdAt'
      ], { cwd: worktreePath, stdio: 'pipe', timeout: 10000 }).toString();
      const runs = JSON.parse(output);
      for (const win of allWindows) {
        if (!win.isDestroyed()) {
          win.webContents.send('ci-status-update', { id, runs });
        }
      }
    } catch {}
  };
  // Initial poll after short delay
  setTimeout(poll, 3000);
  ciPollingIntervals.set(id, setInterval(poll, 30000));
}

function stopCIPolling(id) {
  const intervalId = ciPollingIntervals.get(id);
  if (intervalId) {
    clearInterval(intervalId);
    ciPollingIntervals.delete(id);
  }
}

ipcMain.handle('ci-status', async (_event, { worktreePath, branch }) => {
  try {
    const output = ghExec([
      'run', 'list', '--branch', branch, '--limit', '5',
      '--json', 'status,conclusion,name,url,createdAt'
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 10000 }).toString();
    return { runs: JSON.parse(output) };
  } catch (err) {
    return { runs: [], error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('ci-run-logs', async (_event, { worktreePath, runId }) => {
  try {
    const output = ghExec(['run', 'view', String(runId), '--log-failed'], {
      cwd: worktreePath, stdio: 'pipe', timeout: 15000, maxBuffer: 5 * 1024 * 1024
    }).toString();
    return { logs: output };
  } catch (err) {
    return { logs: '', error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- Git Tags (Feature 11) ----

ipcMain.handle('git-tags', async (_event, { worktreePath }) => {
  try {
    const output = execFileSync('git', ['tag', '-l', '--sort=-creatordate',
      '--format=%(refname:short)\t%(objectname:short)\t%(subject)\t%(creatordate:short)'],
      { cwd: worktreePath, stdio: 'pipe', maxBuffer: 5 * 1024 * 1024 }).toString();
    const tags = output.split('\n').filter(Boolean).map(line => {
      const [name, commit, message, date] = line.split('\t');
      return { name, commit, message: message || '', date: date || '' };
    });
    return { tags };
  } catch (err) {
    return { tags: [], error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-tag-create', async (_event, { worktreePath, name, message, commit }) => {
  try {
    const args = ['tag'];
    if (message) {
      args.push('-a', name, '-m', message);
    } else {
      args.push(name);
    }
    if (commit) args.push(commit);
    execFileSync('git', args, { cwd: worktreePath, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-tag-delete', async (_event, { worktreePath, name }) => {
  try {
    execFileSync('git', ['tag', '-d', name], { cwd: worktreePath, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-tag-push', async (_event, { worktreePath, name }) => {
  try {
    execFileSync('git', ['push', 'origin', name], { cwd: worktreePath, stdio: 'pipe', timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- Task Notes (Feature 14) ----

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

// ---- Auto-fetch (Feature 15) ----

let autoFetchIntervalId = null;

function startAutoFetch() {
  if (autoFetchIntervalId) {
    clearInterval(autoFetchIntervalId);
    autoFetchIntervalId = null;
  }
  const config = loadConfig();
  const interval = config.autoFetchInterval || 60000; // default 60s
  if (interval <= 0) return;

  autoFetchIntervalId = setInterval(() => {
    for (const [id, inst] of instances) {
      if (!inst.alive || !inst.worktreePath) continue;
      try {
        execFileSync('git', ['fetch', '--prune'], { cwd: inst.worktreePath, stdio: 'pipe', timeout: 10000 });
        // Compute ahead/behind
        try {
          const ab = execFileSync('git', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], {
            cwd: inst.worktreePath, stdio: 'pipe', timeout: 5000,
          }).toString().trim();
          const parts = ab.split(/\s+/);
          const ahead = parseInt(parts[0], 10) || 0;
          const behind = parseInt(parts[1], 10) || 0;
          for (const win of allWindows) {
            if (!win.isDestroyed()) {
              win.webContents.send('auto-fetch-update', { id, ahead, behind });
            }
          }
        } catch {}
      } catch {}
    }
  }, interval);
}

// ---- Phase 7: File Viewer ----

ipcMain.handle('read-file', async (_event, { filePath }) => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { content, ext: path.extname(filePath).slice(1) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-file', async (_event, { filePath, content }) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});
