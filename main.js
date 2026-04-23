const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, execFileSync, execFile, spawn } = require('child_process');
const pty = require('node-pty');
const lspManager = require('./lsp-manager');
// Require early: installs console hooks + uncaught handlers on load so every
// subsequent log/error routes through the ring buffer + rolling file.
const { getLogBuffer } = require('./main/util/logging');
const pathGate = require('./main/util/path-gate');
const { pathUnder, pathUnderAnyRoot, getRendererAllowedRoots } = pathGate;
const {
  execFileP, appendStderr, ghEnvForRepo, ghExec, ghExecP,
  clearGhTokenCache, runWithConcurrency, sanitizeExtraEnv,
} = require('./main/util/exec');
const {
  getConfigPath, loadConfig, saveConfig, flushSaveConfig, migratePrReviewCache,
} = require('./main/util/config');
const {
  allWindows, getMainWindow, hardenWindow, createWindow,
} = require('./main/state/windows');
const instancesModule = require('./main/state/instances');
const {
  instances,
  subscribeTerminalChannel, unsubscribeTerminalChannel, sendToTerminalSubscribers,
  listSessionFiles, snapshotSessionIds, detectClaudeSessionId, findLatestSessionId,
  processIdleDetection, clearIdleTimer,
  spawnInWorktree, convertInstanceToShell,
} = instancesModule;
const {
  spawnClaudeStream, makeClaudeCancelHandler,
  debugCheckProcs, inlineEditProcs, inlineCompleteProcs, reviewSurfaceAiProcs,
  implementProcs, explainStreamProcs, aiReviewProcs, commitMsgProcs,
} = require('./main/state/claude-streaming');
const {
  worktreeWatchers, startWorktreeWatcher, stopWorktreeWatcher,
} = require('./main/state/watcher');
const {
  startCIPolling, stopCIPolling, startAutoFetch,
} = require('./main/state/ci-poll');
const prReviewModule = require('./main/state/pr-review');
const {
  prReview,
  broadcastPrReview, sanitizePrReview, currentRepoPath, parseBaseFromUrl,
  pushReviewHistory, fetchThreadsForActive, reloadActivePrReviewMeta,
  findProjectForRepo, findWorktreeForBranch, ensureWorktreeForActivePr,
} = prReviewModule;
// IPC handler registrations — required for side effects (each file
// registers its ipcMain.handle listeners on load).
require('./main/ipc/windows-ipc');
require('./main/ipc/lsp');
require('./main/ipc/skills');
require('./main/ipc/files');
require('./main/ipc/gh');
require('./main/ipc/git');
const tasksModule = require('./main/ipc/tasks');

let isQuitting = false;

// Inject deps that belong to not-yet-extracted modules:
//   - path-gate reads loadConfig + instances for the renderer-allowed-roots
//     check. Both are direct module imports now.
//   - instances.spawnInWorktree needs to see `isQuitting` (moves with
//     bootstrap/app-events.js in Phase 4). startCIPolling is imported from
//     state/ci-poll.js but stays injection-wired to avoid a circular dep
//     (ci-poll needs to read the instances Map).
pathGate.setDeps({ loadConfig, getInstances: () => instances });
instancesModule.setDeps({
  isQuitting: () => isQuitting,
  startCIPolling,
});
// pr-review needs ghJson (stays in main.js until ipc/pr-review.js in Phase 3)
// and runKlausifyInit (moves with bootstrap/app-events.js in Phase 4). Both
// are hoisted function declarations, so passing them by name here is safe.
prReviewModule.setDeps({ ghJson, runKlausifyInit });
tasksModule.setDeps({ runKlausifyInit });

ipcMain.on('subscribe-terminal', (event, channel) => {
  if (typeof channel !== 'string') return;
  subscribeTerminalChannel(channel, event.sender);
});
ipcMain.on('unsubscribe-terminal', (event, channel) => {
  if (typeof channel !== 'string') return;
  unsubscribeTerminalChannel(channel, event.sender);
});


migratePrReviewCache();

