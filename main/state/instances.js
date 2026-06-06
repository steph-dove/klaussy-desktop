// Owns the `instances` Map (id → instance descriptor), the PTY lifecycle
// (spawnInWorktree, convertInstanceToShell), the subscription-based terminal
// broadcast, and the idle-detection machinery that fires Notifications when
// Claude goes quiet or shows a prompt.
//
// Two deps live in modules that don't exist yet and are injected via
// setDeps:
//   - isQuitting() — moving to bootstrap/app-events.js in Phase 4
//   - startCIPolling() — moving to state/ci-poll.js in Phase 2 step 9
// Neither setter has a meaningful default; spawnInWorktree guards each call.

const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const { Notification } = require('electron');
const { loadConfig, saveConfig } = require('../util/config');
const { baseRepoForWorktree } = require('../util/git-repo');
const { sanitizeExtraEnv } = require('../util/exec');
const { defaultShell, shellLoginArgs, shellRunCmdArgs } = require('../util/platform');
const { allWindows, getMainWindow } = require('./windows');
const { getProvider, isAgentMode, binFor, displayNameFor } = require('./ai-providers');
const { ensureWorktreeConsentSync } = require('../util/agent-consent');
const { beginSession } = require('../util/agent-concurrency');

const instances = new Map(); // id -> { name, worktreePath, pty, branch }
let nextId = 1;

let _isQuitting = () => false;
let _startCIPolling = () => {};

function setDeps({ isQuitting, startCIPolling } = {}) {
  if (isQuitting) _isQuitting = isQuitting;
  if (startCIPolling) _startCIPolling = startCIPolling;
}

// Subscription-based PTY broadcast. Previously every onData chunk was sent to
// EVERY BrowserWindow via allWindows + instance.popoutWindows — a 2 main +
// 1 popout setup paid 3× the IPC cost even when only one window actually
// renders that terminal. Now each renderer subscribes to the terminal channels
// it cares about (auto-wired by the onTerminalData preload binding), and we
// send only to that set.
const terminalSubscribers = new Map(); // channel -> Set<webContents>

function subscribeTerminalChannel(channel, webContents) {
  let subs = terminalSubscribers.get(channel);
  if (!subs) { subs = new Set(); terminalSubscribers.set(channel, subs); }
  if (subs.has(webContents)) return;
  subs.add(webContents);
  // Auto-cleanup when the renderer goes away so we don't keep sending to
  // dead senders or leak Set entries. Each subscription adds one destroyed
  // listener; acceptable because Electron caps listeners generously and
  // we remove from the Set here too.
  webContents.once('destroyed', () => {
    const s = terminalSubscribers.get(channel);
    if (s) { s.delete(webContents); if (s.size === 0) terminalSubscribers.delete(channel); }
  });
}

function unsubscribeTerminalChannel(channel, webContents) {
  const subs = terminalSubscribers.get(channel);
  if (!subs) return;
  subs.delete(webContents);
  if (subs.size === 0) terminalSubscribers.delete(channel);
}

function sendToTerminalSubscribers(channel, ...args) {
  const subs = terminalSubscribers.get(channel);
  if (!subs || subs.size === 0) return;
  for (const wc of subs) {
    if (!wc.isDestroyed()) wc.send(channel, ...args);
  }
}

// ---- Session file helpers ----

function listSessionFiles(worktreePath) {
  const home = process.env.HOME || require('os').homedir();
  if (!home || !worktreePath) return [];
  const claudeDir = path.join(home, '.claude', 'projects');
  const encodedPath = worktreePath.replace(/\//g, '-');
  const projectDir = path.join(claudeDir, encodedPath);
  try {
    if (!fs.existsSync(projectDir)) return [];
    return fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        // bigint: true gives `ctimeNs` at nanosecond precision. APFS only
        // exposes 1s / sub-ms granularity for `ctimeMs`, which meant two
        // sessions spawned in the same second could tie in a sort and swap
        // identities on resume. ns-precision is stable across tasks.
        const st = fs.statSync(path.join(projectDir, f), { bigint: true });
        return {
          name: f,
          sessionId: f.replace('.jsonl', ''),
          mtime: Number(st.mtimeMs),
          ctime: Number(st.ctimeMs),
          ctimeNs: st.ctimeNs,  // BigInt
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
    // Sort on ns-precision ctime. BigInt subtraction returns BigInt — convert
    // to Number via sign comparison since Array.sort wants a regular number.
    .sort((a, b) => {
      if (a.ctimeNs < b.ctimeNs) return -1;
      if (a.ctimeNs > b.ctimeNs) return 1;
      return 0;
    });
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
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) {
      mw.show();
      mw.focus();
      mw.webContents.send('notification-clicked', { id: inst.id });
    }
  });

  notification.show();
  inst.lastNotifyTime = Date.now();
}

