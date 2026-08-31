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
const { loadConfig, saveConfig, getNemesisProfile, getNotificationConfig } = require('../util/config');
const nemesis = require('../util/nemesis-client');
const { baseRepoForWorktree, sessionSiblingWorktrees } = require('../util/git-repo');
const { sanitizeExtraEnv } = require('../util/exec');
const { claudeProjectDir } = require('../util/claude-paths');
const { defaultShell, shellLoginArgs, shellRunCmdArgs } = require('../util/platform');
const { allWindows, getMainWindow } = require('./windows');
const { getProvider, isAgentMode, binFor, displayNameFor } = require('./ai-providers');
const { ensureWorktreeConsentSync } = require('../util/agent-consent');
const { beginSession } = require('../util/agent-concurrency');
const { stageInitialPrompt, schedulePromptPaste } = require('../util/agent-prompt');
const { agentExitAction } = require('../util/agent-exit');
const nemesisEvents = require('../util/nemesis-events');
const { isChromeOnly } = require('../util/terminal-excerpt');
const { takeNewOutput, forgetTask: forgetTranscript } = require('../util/session-transcript');
const { sessionNotesEnv, withSessionContext } = require('./session-context');
const agentTranscript = require('../util/agent-transcript');

const instances = new Map(); // id -> { name, worktreePath, pty, branch }
let nextId = 1;

let _isQuitting = () => false;
let _startCIPolling = () => {};
let _stopCIPolling = () => {};

function setDeps({ isQuitting, startCIPolling, stopCIPolling } = {}) {
  if (isQuitting) _isQuitting = isQuitting;
  if (startCIPolling) _startCIPolling = startCIPolling;
  if (stopCIPolling) _stopCIPolling = stopCIPolling;
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

  const match = channel.match(/^terminal-data-(\d+)$/);
  if (match) {
    const id = parseInt(match[1], 10);
    const inst = instances.get(id);
    if (inst && inst.freshenWarning) {
      const msg = `\r\n\x1b[31;1mError: Failed to freshen base branch from origin:\x1b[0m\r\n` +
                  `\x1b[31m${inst.freshenWarning}\x1b[0m\r\n` +
                  `\x1b[33mSpawning a plain shell so you can fix the underlying git issue.\x1b[0m\r\n\r\n`;
      webContents.send(channel, msg);
      inst.freshenWarning = null;
    }
  }

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
  // Claude encodes the cwd by replacing every non-alphanumeric char with '-'
  // (not just '/'); see util/claude-paths. Needed for worktrees with spaces
  // (PR checkouts under "Application Support").
  const projectDir = claudeProjectDir(worktreePath);
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

// `sinceMs` narrows the answer to transcripts written during a given session; a
// worktree accumulates them, and the newest overall is often an older session's.
function findLatestSessionId(worktreePath, sinceMs) {
  const files = listSessionFiles(worktreePath)
    .filter((f) => !sinceMs || f.mtime >= sinceMs)
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].sessionId : null;
}

// ---- Idle / Prompt Detection (A1) ----

const IDLE_TIMEOUT_MS = 15000;
const NOTIFY_COOLDOWN_MS = 30000;
// Holds enough of the screen for a full selection menu with its per-option
// descriptions; 500 clipped the "1. Yes" line that says how to answer it.
const ROLLING_BUFFER_SIZE = 2000;

const PROMPT_PATTERNS = [
  /\(y\/n\)\s*$/i,
  /\(Y\/n\)\s*$/,
  /\(yes\/no\)\s*$/i,
  /Do you want to proceed/i,
  /Press Enter to continue/i,
  /Allow\s.*\?/i,
  /❯\s*$/,
];

// Matching the TUI's own selection footer catches any wording; listing
// phrasings missed plain questions entirely.
const APPROVAL_PROMPT_PATTERNS = [
  /Enter to select/i,
  /\(y\/n\)\s*$/i,
  /\(Y\/n\)\s*$/,
  /\(yes\/no\)\s*$/i,
  /\[y\/n\]\s*$/i,
  /Do you want to proceed/i,
  /Allow\s.*\?/i,
];

// A menu's option descriptions run well past the 200 chars the idle check
// reads, and the answering keystroke sits on the "1. Yes" line near its top.
const APPROVAL_TAIL_CHARS = 1500;

// A single approval prompt can repaint many times per second; only publish one
// approval webhook per instance per this window even if the flag re-arms.
const APPROVAL_NOTIFY_COOLDOWN_MS = 30000;

