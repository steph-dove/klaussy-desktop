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
  // Force the macOS app menu name. In dev (`npx electron .`) the bundled
  // Info.plist still says "Electron" — setName at startup overrides what
  // the menu template's `label: app.name` resolves to so the menu bar
  // shows "Klaussy" instead.
  app.setName('Klaussy');

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
        { role: 'pasteAndMatchStyle' },
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
        { type: 'separator' },
        {
          label: 'Logs',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-logs');
          },
        },
        {
          label: 'How to use Klaussy',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-how-to-use');
          },
        },
        {
          label: 'Skills && Commands',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-skills');
          },
        },
        {
          label: 'Memory (CLAUDE.md)',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-memory');
          },
        },
        {
          label: 'MCP Servers',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-mcp');
          },
        },
        {
          label: 'Plugins',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-plugins');
          },
        },
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-shortcuts');
          },
        },
        {
          label: 'Send feedback…',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-feedback');
          },
        },
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

ipcMain.handle('create-task', async (_event, { name, repoPath, mode, basePath, envVars, baseBranch: requestedBase }) => {
  // Validate repoPath is a git repo
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoPath, stdio: 'pipe' });
  } catch {
    return { error: 'Active project is not a git repository. Remove and re-add the project to initialize git.' };
  }

  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const branch = `${sanitized}`;

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