// macOS apps launched from Finder/Dock get a minimal PATH from launchd
// (~/usr/bin:/bin:/usr/sbin:/sbin), missing brew + the user's local bin
// dirs where gh + claude usually live. Spawning them then errors with
// ENOENT. Prepend the well-known locations so the installed .app can find
// them regardless of how it was launched.
function fixSpawnPath() {
  const homedir = require('os').homedir();
  const candidates = [
    '/opt/homebrew/bin',          // Apple Silicon brew
    '/opt/homebrew/sbin',
    '/usr/local/bin',             // Intel brew + manual installs
    '/usr/local/sbin',
    path.join(homedir, '.local/bin'),
    path.join(homedir, 'bin'),
    path.join(homedir, '.cargo/bin'),
    '/Applications/Cursor.app/Contents/Resources/app/bin',
  ];
  const have = (process.env.PATH || '').split(':').filter(Boolean);
  const want = candidates.filter((p) => !have.includes(p));
  if (want.length) {
    process.env.PATH = want.concat(have).join(':');
  }
}
fixSpawnPath();

function checkExternalCLIs() {
  const deps = [
    { bin: 'gh', name: 'GitHub CLI', uses: 'PR review and GitHub features' },
    { bin: 'claude', name: 'Claude Code', uses: 'AI features (inline edits, ghost text, completions)' },
  ];
  const missing = [];
  let remaining = deps.length;
  deps.forEach((d) => {
    execFile('which', [d.bin], { timeout: 2000 }, (err) => {
      if (err) missing.push(d);
      if (--remaining === 0 && missing.length) {
        const detail = missing.map((m) => `• ${m.name} (${m.bin}) — used for ${m.uses}`).join('\n');
        dialog.showMessageBox({
          type: 'info',
          title: 'Optional CLIs not found',
          message: 'Klaussy will run, but some features need these CLIs on your PATH:',
          detail,
          buttons: ['OK'],
        });
      }
    });
  });
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
          label: 'GitHub Accounts',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-gh-accounts');
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
  checkExternalCLIs();

  // Periodically save sessions in case quit events don't fire
  setInterval(() => {
    if (!isQuitting && instances.size > 0) {
      try { saveSessions(); } catch (err) { console.error('saveSessions failed:', err.message); }
    }
  }, 10000);

  // Start auto-fetch background interval
  startAutoFetch();
});

function shutdownAndSave() {
  if (!isQuitting) {
    isQuitting = true;
    try { saveSessions(); } catch (err) { console.error('saveSessions failed at shutdown:', err.message); }
  }
  for (const [, inst] of instances) {
    try { inst.pty.kill(); } catch {}
  }
  // saveConfig is now async (queued atomic writes). Return the tail of the
  // queue so callers can await the flush before quitting.
  return flushSaveConfig();
}

app.on('window-all-closed', () => {
  if (allWindows.size === 0) {
    shutdownAndSave().finally(() => app.quit());
  }
});

let _beforeQuitFlushed = false;
app.on('before-quit', (event) => {
  // Notify all renderers to save UI state
  for (const win of allWindows) {
    if (!win.isDestroyed()) win.webContents.send('app-before-quit');
  }
  // Stop LSP servers here (merged from a second before-quit handler that
  // used to live further down the file).
  try { lspManager.stopAllServers(); } catch {}
  if (_beforeQuitFlushed) return;
  event.preventDefault();
  shutdownAndSave().finally(() => {
    _beforeQuitFlushed = true;
    app.quit();
  });
});