// Long enough to span the gaps inside one turn, short enough to feel like
// following along.
const TURN_SETTLE_MS = 4000;

// loadConfig() reads config.json synchronously and the stale timer reschedules
// on every pty chunk, so reading the pref there would put a blocking disk read
// in the terminal's hot path.
const STALE_CFG_TTL_MS = 10000;
let _staleCfgReadAt = 0;
let _staleAfterMs = 120000;

function staleAfterMs() {
  const now = Date.now();
  if (now - _staleCfgReadAt > STALE_CFG_TTL_MS) {
    try { _staleAfterMs = getNotificationConfig().staleAfterMs; } catch { /* keep the last value */ }
    _staleCfgReadAt = now;
  }
  return _staleAfterMs;
}

// A Klaussy launched from inside a Claude Code session inherits that session's
// markers, and a child that sees them turns transcript saving off — costing the
// session both its resume id and its readable history.
const INHERITED_SESSION_MARKERS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
];

// KLAUSSY_SESSION_ID names this terminal so notes can record who wrote them; it
// deliberately does not scope the notes dir, which is shared session-wide.
function agentSpawnEnv(worktreePath, terminalId) {
  const env = { ...process.env };
  for (const key of INHERITED_SESSION_MARKERS) delete env[key];
  return { ...env, ...sessionNotesEnv(worktreePath, terminalId) };
}

// A conversation that has not recorded its workspace yet can only be guessed
// at, and the newest file is often a previous session's — so the guess is
// re-made each poll until one names this worktree.
function bindAgyConversation(inst) {
  if (inst.agyConversationExact) return;
  const taken = new Set();
  for (const other of instances.values()) {
    if (other !== inst && other.agyConversation) taken.add(other.agyConversation);
  }
  const found = agentTranscript.findAntigravityConversation(inst.worktreePath, inst.spawnTime, taken);
  if (!found.file) return;
  inst.agyConversationExact = found.exact;
  inst.agyConversation = found.file;
}

// Which file this session's speech is read from, resolved fresh each poll: a
// session id can arrive late, and Antigravity only names its conversation once
// it settles.
function transcriptFileFor(inst, providerId) {
  if (providerId === 'claude') {
    // Claude Code's own hook payload carries the exact path.
    if (inst.transcriptPath) return inst.transcriptPath;
    // Until the 10s sweep names the session, the transcript is found by the
    // worktree — bounded to those written since it began, or the newest is
    // whichever agent last wrote there.
    const sessionId = inst.claudeSessionId || findLatestSessionId(inst.worktreePath, inst.spawnTime);
    if (!sessionId) return '';
    return agentTranscript.claudeTranscriptPath(inst.worktreePath, sessionId);
  }
  if (providerId === 'codex') {
    if (!inst.codexRollout) {
      inst.codexRollout = agentTranscript.findCodexRollout(inst.worktreePath, inst.spawnTime);
    }
    return inst.codexRollout;
  }
  if (providerId === 'antigravity') {
    bindAgyConversation(inst);
    return inst.agyConversation;
  }
  if (providerId === 'opencode') {
    if (!inst.opencodeSession) {
      inst.opencodeSession = agentTranscript.findOpencodeSession(inst.worktreePath, inst.spawnTime);
    }
    return inst.opencodeSession ? agentTranscript.opencodeSource(inst.opencodeSession) : '';
  }
  return '';
}

// A cursor only means something in the file it was measured in: carried over to
// another, it reads from an arbitrary point and posts whatever follows.
function repointTranscript(inst, file, providerId) {
  if (file === inst.transcriptFile) return false;
  const hadOne = !!inst.transcriptFile;
  inst.transcriptFile = file;
  inst.transcriptCursor = 0;
  // Switching away from a file we were reading: what is in the new one was said
  // to whoever was reading it before.
  if (hadOne) return true;
  // Claude stamps every record, so its reader drops the old ones by age and
  // still reports the first thing this run says.
  if (providerId === 'claude') return false;
  return predatesSession(file, inst.spawnTime);
}

function predatesSession(file, spawnTime) {
  if (!spawnTime) return false;
  try { return fs.statSync(file).birthtimeMs < spawnTime; } catch { return false; }
}

function subDisplayName(sub) {
  return sub.label || displayNameFor(sub.mode);
}

// The name a session answers to in chat, and the only thing that tells two tabs
// of one agent apart once a restart has voided their instance ids.
function sessionNameFor(inst, sub) {
  return sub ? `${inst.name} · ${subDisplayName(sub)}` : inst.name;
}