// CI flip notification — fires when a watched task's latest run flips from
// pending to success/failure. Suppressed if the user is looking at any window
// (they can already see the change in real time). Independent of the idle
// notification's NOTIFY_COOLDOWN_MS — CI events are rarer and we don't want
// to swallow a fail notification because an idle one fired 30s ago.
function sendCIFlipNotification(inst, run, bucket) {
  if (!inst.notifyCIEnabled) return;
  if (isAnyWindowFocused()) return;

  const verb = bucket === 'pass' ? 'passed' : bucket === 'fail' ? 'failed' : bucket;
  const notification = new Notification({
    title: `Klaussy — CI ${verb}`,
    body: `${inst.name}${run && run.name ? ' · ' + run.name : ''}`,
    silent: false,
  });

  notification.on('click', () => {
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) {
      mw.show();
      mw.focus();
      mw.webContents.send('notification-clicked', { id: inst.id, view: 'pr-review' });
    }
  });

  notification.show();
}

function processIdleDetection(inst, data) {
  if (!isAgentMode(inst.mode)) return;

  inst.lastDataTime = Date.now();
  inst.notifiedIdle = false;

  // Update rolling buffer
  const stripped = stripAnsi(data);
  inst.recentOutput = (inst.recentOutput + stripped).slice(-ROLLING_BUFFER_SIZE);

  const agentName = displayNameFor(inst.mode);

  // Reset quiet timer
  if (inst.quietTimer) clearTimeout(inst.quietTimer);
  inst.quietTimer = setTimeout(() => {
    if (inst.alive && isAgentMode(inst.mode) && !inst.notifiedIdle) {
      inst.notifiedIdle = true;
      sendIdleNotification(inst, `${agentName} has been idle for 15s`);
    }
  }, IDLE_TIMEOUT_MS);

  // Check prompt patterns against recent output tail
  const tail = inst.recentOutput.slice(-200);
  for (const pattern of PROMPT_PATTERNS) {
    if (pattern.test(tail)) {
      sendIdleNotification(inst, `${agentName} is waiting for input`);
      break;
    }
  }
}

