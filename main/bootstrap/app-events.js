// Application lifecycle: PATH-fixing for Finder launches, external-CLI probe,
// whenReady (menu + window + auto-fetch + periodic save), window-all-closed /
// before-quit / will-quit, and the saveSessions helper that the save path
// depends on. Owns `isQuitting` and dependency-injects it into
// state/instances.js (so spawnInWorktree's orphan-shell guard can read it).

const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { resolveAgentBin } = require('../util/agent-bin');
const { fixSpawnPath, refreshSpawnPath } = require('../util/spawn-path');
const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const lspManager = require('../../lsp-manager');
const { loadConfig, saveConfig, flushSaveConfig, runConfigMigrations } = require('../util/config');
const { mergeSavedSessions } = require('../util/saved-sessions');
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
const { startPrMonitor } = require('../state/pr-monitor');
const prReviewModule = require('../state/pr-review');
require('../ipc/tasks');
const { installAppMenu } = require('./menu');
const { installSecondInstanceFocus } = require('./single-instance');

let isQuitting = false;

// Startup nudge: gh is needed for PR/GitHub features, and at least ONE agent
// CLI is needed to run tasks. We don't require any specific agent — Claude,
// Codex, Gemini, or Copilot all satisfy it — so a Codex-only user isn't told
// they're "missing Claude".
function checkExternalCLIs() {
  const config = loadConfig();
  const providers = allProviders();
  const problems = [];
  if (!resolveAgentBin('gh')) {
    problems.push('• GitHub CLI (gh) — used for PR review and GitHub features');
  }
  // some() so the first installed agent short-circuits the rest.
  if (!providers.some((p) => resolveAgentBin(binFor(p.id, config)))) {
    const names = providers.map((p) => p.displayName).join(', ');
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
}

// A fresh tab has no id until its agent writes the transcript, so it resolves on
// a later save; `claimed` stops two tabs on one worktree adopting the same id.
function resolveSubSessionId(inst, sub, claimed) {
  if (sub.sessionId) return sub.sessionId;
  const provider = getProvider(sub.mode);
  if (!provider || typeof provider.findNewSession !== 'function') return null;
  let found = null;
  try {
    found = provider.findNewSession(inst.worktreePath, sub.preSpawnSessions || new Set());
  } catch { return null; } // a session store we cannot read is not worth failing the save
  if (!found || !found.sessionId || claimed.has(found.sessionId)) return null;
  sub.sessionId = found.sessionId;
  return sub.sessionId;
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

  const sessions = [];
  const claimedSubSessions = new Set();
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
      // notifyPrefs also holds the bell, but keyed by tab name — which two
      // agents on one worktree can share. Recorded per session as well, so a
      // resumed tab comes back the way it was left.
      notifyWebhook: inst.notifyWebhookEnabled === true,
      devLoop: inst.devLoop === true,
      // A second agent opens as a tab on this task rather than a task of its
      // own, so it has no entry here to be resumed from — it rides on the one
      // belonging to the agent that started the session.
      subAgents: (inst.subTerminals || [])
        .filter((s) => s && s.alive && isAgentMode(s.mode))
        .map((s) => {
          const subSessionId = resolveSubSessionId(inst, s, claimedSubSessions);
          if (subSessionId) claimedSubSessions.add(subSessionId);
          return { mode: s.mode, label: s.label || null, sessionId: subSessionId };
        }),
      savedAt: new Date().toISOString(),
    });
  }
  // saveConfig's write is queued, so passing a whole snapshot would revert
  // anything saved between this function starting and landing.
  saveConfig({ savedSessions: mergeSavedSessions(sessions, loadConfig().savedSessions) });
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

  // A second launch of this build focuses the running window instead of
  // starting a rival process (the lock itself is acquired in main.js).
  installSecondInstanceFocus(getMainWindow, allWindows);

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
          // After install + any daily upgrade, warn (once) if klaussy-agents is
          // still below the version floor so the user gets a one-click upgrade
          // instead of silently working against stale skills.
          .then(() => repoIntel.warnIfKlaussyOutdated())
          .catch((e) => console.warn('[repo-intel] tool install/upgrade at boot failed:', e.message));
      }, 3000);
    }

    // Ollama's 4096 default costs opencode its tools and history; deferred and
    // fire-and-forget so a local HTTP call never delays startup.
    if (!process.env.KLAUSSY_E2E) {
      setTimeout(() => {
        require('../state/opencode-config').ensureStartupContextFloor()
          .then((r) => { if (r && r.error) console.warn('[opencode] context floor:', r.error); })
          .catch((e) => console.warn('[opencode] context floor failed:', e.message));
      }, 5000);
    }

    // Periodically save sessions in case quit events don't fire
    setInterval(() => {
      if (!isQuitting && instances.size > 0) {
        try { saveSessions(); } catch (err) { console.error('saveSessions failed:', err.message); }
      }
    }, 10000);

    // Start auto-fetch background interval
    startAutoFetch();
    // Start pull-request background monitoring & auto-fixing
    startPrMonitor();
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