// A session's second agent is a tab on the task, not an instance of its own. It
// speaks for itself, so it mirrors for itself: its own buffer and cursor.
function subMirrorTarget(inst, sub) {
  if (!sub.mirror) {
    sub.mirror = {
      // Distinct from the task id, which keys the parent's own screen buffer.
      id: `${inst.id}:${sub.subId}`,
      name: subDisplayName(sub),
      mode: sub.mode,
      originalMode: sub.mode,
      worktreePath: inst.worktreePath,
      spawnTime: sub.spawnTime || Date.now(),
      recentOutput: '',
      alive: true,
    };
  }
  return sub.mirror;
}

// The sub-terminal half of processIdleDetection: mirroring only, since the
// desktop notifications and approval prompts belong to the task's own agent.
function processSubOutput(inst, sub, data) {
  if (!inst || !sub || !isAgentMode(sub.mode)) return;
  const target = subMirrorTarget(inst, sub);
  target.alive = sub.alive !== false;
  target.recentOutput = (target.recentOutput + stripAnsi(data)).slice(-ROLLING_BUFFER_SIZE);
  // The bell belongs to the session, and this tab is part of it.
  if (inst.notifyWebhookEnabled !== true) return;

  if (sub.turnTimer) clearTimeout(sub.turnTimer);
  sub.turnTimer = setTimeout(() => {
    if (!sub.alive) return;
    try {
      const body = newAgentSpeech(target);
      if (!body) return;
      nemesisEvents.publish({
        type: nemesisEvents.EVENT_TYPES.MESSAGE,
        // Its own id, not the task's: an answer typed under what this agent
        // said has to reach this agent, not whichever one owns the session.
        containerId: target.id,
        sessionName: sessionNameFor(inst, sub),
        workspacePath: inst.worktreePath,
        sessionBranch: inst.branch || '',
        agentName: displayNameFor(sub.mode),
        body,
        ts: Date.now(),
        notify: true,
      });
    } catch { /* never let a publish break the terminal path */ }
  }, TURN_SETTLE_MS);
  sub.turnTimer.unref?.();
}

function fileSize(file) {
  if (!file) return 0;
  try { return fs.statSync(file).size; } catch { return -1; }
}

// Set KLAUSSY_DEBUG_MIRROR to tell a transcript read from a screen scrape, which
// look identical once the text reaches chat.
function traceMirror(inst, providerId, source, text) {
  if (!process.env.KLAUSSY_DEBUG_MIRROR) return;
  console.warn('[mirror] ' + JSON.stringify({
    id: inst.id,
    mode: inst.mode,
    originalMode: inst.originalMode,
    providerId,
    source,
    file: inst.transcriptFile || '',
    size: fileSize(inst.transcriptFile),
    cursor: inst.transcriptCursor,
    chars: (text || '').length,
    head: (text || '').slice(0, 120),
  }));
}

// Prefer the agent's own session store; a screen scrape has to guess at redraws.
function newAgentSpeech(inst) {
  const providerId = isAgentMode(inst.originalMode) ? inst.originalMode : inst.mode;
  const file = agentTranscript.hasReader(providerId) ? transcriptFileFor(inst, providerId) : '';
  if (file) {
    const read = agentTranscript.readNewMessages(providerId, {
      fromEnd: repointTranscript(inst, file, providerId),
      worktreePath: inst.worktreePath,
      transcriptFile: file,
      cursor: inst.transcriptCursor || 0,
      sinceMs: inst.spawnTime,
    });
    // A reader that answered is the whole answer. Falling through to the screen
    // when it had nothing new posts the turn a second time, mangled by the
    // repaint the transcript exists to avoid reading.
    if (read) {
      if (read.cursor != null) inst.transcriptCursor = read.cursor;
      traceMirror(inst, providerId, read.text ? 'transcript' : 'transcript-silent', read.text);
      return read.text || '';
    }
  }
  const scraped = takeNewOutput(inst.id, inst.recentOutput);
  traceMirror(inst, providerId, 'screen', scraped);
  return scraped;
}

function stripAnsi(str) {
  return str
    // Cursor-forward is how a TUI lays out columns; dropping it with the rest of
    // the escapes ran words together ("1.Yes"), which then matched nothing.
    .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Math.min(parseInt(n || '1', 10), 80)))
    // OSC (window title and friends), ended by BEL or ST.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Full CSI: parameter bytes are 0x30-0x3F, including the '?' of private
    // modes like ESC[?25l, which a digits-only class left as literal text.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // Charset selection and the single-character escapes a TUI emits.
    .replace(/\x1b[()][0-9A-B]/g, '')
    .replace(/\x1b[=>78MENOc]/g, '');
}

