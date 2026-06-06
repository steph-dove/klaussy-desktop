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
  allWindows, getMainWindow, createWindow,
} = require('../state/windows');
const instancesModule = require('../state/instances');
const {
  instances,
  subscribeTerminalChannel, unsubscribeTerminalChannel,
  detectClaudeSessionId, findLatestSessionId,
} = instancesModule;
const { getProvider, isAgentMode, allProviders, binFor } = require('../state/ai-providers');
const { startAutoFetch, startCIPolling } = require('../state/ci-poll');
const prReviewModule = require('../state/pr-review');
require('../ipc/tasks');
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

module.exports = { install, refreshSpawnPath };
