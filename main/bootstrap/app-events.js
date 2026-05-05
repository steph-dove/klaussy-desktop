// Application lifecycle: PATH-fixing for Finder launches, external-CLI probe,
// whenReady (menu + window + auto-fetch + periodic save), window-all-closed /
// before-quit / will-quit, and the saveSessions + klausify-init helpers that
// the save path depends on. Owns `isQuitting` and dependency-injects it into
// state/instances.js (so spawnInWorktree's orphan-shell guard can read it).

const path = require('path');
const fs = require('fs');
const { execSync, execFileSync, execFile } = require('child_process');
const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const lspManager = require('../../lsp-manager');
const { loadConfig, saveConfig, flushSaveConfig, runConfigMigrations } = require('../util/config');
const {
  allWindows, getMainWindow, createWindow,
} = require('../state/windows');
const instancesModule = require('../state/instances');
const {
  instances,
  subscribeTerminalChannel, unsubscribeTerminalChannel,
  detectClaudeSessionId, findLatestSessionId,
} = instancesModule;
const { startAutoFetch, startCIPolling } = require('../state/ci-poll');
const prReviewModule = require('../state/pr-review');
const tasksModule = require('../ipc/tasks');
const { installAppMenu } = require('./menu');

let isQuitting = false;

// macOS apps launched from Finder/Dock get a minimal PATH from launchd
// (~/usr/bin:/bin:/usr/sbin:/sbin), missing brew + the user's local bin
// dirs where gh + claude usually live. Spawning them then errors with
// ENOENT. Prepend the well-known locations so the installed .app can find
// them regardless of how it was launched.
//
// On Windows the system PATH is composed from the registry (HKLM + HKCU
// "Path" values) and is comprehensive enough that GUI launches see the
// same PATH as a fresh shell — no fix-up needed. We no-op there to avoid
// pasting POSIX paths onto a `;`-separated PATH string.
function fixSpawnPath() {
  if (process.platform === 'win32') return;
  const homedir = require('os').homedir();
  // Mac and Linux candidates intermixed — adding paths that don't exist on
  // a given platform is a harmless no-op. Avoiding two near-identical lists.
  const candidates = [
    '/opt/homebrew/bin',          // Apple Silicon brew (mac)
    '/opt/homebrew/sbin',
    '/usr/local/bin',             // Intel brew + manual installs (mac/linux)
    '/usr/local/sbin',
    '/snap/bin',                  // snap-installed CLIs (Ubuntu/snap distros)
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
  const { whichBinSync } = require('../util/platform');

  // pipx works on every platform — but on Windows and minimal Linux installs
  // it's often missing because Python ships without it. Surface a platform-
  // appropriate install hint when pipx isn't on PATH so the user isn't left
  // guessing how to get unstuck.
  if (!whichBinSync('pipx')) {
    let detail;
    if (process.platform === 'win32') {
      detail =
        'klausify needs the pipx CLI. Install pipx first:\n\n' +
        '  python -m pip install --user pipx\n' +
        '  python -m pipx ensurepath\n\n' +
        'Restart Klaussy after pipx is on PATH, or install klausify directly with `pip install klausify`.';
    } else if (process.platform === 'darwin') {
      detail =
        'klausify needs the pipx CLI. Install pipx first:\n\n' +
        '  brew install pipx\n' +
        '  pipx ensurepath\n\n' +
        'Restart Klaussy after pipx is on PATH.';
    } else {
      // Linux + anything else POSIX. apt-installed pipx on Ubuntu 23.04+ works
      // out of the box; older Ubuntus need the python -m fallback.
      detail =
        'klausify needs the pipx CLI. Install pipx first:\n\n' +
        '  sudo apt install pipx   # Ubuntu 23.04+\n' +
        '  python3 -m pip install --user pipx && python3 -m pipx ensurepath\n\n' +
        'Restart Klaussy after pipx is on PATH.';
    }
    await dialog.showMessageBox(mw, {
      type: 'info',
      buttons: ['OK'],
      title: 'pipx not found',
      message: 'klausify CLI is not installed, and pipx is also missing.',
      detail,
    });
    return false;
  }

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
    dialog.showErrorBox(
      'Installation failed',
      'Could not install klausify:\n' + (err.stderr ? err.stderr.toString() : err.message) +
        '\n\nTry manually: pipx install klausify',
    );
    return false;
  }
}

async function runKlausifyInit(worktreePath, baseBranch) {
  // Skip entirely in e2e: a missing-klausify install prompt would hang
  // the test, and a present-klausify run adds 5+ seconds of noise to
  // every create-task spec for behavior the tests aren't asserting.
  if (process.env.KLAUSSY_E2E) return;
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

function install() {
  // Inject deps that state modules need but can't require directly:
  //   - path-gate already got its deps in main.js on import (that's the one
  //     cross-module hookup main.js still owns).
  //   - instances.spawnInWorktree reads isQuitting (local to this module)
  //     and calls startCIPolling (state/ci-poll — importable directly, but
  //     state modules don't import each other; injection avoids the cycle).
  //   - pr-review + tasks call runKlausifyInit, which lives here.
  instancesModule.setDeps({
    isQuitting: () => isQuitting,
    startCIPolling,
  });
  prReviewModule.setDeps({ runKlausifyInit });
  tasksModule.setDeps({ runKlausifyInit });

  // Terminal subscribe/unsubscribe — tiny IPC relay into state/instances.
  ipcMain.on('subscribe-terminal', (event, channel) => {
    if (typeof channel !== 'string') return;
    subscribeTerminalChannel(channel, event.sender);
  });
  ipcMain.on('unsubscribe-terminal', (event, channel) => {
    if (typeof channel !== 'string') return;
    unsubscribeTerminalChannel(channel, event.sender);
  });

  runConfigMigrations();
  fixSpawnPath();

  app.whenReady().then(() => {
    // Force the macOS app menu name. In dev (`npx electron .`) the bundled
    // Info.plist still says "Electron" — setName at startup overrides what
    // the menu template's `label: app.name` resolves to so the menu bar
    // shows "Klaussy" instead.
    app.setName('Klaussy');

    // Set dock icon on macOS using PNG (avoids icon cache issues with .icns)
    if (process.platform === 'darwin' && app.dock) {
      const { nativeImage } = require('electron');
      const iconPath = path.join(__dirname, '..', '..', 'icon.png');
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) {
        app.dock.setIcon(icon);
      }
    }

    installAppMenu();
    createWindow();
    if (!process.env.KLAUSSY_E2E) checkExternalCLIs();

    // Periodically save sessions in case quit events don't fire
    setInterval(() => {
      if (!isQuitting && instances.size > 0) {
        try { saveSessions(); } catch (err) { console.error('saveSessions failed:', err.message); }
      }
    }, 10000);

    // Start auto-fetch background interval
    startAutoFetch();
  });

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
}

module.exports = { install };