// Best-effort: pull the tool awaiting authorization out of an approval prompt
// ("Allow <tool>?" / "Do you want to <verb>…"); '' when nothing recognizable.
function extractApprovalTool(tail) {
  const allow = tail.match(/Allow\s+([^\n?]+?)\s*\?/i);
  if (allow) return allow[1].trim();
  const wants = tail.match(/Do you want to\s+([^\n?]+?)\s*\??\s*$/i);
  if (wants) return wants[1].trim();
  return '';
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

  // Mirroring the agent's own words means following along doesn't depend on
  // recognising prompt shapes.
  if (inst.turnTimer) clearTimeout(inst.turnTimer);
  inst.turnTimer = setTimeout(() => {
    if (!inst.alive || !isAgentMode(inst.mode)) {
      traceMirror(inst, inst.mode, inst.alive ? 'not-an-agent' : 'not-alive', '');
      return;
    }
    // The bell decides whether a turn is mirrored at all, so a silent session
    // looks the same here as a broken one until this says which it is.
    if (inst.notifyWebhookEnabled !== true) {
      traceMirror(inst, inst.mode, 'bell-off', '');
      return;
    }
    try {
      const body = newAgentSpeech(inst);
      if (!body) return;
      nemesisEvents.publish({
        type: nemesisEvents.EVENT_TYPES.MESSAGE,
        containerId: inst.id,
        sessionName: inst.name,
        workspacePath: inst.worktreePath,
        sessionBranch: inst.branch || '',
        agentName,
        body,
        ts: Date.now(),
        notify: true,
      });
    } catch { /* never let a publish break the terminal path */ }
  }, TURN_SETTLE_MS);
  inst.turnTimer.unref?.();

  // A longer quiet stretch, reported to chat rather than the desktop: the agent
  // has stopped without asking anything, usually with output waiting to be read.
  if (inst.staleTimer) clearTimeout(inst.staleTimer);
  // An idle agent still repaints its spinner and input box; counting that as
  // activity re-armed the alert forever for a session that had done nothing.
  if (!isChromeOnly(stripped)) inst.staleNotified = false;
  const quietMs = staleAfterMs();
  inst.staleTimer = setTimeout(() => {
    if (!inst.alive || !isAgentMode(inst.mode)) return;
    // An approval prompt already told them, and more precisely.
    if (inst.approvalPending || inst.staleNotified) return;
    // Mirroring already delivered whatever the agent said, so announcing the
    // silence after it would just repeat the same turn.
    try { if (getNotificationConfig().events.message) return; } catch { /* fall through */ }
    inst.staleNotified = true;
    try {
      nemesisEvents.publish({
        type: nemesisEvents.EVENT_TYPES.STALE,
        containerId: inst.id,
        sessionName: inst.name,
        workspacePath: inst.worktreePath,
        sessionBranch: inst.branch || '',
        agentName,
        quietMs,
        logsTail: inst.recentOutput,
        ts: Date.now(),
        notify: inst.notifyWebhookEnabled === true,
      });
    } catch { /* never let a publish break the terminal path */ }
  }, quietMs);
  inst.staleTimer.unref?.();

  // Check prompt patterns against recent output tail
  const tail = inst.recentOutput.slice(-200);
  for (const pattern of PROMPT_PATTERNS) {
    if (pattern.test(tail)) {
      sendIdleNotification(inst, `${agentName} is waiting for input`);
      break;
    }
  }

  // Publish approval-required on the transition into a waiting state. The
  // approvalPending flag + cooldown stop a repainting TUI from storming the webhook.
  const approvalTail = inst.recentOutput.slice(-APPROVAL_TAIL_CHARS);
  const needsApproval = APPROVAL_PROMPT_PATTERNS.some((p) => p.test(approvalTail));
  if (needsApproval) {
    const now = Date.now();
    if (!inst.approvalPending && now - inst.lastApprovalPublishTime >= APPROVAL_NOTIFY_COOLDOWN_MS) {
      inst.approvalPending = true;
      inst.lastApprovalPublishTime = now;
      try {
        nemesisEvents.publish({
          type: nemesisEvents.EVENT_TYPES.APPROVAL_REQUIRED,
          containerId: inst.id,
          sessionName: inst.name,
          workspacePath: inst.worktreePath,
          sessionBranch: inst.branch || '',
          agentName,
          tool: extractApprovalTool(approvalTail),
          logsTail: inst.recentOutput,
          ts: now,
          notify: inst.notifyWebhookEnabled === true,
        });
      } catch { /* never let a publish break the terminal path */ }
    }
  } else {
    // The prompt is gone (answered locally or the agent moved on), so any
    // Approve/Reject button still sitting in chat now refers to nothing.
    if (inst.approvalPending) {
      try { require('../util/approval-registry').revokeForTask(inst.id); } catch { /* non-fatal */ }
    }
    inst.approvalPending = false;
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
  // Webhook bell: an explicit per-task choice wins, otherwise the global
  // "notify new sessions" default. Shells never post regardless.
  const webhookPref = (typeof pref === 'object' && pref !== null) ? pref.webhook : undefined;
  inst.notifyWebhookEnabled = isAgentMode(inst.mode) && (typeof webhookPref === 'boolean'
    ? webhookPref
    : getNotificationConfig(config).notifyNewSessions);
  inst.lastDataTime = 0;
  inst.quietTimer = null;
  inst.notifiedIdle = false;
  inst.lastNotifyTime = 0;
  inst.recentOutput = '';
  inst.approvalPending = false;
  inst.lastApprovalPublishTime = 0;
  inst.staleTimer = null;
  inst.staleNotified = false;
  inst.turnTimer = null;
}

function clearIdleTimer(inst) {
  if (inst.quietTimer) {
    clearTimeout(inst.quietTimer);
    inst.quietTimer = null;
  }
  if (inst.staleTimer) {
    clearTimeout(inst.staleTimer);
    inst.staleTimer = null;
  }
  if (inst.turnTimer) {
    clearTimeout(inst.turnTimer);
    inst.turnTimer = null;
  }
}

// ---- PTY lifecycle ----

function spawnInWorktree(name, worktreePath, branch, mode, resumeSessionId, extraEnv, prNumber, initialPrompt, freshenWarning, resumeLatest) {
  const id = nextId++;
  const userShell = defaultShell();
  extraEnv = sanitizeExtraEnv(extraEnv);
  const spawnEnv = agentSpawnEnv(worktreePath, id);

  // An agent mode (claude/codex/gemini/copilot) launches that CLI; 'shell'
  // mode launches a plain login shell. The provider registry owns the exact
  // command string (binary, resume flag) so this stays tool-agnostic.
  const config = loadConfig();
  let agentCmd;
  let session = { release: () => {} };
  let promptFile = null;  // staged-prompt tempfile (cross-agent handoff), removed on exit
  let needsEnter = false; // codex-style TUIs pre-fill but wait for an Enter
  let pasteText = null;   // kimi-style TUIs take no spawn-time prompt at all
  let ptyProc;

  if (mode === 'shell') {
    agentCmd = null;
  } else {
    const provider = getProvider(mode) || getProvider('claude');
    const bin = binFor(provider.id, config);
    // Nemesis8 runs `nemesis8 interactive` in this pty, resolved from the picked
    // gateway profile (nemesis8:<id>) — its inner agent and, if remote, URL/token.
    const nemProfile = nemesis.shouldUseNemesis(mode) ? getNemesisProfile(mode) : null;
    // Gated agents (Gemini) prompt once per worktree for trust + file access.
    // If the user cancels, don't spawn at all.
    const consent = ensureWorktreeConsentSync(provider.id, worktreePath);
    if (!consent.allowed) return { cancelled: true };
    // Token-rotation guard: warn before a second concurrent Codex session.
    session = beginSession(provider.id);
    if (!session.ok) return { cancelled: true };
    const model = nemProfile ? (nemProfile.model || '') : ((config.agentModel || {})[provider.id] || '');
    const sessionDirs = sessionSiblingWorktrees(worktreePath);
    const notesDir = spawnEnv.KLAUSSY_SESSION_NOTES_DIR;
    agentCmd = provider.buildInteractiveCmd(bin, {
      resumeSessionId,
      resumeLatest: resumeLatest !== undefined ? resumeLatest : (!resumeSessionId && resumeSessionId !== null && resumeSessionId !== undefined),
      trust: consent.trust,
      model,
      sessionDirs,
      notesDir,
      profile: nemProfile,
    });
    // Cross-agent resume handoff: seed the incoming agent with a brief distilled
    // from the prior (different-agent) session, passed at spawn rather than
    // typed in (see util/agent-prompt + state/session-handoff).
    if (initialPrompt) {
      const seeded = withSessionContext(worktreePath, initialPrompt);
      const staged = stageInitialPrompt(provider, agentCmd, seeded, `handoff-${id}`, userShell);
      agentCmd = staged.agentCmd;
      promptFile = staged.promptFile;
      needsEnter = staged.needsEnter;
      pasteText = staged.pasteText || null;
    }
  }

  const args = agentCmd ? shellRunCmdArgs(userShell, agentCmd) : shellLoginArgs(userShell);
  try {
    ptyProc = pty.spawn(userShell, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: worktreePath,
      env: { ...spawnEnv, TERM: 'xterm-256color', ...(extraEnv || {}) },
    });
  } catch (err) {
    if (session && session.release) session.release();
    if (promptFile) { try { fs.unlinkSync(promptFile); } catch (_) {} }
    return { error: `Failed to spawn terminal process (${userShell}): ${err.message}` };
  }

  // codex pre-fills its positional handoff prompt but waits for an Enter to
  // submit (Claude/Gemini/Antigravity auto-run theirs). Nudge once the TUI is
  // up, with a retry for a slow boot; harmless for agents that already ran it.
  if (needsEnter) {
    const sendEnter = () => { try { if (instances.get(id)) ptyProc.write('\r'); } catch { /* gone */ } };
    setTimeout(sendEnter, 3500);
    setTimeout(sendEnter, 8000);
  }

  // Paste-delivery agents (kimi) took no prompt at spawn; no-ops for the rest.
  schedulePromptPaste(ptyProc, pasteText, () => !!instances.get(id));

  // The base repo this worktree belongs to — used to group/filter worktrees by
  // repository in the sidebar. Derived from the worktree's common git dir so it
  // works for created, attached, and resumed worktrees alike (null for plain
  // non-git folders).
  const repoPath = baseRepoForWorktree(worktreePath);

  // Symlink the base repo's env files (.env, .envrc, …) into this worktree NOW,
  // synchronously and independently of repo-intel generation. Worktrees hold
  // only committed files, so gitignored env files are missing — and the agent
  // (and dev servers/tests) can't find them. Doing it here, not as a side
  // effect of the async intel pipeline, means env is present the instant the
  // agent starts even if repo-intel is uninstalled, slow, or backed off.
  try {
    require('./repo-intel').ensureEnvLinks(worktreePath);
  } catch (e) {
    console.warn('[repo-intel] env link failed:', e.message);
  }

  // Every session, not just the one that created the worktree — otherwise a
  // worktree predating the base's last regeneration starts with stale docs.
  try {
    require('./repo-intel').syncIntelIntoWorktree(worktreePath);
  } catch (e) {
    console.warn('[repo-intel] worktree conventions sync failed:', e.message);
  }

  // Kick off repo-intel generation for the base repo (conventions + import
  // graph for agent prompts). Fire-and-forget: cheap when fresh, never blocks
  // the spawn, degrades silently if the conventions CLI is missing. Lazy
  // require avoids loading electron's app module before bootstrap.
  if (repoPath) {
    try {
      require('./repo-intel').ensureRepoIntel(repoPath);
    } catch (e) {
      console.warn('[repo-intel] ensure failed:', e.message);
    }
    // Pre-commit silent-failure hook (terminal/agent commits). Idempotent,
    // pref-gated inside.
    try {
      require('./precommit-hook').installHookForRepo(repoPath);
    } catch (e) {
      console.warn('[precommit-hook] install failed:', e.message);
    }
  }

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
    freshenWarning: freshenWarning || null,
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

  // Start the webhook notification gateway once an agent (not a plain shell) is
  // running. Idempotent and pref-gated inside — a no-op unless the user has
  // configured a Slack/Discord webhook URL.
  if (isAgentMode(mode)) {
    try { require('../util/notification-gateway').ensureStarted(); } catch (e) {
      console.warn('[notification-gateway] start failed:', e.message);
    }
    // Claude reports its own permission prompts and turn ends, which the
    // terminal can only be pattern-matched for.
    if (mode === 'claude') {
      const r = require('../util/claude-hooks').installForWorktree(worktreePath);
      if (!r.ok) console.warn('[claude-hook] install failed:', r.error);
    }
  }

  ptyProc.onData((data) => {
    processIdleDetection(instance, data);
    sendToTerminalSubscribers(`terminal-data-${id}`, data);
  });

  ptyProc.onExit(makeAgentExitHandler(instance, ptyProc, { session, promptFile }));

  // Start CI polling for this task (dep-injected so ci-poll.js can own it
  // in a later phase without a circular import between state modules).
  _startCIPolling(id, worktreePath, branch);

  return { id, name, worktreePath, branch, mode, repoPath };
}