function initIdleDetectionFields(inst) {
  const config = loadConfig();
  // notifyPrefs is either a boolean (legacy: idle-only) or {idle, ci} (new).
  // Treat missing as both-enabled to preserve previous behavior.
  const pref = config.notifyPrefs?.[inst.name];
  if (typeof pref === 'object' && pref !== null) {
    inst.notifyEnabled = pref.idle !== false;
    inst.notifyCIEnabled = pref.ci !== false;
  } else {
    inst.notifyEnabled = pref !== false;
    inst.notifyCIEnabled = true;
  }
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

// ---- PTY lifecycle ----

function spawnInWorktree(name, worktreePath, branch, mode, resumeSessionId, extraEnv, prNumber) {
  const id = nextId++;
  const userShell = defaultShell();
  extraEnv = sanitizeExtraEnv(extraEnv);

  // An agent mode (claude/codex/gemini/copilot) launches that CLI; 'shell'
  // mode launches a plain login shell. The provider registry owns the exact
  // command string (binary, resume flag) so this stays tool-agnostic.
  const config = loadConfig();
  let agentCmd;
  let session = { release: () => {} };
  if (mode === 'shell') {
    agentCmd = null;
  } else {
    const provider = getProvider(mode) || getProvider('claude');
    const bin = binFor(provider.id, config);
    // Gated agents (Gemini) prompt once per worktree for trust + file access.
    // If the user cancels, don't spawn at all.
    const consent = ensureWorktreeConsentSync(provider.id, worktreePath);
    if (!consent.allowed) return { cancelled: true };
    // Token-rotation guard: warn before a second concurrent Codex session.
    session = beginSession(provider.id);
    if (!session.ok) return { cancelled: true };
    const model = (config.agentModel || {})[provider.id] || '';
    agentCmd = provider.buildInteractiveCmd(bin, { resumeSessionId, trust: consent.trust, model });
  }

  const args = agentCmd ? shellRunCmdArgs(userShell, agentCmd) : shellLoginArgs(userShell);
  const ptyProc = pty.spawn(userShell, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: worktreePath,
    env: { ...process.env, TERM: 'xterm-256color', ...(extraEnv || {}) },
  });

  // The base repo this worktree belongs to — used to group/filter worktrees by
  // repository in the sidebar. Derived from the worktree's common git dir so it
  // works for created, attached, and resumed worktrees alike (null for plain
  // non-git folders).
  const repoPath = baseRepoForWorktree(worktreePath);

  const instance = {
    id, name, worktreePath, branch, mode, originalMode: mode, repoPath,
    pty: ptyProc, alive: true, popoutWindows: new Set(), extraEnv: extraEnv || {},
    subTerminals: [], nextSubId: 1,
    spawnTime: Date.now(),
    // The token-rotation concurrency slot for this agent process; restart-task
    // hands it off (release old, acquire new) so the live-session count stays
    // accurate. Released in onExit.
    agentSession: session,
    // Only providers with per-worktree .jsonl sessions (Claude today) snapshot
    // pre-spawn ids for exact-session detection; others resume via their native
    // "continue latest in this dir" flag instead (see ai-providers.js).
    preSpawnSessionIds: (isAgentMode(mode) && getProvider(mode).perWorktreeSessions)
      ? snapshotSessionIds(worktreePath) : new Set(),
    claudeSessionId: (isAgentMode(mode) && getProvider(mode).supportsExactResume)
      ? (resumeSessionId || null) : null,
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

  // Remember the repo so discovery (scan roots, existing-worktree grouping)
  // keeps working without a user-managed "projects" list. This is invisible
  // plumbing — the repo is never surfaced as a manually-created project.
  if (repoPath) {
    try {
      const cfg = loadConfig();
      if (!cfg.projects) cfg.projects = [];
      if (!cfg.projects.find(p => p.path === repoPath)) {
        cfg.projects.push({ name: path.basename(repoPath), path: repoPath });
        saveConfig(cfg);
      }
    } catch {}
  }

  ptyProc.onData((data) => {
    processIdleDetection(instance, data);
    sendToTerminalSubscribers(`terminal-data-${id}`, data);
  });

  ptyProc.onExit(({ exitCode }) => {
    clearIdleTimer(instance);
    session.release(); // free the concurrency slot (Codex token-rotation guard)
    // If this was a Claude session, auto-convert to shell in-place — but
    // only for natural exits. An explicit kill-task sets `killed`, and
    // restart-task sets `restarting`; neither should spawn a shell we'd
    // lose track of (kill-task already deleted the instances entry; the
    // orphan shell would have no Map entry and nothing could kill it).
    if (isAgentMode(instance.mode) && !_isQuitting()
        && !instance.killed && !instance.restarting) {
      convertInstanceToShell(instance);
      return;
    }
    instance.alive = false;
    sendToTerminalSubscribers(`terminal-exit-${id}`, exitCode);
  });

  // Start CI polling for this task (dep-injected so ci-poll.js can own it
  // in a later phase without a circular import between state modules).
  _startCIPolling(id, worktreePath, branch);

  return { id, name, worktreePath, branch, mode, repoPath };
}

function convertInstanceToShell(inst) {
  sendIdleNotification(inst, `${displayNameFor(inst.originalMode || inst.mode)} has exited`);
  const id = inst.id;
  const userShell = defaultShell();
  const ptyProc = pty.spawn(userShell, shellLoginArgs(userShell), {
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
    sendToTerminalSubscribers(`terminal-data-${id}`, data);
  });

  ptyProc.onExit(() => {
    inst.alive = false;
    sendToTerminalSubscribers(`terminal-exit-${id}`);
  });

  // task-converted-to-shell is a per-window UI update (buttons re-render) so
  // it stays a broadcast to allWindows + popouts. Cheap, infrequent.
  for (const win of allWindows) {
    if (!win.isDestroyed()) win.webContents.send('task-converted-to-shell', { id });
  }
}

module.exports = {
  instances,
  subscribeTerminalChannel,
  unsubscribeTerminalChannel,
  sendToTerminalSubscribers,
  listSessionFiles,
  snapshotSessionIds,
  detectClaudeSessionId,
  findLatestSessionId,
  processIdleDetection,
  clearIdleTimer,
  spawnInWorktree,
  convertInstanceToShell,
  sendCIFlipNotification,
  isAnyWindowFocused,
  setDeps,
};
