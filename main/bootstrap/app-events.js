// Application lifecycle: PATH-fixing for Finder launches, external-CLI probe,
// whenReady (menu + window + auto-fetch + periodic save), window-all-closed /
// before-quit / will-quit, and the saveSessions helper that the save path
// depends on. Owns `isQuitting` and dependency-injects it into
// state/instances.js (so spawnInWorktree's orphan-shell guard can read it).

const path = require('path');
const fs = require('fs');
const { execSync, execFileSync, execFile } = require('child_process');
const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const lspManager = require('../../lsp-manager');
const { loadConfig, saveConfig, flushSaveConfig, runConfigMigrations } = require('../util/config');
const {
  allWindows, getMainWindow, createWindow, setWindowCloseHook,
} = require('../state/windows');
const instancesModule = require('../state/instances');
const {
  instances,
  subscribeTerminalChannel, unsubscribeTerminalChannel,
  detectClaudeSessionId, findLatestSessionId,
} = instancesModule;
const { getProvider, isAgentMode, allProviders, binFor } = require('../state/ai-providers');
const { startAutoFetch, startCIPolling, stopCIPolling } = require('../state/ci-poll');
const prReviewModule = require('../state/pr-review');
require('../ipc/tasks');
const { installAppMenu } = require('./menu');

let isQuitting = false;

// GUI-launched apps don't inherit a shell's PATH, so a pip/pipx-installed CLI
// (klaussy, conventions, plus gh/claude) is invisible to spawns and errors
// with ENOENT until we prepend the well-known install dirs. This bites every
// platform, not just macOS:
//   - macOS: Finder/Dock launches get a minimal launchd PATH (/usr/bin:/bin:
//     /usr/sbin:/sbin), missing brew + the user's local bin dirs.
//   - Windows: GUI launches inherit the registry PATH, which does NOT include
//     pipx's default bin dir (%USERPROFILE%\.local\bin) or pip --user's
//     Scripts dir unless `pipx ensurepath` ran AND the user re-logged in.
//   - Linux: a .desktop/AppImage launch inherits a minimal PATH that may omit
//     ~/.local/bin (where pipx + pip --user land).
// Returns the per-platform list of dirs to put on PATH. Adding a dir that
// doesn't exist is a harmless no-op, so we don't stat them here.
function spawnPathCandidates() {
  const homedir = require('os').homedir();
  if (process.platform === 'win32') {
    const out = [
      // pipx's default bin dir is ~/.local/bin on EVERY OS, Windows included.
      path.join(homedir, '.local', 'bin'),
    ];
    // pip --user console scripts: %APPDATA%\Python\Python3X\Scripts. The minor
    // version varies, so enumerate what exists.
    if (process.env.APPDATA) {
      const pyRoot = path.join(process.env.APPDATA, 'Python');
      try {
        for (const e of fs.readdirSync(pyRoot, { withFileTypes: true })) {
          if (e.isDirectory()) out.push(path.join(pyRoot, e.name, 'Scripts'));
        }
      } catch { /* nothing pip-user installed */ }
    }
    return out;
  }
  // macOS + Linux intermixed — a path that doesn't exist on one is harmless.
  const out = [
    '/opt/homebrew/bin',          // Apple Silicon brew (mac)
    '/opt/homebrew/sbin',
    '/usr/local/bin',             // Intel brew + manual installs (mac/linux)
    '/usr/local/sbin',
    '/snap/bin',                  // snap-installed CLIs (Ubuntu/snap distros)
    path.join(homedir, '.local/bin'),   // pipx + pip --user (linux, mac)
    path.join(homedir, 'bin'),
    path.join(homedir, '.cargo/bin'),
    '/Applications/Cursor.app/Contents/Resources/app/bin',
  ];
  // macOS `pip install --user` drops console scripts into
  // ~/Library/Python/<X.Y>/bin — NOT ~/.local/bin. Without this a pip-user
  // fallback install "succeeds" but the CLI is invisible (spawn ENOENT).
  if (process.platform === 'darwin') {
    try {
      const pyRoot = path.join(homedir, 'Library', 'Python');
      for (const e of fs.readdirSync(pyRoot, { withFileTypes: true })) {
        if (e.isDirectory()) out.push(path.join(pyRoot, e.name, 'bin'));
      }
    } catch { /* no ~/Library/Python — nothing pip-user installed */ }
  }
  return out;
}