// Built by the provider itself so the hint can't drift from what restart-task
// runs. `trust` is deliberately omitted — a permission-bypass flag shouldn't be
// pasted into a chat channel.
function resumeHintFor(inst) {
  try {
    const mode = isAgentMode(inst.originalMode) ? inst.originalMode : inst.mode;
    const provider = getProvider(mode);
    if (!provider || typeof provider.buildInteractiveCmd !== 'function') return {};
    const config = loadConfig();
    const bin = binFor(provider.id, config);
    const profile = nemesis.shouldUseNemesis(mode) ? getNemesisProfile(mode) : null;
    const model = profile ? (profile.model || '') : ((config.agentModel || {})[provider.id] || '');
    const sessionId = inst.claudeSessionId
      || (provider.supportsExactResume ? findLatestSessionId(inst.worktreePath) : '')
      || '';
    const command = provider.buildInteractiveCmd(bin, {
      resumeSessionId: sessionId || undefined,
      resumeLatest: !sessionId,
      model,
      profile,
    });
    // resumeExact drives the wording: only an id guarantees the same
    // conversation comes back, so everything else is offered as a fresh start.
    return { sessionId, resumeCommand: command, resumeExact: Boolean(sessionId) };
  } catch (err) {
    console.warn('[instances] resume hint failed:', err.message);
    return {};
  }
}