app.on('will-quit', () => {
  // shutdownAndSave already awaited in before-quit; keep idempotent call here
  // for the window-all-closed path.
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

// ---- IPC Handlers ----

// ---- Session Persistence ----


ipcMain.handle('select-repo', async () => {
  const result = await dialog.showOpenDialog(getMainWindow(), {
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
  const mw = getMainWindow();
  if (!mw || mw.isDestroyed()) return false;
  const { response } = await dialog.showMessageBox(mw, {
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



// ---- Sub-terminal Multiplexing (Feature 5) ----



// ---- Idle Notification Toggle ----


// ---- Rename Task (A4) ----


// ---- H2: Cross-task review inbox aggregator ----
// (collectWorktreeState lives in main/ipc/git.js now and is imported above.)



// ---- Phase E: Reliability / Diagnostics ----


// E3: Per-task env vars — stored in create-task and passed to pty spawn
// The create-task handler already exists; we extend the modal to pass env/cwd
// and store them on the instance. The spawn functions already use worktreePath as cwd.

// ---- Phase 3: Multi-Project ----

ipcMain.handle('list-projects', () => {
  const config = loadConfig();
  return config.projects || [];
});

ipcMain.handle('add-project', async () => {
  const result = await dialog.showOpenDialog(getMainWindow(), {
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

// ---- Phase 4: Pop-Out Windows ----


// ---- Phase G: Review others' PRs ----
//
// State (prReview.active) + fetch/broadcast helpers live in
// main/state/pr-review.js; this file owns only the IPC handlers + the
// ghJson / ghText helpers they share. The ipc/pr-review.js module will
// absorb both in Phase 3.

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
    prReview.active = {
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

ipcMain.handle('pr-recent', () => {
  const config = loadConfig();
  return { items: config.reviewHistory || [] };
});

ipcMain.handle('pr-refresh-threads', async () => {
  if (!prReview.active) return { error: 'No active PR review' };
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
  if (!prReview.active) return { error: 'No active PR review' };
  const { meta, baseOwner, baseRepo } = prReview.active;
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

  // Only surface an error if BOTH APIs failed — previously `||` meant that
  // a legitimate "no checks" response from one endpoint plus a transient
  // failure on the other was reported as an error, swallowing real data.
  if (checks.length === 0 && runsRes.err && statusRes.err) {
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
ipcMain.handle('pr-debug-check-start', (event, { requestId, checkLink, checkName }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (debugCheckProcs.has(requestId)) return { error: 'Already debugging' };
  if (!prReview.active) return { error: 'No active PR review' };
  const { meta, baseOwner, baseRepo, diff } = prReview.active;
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

  spawnClaudeStream({
    requestId, procMap: debugCheckProcs, channelPrefix: 'pr-debug-check',
    sender, cwd, prompt,
  });
  return { ok: true };
});

ipcMain.handle('pr-debug-check-cancel', makeClaudeCancelHandler(debugCheckProcs));

// K3: inline AI edit — streams a claude -p replacement for a selection.
// Kept deliberately strict: the prompt tells claude to emit ONLY the
// replacement code so the renderer can paste it back verbatim without
// having to strip markdown fences or preamble.
ipcMain.handle('inline-edit-start', (event, { requestId, worktreePath, instruction, selection, languageId, filePath }) => {
  const prompt =
    'You are editing code inline. Apply this instruction to the code below and return ONLY the replacement code.\n\n' +
    'Rules (strict):\n' +
    '- Respond with ONLY the replacement code — no explanations, no markdown code fences, no preamble, no trailing commentary.\n' +
    '- Preserve the indentation style of the original (tabs vs spaces, width).\n' +
    '- Keep the replacement self-contained: it will replace the exact selection in-place.\n' +
    '- Do not add imports unless the instruction requires them; if you do, they belong inside the replacement, not elsewhere.\n\n' +
    (filePath ? `File: ${filePath}\n` : '') +
    (languageId ? `Language: ${languageId}\n\n` : '\n') +
    `Instruction: ${instruction}\n\n` +
    'Original selection:\n' +
    selection + '\n';

  spawnClaudeStream({
    requestId, procMap: inlineEditProcs, channelPrefix: 'inline-edit',
    sender: event.sender,
    cwd: worktreePath || currentRepoPath() || require('os').homedir(),
    prompt,
  });
  return { ok: true };
});

ipcMain.handle('inline-edit-cancel', makeClaudeCancelHandler(inlineEditProcs));

// K6: inline AI completion — predicts what comes at the cursor.
// Context-before / context-after let claude see both sides of the insertion
// point so completions respect what already exists on the next line.
ipcMain.handle('inline-complete-start', (event, { requestId, worktreePath, before, after, languageId, filePath }) => {
  const prompt =
    'You are an inline code-completion engine. Predict what belongs at the cursor position.\n\n' +
    'Rules (strict):\n' +
    '- Return ONLY the insertion text — no explanations, no markdown fences, no preamble.\n' +
    '- Keep it concise: a few lines at most; stop when the natural unit ends (statement, block, close paren).\n' +
    '- Do NOT repeat the text that already comes before or after the cursor.\n' +
    '- Match the surrounding indentation style exactly.\n' +
    '- If nothing obvious should go here, return an empty response.\n\n' +
    (filePath ? `File: ${filePath}\n` : '') +
    (languageId ? `Language: ${languageId}\n\n` : '\n') +
    'Before cursor:\n' + before + '\n\n' +
    '<CURSOR>\n\n' +
    'After cursor:\n' + after + '\n';

  spawnClaudeStream({
    requestId, procMap: inlineCompleteProcs, channelPrefix: 'inline-complete',
    sender: event.sender,
    cwd: worktreePath || currentRepoPath() || require('os').homedir(),
    prompt,
  });
  return { ok: true };
});

ipcMain.handle('inline-complete-cancel', makeClaudeCancelHandler(inlineCompleteProcs));

ipcMain.handle('pr-review-merge', async (_event, { strategy }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const flag = { merge: '--merge', squash: '--squash', rebase: '--rebase' }[strategy];
  if (!flag) return { error: 'Unknown merge strategy: ' + strategy };
  const { meta } = prReview.active;
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

// G5: materialize the PR as a worktree + spawn a task in it.
ipcMain.handle('pr-checkout-locally', async () => {
  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };
  const { worktreePath, branch } = ensured;
  const { number, baseOwner, baseRepo } = prReview.active;

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
  if (prReview.active && prReview.active.popout && !prReview.active.popout.isDestroyed()) {
    prReview.active.popout.close();
  }
  prReview.active = null;
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
ipcMain.handle('pr-review-ai-start', async (event, { requestId }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (reviewSurfaceAiProcs.has(requestId)) return { error: 'Already in flight' };
  if (!prReview.active) return { error: 'No active PR review' };

  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };

  const baseBranch = (prReview.active.meta && prReview.active.meta.baseRefName) || 'main';
  const prompt = PR_REVIEW_TEMPLATE
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch)
    .replace(/\{\{REPO_SPECIFIC_CHECKS\}\}/g, '');

  spawnClaudeStream({
    requestId, procMap: reviewSurfaceAiProcs, channelPrefix: 'pr-review-ai',
    sender: event.sender,
    cwd: ensured.worktreePath,
    prompt,
    streamJson: true,
  });
  return { ok: true, worktreePath: ensured.worktreePath };
});

ipcMain.handle('pr-review-ai-cancel', makeClaudeCancelHandler(reviewSurfaceAiProcs));

// G7: implement a single finding (or "all findings" via one big prompt) by
// spawning claude in the PR's worktree with edit tools. Mirrors the AI-review
// streaming protocol so the renderer can show progress chips + result.
ipcMain.handle('pr-review-implement-start', async (event, { requestId, mode, body }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (implementProcs.has(requestId)) return { error: 'Already in flight' };
  if (!prReview.active) return { error: 'No active PR review' };
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

  spawnClaudeStream({
    requestId, procMap: implementProcs, channelPrefix: 'pr-review-implement',
    sender: event.sender,
    cwd: ensured.worktreePath,
    prompt,
    streamJson: true,
    extraDoneFields: { worktreePath: ensured.worktreePath },
  });
  return { ok: true, worktreePath: ensured.worktreePath };
});

ipcMain.handle('pr-review-implement-cancel', makeClaudeCancelHandler(implementProcs));

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
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/issues/${number}/comments`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.

  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
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

// Patch an existing issue comment. `commentId` is the REST numeric id
// (GraphQL exposes it as databaseId). Posts to the `/issues/comments/{id}`
// REST endpoint — distinct from review comments which live under `/pulls/`.
ipcMain.handle('pr-edit-issue-comment', async (_event, { commentId, body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const id = parseInt(commentId, 10);
  if (!id) return { error: 'Missing or invalid comment id' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/issues/comments/${id}`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.
  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'PATCH', '--input', '-'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try { const p = JSON.parse(stdoutBuf); if (p.message) msg = p.message; } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true, body });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

// Patch an existing inline/review comment. Separate endpoint from issue
// comments: `/repos/{o}/{r}/pulls/comments/{id}`.
ipcMain.handle('pr-edit-review-comment', async (_event, { commentId, body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const id = parseInt(commentId, 10);
  if (!id) return { error: 'Missing or invalid comment id' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/comments/${id}`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.
  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'PATCH', '--input', '-'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try { const p = JSON.parse(stdoutBuf); if (p.message) msg = p.message; } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true, body });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

// Cache the current gh-authed user so we only show the edit control on
// comments this user can actually modify. gh api /user is the cheap
// canonical endpoint; we call it once per review session.
let cachedCurrentUser = null;
ipcMain.handle('pr-current-user', async () => {
  if (cachedCurrentUser) return { login: cachedCurrentUser };
  try {
    const out = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      stdio: 'pipe', timeout: 10000,
    }).toString().trim();
    if (out) cachedCurrentUser = out;
    return { login: cachedCurrentUser };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// Reply to a specific review comment (threaded). `inReplyTo` is the parent
// comment's REST databaseId — the same id GraphQL returns on each review
// comment so we can thread using data we already fetch. Uses GitHub's
// dedicated replies endpoint so we don't have to fake a new-comment shape.
ipcMain.handle('pr-reply-to-review-comment', async (_event, { inReplyTo, body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const parentId = parseInt(inReplyTo, 10);
  if (!parentId) return { error: 'Missing or invalid parent comment id' };
  if (!body || !body.trim()) return { error: 'Reply body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/${number}/comments/${parentId}/replies`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.

  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
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
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number } = prReview.active;
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
  // `spawn` is imported at the top of the file.

  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
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

ipcMain.handle('pr-review-state', () => prReview.active ? sanitizePrReview(prReview.active) : null);

ipcMain.handle('pr-review-close', () => {
  if (prReview.active && prReview.active.popout && !prReview.active.popout.isDestroyed()) {
    prReview.active.popout.close();
  }
  prReview.active = null;
  broadcastPrReview();
  return { ok: true };
});

ipcMain.handle('pop-out-pr-review', () => {
  if (!prReview.active) return { error: 'No active PR review' };
  if (prReview.active.popout && !prReview.active.popout.isDestroyed()) {
    prReview.active.popout.focus();
    return { ok: true };
  }

  const popout = new BrowserWindow({
    width: 1100,
    height: 800,
    title: `Review \u2014 #${prReview.active.number} ${prReview.active.meta.title || ''}`,
    icon: path.join(__dirname, 'icon.icns'),
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(popout);

  popout.loadFile(path.join(__dirname, 'renderer', 'pr-review.html'));
  prReview.active.popout = popout;
  broadcastPrReview();

  popout.on('closed', () => {
    if (prReview.active && prReview.active.popout === popout) {
      prReview.active.popout = null;
      broadcastPrReview();
    }
  });

  return { ok: true };
});

ipcMain.handle('pop-in-pr-review', () => {
  if (prReview.active && prReview.active.popout && !prReview.active.popout.isDestroyed()) {
    prReview.active.popout.close();
  }
  return { ok: true };
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
ipcMain.handle('explain-diff-stream-start', (event, { requestId, worktreePath, file, hunk }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (explainStreamProcs.has(requestId)) return { error: 'Already streaming' };
  spawnClaudeStream({
    requestId, procMap: explainStreamProcs, channelPrefix: 'explain-diff',
    sender: event.sender,
    cwd: worktreePath || currentRepoPath() || require('os').homedir(),
    prompt: explainPrompt(file, hunk),
  });
  return { ok: true };
});

// Streams a suggested commit message for the staged changes into the diff
// panel. Renderer shows a sparkle button next to the commit input; the result
// is editable before the user actually commits. Pulls the last few commit
// subjects so claude can match the repo's tone (conventional / prefix / etc.)
// without us prescribing a style.
ipcMain.handle('claude-commit-message-start', async (event, { requestId, worktreePath }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (commitMsgProcs.has(requestId)) return { error: 'Already generating' };
  if (!worktreePath) return { error: 'Missing worktreePath' };

  let diff = '';
  try {
    const { stdout } = await execFileP('git', ['diff', '--cached'], {
      cwd: worktreePath, maxBuffer: 5 * 1024 * 1024,
    });
    diff = stdout;
  } catch (err) {
    return { error: 'Could not read staged diff: ' + (err.stderr || err.message) };
  }
  if (!diff.trim()) return { error: 'No staged changes to summarize' };

  // Cap diff to keep the prompt inside a reasonable budget. If the staged diff
  // is huge, trim and tell claude we truncated so it doesn't hallucinate whole
  // regions of the change.
  const MAX = 80 * 1024;
  const diffForPrompt = diff.length > MAX
    ? diff.slice(0, MAX) + '\n\n[... diff truncated ...]\n'
    : diff;

  let recent = '';
  try {
    const { stdout } = await execFileP('git', ['log', '-n', '10', '--format=%s'], {
      cwd: worktreePath,
    });
    recent = stdout.trim();
  } catch { /* brand-new repo or no commits; omit style sample */ }

  const prompt =
    'Write a commit message for the staged changes below.\n\n' +
    'Rules (strict):\n' +
    '- Output ONLY the commit message — no explanations, no code fences, no preamble.\n' +
    '- First line is the subject: imperative mood, under 72 chars, no trailing period.\n' +
    '- If the change is non-trivial, add a blank line and a short body explaining the "why".\n' +
    '- Match the style (prefix conventions, length, tone) of the recent subjects shown below.\n\n' +
    (recent ? 'Recent commit subjects (for style only):\n' + recent + '\n\n' : '') +
    'Staged diff:\n' + diffForPrompt;

  spawnClaudeStream({
    requestId, procMap: commitMsgProcs, channelPrefix: 'claude-commit-message',
    sender: event.sender,
    cwd: worktreePath,
    prompt,
  });
  return { ok: true };
});

ipcMain.handle('claude-commit-message-cancel', makeClaudeCancelHandler(commitMsgProcs));

ipcMain.handle('explain-diff-stream-cancel', makeClaudeCancelHandler(explainStreamProcs));

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

// Legacy config.prReviews cache was retired in favor of the file-per-PR cache
// in userData/pr-review-cache/. Entries are migrated once on startup via
// migratePrReviewCache(); see the file-per-PR handlers above for the current
// shape and the *-by-pr IPCs.

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
  // `text` is PR-comment / AI-finding content from untrusted GitHub. If it
  // contains \x1b[201~ (the paste end marker), the shell exits paste mode
  // mid-write and treats the remainder as typed input — which would execute
  // injected commands. Strip the paste-mode sequences from `text` so they
  // cannot break out of the bracket we wrap it in.
  const safeText = typeof text === 'string'
    ? text.replace(/\x1b\[20[01]~/g, '')
    : '';
  try {
    target.pty.write(BP_START + safeText + BP_END);
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

  // stream-json gives us a JSONL event per assistant/tool/result block so we
  // can surface progress in the UI instead of a 15-minute silent spinner.
  spawnClaudeStream({
    requestId, procMap: aiReviewProcs, channelPrefix: 'pr-ai-review',
    sender: event.sender,
    cwd: worktreePath,
    prompt,
    streamJson: true,
  });
  return { ok: true };
});

ipcMain.handle('pr-ai-review-cancel', makeClaudeCancelHandler(aiReviewProcs));

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

// ---- Task Notes (Feature 14) ----