// Prepend dirs to process.env.PATH (de-duped, OS-correct separator). Prepend
// — not append — so our known-good install dir wins over a stale shim earlier
// on PATH.
function prependToSpawnPath(dirs) {
  const sep = path.delimiter;
  const have = (process.env.PATH || '').split(sep).filter(Boolean);
  const want = dirs.filter((d) => d && !have.includes(d));
  if (want.length) process.env.PATH = want.concat(have).join(sep);
}

function fixSpawnPath() {
  prependToSpawnPath(spawnPathCandidates());
}

// Ask pipx where it actually exposes app shims — honors a custom PIPX_BIN_DIR
// the static candidate list can't know about. Best-effort; null if pipx is
// absent or the query fails.
function pipxBinDir() {
  try {
    const out = execFileSync('pipx', ['environment', '--value', 'PIPX_BIN_DIR'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).toString().trim();
    return out || null;
  } catch { return null; }
}

// Refresh process.env.PATH from the OS's authoritative source — used after
// the in-app installer runs so newly-installed binaries are reachable
// without a Klaussy restart. fixSpawnPath() only adds *known* dirs; this
// also picks up whatever brew/winget/apt or pipx ensurepath touched.
//
//   macOS / Linux: spawn a login+interactive shell which sources the user's
//                  rc/profile files, then read its $PATH.
//   Windows:       re-read HKLM + HKCU "Path" from the registry (which is
//                  what GUI launches start from anyway).
function refreshSpawnPath() {
  fixSpawnPath();
  // pipx may expose shims under a custom PIPX_BIN_DIR the static list misses.
  const px = pipxBinDir();
  if (px) prependToSpawnPath([px]);
  try {
    if (process.platform === 'win32') {
      const out1 = execSync('reg query "HKCU\\Environment" /v Path', { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 }).toString();
      const out2 = execSync('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path', { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 }).toString();
      const extract = (txt) => {
        const m = txt.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+?)\r?\n/);
        return m ? m[1].trim() : '';
      };
      const fresh = [extract(out2), extract(out1)].filter(Boolean).join(';').split(';').filter(Boolean);
      if (fresh.length) {
        const have = (process.env.PATH || '').split(';').filter(Boolean);
        const merged = [];
        for (const p of fresh) if (!merged.includes(p)) merged.push(p);
        for (const p of have)  if (!merged.includes(p)) merged.push(p);
        process.env.PATH = merged.join(';');
      }
      return;
    }
    // POSIX: -l (login) sources profile files, -i (interactive) sources rc.
    // Both together mimic a fresh login shell. Output goes to stdout; any
    // rc-file noise goes to stderr which we discard.
    const shell = process.env.SHELL || '/bin/bash';
    const out = execSync(`${shell} -lic 'echo "$PATH"' 2>/dev/null`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
    if (out) {
      const fresh = out.split(':').filter(Boolean);
      const have = (process.env.PATH || '').split(':').filter(Boolean);
      const merged = [];
      for (const p of have)  if (!merged.includes(p)) merged.push(p);
      for (const p of fresh) if (!merged.includes(p)) merged.push(p);
      process.env.PATH = merged.join(':');
    }
  } catch { /* shell or registry read failed; keep current PATH */ }
}

// Resolve whether a binary is reachable: a configured absolute path is checked
// on disk; a bare name is looked up on PATH via `which`.
function binPresent(bin, cb) {
  if (bin && bin.includes('/')) { cb(fs.existsSync(bin)); return; }
  execFile('which', [bin], { timeout: 2000 }, (err) => cb(!err));
}