function spawnInWorktree(name, worktreePath, branch, mode, resumeSessionId, extraEnv, prNumber) {
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
    // G5: if this task was spawned from a PR review "Check out locally", the
    // PR number is recorded here so pr-for-branch can load the PR directly
    // instead of guessing from branch-name heuristics (which fail for fork
    // PRs where the local branch name differs from the original head ref).
    prNumber: prNumber || null,
    prBaseOwner: null,
    prBaseRepo: null,
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

// List Claude skills + slash commands from disk so users can discover what
// they have installed without leaving Klaussy. Walks user-level skills + a
// source per klausify project (most users keep skills per-repo, so showing
// just the active project would hide most of what they have).
ipcMain.handle('list-skills', async () => {
  const homedir = require('os').homedir();
  const sources = [
    { kind: 'user', label: 'user', skillsDir: path.join(homedir, '.claude', 'skills'), cmdsDir: path.join(homedir, '.claude', 'commands') },
  ];
  const config = loadConfig();
  const projects = config.projects || [];
  for (const p of projects) {
    if (!p || !p.path) continue;
    sources.push({
      kind: 'project',
      label: p.name || path.basename(p.path),
      skillsDir: path.join(p.path, '.claude', 'skills'),
      cmdsDir: path.join(p.path, '.claude', 'commands'),
    });
  }
  // Belt-and-suspenders: include the currently-active repo even if it
  // isn't in config.projects (rare, but happens during transient setup).
  const active = currentRepoPath();
  if (active && !projects.find((p) => p && p.path === active)) {
    sources.push({
      kind: 'project',
      label: path.basename(active),
      skillsDir: path.join(active, '.claude', 'skills'),
      cmdsDir: path.join(active, '.claude', 'commands'),
    });
  }

  function parseFrontmatter(text) {
    if (!text) return { name: '', description: '' };
    const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return { name: '', description: '' };
    const out = {};
    m[1].split('\n').forEach((line) => {
      const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
      if (!kv) return;
      let val = kv[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[kv[1]] = val;
    });
    return out;
  }

  const skills = [];
  const commands = [];

  for (const src of sources) {
    // Skills: each subdirectory of skillsDir is a skill; SKILL.md inside.
    try {
      const entries = fs.readdirSync(src.skillsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const skillFile = path.join(src.skillsDir, ent.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        const text = fs.readFileSync(skillFile, 'utf8');
        const fm = parseFrontmatter(text);
        skills.push({
          name: fm.name || ent.name,
          description: fm.description || '',
          source: src.label,
          path: skillFile,
        });
      }
    } catch (_) { /* dir doesn't exist — fine */ }

    // Slash commands: <name>.md files in commands dir.
    try {
      const entries = fs.readdirSync(src.cmdsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
        const file = path.join(src.cmdsDir, ent.name);
        const text = fs.readFileSync(file, 'utf8');
        const fm = parseFrontmatter(text);
        // Body after frontmatter for a fallback description.
        let body = text.replace(/^---[\s\S]*?\n---\s*/, '').trim();
        commands.push({
          name: '/' + ent.name.replace(/\.md$/, ''),
          description: fm.description || body.split('\n')[0].slice(0, 160),
          source: src.label,
          path: file,
        });
      }
    } catch (_) {}
  }

  // Sort: user first, then projects alphabetically by label, then by name
  // within each source.
  const sorter = (a, b) => {
    if (a.source === 'user' && b.source !== 'user') return -1;
    if (b.source === 'user' && a.source !== 'user') return 1;
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.name.localeCompare(b.name);
  };
  skills.sort(sorter);
  commands.sort(sorter);
  return { skills, commands };
});

ipcMain.handle('open-skill-file', (_event, { filePath }) => {
  if (!filePath) return { ok: false };
  shell.openPath(filePath);
  return { ok: true };
});

ipcMain.handle('read-skill-file', (_event, { filePath }) => {
  if (!filePath) return { error: 'No file path' };
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-skill-file', (_event, { filePath, content }) => {
  if (!filePath) return { error: 'No file path' };
  if (typeof content !== 'string') return { error: 'Content must be a string' };
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// List CLAUDE.md memory files across scopes. Each scope has at most one
// memory file — the dialog uses this to show what's there vs. missing.
ipcMain.handle('list-memory-files', () => {
  const homedir = require('os').homedir();
  const out = [];
  const scopes = [
    { kind: 'user', label: 'user', file: path.join(homedir, '.claude', 'CLAUDE.md') },
  ];
  const config = loadConfig();
  const projects = config.projects || [];
  for (const p of projects) {
    if (!p || !p.path) continue;
    // Project root is the canonical location; fall back to .claude/CLAUDE.md
    // if the user keeps it there instead.
    const rootFile = path.join(p.path, 'CLAUDE.md');
    const dotFile = path.join(p.path, '.claude', 'CLAUDE.md');
    const file = fs.existsSync(rootFile) ? rootFile : (fs.existsSync(dotFile) ? dotFile : rootFile);
    scopes.push({ kind: 'project', label: p.name || path.basename(p.path), file });
  }
  for (const s of scopes) {
    out.push({
      scope: s.label,
      kind: s.kind,
      path: s.file,
      exists: fs.existsSync(s.file),
    });
  }
  return { entries: out };
});

// MCP server inventory. Reads user + project mcp configs from the canonical
// locations claude looks at. Returns each entry's name, command, args, env
// vars (keys only — never values) so the dialog can render a status table.
ipcMain.handle('list-mcp-servers', () => {
  const homedir = require('os').homedir();
  const sources = [
    { kind: 'user', label: 'user', files: [
      path.join(homedir, '.claude.json'),
      path.join(homedir, '.claude', 'mcp.json'),
    ] },
  ];
  const config = loadConfig();
  const projects = config.projects || [];
  for (const p of projects) {
    if (!p || !p.path) continue;
    sources.push({
      kind: 'project',
      label: p.name || path.basename(p.path),
      files: [
        path.join(p.path, '.mcp.json'),
        path.join(p.path, '.claude', 'mcp.json'),
      ],
    });
  }
  const servers = [];
  for (const src of sources) {
    for (const file of src.files) {
      if (!fs.existsSync(file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const map = (raw && raw.mcpServers) || {};
        for (const [name, def] of Object.entries(map)) {
          if (!def || typeof def !== 'object') continue;
          servers.push({
            name,
            source: src.label,
            sourceKind: src.kind,
            sourceFile: file,
            command: def.command || '',
            args: Array.isArray(def.args) ? def.args : [],
            envKeys: def.env && typeof def.env === 'object' ? Object.keys(def.env) : [],
            type: def.type || 'stdio',
          });
        }
      } catch (_) { /* malformed config — skip silently */ }
    }
  }
  servers.sort((a, b) => {
    if (a.sourceKind === 'user' && b.sourceKind !== 'user') return -1;
    if (b.sourceKind === 'user' && a.sourceKind !== 'user') return 1;
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.name.localeCompare(b.name);
  });
  return { servers };
});

// Plugin inventory. Plugins live under ~/.claude/plugins/<name>/ — we read
// each plugin's plugin.json (or package.json fallback) to get name +
// description + what it bundles (skills/commands/agents).
ipcMain.handle('list-plugins', () => {
  const homedir = require('os').homedir();
  const root = path.join(homedir, '.claude', 'plugins');
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return { plugins: out }; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const pluginDir = path.join(root, ent.name);
    let manifest = {};
    for (const candidate of ['plugin.json', 'package.json', 'manifest.json']) {
      const f = path.join(pluginDir, candidate);
      if (!fs.existsSync(f)) continue;
      try { manifest = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch (_) {}
    }
    // Rough inventory of what the plugin bundles.
    const bundles = [];
    for (const sub of ['skills', 'commands', 'agents', 'hooks']) {
      const d = path.join(pluginDir, sub);
      try {
        const items = fs.readdirSync(d).filter((f) => !f.startsWith('.'));
        if (items.length > 0) bundles.push(sub + ' (' + items.length + ')');
      } catch (_) {}
    }
    out.push({
      name: manifest.name || ent.name,
      description: manifest.description || '',
      version: manifest.version || '',
      author: typeof manifest.author === 'string' ? manifest.author : (manifest.author && manifest.author.name) || '',
      path: pluginDir,
      bundles,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { plugins: out };
});

ipcMain.handle('create-memory-file', (_event, { filePath }) => {
  if (!filePath) return { error: 'No file path' };
  if (fs.existsSync(filePath)) return { error: 'File already exists.' };
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const starter = '# Project memory\n\n'
      + 'Notes Claude should keep in mind for this scope. Examples:\n\n'
      + '- Coding conventions to follow.\n'
      + '- Files / folders to ignore.\n'
      + '- Domain terminology that may otherwise be ambiguous.\n';
    fs.writeFileSync(filePath, starter, 'utf8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Create a new skill or slash-command in the chosen scope. Writes a starter
// file with frontmatter so the user has somewhere to start instead of an
// empty doc; the dialog opens it for editing immediately.
ipcMain.handle('create-skill-file', (_event, { type, scope, name }) => {
  if (type !== 'skill' && type !== 'command') return { error: 'Unknown type: ' + type };
  if (!name || !/^[a-zA-Z0-9_-][a-zA-Z0-9_-]*$/.test(name)) {
    return { error: 'Name must contain only letters, numbers, dashes, and underscores.' };
  }
  // Resolve the scope's .claude root.
  let root;
  if (scope === 'user') {
    root = path.join(require('os').homedir(), '.claude');
  } else {
    // scope is the absolute project path.
    if (!scope || !fs.existsSync(scope)) return { error: 'Invalid project scope: ' + scope };
    root = path.join(scope, '.claude');
  }

  let filePath, starter;
  if (type === 'skill') {
    const skillDir = path.join(root, 'skills', name);
    filePath = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(filePath)) return { error: 'A skill named "' + name + '" already exists in this scope.' };
    try { fs.mkdirSync(skillDir, { recursive: true }); }
    catch (err) { return { error: 'Could not create skill dir: ' + err.message }; }
    starter = '---\n'
      + 'name: ' + name + '\n'
      + 'description: One-line description used by Claude to decide when to apply this skill.\n'
      + '---\n\n'
      + '# ' + name + '\n\n'
      + 'Describe what this skill does, when to use it, and any guardrails.\n';
  } else {
    const cmdsDir = path.join(root, 'commands');
    filePath = path.join(cmdsDir, name + '.md');
    if (fs.existsSync(filePath)) return { error: 'A slash command named "' + name + '" already exists in this scope.' };
    try { fs.mkdirSync(cmdsDir, { recursive: true }); }
    catch (err) { return { error: 'Could not create commands dir: ' + err.message }; }
    starter = '---\n'
      + 'description: One-line description shown when the user types /\n'
      + '---\n\n'
      + 'Instructions Claude should follow when /' + name + ' is invoked.\n';
  }

  try {
    fs.writeFileSync(filePath, starter, 'utf8');
    return { path: filePath, name: name, type: type };
  } catch (err) {
    return { error: 'Could not write file: ' + err.message };
  }
});

// Pre-launch dep check: probe gh + claude so a first-run dialog can guide
// the user through setup instead of letting them hit cryptic IPC errors
// downstream when these CLIs are missing or unauthed.
ipcMain.handle('check-dependencies', async () => {
  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';

  function probe(cmd, args) {
    try {
      const out = execFileSync(cmd, args, { stdio: 'pipe', timeout: 5000 }).toString().trim();
      return { ok: true, output: out };
    } catch (err) {
      return { ok: false, error: (err.stderr ? err.stderr.toString() : err.message).trim() };
    }
  }

  const ghVersion = probe('gh', ['--version']);
  const ghAuth = ghVersion.ok ? probe('gh', ['auth', 'status']) : { ok: false, error: 'gh not installed' };
  const claudeVersion = probe(claudeBin, ['--version']);

  return {
    gh: {
      installed: ghVersion.ok,
      authed: ghAuth.ok,
      version: ghVersion.ok ? ghVersion.output.split('\n')[0] : null,
      authError: ghAuth.ok ? null : ghAuth.error,
    },
    claude: {
      installed: claudeVersion.ok,
      version: claudeVersion.ok ? claudeVersion.output : null,
      path: claudeBin,
    },
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

ipcMain.handle('git-apply-patch', async (_event, { worktreePath, patch, reverse }) => {
  try {
    const args = ['apply', '--cached', '--whitespace=nowarn'];
    if (reverse) args.push('-R');
    execFileSync('git', args, {
      cwd: worktreePath,
      input: patch,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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

// ---- H2: Cross-task review inbox aggregator ----
//
// Runs git ops truly in parallel (async execFile) so aggregating N worktrees
// costs ~max(per-worktree) instead of ~sum. Per-worktree errors degrade to a
// zeroed row with `error:` set rather than rejecting the whole Promise.all.
const execFileP = require('util').promisify(execFile);

async function collectWorktreeState(task) {
  const cwd = task.worktreePath;
  try {
    const [statusOut, branchOut, ahead] = await Promise.all([
      execFileP('git', ['status', '--porcelain'], { cwd, maxBuffer: 10 * 1024 * 1024 })
        .then(r => r.stdout).catch(() => ''),
      execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
        .then(r => r.stdout.trim()).catch(() => ''),
      (async () => {
        try {
          const up = (await execFileP('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd })).stdout.trim();
          const counts = (await execFileP('git', ['rev-list', '--left-right', '--count', up + '...HEAD'], { cwd })).stdout.trim();
          const [behind, ahead] = counts.split(/\s+/).map(n => parseInt(n, 10) || 0);
          return { ahead, behind };
        } catch { return { ahead: 0, behind: 0 }; }
      })(),
    ]);
    // Porcelain status: first col = index (staged), second col = worktree (unstaged).
    // "??" is untracked. "MM" etc. counts in both staged and unstaged.
    let staged = 0, unstaged = 0, untracked = 0;
    for (const line of statusOut.split('\n')) {
      if (!line) continue;
      const x = line.charAt(0), y = line.charAt(1);
      if (x === '?' && y === '?') { untracked++; continue; }
      if (x !== ' ' && x !== '?') staged++;
      if (y !== ' ' && y !== '?') unstaged++;
    }
    return {
      taskId: task.id, branch: branchOut,
      staged, unstaged, untracked,
      ahead: ahead.ahead, behind: ahead.behind,
    };
  } catch (err) {
    return {
      taskId: task.id, branch: '',
      staged: 0, unstaged: 0, untracked: 0,
      ahead: 0, behind: 0,
      error: err.message,
    };
  }
}

ipcMain.handle('list-all-dirty-worktrees', async () => {
  return Promise.all(Array.from(instances.values()).map(collectWorktreeState));
});

ipcMain.handle('get-worktree-state', async (_event, { taskId }) => {
  const task = instances.get(taskId);
  if (!task) return null;
  return collectWorktreeState(task);
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

// ---- Phase G: Review others' PRs ----
//
// activePrReview is the single source of truth so the main-window panel and
// the detached pop-out see the same state (no duplicate fetches, no lost
// pending comments). null = no review open.

let activePrReview = null; // { repo, number, meta, diff, popout: BrowserWindow|null }

function broadcastPrReview() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('pr-review-state', activePrReview ? sanitizePrReview(activePrReview) : null);
  }
}

function sanitizePrReview(s) {
  // Strip the BrowserWindow reference — not serializable across IPC.
  const { popout, ...rest } = s;
  return { ...rest, popped: !!popout };
}

function ghJson(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error('gh returned non-JSON: ' + stdout.slice(0, 200))); }
    });
  });
}

function ghText(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
  });
}

function currentRepoPath() {
  const config = loadConfig();
  return config.repoPath || null;
}

ipcMain.handle('pr-list', async () => {
  const cwd = currentRepoPath();
  if (!cwd) return { error: 'No active project. Add a project first.' };
  try {
    const prs = await ghJson([
      'pr', 'list',
      '--json', 'number,title,author,state,updatedAt,headRefName,baseRefName,isDraft,reviewDecision,url',
      '--limit', '50',
    ], cwd);
    return { prs };
  } catch (err) {
    return { error: (err.stderr || err.message || '').trim() };
  }
});

ipcMain.handle('pr-lookup-url', async (_event, { url }) => {
  // gh just needs a valid cwd (any git repo or non-repo dir works for a
  // URL-targeted call). Falling back to homedir lets reviewers use Klaussy
  // without first adding a klausify project.
  const cwd = currentRepoPath() || require('os').homedir();
  try {
    const meta = await ghJson([
      'pr', 'view', url,
      '--json', 'number,title,author,state,updatedAt,headRefName,baseRefName,isDraft,reviewDecision,url,body,headRepository,headRepositoryOwner',
    ], cwd);
    return { meta };
  } catch (err) {
    return { error: (err.stderr || err.message || '').trim() };
  }
});

// GitHub PR URLs always encode the base repo: /{owner}/{repo}/pull/{n}.
// Using the URL avoids an extra gh call and works for both the picker path
// and the paste-URL path, since `gh pr view --json url` is always populated.
function parseBaseFromUrl(url) {
  if (!url) return null;
  const m = url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/\d+/);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}

ipcMain.handle('pr-load', async (_event, { number, url }) => {
  // URL-form calls don't need an active project — gh derives the repo from
  // the URL. The number-only form (used by the picker's "open in current
  // project" list) does, since gh resolves it against the cwd's origin.
  if (!url && !currentRepoPath()) {
    return { error: 'Add a project to look up PRs by number, or paste a full PR URL.' };
  }
  const cwd = currentRepoPath() || require('os').homedir();
  const target = url || String(number);
  try {
    const [meta, diff] = await Promise.all([
      ghJson([
        'pr', 'view', target,
        '--json', 'number,title,author,state,createdAt,updatedAt,headRefName,baseRefName,headRefOid,isDraft,reviewDecision,url,body,headRepository,headRepositoryOwner,mergeable,mergeStateStatus',
      ], cwd),
      ghText(['pr', 'diff', target], cwd),
    ]);
    const base = parseBaseFromUrl(meta.url);
    const repo = base ? `${base.owner}/${base.name}` : null;
    activePrReview = {
      repo, number: meta.number, meta, diff,
      baseOwner: base ? base.owner : null,
      baseRepo: base ? base.name : null,
      threads: null, // null = loading, [] = loaded-empty
      threadsError: null,
      popout: null,
    };
    broadcastPrReview();

    // Record this PR in review history (most recent first, deduped by URL,
    // capped at 20). Separate from load-path so a storage hiccup can't break
    // the review UI.
    try { pushReviewHistory(meta); } catch (_) {}

    // Fire-and-forget thread fetch; broadcasts again when ready so the renderer
    // can paint the shell immediately without waiting on the GraphQL round-trip.
    fetchThreadsForActive();

    return { ok: true };
  } catch (err) {
    return { error: (err.stderr || err.message || '').trim() };
  }
});

function pushReviewHistory(meta) {
  if (!meta || !meta.url) return;
  const config = loadConfig();
  const history = (config.reviewHistory || []).filter(e => e.url !== meta.url);
  history.unshift({
    url: meta.url,
    number: meta.number,
    title: meta.title || '',
    author: (meta.author && (meta.author.login || meta.author.name)) || '',
    state: meta.state || '',
    isDraft: !!meta.isDraft,
    headRefName: meta.headRefName || '',
    baseRefName: meta.baseRefName || '',
    viewedAt: new Date().toISOString(),
  });
  config.reviewHistory = history.slice(0, 20);
  saveConfig(config);
}

ipcMain.handle('pr-recent', () => {
  const config = loadConfig();
  return { items: config.reviewHistory || [] };
});

// GraphQL-backed thread fetch. Scoped to the *base* repo (target), not the
// head repo (fork), because threads live on the target.
async function fetchThreadsForActive() {
  if (!activePrReview) return;
  // gh api graphql doesn't need to run inside the target repo — owner/repo
  // are passed as query variables. Falling back to homedir means reviewers
  // without an active klausify project still get threads + comments.
  const cwd = currentRepoPath() || require('os').homedir();
  if (!activePrReview.baseOwner || !activePrReview.baseRepo) {
    activePrReview.threadsError = 'Could not parse base repo from PR url';
    broadcastPrReview();
    return;
  }
  const owner = activePrReview.baseOwner;
  const repo = activePrReview.baseRepo;
  const number = activePrReview.number;

  // One round trip for threads + issue-comments + reviews. Conversation tab
  // reads from comments + reviews; Files tab reads from reviewThreads. There's
  // duplication between review.comments and reviewThreads.comments, but the
  // two consumers render different shapes, so we keep both and let them pick.
  const query = 'query($owner: String!, $repo: String!, $number: Int!) {'
    + '  repository(owner: $owner, name: $repo) {'
    + '    pullRequest(number: $number) {'
    + '      reviewThreads(first: 100) {'
    + '        nodes {'
    + '          id isResolved isOutdated path line originalLine startLine originalStartLine diffSide'
    + '          comments(first: 100) { nodes { databaseId author { login } createdAt body diffHunk } }'
    + '        }'
    + '      }'
    + '      comments(first: 100) {'
    + '        nodes { databaseId author { login } createdAt body url }'
    + '      }'
    + '      reviews(first: 100) {'
    + '        nodes {'
    + '          databaseId state body submittedAt author { login }'
    + '          comments(first: 100) { nodes { databaseId body path line diffHunk } }'
    + '        }'
    + '      }'
    + '    }'
    + '  }'
    + '}';

  try {
    const out = await new Promise((resolve, reject) => {
      execFile('gh', [
        'api', 'graphql',
        '-f', 'query=' + query,
        '-f', 'owner=' + owner,
        '-f', 'repo=' + repo,
        '-F', 'number=' + number,
      ], { cwd, maxBuffer: 50 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
        if (err) { err.stderr = stderr; err.stdout = stdout; return reject(err); }
        resolve(stdout);
      });
    });
    const parsed = JSON.parse(out);
    if (parsed.errors && parsed.errors.length) {
      if (!activePrReview || activePrReview.number !== number) return;
      activePrReview.threadsError = parsed.errors.map(e => e.message).join('; ');
      broadcastPrReview();
      return;
    }
    const pr = parsed.data && parsed.data.repository && parsed.data.repository.pullRequest;
    const threads = (pr && pr.reviewThreads && pr.reviewThreads.nodes) || [];
    const issueComments = (pr && pr.comments && pr.comments.nodes) || [];
    const reviews = (pr && pr.reviews && pr.reviews.nodes) || [];
    // User may have navigated away while we were fetching; bail if the review
    // behind us was swapped for a different PR.
    if (!activePrReview || activePrReview.number !== number) return;
    activePrReview.threads = threads;
    activePrReview.issueComments = issueComments;
    activePrReview.reviews = reviews;
    activePrReview.threadsError = null;
    broadcastPrReview();
  } catch (err) {
    if (!activePrReview || activePrReview.number !== number) return;
    // gh api writes error JSON to stdout on non-zero exit
    let msg = (err.stderr || err.message || '').trim();
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout.toString());
        if (parsed.errors) msg = parsed.errors.map(e => e.message).join('; ');
      } catch (_) {}
    }
    activePrReview.threadsError = msg;
    broadcastPrReview();
  }
}

ipcMain.handle('pr-refresh-threads', async () => {
  if (!activePrReview) return { error: 'No active PR review' };
  await fetchThreadsForActive();
  return { ok: true };
});

// G6: CI checks scoped to the PR review surface. `gh pr checks -R …`
// mangles the repo name in its GraphQL query on some gh versions. Using
// `gh pr view -R … --json statusCheckRollup` reads the same rollup through a
// different code path that handles the -R flag cleanly, and reshapes to the
// { name, state, bucket, link, workflow, description } shape the renderer
// already knows how to draw.
ipcMain.handle('pr-review-checks', async () => {
  if (!activePrReview) return { error: 'No active PR review' };
  const { meta, baseOwner, baseRepo } = activePrReview;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const sha = meta && meta.headRefOid;
  if (!sha) return { checks: [], error: 'Missing head commit sha' };
  const cwd = currentRepoPath() || require('os').homedir();

  // REST endpoint is more forgiving than gh's GraphQL path for this repo
  // (which throws "Could not resolve to a Repository" on both `gh pr checks`
  // and a custom gh api graphql call). Runs + statuses are separate APIs,
  // so we fetch both in parallel and merge.
  async function run(args) {
    return new Promise((resolve) => {
      execFile('gh', ['api'].concat(args), { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
        (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    });
  }
  const [runsRes, statusRes] = await Promise.all([
    run([`repos/${baseOwner}/${baseRepo}/commits/${sha}/check-runs`, '--paginate']),
    run([`repos/${baseOwner}/${baseRepo}/commits/${sha}/status`]),
  ]);

  const checks = [];
  if (!runsRes.err) {
    try {
      const parsed = JSON.parse(runsRes.stdout);
      const runs = parsed.check_runs || [];
      runs.forEach((r) => checks.push(normalizeCheckRun(r)));
    } catch (_) {}
  }
  if (!statusRes.err) {
    try {
      const parsed = JSON.parse(statusRes.stdout);
      const statuses = parsed.statuses || [];
      statuses.forEach((s) => checks.push(normalizeStatus(s)));
    } catch (_) {}
  }

  // Both calls failed — surface the first real error so the user sees why.
  if (checks.length === 0 && (runsRes.err || statusRes.err)) {
    const first = runsRes.err || statusRes.err;
    const raw = (first.stderr ? first.stderr.toString() : first.message) || '';
    return { checks: [], error: raw.trim() };
  }
  return { checks };
});

function bucketFromState(rawState) {
  const s = (rawState || '').toLowerCase();
  if (s === 'success' || s === 'neutral') return 'pass';
  if (s === 'failure' || s === 'timed_out' || s === 'action_required' || s === 'error') return 'fail';
  if (s === 'cancelled') return 'cancel';
  if (s === 'skipped') return 'skipping';
  if (['queued', 'in_progress', 'pending', 'waiting', 'expected', 'requested'].includes(s)) return 'pending';
  return 'pending';
}

function normalizeCheckRun(r) {
  // GitHub REST check-run: { name, status, conclusion, details_url, output: {...}, app: { name }, ... }
  const rawState = (r.conclusion || r.status || '').toLowerCase();
  return {
    name: r.name || '(unnamed)',
    state: rawState,
    bucket: bucketFromState(rawState),
    link: r.details_url || r.html_url || '',
    workflow: (r.app && r.app.name) || '',
    description: (r.output && r.output.title) || '',
  };
}

function normalizeStatus(s) {
  // Legacy REST status: { context, state, target_url, description, ... }
  return {
    name: s.context || '(unnamed)',
    state: (s.state || '').toLowerCase(),
    bucket: bucketFromState(s.state),
    link: s.target_url || '',
    workflow: '',
    description: s.description || '',
  };
}

// Debug a single failing CI check. Pulls the failing job's logs, builds a
// prompt with PR description + diff + log tail, and streams claude's analysis
// back to the renderer. Same chunk/done event protocol as Explain so the
// renderer can reuse the same UX.
const debugCheckProcs = new Map();

ipcMain.handle('pr-debug-check-start', (event, { requestId, checkLink, checkName }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (debugCheckProcs.has(requestId)) return { error: 'Already debugging' };
  if (!activePrReview) return { error: 'No active PR review' };
  const { meta, baseOwner, baseRepo, diff } = activePrReview;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  if (!checkLink) return { error: 'Check has no run link to fetch logs from' };

  // GitHub job links look like:
  //   https://github.com/<owner>/<repo>/actions/runs/<runId>/job/<jobId>
  const m = checkLink.match(/\/actions\/runs\/(\d+)\/job\/(\d+)/);
  const runId = m ? m[1] : null;
  const jobId = m ? m[2] : null;
  if (!runId || !jobId) return { error: 'Could not parse run/job id from link: ' + checkLink };

  const cwd = currentRepoPath() || require('os').homedir();
  const sender = event.sender;
  const chunkChannel = 'pr-debug-check-chunk-' + requestId;
  const doneChannel = 'pr-debug-check-done-' + requestId;

  // Fetch logs. gh run view follows the 302-to-download redirect properly,
  // unlike the bare `gh api .../jobs/{id}/logs` call which often surfaces
  // as HTTP 404. Fall back to the api endpoint if `gh run view` fails (e.g.
  // wrong repo, expired retention).
  let logs = '';
  try {
    logs = execFileSync('gh', [
      'run', 'view', String(runId),
      '-R', `${baseOwner}/${baseRepo}`,
      '--log-failed',
    ], { cwd, stdio: 'pipe', timeout: 30000, maxBuffer: 50 * 1024 * 1024 }).toString();
  } catch (errA) {
    try {
      logs = execFileSync('gh', [
        'api', `/repos/${baseOwner}/${baseRepo}/actions/jobs/${jobId}/logs`,
      ], { cwd, stdio: 'pipe', timeout: 20000, maxBuffer: 50 * 1024 * 1024 }).toString();
    } catch (errB) {
      const msg = (errA.stderr ? errA.stderr.toString().trim() : errA.message)
        || (errB.stderr ? errB.stderr.toString().trim() : errB.message);
      return { error: 'Could not fetch logs: ' + msg };
    }
  }
  const logLines = logs.split('\n');
  const logTail = logLines.slice(-400).join('\n');

  // Truncate diff too — long PRs can easily exceed the prompt budget. The
  // file list + first ~600 lines is usually enough to let claude judge
  // whether the PR caused the failure; full diff is rarely needed.
  const diffSnippet = (diff || '').split('\n').slice(0, 600).join('\n')
    + ((diff || '').split('\n').length > 600 ? '\n\n[... diff truncated ...]\n' : '');

  const prompt =
    `A pull request has a failing CI check. Help diagnose it.\n\n`
    + `## PR\n#${meta.number}: ${meta.title || ''}\n`
    + (meta.body ? `\n${meta.body.slice(0, 2000)}\n` : '')
    + `\n## Failing check\nName: ${checkName || '(unnamed)'}\nLink: ${checkLink}\n`
    + `\n## Last lines of the failing job log\n\`\`\`\n${logTail}\n\`\`\`\n`
    + `\n## PR diff (truncated to 600 lines)\n\`\`\`\n${diffSnippet}\n\`\`\`\n`
    + `\nAnswer in this structure:\n`
    + `1. **What broke** — one or two sentences naming the actual failure.\n`
    + `2. **Caused by this PR?** — yes / no / likely, with the specific evidence from the diff vs log.\n`
    + `3. **Fix** — concrete, code-level suggestion. Use file:line references when possible.\n`
    + `Keep it tight; no preamble.`;

  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  const { spawn } = require('child_process');
  const proc = spawn(claudeBin, ['-p', prompt], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  debugCheckProcs.set(requestId, proc);

  let stderrBuf = '';
  proc.stdout.on('data', (chunk) => {
    if (!sender.isDestroyed()) sender.send(chunkChannel, chunk.toString());
  });
  proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
  proc.on('error', (err) => {
    debugCheckProcs.delete(requestId);
    if (!sender.isDestroyed()) sender.send(doneChannel, { error: err.message });
  });
  proc.on('exit', (code, signal) => {
    debugCheckProcs.delete(requestId);
    if (sender.isDestroyed()) return;
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      sender.send(doneChannel, { cancelled: true });
    } else if (code !== 0) {
      sender.send(doneChannel, { error: stderrBuf.trim() || ('claude exited with code ' + code) });
    } else {
      sender.send(doneChannel, { ok: true });
    }
  });

  return { ok: true };
});

ipcMain.handle('pr-debug-check-cancel', (_event, { requestId }) => {
  const proc = debugCheckProcs.get(requestId);
  if (!proc) return { ok: false };
  try { proc.kill('SIGTERM'); } catch {}
  return { ok: true };
});

ipcMain.handle('pr-review-merge', async (_event, { strategy }) => {
  if (!activePrReview) return { error: 'No active PR review' };
  const flag = { merge: '--merge', squash: '--squash', rebase: '--rebase' }[strategy];
  if (!flag) return { error: 'Unknown merge strategy: ' + strategy };
  const { meta } = activePrReview;
  if (!meta || !meta.url) return { error: 'Could not determine PR URL' };
  const cwd = currentRepoPath() || require('os').homedir();
  try {
    // URL form bypasses gh's buggy -R repo resolution (see pr-review-checks
    // for the failure mode we're avoiding).
    ghExec(['pr', 'merge', meta.url, flag], {
      cwd, stdio: 'pipe', timeout: 30000,
    });
    await reloadActivePrReviewMeta();
    fetchThreadsForActive();
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

async function reloadActivePrReviewMeta() {
  if (!activePrReview) return;
  const { meta: existingMeta } = activePrReview;
  if (!existingMeta || !existingMeta.url) return;
  const cwd = currentRepoPath() || require('os').homedir();
  try {
    const meta = await ghJson([
      'pr', 'view', existingMeta.url,
      '--json', 'number,title,author,state,createdAt,updatedAt,headRefName,baseRefName,headRefOid,isDraft,reviewDecision,url,body,headRepository,headRepositoryOwner,mergeable,mergeStateStatus',
    ], cwd);
    if (!activePrReview || activePrReview.number !== meta.number) return;
    activePrReview.meta = Object.assign({}, activePrReview.meta, meta);
    broadcastPrReview();
  } catch (_) { /* non-fatal */ }
}

// Walk the user's klausify projects and return the first whose `origin`
// remote points at <owner>/<repo> (GitHub URL, either SSH or HTTPS form).
// Returns null when no project matches — the caller surfaces an explicit
// "add this repo as a project" error.
function findProjectForRepo(owner, repo) {
  const config = loadConfig();
  const projects = config.projects || [];
  const needle = `${owner}/${repo}`;
  for (const p of projects) {
    if (!p || !p.path) continue;
    try {
      const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: p.path, stdio: 'pipe',
      }).toString().trim();
      // Accept https://github.com/owner/repo(.git)? and git@github.com:owner/repo(.git)?
      const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (m && `${m[1]}/${m[2]}` === needle) return p.path;
    } catch (_) { /* skip */ }
  }
  return null;
}

// Scan `git worktree list --porcelain` for the worktree (if any) that has
// `refs/heads/<branch>` checked out. Returns the worktree path or null.
function findWorktreeForBranch(cwd, branch) {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd, stdio: 'pipe',
    }).toString();
    // Entries are blank-line-separated "worktree <path>\nHEAD ...\nbranch ..." blocks.
    const blocks = out.split(/\n\n+/);
    for (const block of blocks) {
      let wtPath = null, wtBranch = null;
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length).trim();
        else if (line.startsWith('branch ')) wtBranch = line.slice('branch '.length).trim();
      }
      if (wtBranch === `refs/heads/${branch}` && wtPath) return wtPath;
    }
  } catch (_) {}
  return null;
}

// Shared helper: ensure a worktree exists for activePrReview's PR head and
// return its path. Used by G5 (which then spawns a task) and G7 (which runs
// the AI review there). Resolves cwd in this order:
//   1. active project's origin matches the PR base repo
//   2. another klausify project's origin matches
//   3. auto-clone into userData/pr-checkouts (partial clone)
// Reuses an existing worktree on the branch instead of fighting git when
// the user has it checked out already.
async function ensureWorktreeForActivePr() {
  if (!activePrReview) return { error: 'No active PR review' };
  const { number, meta, baseOwner, baseRepo } = activePrReview;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo from PR metadata' };

  const active = currentRepoPath();
  let cwd = null;
  if (active) {
    try {
      const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: active, stdio: 'pipe',
      }).toString().trim();
      const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (m && `${m[1]}/${m[2]}` === `${baseOwner}/${baseRepo}`) cwd = active;
    } catch (_) {}
  }
  if (!cwd) cwd = findProjectForRepo(baseOwner, baseRepo);

  let token = '';
  try {
    token = execFileSync('gh', ['auth', 'token'], { stdio: 'pipe' }).toString().trim();
  } catch (_) {
    return { error: 'Could not read gh auth token — run `gh auth login` first.' };
  }
  const authedUrl = `https://oauth2:${token}@github.com/${baseOwner}/${baseRepo}.git`;
  const scrub = (s) => (s || '').replace(/oauth2:[^@]+@/g, 'oauth2:***@');

  if (!cwd) {
    const cloneBase = path.join(app.getPath('userData'), 'pr-checkouts');
    const clonePath = path.join(cloneBase, `${baseOwner}-${baseRepo}`);
    if (!fs.existsSync(clonePath)) {
      try { fs.mkdirSync(cloneBase, { recursive: true }); } catch (_) {}
      try {
        execFileSync('git', ['clone', '--filter=blob:none', authedUrl, clonePath], { stdio: 'pipe' });
      } catch (err) {
        const raw = (err.stderr ? err.stderr.toString() : err.message) || '';
        return { error: 'Clone failed: ' + scrub(raw) };
      }
    }
    cwd = clonePath;
  }

  const localBranch = (meta && meta.headRefName) || `pr-${number}`;
  const sanitizedForPath = localBranch.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);

  const existingWorktreePath = findWorktreeForBranch(cwd, localBranch);
  if (existingWorktreePath) {
    return { worktreePath: existingWorktreePath, branch: localBranch, baseRepoCwd: cwd, existed: true };
  }

  try {
    execFileSync('git', ['fetch', authedUrl, `+refs/pull/${number}/head:refs/heads/${localBranch}`], {
      cwd, stdio: 'pipe',
    });
  } catch (err) {
    const raw = (err.stderr ? err.stderr.toString() : err.message) || '';
    return { error: 'Fetch failed: ' + scrub(raw) };
  }

  const repoBasename = path.basename(cwd);
  const worktreeDir = path.dirname(cwd);
  const worktreePath = path.join(worktreeDir, repoBasename + '-' + sanitizedForPath);

  if (fs.existsSync(worktreePath)) {
    // Stale dir from a prior run we never wired up — reuse silently rather
    // than failing. git worktree add would error if it's still registered.
    return { worktreePath, branch: localBranch, baseRepoCwd: cwd, existed: true };
  }

  try {
    execFileSync('git', ['worktree', 'add', worktreePath, localBranch], { cwd, stdio: 'pipe' });
  } catch (err) {
    return { error: 'Worktree create failed: ' + (err.stderr ? err.stderr.toString() : err.message) };
  }

  try { await runKlausifyInit(worktreePath); } catch (_) {}
  return { worktreePath, branch: localBranch, baseRepoCwd: cwd, existed: false };
}

// G5: materialize the PR as a worktree + spawn a task in it.
ipcMain.handle('pr-checkout-locally', async () => {
  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };
  const { worktreePath, branch } = ensured;
  const { number, baseOwner, baseRepo } = activePrReview;

  // Already tracked as a task? Focus it instead of spawning a duplicate.
  const existingTask = Array.from(instances.values()).find(i => i.worktreePath === worktreePath);
  let payload;
  if (existingTask) {
    if (!existingTask.prNumber) existingTask.prNumber = number;
    if (!existingTask.prBaseOwner) existingTask.prBaseOwner = baseOwner;
    if (!existingTask.prBaseRepo) existingTask.prBaseRepo = baseRepo;
    payload = {
      id: existingTask.id, name: existingTask.name,
      worktreePath: existingTask.worktreePath, branch: existingTask.branch, mode: existingTask.mode,
    };
  } else {
    const task = spawnInWorktree(branch, worktreePath, branch, 'claude', null, null, number);
    const inst = instances.get(task.id);
    if (inst) {
      inst.prBaseOwner = baseOwner;
      inst.prBaseRepo = baseRepo;
    }
    payload = task;
  }

  // Exit review mode first so the task grid is visible again, THEN announce
  // the new task so the main-window listener can focus it without fighting
  // the review-mode takeover.
  if (activePrReview && activePrReview.popout && !activePrReview.popout.isDestroyed()) {
    activePrReview.popout.close();
  }
  activePrReview = null;
  broadcastPrReview();

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('pr-checkout-ready', payload);
  }
  return { ok: true, task: payload, reused: !!existingTask };
});

// G7: AI review in the PR review surface. Ensures a worktree (auto-cloning
// if needed) and spawns claude with the PR_REVIEW_TEMPLATE, streaming
// stream-json events back to the renderer. Mirrors F6's protocol so the
// renderer can reuse the same chunk parser.
const reviewSurfaceAiProcs = new Map();

ipcMain.handle('pr-review-ai-start', async (event, { requestId }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (reviewSurfaceAiProcs.has(requestId)) return { error: 'Already in flight' };
  if (!activePrReview) return { error: 'No active PR review' };

  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };

  const baseBranch = (activePrReview.meta && activePrReview.meta.baseRefName) || 'main';
  const prompt = PR_REVIEW_TEMPLATE
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch)
    .replace(/\{\{REPO_SPECIFIC_CHECKS\}\}/g, '');

  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  const { spawn } = require('child_process');
  const proc = spawn(claudeBin, [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
  ], {
    cwd: ensured.worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  reviewSurfaceAiProcs.set(requestId, proc);

  const dataChannel = 'pr-review-ai-data-' + requestId;
  const doneChannel = 'pr-review-ai-done-' + requestId;
  const sender = event.sender;
  let stderrBuf = '';

  proc.stdout.on('data', (chunk) => {
    if (!sender.isDestroyed()) sender.send(dataChannel, chunk.toString());
  });
  proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
  proc.on('error', (err) => {
    reviewSurfaceAiProcs.delete(requestId);
    if (!sender.isDestroyed()) sender.send(doneChannel, { error: err.message });
  });
  proc.on('exit', (code, signal) => {
    reviewSurfaceAiProcs.delete(requestId);
    if (sender.isDestroyed()) return;
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      sender.send(doneChannel, { cancelled: true });
    } else if (code !== 0) {
      sender.send(doneChannel, { error: stderrBuf.trim() || ('claude exited with code ' + code) });
    } else {
      sender.send(doneChannel, { ok: true });
    }
  });

  return { ok: true, worktreePath: ensured.worktreePath };
});

ipcMain.handle('pr-review-ai-cancel', (_event, { requestId }) => {
  const proc = reviewSurfaceAiProcs.get(requestId);
  if (!proc) return { ok: false };
  try { proc.kill('SIGTERM'); } catch {}
  return { ok: true };
});

// G7: implement a single finding (or "all findings" via one big prompt) by
// spawning claude in the PR's worktree with edit tools. Mirrors the AI-review
// streaming protocol so the renderer can show progress chips + result.
const implementProcs = new Map();

ipcMain.handle('pr-review-implement-start', async (event, { requestId, mode, body }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (implementProcs.has(requestId)) return { error: 'Already in flight' };
  if (!activePrReview) return { error: 'No active PR review' };
  if (!body || !body.trim()) return { error: 'Empty implement body' };

  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };

  // Two prompts depending on whether we're implementing one finding or many.
  // Both share guardrails so claude doesn't drift into unrelated cleanup or
  // start running tests/commits.
  const guardrails =
    `\n\nGuidelines:\n`
    + `- Only change what the finding(s) ask for; do not add unrelated cleanup.\n`
    + `- Do not run tests, install deps, or commit/push.\n`
    + `- After making the changes, summarize each change in one short bullet,\n`
    + `  prefixed with the file path. Be terse.\n`;
  const prompt = mode === 'all'
    ? `Apply the following code-review findings to the codebase:\n\n${body}` + guardrails
    : `Apply the following code-review finding to the codebase:\n\n${body}` + guardrails;

  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  const { spawn } = require('child_process');
  const proc = spawn(claudeBin, [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
  ], {
    cwd: ensured.worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  implementProcs.set(requestId, proc);

  const dataChannel = 'pr-review-implement-data-' + requestId;
  const doneChannel = 'pr-review-implement-done-' + requestId;
  const sender = event.sender;
  let stderrBuf = '';

  proc.stdout.on('data', (chunk) => {
    if (!sender.isDestroyed()) sender.send(dataChannel, chunk.toString());
  });
  proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
  proc.on('error', (err) => {
    implementProcs.delete(requestId);
    if (!sender.isDestroyed()) sender.send(doneChannel, { error: err.message });
  });
  proc.on('exit', (code, signal) => {
    implementProcs.delete(requestId);
    if (sender.isDestroyed()) return;
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      sender.send(doneChannel, { cancelled: true });
    } else if (code !== 0) {
      sender.send(doneChannel, { error: stderrBuf.trim() || ('claude exited with code ' + code) });
    } else {
      sender.send(doneChannel, { ok: true, worktreePath: ensured.worktreePath });
    }
  });

  return { ok: true, worktreePath: ensured.worktreePath };
});

ipcMain.handle('pr-review-implement-cancel', (_event, { requestId }) => {
  const proc = implementProcs.get(requestId);
  if (!proc) return { ok: false };
  try { proc.kill('SIGTERM'); } catch {}
  return { ok: true };
});

// G7 persistence: cache a PR's AI review + per-finding state by
// (owner, repo, number) so re-opening a PR (or restarting the app) restores
// the prior review and the user's Ignore / Implemented marks.
function reviewCachePathFor(owner, repo, number) {
  const dir = path.join(app.getPath('userData'), 'pr-review-cache');
  const safe = `${owner}-${repo}-${number}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return { dir, file: path.join(dir, safe + '.json') };
}

ipcMain.handle('pr-review-cache-get-by-pr', (_event, { owner, repo, number }) => {
  if (!owner || !repo || !number) return { cached: null };
  const { file } = reviewCachePathFor(owner, repo, number);
  try {
    if (!fs.existsSync(file)) return { cached: null };
    const raw = fs.readFileSync(file, 'utf8');
    return { cached: JSON.parse(raw) };
  } catch (err) {
    return { cached: null, error: err.message };
  }
});

ipcMain.handle('pr-review-cache-save-by-pr', (_event, { owner, repo, number, data }) => {
  if (!owner || !repo || !number) return { ok: false, error: 'Missing key' };
  const { dir, file } = reviewCachePathFor(owner, repo, number);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('pr-review-cache-clear-by-pr', (_event, { owner, repo, number }) => {
  if (!owner || !repo || !number) return { ok: false };
  const { file } = reviewCachePathFor(owner, repo, number);
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
  return { ok: true };
});

// G4: post all pending review comments + decision as one review. The GitHub
// REST endpoint accepts `comments` inline so we only make one network call.
// Piping JSON on stdin avoids shell-escaping pain for multiline comment
// bodies.
// General issue comment on the PR — no line context, just a body.
ipcMain.handle('pr-add-issue-comment', async (_event, { body }) => {
  if (!activePrReview) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number } = activePrReview;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/issues/${number}/comments`;
  const cwd = currentRepoPath() || require('os').homedir();
  const { spawn } = require('child_process');

  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf += c.toString(); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try {
            const parsed = JSON.parse(stdoutBuf);
            if (parsed.message) msg = parsed.message;
          } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

// Reply to a specific review comment (threaded). `inReplyTo` is the parent
// comment's REST databaseId — the same id GraphQL returns on each review
// comment so we can thread using data we already fetch. Uses GitHub's
// dedicated replies endpoint so we don't have to fake a new-comment shape.
ipcMain.handle('pr-reply-to-review-comment', async (_event, { inReplyTo, body }) => {
  if (!activePrReview) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number } = activePrReview;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const parentId = parseInt(inReplyTo, 10);
  if (!parentId) return { error: 'Missing or invalid parent comment id' };
  if (!body || !body.trim()) return { error: 'Reply body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/${number}/comments/${parentId}/replies`;
  const cwd = currentRepoPath() || require('os').homedir();
  const { spawn } = require('child_process');

  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf += c.toString(); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try {
            const parsed = JSON.parse(stdoutBuf);
            if (parsed.message) msg = parsed.message + (parsed.errors ? ': ' + JSON.stringify(parsed.errors) : '');
          } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

ipcMain.handle('pr-submit-review', async (_event, { event, body, comments }) => {
  if (!activePrReview) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number } = activePrReview;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  if (!event) return { error: 'Missing review event (APPROVE / REQUEST_CHANGES / COMMENT)' };

  const payload = {
    event,
    body: body || '',
    comments: (comments || []).map((c) => {
      const out = {
        path: c.path,
        body: c.body,
        side: c.side || 'RIGHT',
      };
      // GitHub requires `line` always; `start_line` only for multi-line.
      if (typeof c.line === 'number') out.line = c.line;
      if (typeof c.startLine === 'number' && c.startLine !== c.line) {
        out.start_line = c.startLine;
        out.start_side = c.startSide || out.side;
      }
      return out;
    }),
  };

  const cwd = currentRepoPath() || require('os').homedir();
  const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/${number}/reviews`;
  const { spawn } = require('child_process');

  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf += c.toString(); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        // gh often writes JSON errors to stdout on non-zero exit.
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try {
            const parsed = JSON.parse(stdoutBuf);
            if (parsed.message) msg = parsed.message + (parsed.errors ? ': ' + JSON.stringify(parsed.errors) : '');
          } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true });
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
});

ipcMain.handle('pr-review-state', () => activePrReview ? sanitizePrReview(activePrReview) : null);

ipcMain.handle('pr-review-close', () => {
  if (activePrReview && activePrReview.popout && !activePrReview.popout.isDestroyed()) {
    activePrReview.popout.close();
  }
  activePrReview = null;
  broadcastPrReview();
  return { ok: true };
});

ipcMain.handle('pop-out-pr-review', () => {
  if (!activePrReview) return { error: 'No active PR review' };
  if (activePrReview.popout && !activePrReview.popout.isDestroyed()) {
    activePrReview.popout.focus();
    return { ok: true };
  }

  const popout = new BrowserWindow({
    width: 1100,
    height: 800,
    title: `Review \u2014 #${activePrReview.number} ${activePrReview.meta.title || ''}`,
    icon: path.join(__dirname, 'icon.icns'),
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  popout.loadFile(path.join(__dirname, 'renderer', 'pr-review.html'));
  activePrReview.popout = popout;
  broadcastPrReview();

  popout.on('closed', () => {
    if (activePrReview && activePrReview.popout === popout) {
      activePrReview.popout = null;
      broadcastPrReview();
    }
  });

  return { ok: true };
});

ipcMain.handle('pop-in-pr-review', () => {
  if (activePrReview && activePrReview.popout && !activePrReview.popout.isDestroyed()) {
    activePrReview.popout.close();
  }
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

function explainPrompt(file, hunk) {
  return `Explain this specific code concisely. What does it do and why might it have been written this way?\n\nFile: ${file}\n\nSelected code:\n\`\`\`\n${hunk}\n\`\`\``;
}

ipcMain.handle('explain-diff', async (_event, { worktreePath, file, hunk }) => {
  // PR review mode calls this without a worktree — fall back to the current
  // project path (or the user's home as a last resort) since execFile insists
  // on a valid cwd. Claude doesn't actually need repo context for this prompt.
  const cwd = worktreePath || currentRepoPath() || require('os').homedir();
  return new Promise((resolve) => {
    execFile('claude', ['-p', explainPrompt(file, hunk)], {
      cwd,
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

// Streaming variant. Pipes claude stdout to the renderer in real time so the
// user sees tokens as they arrive instead of staring at a 10-second spinner.
// Callers pass a requestId; chunks arrive on `explain-diff-chunk-<id>` and
// completion on `explain-diff-done-<id>`.
const explainStreamProcs = new Map();

ipcMain.handle('explain-diff-stream-start', (event, { requestId, worktreePath, file, hunk }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (explainStreamProcs.has(requestId)) return { error: 'Already streaming' };

  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  const cwd = worktreePath || currentRepoPath() || require('os').homedir();
  const { spawn } = require('child_process');

  const proc = spawn(claudeBin, ['-p', explainPrompt(file, hunk)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  explainStreamProcs.set(requestId, proc);

  const chunkChannel = 'explain-diff-chunk-' + requestId;
  const doneChannel = 'explain-diff-done-' + requestId;
  const sender = event.sender;
  let stderrBuf = '';

  proc.stdout.on('data', (chunk) => {
    if (!sender.isDestroyed()) sender.send(chunkChannel, chunk.toString());
  });
  proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

  proc.on('error', (err) => {
    explainStreamProcs.delete(requestId);
    if (!sender.isDestroyed()) sender.send(doneChannel, { error: err.message });
  });

  proc.on('exit', (code, signal) => {
    explainStreamProcs.delete(requestId);
    if (sender.isDestroyed()) return;
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      sender.send(doneChannel, { cancelled: true });
    } else if (code !== 0) {
      sender.send(doneChannel, { error: stderrBuf.trim() || ('claude exited with code ' + code) });
    } else {
      sender.send(doneChannel, { ok: true });
    }
  });

  return { ok: true };
});

ipcMain.handle('explain-diff-stream-cancel', (_event, { requestId }) => {
  const proc = explainStreamProcs.get(requestId);
  if (!proc) return { ok: false };
  try { proc.kill('SIGTERM'); } catch {}
  return { ok: true };
});

// ---- Whole-PR AI Review ----

const PR_REVIEW_TEMPLATE = `You are conducting a thorough PR review. Follow these phases in order.

---

## Phase 1: Context Gathering

1. Run \`git diff --stat {{BASE_BRANCH}}...HEAD\` and count the total lines changed (additions + deletions).
2. Run \`git diff {{BASE_BRANCH}}...HEAD\` to get the full diff.
3. Run \`git log {{BASE_BRANCH}}..HEAD --oneline\` to understand commit history and intent.
4. For each changed file, read the full file (not just the diff hunks) to understand surrounding context.
5. If the branch name contains a ticket reference (e.g. FEAT-1234), note it for context.

Store the diff output, file contents, and commit log — you will need them in the next phase.

---

## Phase 2: Triage

Count the total lines changed from the \`--stat\` output.

- **If < 150 lines changed:** proceed to [Small PR Review](#small-pr-review) below.
- **If >= 150 lines changed:** proceed to [Parallel Review](#parallel-review) below.

---

## Small PR Review

You are a senior/principal-level engineer reviewing a pull request. Treat this as a real production PR. Output ONLY PR-style review comments, as if leaving inline comments on GitHub/GitLab.

### Comment format (required for every comment):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (specific suggestion or alternative)

### Review rules:

- Be skeptical and precise.
- Assume the code will be read and modified by others.
- Repeat the code to help pinpoint the issue. No more than 10 lines.
- If something relies on an unstated assumption, call it out.
- If behavior is unclear, treat that as a problem.
- Prefer concrete fixes over vague advice.

### What to look for (in order of priority):

1. **Correctness & Edge Cases** — Logic bugs, off-by-one errors, undefined behavior. Error handling gaps, partial failures.
2. **Concurrency & State** — Race conditions, shared mutable state. Thread safety, async misuse, ordering assumptions.
3. **Design & API Boundaries** — Leaky abstractions, tight coupling. Public interfaces that are hard to evolve.
4. **Performance & Scalability** — Inefficient loops, N+1 calls, blocking I/O. Work done in hot paths that doesn't need to be.
5. **Reliability** — Missing retries, timeouts, idempotency. Resource cleanup (connections, files, tasks).
6. **Security** — Input validation, trust boundaries. Logging sensitive data.
7. **Readability & Maintainability** — Ambiguous naming, overly clever code. Comments that explain "what" instead of "why".
8. **Test Coverage** — Were tests added or updated for the changes? Are edge cases covered?
9. **Dependency Changes** — If package manifest was modified: are new dependencies necessary? Are versions pinned? Flag any new dependencies that duplicate existing functionality.
10. **Scope** — Identify the primary intent of the PR. Flag changes unrelated to that intent with **Warn** severity.

{{REPO_SPECIFIC_CHECKS}}

### Tone & standards:

- Assume a high bar (staff/principal quality).
- If something is "technically correct but fragile," say so.
- If something would fail under load or future change, flag it.
- Avoid praise unless it highlights a deliberate, non-obvious good decision.

### Validate findings:

Before writing the final output, validate every finding you produced. For each one:

1. **Read the full file** referenced in the finding (not just the diff hunk).
2. **Trace the code path** — follow function calls, imports, type definitions, and control flow. Read caller and callee files as needed.
3. **Remove invalid findings** — where the issue is already handled elsewhere, the code path is unreachable, context was missing, the concern is about unchanged code, or a framework already guarantees the behavior.
4. **Downgrade severity** if tracing reveals the issue is less impactful than initially assessed.

A shorter, accurate review is far more valuable than a long review with false positives.

### End of review:

After validation, add a final PR summary:

**Overall verdict:** Approve / Request Changes / Block

**Highest-risk issues:**
1. ...
2. ...
3. ...

**Test coverage assessment:**
- [ ] Adequate test coverage for changes
- [ ] Edge cases tested

---

## Parallel Review

This PR is large enough to benefit from focused, parallel review. Use the **Agent tool** to launch all four of the following review agents **simultaneously in a single response**. Pass each agent the full diff, changed file contents, and commit log you gathered in Phase 1.

**Important:** Each agent returns its findings as text. Agents must NOT write any files.

---

### Agent 1: Correctness & Logic

Use the Agent tool with this prompt (include the diff and file contents you gathered):

\`\`\`
You are a senior engineer reviewing a pull request. Your ONLY focus is correctness and concurrency. Ignore all other concerns (design, style, security, etc.) — other reviewers are handling those.

Here is the diff:
[PASTE THE FULL DIFF HERE]

Here is the commit log:
[PASTE THE COMMIT LOG HERE]

Read every changed file in full for surrounding context.

## What to look for:

### Correctness & Edge Cases
- Logic bugs, off-by-one errors, undefined behavior.
- Error handling gaps, partial failures.
- Incorrect return values or wrong types.
- Boundary conditions: empty inputs, nil/null, max values, overflow.
- State mutations that violate invariants.

### Concurrency & State
- Race conditions, shared mutable state.
- Thread safety, async misuse, ordering assumptions.
- Deadlocks, livelocks, starvation.
- Missing synchronization or incorrect lock scope.
- Assumptions about execution order in async code.

## Output format (required for every finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**Comment:**

- What is wrong, why this is a problem (be specific about the failure mode)
- What should be changed (concrete fix or alternative)

Rules:
- Be skeptical and precise.
- Repeat the relevant code (up to 10 lines) to pinpoint the issue.
- If something relies on an unstated assumption, call it out.
- Prefer concrete fixes over vague advice.
- Return ONLY your findings. Do not write any files.
\`\`\`

---

### Agent 2: Architecture & Design

Use the Agent tool with this prompt (include the diff and file contents you gathered):

\`\`\`
You are a senior engineer reviewing a pull request. Your ONLY focus is architecture, design, performance, reliability, and dependency changes. Ignore correctness bugs, style, and security — other reviewers are handling those.

Here is the diff:
[PASTE THE FULL DIFF HERE]

Here is the commit log:
[PASTE THE COMMIT LOG HERE]

Read every changed file in full for surrounding context.

## What to look for:

### Design & API Boundaries
- Leaky abstractions, tight coupling.
- Public interfaces that are hard to evolve.
- Violation of existing architectural patterns in the codebase.
- Responsibilities placed in the wrong layer or module.

### Performance & Scalability
- Inefficient loops, N+1 calls, blocking I/O.
- Work done in hot paths that doesn't need to be.
- Missing pagination, unbounded queries, or unbounded memory growth.
- Allocations or copies that could be avoided.

### Reliability
- Missing retries, timeouts, idempotency.
- Resource cleanup (connections, files, tasks).
- Failure modes that leave the system in an inconsistent state.
- Missing circuit breakers or backpressure for external calls.

### Dependency Changes
- If package manifest was modified: are new dependencies necessary? Are versions pinned?
- Flag any new dependencies that duplicate existing functionality.
- Evaluate transitive dependency impact.

## Output format (required for every finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (concrete fix or alternative)

Rules:
- Be skeptical and precise.
- Repeat the relevant code (up to 10 lines) to pinpoint the issue.
- Think about how changes behave at scale and over time.
- Prefer concrete fixes over vague advice.
- Return ONLY your findings. Do not write any files.
\`\`\`

---

### Agent 3: Security & Quality

Use the Agent tool with this prompt (include the diff and file contents you gathered):

\`\`\`
You are a senior engineer reviewing a pull request. Your ONLY focus is security, readability, maintainability, and test coverage. Ignore correctness bugs, architecture, and performance — other reviewers are handling those.

Here is the diff:
[PASTE THE FULL DIFF HERE]

Here is the commit log:
[PASTE THE COMMIT LOG HERE]

Read every changed file in full for surrounding context.

## What to look for:

### Security
- Input validation gaps, trust boundary violations.
- Injection vectors: SQL, command, XSS, path traversal.
- Authentication/authorization bypasses.
- Logging or exposing sensitive data (tokens, passwords, PII).
- Insecure defaults or missing security headers.
- Cryptographic misuse (weak algorithms, hardcoded keys).

### Readability & Maintainability
- Ambiguous naming, overly clever code.
- Comments that explain "what" instead of "why".
- Functions that are too long or do too many things.
- Magic numbers or strings without explanation.
- Dead code or unreachable branches.

### Test Coverage
- Were tests added or updated for the changes?
- Are edge cases covered?
- Are failure paths tested?
- Do tests actually assert meaningful behavior (not just "doesn't crash")?
- Are mocks/stubs appropriate, or do they hide real behavior?

## Output format (required for every finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (concrete fix or alternative)

Rules:
- Be skeptical and precise.
- Repeat the relevant code (up to 10 lines) to pinpoint the issue.
- For security issues, describe the attack vector concretely.
- Prefer concrete fixes over vague advice.
- Return ONLY your findings. Do not write any files.
\`\`\`

---

### Agent 4: Scope & Conventions

Use the Agent tool with this prompt (include the diff and file contents you gathered):

\`\`\`
You are a senior engineer reviewing a pull request. Your ONLY focus is scope analysis and adherence to project conventions. Ignore bugs, architecture, security, and style — other reviewers are handling those.

Here is the diff:
[PASTE THE FULL DIFF HERE]

Here is the commit log:
[PASTE THE COMMIT LOG HERE]

Read every changed file in full for surrounding context.

## What to look for:

### Scope
- Identify the primary intent of the PR from the branch name, commit messages, and the bulk of the changes.
- Flag any changes that do not appear related to that primary intent (e.g. drive-by refactors, unrelated formatting, feature creep).
- Use **Warn** severity for unrelated changes — they may be intentional, but should be called out for the author to confirm.
- Check that the PR does one thing well rather than bundling unrelated work.

### Project Conventions
{{REPO_SPECIFIC_CHECKS}}

If no repo-specific checks are listed above, check the CLAUDE.md file in the repository for project conventions, commands, and known pitfalls, and verify the PR adheres to them.

## Output format (required for every finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (concrete fix or alternative)

Rules:
- Be precise about what is out of scope vs. in scope.
- For convention violations, reference the specific convention.
- Prefer concrete fixes over vague advice.
- Return ONLY your findings. Do not write any files.
\`\`\`

---

## Phase 3: Validation

Before synthesizing, validate every finding from the sub-agents. For each finding:

1. **Read the full file** referenced in the finding's location (not just the diff hunk).
2. **Trace the code path** — follow function calls, imports, type definitions, and control flow to understand the full context. Read caller and callee files as needed.
3. **Determine if the finding is still valid** given the full context. Common reasons a finding is invalid:
   - The issue is already handled elsewhere (e.g., validation happens in a caller, error is caught upstream).
   - The code path cannot actually be reached in the way the finding assumes.
   - The finding misreads the logic due to missing surrounding context.
   - The concern is about code that was not changed in this PR and is out of scope.
   - A dependency or framework already guarantees the behavior the finding questions.
4. **Remove invalid findings.** Do not include them in the final output. Do not note that they were removed.
5. **Downgrade severity** if tracing reveals the issue is less impactful than initially assessed (e.g., a "High" race condition that only affects a debug-only path should be "Low" or "Nit").

Be thorough — read as many files as needed to verify each finding. A shorter, accurate review is far more valuable than a long review with false positives.

---

## Phase 4: Synthesis

After validation, synthesize the remaining findings:

1. **Deduplicate**: If multiple agents flagged the same issue, keep the most detailed comment and use the highest severity assigned.
2. **Sort by severity**: Blocker > High > Medium > Low > Warn > Nit.
3. **Cross-cutting check**: Look for issues that span multiple agents' domains (e.g., a correctness bug that is also a security vulnerability). Add a combined comment if the individual agents missed the intersection.
4. **Assess overall quality**: Consider the findings holistically.

### Comment format (for each finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**[Category: Correctness | Concurrency | Design | Performance | Reliability | Security | Readability | Tests | Dependencies | Scope | Conventions]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (specific suggestion or alternative)

### Final PR summary:

**Overall verdict:** Approve / Request Changes / Block

**Highest-risk issues:**
1. ...
2. ...
3. ...

**Test coverage assessment:**
- [ ] Adequate test coverage for changes
- [ ] Edge cases tested

**Review method:** Parallel (4 focused sub-agents)

---

## IMPORTANT: Output

Do NOT write any files. Output the final review directly as your response to this prompt. The user will read it from your stdout.`;

// In-flight AI review processes, keyed by renderer-generated request id
// so the renderer can cancel them.
const aiReviewProcs = new Map();

// Cached PR reviews persist across app restarts: config.prReviews[repo#n] = { review, savedAt }
function prReviewKey(repo, prNumber) { return repo + '#' + prNumber; }

ipcMain.handle('pr-review-cache-get', (_event, { worktreePath, prNumber }) => {
  try {
    const repoResult = ghExec(['repo', 'view', '--json', 'nameWithOwner'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const repo = JSON.parse(repoResult).nameWithOwner;
    const config = loadConfig();
    const cached = (config.prReviews || {})[prReviewKey(repo, prNumber)];
    return { cached: cached || null };
  } catch {
    return { cached: null };
  }
});

ipcMain.handle('pr-review-cache-save', (_event, { worktreePath, prNumber, review }) => {
  try {
    const repoResult = ghExec(['repo', 'view', '--json', 'nameWithOwner'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const repo = JSON.parse(repoResult).nameWithOwner;
    const config = loadConfig();
    if (!config.prReviews) config.prReviews = {};
    config.prReviews[prReviewKey(repo, prNumber)] = { review: review, savedAt: new Date().toISOString() };
    saveConfig(config);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('pr-review-cache-clear', (_event, { worktreePath, prNumber }) => {
  try {
    const repoResult = ghExec(['repo', 'view', '--json', 'nameWithOwner'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const repo = JSON.parse(repoResult).nameWithOwner;
    const config = loadConfig();
    if (config.prReviews) delete config.prReviews[prReviewKey(repo, prNumber)];
    saveConfig(config);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Send text to the Claude terminal for a given worktree (via bracketed paste,
// so multi-line content doesn't submit partial lines). Returns the task id.
ipcMain.handle('pr-fix-in-terminal', (_event, { worktreePath, text }) => {
  // Prefer an alive claude-mode instance; fall back to any alive instance.
  let target = null;
  for (const [, inst] of instances) {
    if (inst.worktreePath === worktreePath && inst.alive && inst.mode === 'claude') { target = inst; break; }
  }
  if (!target) {
    for (const [, inst] of instances) {
      if (inst.worktreePath === worktreePath && inst.alive) { target = inst; break; }
    }
  }
  if (!target) return { error: 'No active task for this worktree. Start a Claude task first.' };

  const BP_START = '\x1b[200~';
  const BP_END = '\x1b[201~';
  try {
    target.pty.write(BP_START + text + BP_END);
    return { ok: true, taskId: target.id, mode: target.mode };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('pr-ai-review-start', (event, { worktreePath, baseBranch, requestId }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (aiReviewProcs.has(requestId)) return { error: 'Review already in flight for ' + requestId };

  const prompt = PR_REVIEW_TEMPLATE
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch || 'main')
    .replace(/\{\{REPO_SPECIFIC_CHECKS\}\}/g, '');

  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  const { spawn } = require('child_process');
  // stream-json gives us a JSONL event per assistant/tool/result block so we
  // can surface progress in the UI instead of a 15-minute silent spinner.
  const proc = spawn(claudeBin, [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
  ], {
    cwd: worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  aiReviewProcs.set(requestId, proc);

  const dataChannel = 'pr-ai-review-data-' + requestId;
  const doneChannel = 'pr-ai-review-done-' + requestId;
  let stderrBuf = '';
  const sender = event.sender;

  proc.stdout.on('data', (chunk) => {
    if (!sender.isDestroyed()) sender.send(dataChannel, chunk.toString());
  });
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
  });

  proc.on('error', (err) => {
    aiReviewProcs.delete(requestId);
    if (!sender.isDestroyed()) sender.send(doneChannel, { error: err.message });
  });

  proc.on('exit', (code, signal) => {
    aiReviewProcs.delete(requestId);
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      if (!sender.isDestroyed()) sender.send(doneChannel, { cancelled: true });
      return;
    }
    if (code !== 0) {
      if (!sender.isDestroyed()) sender.send(doneChannel, { error: stderrBuf || `claude exited with code ${code}` });
      return;
    }
    if (!sender.isDestroyed()) sender.send(doneChannel, { ok: true });
  });

  return { ok: true };
});

ipcMain.handle('pr-ai-review-cancel', (_event, { requestId }) => {
  const proc = aiReviewProcs.get(requestId);
  if (!proc) return { ok: false, error: 'No in-flight review' };
  try { proc.kill('SIGTERM'); } catch {}
  return { ok: true };
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
  const jsonFields = 'number,title,state,body,url,headRefName,baseRefName,headRefOid,additions,deletions,reviewDecision,comments,reviews,mergeable,mergeStateStatus,isDraft';

  // G5 fast path: if this worktree was created from "Check out locally",
  // look up the PR by its recorded number + base repo. Avoids gh's default
  // branch-matching lookup which fails for cross-repo (fork) PRs and for
  // any situation where the local branch name doesn't match the head ref.
  let hintedInst = null;
  for (const inst of instances.values()) {
    if (inst.worktreePath === worktreePath && inst.prNumber) { hintedInst = inst; break; }
  }
  if (hintedInst) {
    try {
      const args = ['pr', 'view', String(hintedInst.prNumber), '--json', jsonFields];
      if (hintedInst.prBaseOwner && hintedInst.prBaseRepo) {
        args.push('-R', `${hintedInst.prBaseOwner}/${hintedInst.prBaseRepo}`);
      }
      const result = ghExec(args, { cwd: worktreePath, stdio: 'pipe', timeout: 15000 }).toString();
      return { pr: JSON.parse(result) };
    } catch (err) {
      // Fall through to branch-matching lookup if the hinted one errors.
    }
  }

  try {
    const result = ghExec([
      'pr', 'view', '--json', jsonFields,
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

ipcMain.handle('pr-add-review-comment', async (_event, { worktreePath, prNumber, body, path: filePath, line, side, startLine, startSide, commitId }) => {
  try {
    const repoResult = ghExec(['repo', 'view', '--json', 'nameWithOwner'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const repo = JSON.parse(repoResult).nameWithOwner;
    const args = [
      'api', '--method', 'POST',
      `repos/${repo}/pulls/${prNumber}/comments`,
      '-f', 'body=' + body,
      '-f', 'path=' + filePath,
      '-F', 'line=' + line,
      '-f', 'side=' + (side || 'RIGHT'),
      '-f', 'commit_id=' + commitId,
    ];
    if (startLine && startLine !== line) {
      args.push('-F', 'start_line=' + startLine);
      args.push('-f', 'start_side=' + (startSide || side || 'RIGHT'));
    }
    ghExec(args, { cwd: worktreePath, stdio: 'pipe', timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('pr-merge', async (_event, { worktreePath, prNumber, strategy }) => {
  const flag = { merge: '--merge', squash: '--squash', rebase: '--rebase' }[strategy];
  if (!flag) return { error: 'Unknown merge strategy: ' + strategy };
  try {
    ghExec(['pr', 'merge', String(prNumber), flag], {
      cwd: worktreePath, stdio: 'pipe', timeout: 30000
    });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
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

ipcMain.handle('pr-review-threads', async (_event, { worktreePath, prNumber }) => {
  try {
    const repoResult = ghExec(['repo', 'view', '--json', 'nameWithOwner'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const [owner, repo] = JSON.parse(repoResult).nameWithOwner.split('/');
    const query = 'query($owner: String!, $repo: String!, $number: Int!) {'
      + '  repository(owner: $owner, name: $repo) {'
      + '    pullRequest(number: $number) {'
      + '      reviewThreads(first: 100) {'
      + '        nodes {'
      + '          id isResolved isOutdated path line originalLine startLine originalStartLine diffSide'
      + '          comments(first: 100) { nodes { databaseId author { login } createdAt body diffHunk } }'
      + '        }'
      + '      }'
      + '    }'
      + '  }'
      + '}';
    const out = ghExec([
      'api', 'graphql',
      '-f', 'query=' + query,
      '-f', 'owner=' + owner,
      '-f', 'repo=' + repo,
      '-F', 'number=' + prNumber,
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 15000 }).toString();
    const parsed = JSON.parse(out);
    if (parsed && parsed.errors && parsed.errors.length) {
      return { threads: [], error: parsed.errors.map(e => e.message).join('; ') };
    }
    const threads = (parsed && parsed.data && parsed.data.repository && parsed.data.repository.pullRequest
      && parsed.data.repository.pullRequest.reviewThreads && parsed.data.repository.pullRequest.reviewThreads.nodes) || [];
    return { threads };
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    // `gh api graphql` often writes the JSON error body to stdout even on non-zero exit
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout.toString());
        if (parsed.errors && parsed.errors.length) {
          return { threads: [], error: parsed.errors.map(e => e.message).join('; ') };
        }
      } catch {}
    }
    return { threads: [], error: stderr || err.message };
  }
});

function resolveOrUnresolveThread(worktreePath, threadId, resolve) {
  const mutation = resolve
    ? 'mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }'
    : 'mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }';
  try {
    ghExec([
      'api', 'graphql',
      '-f', 'query=' + mutation,
      '-F', 'id=' + threadId,
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
}

ipcMain.handle('pr-resolve-thread', (_event, { worktreePath, threadId }) => {
  return resolveOrUnresolveThread(worktreePath, threadId, true);
});

ipcMain.handle('pr-unresolve-thread', (_event, { worktreePath, threadId }) => {
  return resolveOrUnresolveThread(worktreePath, threadId, false);
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

// ---- H3: Worktree file watcher for instant diff refresh ----

// Subscribers is a per-webContents refcount (Map<webContents, number>) rather
// than a Set, so independent renderer features (diff panel + H2 sidebar) that
// both watch the same worktree don't clobber each other's subscription when
// one unsubscribes.
const worktreeWatchers = new Map(); // worktreePath -> { watcher, subscribers: Map<webContents, number>, debounceTimer }

// Path patterns we ignore — high-churn build output and git internals that don't
// affect our UI. .git/index and .git/HEAD are NOT ignored: they signal git state
// changes we want to reflect (commits, stages made from the terminal, etc.).
const WATCH_IGNORE_RE = /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|__pycache__|\.pytest_cache|\.mypy_cache|\.turbo|target|\.DS_Store)(\/|$)|^\.git\/(objects|logs|refs|packed-refs|FETCH_HEAD|ORIG_HEAD|COMMIT_EDITMSG)/;

function startWorktreeWatcher(worktreePath) {
  let state = worktreeWatchers.get(worktreePath);
  if (state) return state;

  state = { watcher: null, subscribers: new Map(), debounceTimer: null };

  try {
    state.watcher = fs.watch(worktreePath, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      // Normalize separators — on macOS we get forward slashes already, but be safe.
      const rel = filename.replace(/\\/g, '/');
      if (WATCH_IGNORE_RE.test(rel)) return;

      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        for (const wc of state.subscribers.keys()) {
          if (!wc.isDestroyed()) wc.send('worktree-changed', { worktreePath });
        }
      }, 200);
    });
    state.watcher.on('error', (err) => {
      console.error('[watch]', worktreePath, err.message);
    });
  } catch (err) {
    console.error('[watch] failed to start', worktreePath, err.message);
    return null;
  }

  worktreeWatchers.set(worktreePath, state);
  return state;
}

function stopWorktreeWatcher(worktreePath) {
  const state = worktreeWatchers.get(worktreePath);
  if (!state) return;
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  try { state.watcher && state.watcher.close(); } catch (_) {}
  worktreeWatchers.delete(worktreePath);
}

ipcMain.handle('watch-worktree', (event, { worktreePath }) => {
  if (!worktreePath) return { error: 'no worktreePath' };
  const state = startWorktreeWatcher(worktreePath);
  if (!state) return { error: 'watcher failed to start' };
  const count = state.subscribers.get(event.sender) || 0;
  state.subscribers.set(event.sender, count + 1);
  // Auto-cleanup when the renderer is destroyed (window closed, reload, etc.).
  // Only registered on the first subscription from this sender — refcount
  // increments don't re-register the destroyed listener.
  if (count === 0) {
    const cleanup = () => {
      const s = worktreeWatchers.get(worktreePath);
      if (!s) return;
      s.subscribers.delete(event.sender);
      if (s.subscribers.size === 0) stopWorktreeWatcher(worktreePath);
    };
    event.sender.once('destroyed', cleanup);
  }
  return { ok: true };
});

ipcMain.handle('unwatch-worktree', (event, { worktreePath }) => {
  if (!worktreePath) return { ok: true };
  const state = worktreeWatchers.get(worktreePath);
  if (!state) return { ok: true };
  const count = state.subscribers.get(event.sender) || 0;
  if (count <= 1) state.subscribers.delete(event.sender);
  else state.subscribers.set(event.sender, count - 1);
  if (state.subscribers.size === 0) stopWorktreeWatcher(worktreePath);
  return { ok: true };
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

ipcMain.handle('write-file', async (_event, { filePath, content }) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});