// Shared by spawn and restart: a copy that dropped the quit/kill/restart guards
// was the original orphaned-shell bug.
function makeAgentExitHandler(instance, ptyProc, { session, promptFile } = {}) {
  const id = instance.id;
  return ({ exitCode } = {}) => {
    clearIdleTimer(instance);
    if (session) session.release(); // free the concurrency slot (Codex token-rotation guard)
    if (promptFile) { try { fs.unlinkSync(promptFile); } catch { /* already gone */ } }
    const action = agentExitAction({
      isCurrentPty: !instance.pty || instance.pty === ptyProc,
      isAgent: isAgentMode(instance.mode),
      quitting: _isQuitting(),
      killed: !!instance.killed,
      restarting: !!instance.restarting,
    });
    if (action === 'ignore') return;
    if (action === 'convert') {
      // 'convert' is exactly the agent's own natural exit — not a stale pty, a
      // user kill/restart, or app quit — so it's the one place to publish the
      // terminal lifecycle event the notification gateway webhooks on.
      try {
        nemesisEvents.publish({
          type: exitCode === 0 ? nemesisEvents.EVENT_TYPES.COMPLETED : nemesisEvents.EVENT_TYPES.FAILED,
          containerId: instance.id,
          sessionName: instance.name,
          workspacePath: instance.worktreePath,
          agentName: displayNameFor(instance.originalMode || instance.mode),
          exitCode,
          logsTail: instance.recentOutput || '',
          ts: Date.now(),
          notify: instance.notifyWebhookEnabled === true,
          ...resumeHintFor(instance),
        });
      } catch { /* never let a publish break teardown */ }
      // The tab becomes a shell next, so nothing in chat should still route here.
      try { require('../util/approval-registry').revokeForTask(instance.id); } catch { /* non-fatal */ }
      try { require('../util/notification-gateway').forgetTask(instance.id); } catch { /* non-fatal */ }
      try { forgetTranscript(instance.id); } catch { /* non-fatal */ }
      try { require('./session-activity').forgetInstance(instance.id); } catch { /* non-fatal */ }
      convertInstanceToShell(instance, exitCode);
      return;
    }
    instance.alive = false;
    sendToTerminalSubscribers(`terminal-exit-${id}`, exitCode);
  };
}