// Startup nudge: gh is needed for PR/GitHub features, and at least ONE agent
// CLI is needed to run tasks. We don't require any specific agent — Claude,
// Codex, Gemini, or Copilot all satisfy it — so a Codex-only user isn't told
// they're "missing Claude".
function checkExternalCLIs() {
  const config = loadConfig();
  const agents = allProviders().map((p) => ({ name: p.displayName, bin: binFor(p.id, config) }));
  let remaining = 1 + agents.length;
  let ghMissing = false;
  let anyAgent = false;

  const finish = () => {
    if (--remaining > 0) return;
    const problems = [];
    if (ghMissing) problems.push('• GitHub CLI (gh) — used for PR review and GitHub features');
    if (!anyAgent) {
      const names = allProviders().map((p) => p.displayName).join(', ');
      problems.push(`• An AI agent CLI (${names}) — needed to run tasks`);
    }
    if (!problems.length) return;
    dialog.showMessageBox({
      type: 'info',
      title: 'Optional CLIs not found',
      message: 'Klaussy will run, but some features need these on your PATH:',
      detail: problems.join('\n') + '\n\nOpen Setup Check in the app to install them.',
      buttons: ['OK'],
    });
  };

  binPresent('gh', (ok) => { if (!ok) ghMissing = true; finish(); });
  agents.forEach((a) => binPresent(a.bin, (ok) => { if (ok) anyAgent = true; finish(); }));
}

function saveSessions() {
  // Only overwrite savedSessions if there are active instances;
  // otherwise keep whatever was previously saved
  if (instances.size === 0) return;

  // Group exact-resume agents (Claude today) by worktree so we can
  // disambiguate when multiple terminals share a worktree. Each such instance
  // owns its own session .jsonl. Other providers don't track exact ids — they
  // resume their latest session in the worktree via a native flag — so they're
  // saved with sessionId=null and skipped here.
  const exactByWorktree = new Map();
  for (const [, inst] of instances) {
    const saveMode = inst.originalMode || inst.mode;
    const provider = getProvider(saveMode);
    if (!provider || !provider.supportsExactResume) continue;
    if (!exactByWorktree.has(inst.worktreePath)) exactByWorktree.set(inst.worktreePath, []);
    exactByWorktree.get(inst.worktreePath).push(inst);
  }

  // For each worktree, resolve instance session IDs by picking .jsonl files
  // that (a) weren't present at that instance's spawn and (b) haven't already
  // been claimed by another instance on the same worktree. This covers fresh
  // spawns (detect picks up the new file) and resumes where Claude forks the
  // session into a new .jsonl (detect supersedes the initial resume id).
  for (const [, insts] of exactByWorktree) {
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
    const provider = getProvider(saveMode);
    const sessionId = provider && provider.supportsExactResume
      ? (inst.claudeSessionId || findLatestSessionId(inst.worktreePath))
      : null;
    sessions.push({
      sessionId: sessionId,
      name: inst.name,
      worktreePath: inst.worktreePath,
      branch: inst.branch,
      mode: saveMode,
      repoPath: inst.repoPath || null,
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
  instancesModule.setDeps({
    isQuitting: () => isQuitting,
    startCIPolling,
    stopCIPolling,
  });

  // Closing a window while others stay open: kill the tasks only that window
  // was rendering so their worktrees stop reading as "active" (otherwise the
  // session can't be reopened from another window — "Every worktree in this
  // session is already open."). Skipped when quitting or closing the LAST
  // window — those paths run shutdownAndSave, which persists live sessions for
  // resume; reclaiming first would delete them before they're saved. (The
  // closing window is still in allWindows during 'close', so size <= 1 means
  // it's the last one.)
  setWindowCloseHook((win) => {
    if (isQuitting || allWindows.size <= 1) return;
    if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
    instancesModule.reclaimOrphanedTasks(win.webContents);
  });

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

    // First-run: auto-install the repo-analysis CLIs (klaussy-repo-conventions
    // + klaussy-agents) from PyPI if missing, so repo intelligence works out of the
    // box. Background, after the window exists so its toasts are visible;
    // never blocks startup.
    if (!process.env.KLAUSSY_E2E) {
      setTimeout(() => {
        const repoIntel = require('../state/repo-intel');
        // Install if missing, then (daily-gated) upgrade to latest so users keep
        // getting new skills. Upgrade after install so a fresh machine doesn't
        // do both at once.
        Promise.resolve()
          .then(() => repoIntel.ensureReviewTools())
          .then(() => repoIntel.upgradeReviewToolsIfDue())
          .catch((e) => console.warn('[repo-intel] tool install/upgrade at boot failed:', e.message));
      }, 3000);
    }

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
    // If a review left a non-default gh account active, restore the user's
    // original active account on quit so the terminal/git aren't left switched.
    try { require('../state/pr-review').restoreGhAfterReview(); } catch (_) {}
  });
}

module.exports = { install, refreshSpawnPath };
