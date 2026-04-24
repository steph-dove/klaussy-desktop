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
require('./main/ipc/repo');
require('./main/ipc/claude-stream-ipc');
require('./main/ipc/pr-review');

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
// runKlausifyInit lives in main.js (moves with bootstrap/app-events.js in
// Phase 4). pr-review's ghJson is injected from ipc/pr-review.js itself
// now that the helper lives in that module.
prReviewModule.setDeps({ runKlausifyInit });
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