function convertInstanceToShell(inst, exitCode) {
  const uptimeS = inst.spawnTime ? Math.round((Date.now() - inst.spawnTime) / 1000) : null;
  // The CLI's own exit reason isn't captured, so a crash, an auth failure, and
  // a user typing /exit all look alike here.
  console.log(`[agent-exit] ${inst.mode} in "${inst.name}" exited`
    + ` (code=${exitCode == null ? '?' : exitCode}${uptimeS == null ? '' : `, uptime=${uptimeS}s`})`
    + ' — converting terminal to shell');
  sendIdleNotification(inst, `${displayNameFor(inst.originalMode || inst.mode)} has exited`);
  const id = inst.id;
  const userShell = defaultShell();
  const ptyProc = pty.spawn(userShell, shellLoginArgs(userShell), {
    name: 'xterm-256color',
    cols: inst.pty.cols || 120,
    rows: inst.pty.rows || 30,
    cwd: inst.worktreePath,
    env: { ...process.env, TERM: 'xterm-256color', ...sessionNotesEnv(inst.worktreePath, id) },
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

// A window is closing while other windows stay open. Tasks that ONLY this
// window was rendering would otherwise leak: their PTYs keep running with no
// window able to show them again (the sole reattach path is an app restart),
// and their worktrees stay flagged "active" — so the user can't reopen the
// session from another window ("Every worktree in this session is already
// open."). Kill those orphaned PTYs so the worktrees free up. A task still
// rendered by another live window (or a popout) is left running, untouched.
//
// MUST run on the window's 'close' (not 'closed'): ownership is read from the
// terminal subscription set, and the per-channel auto-cleanup removes this
// window's webContents the instant it is destroyed.
function reclaimOrphanedTasks(closingWc) {
  for (const [id, inst] of instances) {
    const subs = terminalSubscribers.get(`terminal-data-${id}`);
    // Only reclaim tasks this window actually rendered.
    if (!subs || !subs.has(closingWc)) continue;
    // Leave it running if any OTHER live window — or a popout — still shows it.
    let otherViewer = false;
    for (const wc of subs) {
      if (wc !== closingWc && !wc.isDestroyed()) { otherViewer = true; break; }
    }
    if (!otherViewer) {
      for (const w of inst.popoutWindows) {
        if (!w.isDestroyed()) { otherViewer = true; break; }
      }
    }
    if (otherViewer) continue;

    // Same teardown as kill-task: flag killed BEFORE kill() so the onExit
    // handler skips the Claude→shell auto-convert (which would spawn an orphan
    // PTY with no instances entry that nothing could ever stop).
    inst.killed = true;
    clearIdleTimer(inst);
    _stopCIPolling(id);
    try { inst.pty.kill(); } catch {}
    for (const sub of (inst.subTerminals || [])) {
      try { sub.pty.kill(); } catch {}
    }
    inst.alive = false;
    // Never touch the worktree/branch on disk — only stop the process.
    instances.delete(id);
  }
}

// True only while this instance is still running its agent CLI. False once it
// has been converted to a plain shell, which keeps the same id and alive flag.
function isAgentInstance(inst) {
  return Boolean(inst && inst.alive && isAgentMode(inst.mode));
}

// A task's extra agent tabs are sub-terminals, so they have no `instances` entry
// of their own and the map alone is never the whole session.
function liveAgentInstances() {
  const out = [];
  for (const [, inst] of instances) {
    out.push(inst);
    for (const sub of (inst.subTerminals || [])) {
      if (sub.alive && isAgentMode(sub.mode) && sub.mirror) out.push(sub.mirror);
    }
  }
  return out;
}

function notifyingAgentInstances() {
  const out = [];
  for (const [, inst] of instances) {
    if (!inst.notifyWebhookEnabled) continue;
    if (isAgentInstance(inst)) out.push(inst);
    // A second agent in the session answers for itself, so it counts as its own
    // candidate — otherwise a reply meant for it is read as unambiguous and
    // handed to the agent that owns the task.
    for (const sub of (inst.subTerminals || [])) {
      if (sub.alive && isAgentMode(sub.mode) && sub.mirror) out.push(sub.mirror);
    }
  }
  return out.sort((a, b) => (b.spawnTime || 0) - (a.spawnTime || 0));
}

module.exports = {
  instances,
  isAgentInstance,
  notifyingAgentInstances,
  liveAgentInstances,
  stripAnsi,
  APPROVAL_PROMPT_PATTERNS,
  ROLLING_BUFFER_SIZE,
  reclaimOrphanedTasks,
  subscribeTerminalChannel,
  unsubscribeTerminalChannel,
  sendToTerminalSubscribers,
  listSessionFiles,
  snapshotSessionIds,
  detectClaudeSessionId,
  findLatestSessionId,
  processIdleDetection,
  processSubOutput,
  sessionNameFor,
  clearIdleTimer,
  spawnInWorktree,
  convertInstanceToShell,
  makeAgentExitHandler,
  sendCIFlipNotification,
  isAnyWindowFocused,
  setDeps,
};
