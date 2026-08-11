// One chat thread per agent session, on both platforms: routing follows the
// thread you typed in, so no capped message->task map can forget an old alert.

const path = require('path');
const { loadConfig, saveConfig } = require('./config');

const DISCORD_API = 'https://discord.com/api/v10';
// A thread outlives the app that opened it, so what identifies its session must
// too: an instance id is handed out afresh each launch, while the worktree and
// its agent stay the same session to whoever is typing.
const MAX_REMEMBERED_THREADS = 200;
const THREAD_ARCHIVE_MINUTES = 1440; // 24h; a new alert un-archives it anyway

// In-flight creations are kept as promises so two alerts arriving together
// can't open two threads for one session.
const _sessions = new Map();
const _slackThreadToTask = new Map();
const _discordThreadToTask = new Map();
const _pending = new Map();
// Message id -> task, so replying to any alert reaches its session even when no
// thread exists (thread creation needs a permission the bot may not have).
const _messageToTask = new Map();
const MAX_TRACKED_MESSAGES = 300;
// Thread -> the worktree and agent it was opened for, which outlive a restart.
const _threadOwners = new Map();

function rememberMessage(messageId, taskId) {
  if (!messageId) return;
  _messageToTask.set(String(messageId), String(taskId));
  if (_messageToTask.size > MAX_TRACKED_MESSAGES) {
    _messageToTask.delete(_messageToTask.keys().next().value);
  }
}

function taskForMessage(messageId) {
  return _messageToTask.get(String(messageId));
}

// Two sessions on one repo, or two agents in one session, would otherwise
// share a thread name.
function sessionLabel(event) {
  const repo = event.workspacePath ? path.basename(event.workspacePath) : '';
  const agent = event.agentName || 'Agent';
  const where = [event.sessionBranch, repo].filter(Boolean).join(' · ');
  const label = where ? `${where} (${agent})` : agent;
  return label.slice(0, 90); // Discord caps thread names at 100
}

function entryFor(taskId) {
  let e = _sessions.get(String(taskId));
  if (!e) { e = {}; _sessions.set(String(taskId), e); }
  return e;
}

function taskForSlackThread(ts) { return _slackThreadToTask.get(String(ts)); }
function taskForDiscordThread(id) { return _discordThreadToTask.get(String(id)); }

function rememberThreadOwner(threadId, event) {
  if (!threadId || !event.workspacePath) return;
  // Held in memory as well as on disk: saveConfig's write is queued, and a
  // reply can arrive before it lands.
  _threadOwners.set(String(threadId), {
    worktreePath: event.workspacePath,
    agentName: event.agentName || '',
    sessionName: event.sessionName || '',
  });
  try {
    const config = loadConfig();
    const kept = config.notificationThreads || {};
    kept[String(threadId)] = {
      worktreePath: event.workspacePath,
      agentName: event.agentName || '',
      sessionName: event.sessionName || '',
      at: new Date().toISOString(),
    };
    const ids = Object.keys(kept);
    const dropped = [];
    if (ids.length > MAX_REMEMBERED_THREADS) {
      ids.sort((a, b) => String(kept[a].at).localeCompare(String(kept[b].at)));
      for (const id of ids.slice(0, ids.length - MAX_REMEMBERED_THREADS)) {
        delete kept[id];
        dropped.push(id);
      }
    }
    // Only this writer's key: a whole snapshot would carry stale copies of
    // everything else over a prefs save landing meanwhile. Pruned ids go as
    // undefined, which JSON.stringify drops, or the merge restores them.
    for (const id of dropped) kept[id] = undefined;
    saveConfig({ notificationThreads: kept });
  } catch (err) {
    console.error('[session-threads] could not record thread owner:', err.message);
  }
}

// A tab counts as its own candidate, not as part of the task it runs on.
function reattachCandidates() {
  const { instances, sessionNameFor } = require('../state/instances');
  const { isAgentMode, displayNameFor } = require('../state/ai-providers');
  const out = [];
  for (const [, inst] of instances) {
    if (!inst.alive) continue;
    const mode = inst.originalMode || inst.mode;
    if (isAgentMode(mode)) {
      out.push({
        id: String(inst.id),
        worktreePath: inst.worktreePath,
        agentName: displayNameFor(mode),
        sessionName: sessionNameFor(inst),
      });
    }
    for (const sub of (inst.subTerminals || [])) {
      if (!sub.alive || !isAgentMode(sub.mode)) continue;
      out.push({
        id: `${inst.id}:${sub.subId}`,
        worktreePath: inst.worktreePath,
        agentName: displayNameFor(sub.mode),
        sessionName: sessionNameFor(inst, sub),
      });
    }
  }
  return out;
}

// Reattaches a thread the running app has no memory of to whatever is now
// running in the worktree and agent it was opened for. Returns '' when nothing
// there matches, so the caller says so rather than answering someone else.
function reattachThread(threadId) {
  let record = _threadOwners.get(String(threadId));
  if (!record) {
    try { record = (loadConfig().notificationThreads || {})[String(threadId)]; } catch { return ''; }
  }
  if (!record) return '';
  const pool = reattachCandidates().filter((c) => c.worktreePath === record.worktreePath
    && c.agentName === record.agentName);
  // A task and a tab running the same agent match on everything but the session
  // name, which records written before it was kept don't have — so those fall
  // back to agent alone, and only when one candidate makes it unambiguous.
  const named = record.sessionName
    ? pool.filter((c) => c.sessionName === record.sessionName)
    : [];
  const match = named.length === 1 ? named[0] : (pool.length === 1 ? pool[0] : null);
  if (!match) return '';
  _discordThreadToTask.set(String(threadId), match.id);
  _slackThreadToTask.set(String(threadId), match.id);
  return match.id;
}

function once(key, fn) {
  if (_pending.has(key)) return _pending.get(key);
  const p = Promise.resolve().then(fn).finally(() => _pending.delete(key));
  _pending.set(key, p);
  return p;
}

async function slackPost(cfg, body) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + cfg.slackBotToken,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

// Returns the parent ts the session's alerts thread under, or '' if it couldn't
// be posted — the caller then posts flat.
async function ensureSlackThread(cfg, event) {
  const taskId = String(event.containerId || '');
  if (!taskId) return '';
  const entry = entryFor(taskId);
  if (entry.slackTs) return entry.slackTs;

  return once('slack:' + taskId, async () => {
    const existing = entryFor(taskId).slackTs;
    if (existing) return existing;
    try {
      const body = await slackPost(cfg, {
        channel: cfg.slackChannel,
        text: `🧵 ${sessionLabel(event)}`,
      });
      if (!body.ok || !body.ts) {
        console.error('[session-threads] slack parent failed:', body.error || 'no ts');
        return '';
      }
      entryFor(taskId).slackTs = body.ts;
      _slackThreadToTask.set(String(body.ts), taskId);
      rememberThreadOwner(body.ts, event);
      return body.ts;
    } catch (err) {
      // A rejection here would reject the whole dispatch, taking the Discord
      // post down with it — offline should cost one thread, not every alert.
      console.error('[session-threads] slack parent failed:', err.message);
      return '';
    }
  });
}

async function discordFetch(cfg, url, init) {
  return fetch(url, {
    ...init,
    headers: {
      authorization: 'Bot ' + cfg.discordBotToken,
      'content-type': 'application/json',
      ...(init && init.headers),
    },
  });
}

async function ensureDiscordThread(cfg, event) {
  const taskId = String(event.containerId || '');
  if (!taskId) return '';
  const entry = entryFor(taskId);
  if (entry.discordThreadId) return entry.discordThreadId;
  // The anchor goes into the channel before the thread can hang off it, so a bot
  // that can post but not open threads would leave one behind on every alert.
  if (entry.discordThreadRefused) return '';

  return once('discord:' + taskId, async () => {
    const existing = entryFor(taskId).discordThreadId;
    if (existing) return existing;
    try {
      const anchorRes = await discordFetch(cfg, `${DISCORD_API}/channels/${cfg.discordChannel}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: `🧵 **${sessionLabel(event)}**` }),
      });
      if (!anchorRes.ok) {
        console.error('[session-threads] discord anchor failed: HTTP', anchorRes.status);
        return '';
      }
      const anchor = await anchorRes.json();
      const threadRes = await discordFetch(
        cfg, `${DISCORD_API}/channels/${cfg.discordChannel}/messages/${anchor.id}/threads`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: sessionLabel(event),
            auto_archive_duration: THREAD_ARCHIVE_MINUTES,
          }),
        },
      );
      if (!threadRes.ok) {
        entryFor(taskId).discordThreadRefused = true;
        console.error('[session-threads] discord thread failed: HTTP', threadRes.status,
          threadRes.status === 403
            ? '— the bot lacks Create Public Threads; re-invite with permissions=292057844736'
            : '');
        return '';
      }
      const thread = await threadRes.json();
      entryFor(taskId).discordThreadId = thread.id;
      _discordThreadToTask.set(String(thread.id), taskId);
      rememberThreadOwner(thread.id, event);
      return thread.id;
    } catch (err) {
      console.error('[session-threads] discord thread failed:', err.message);
      return '';
    }
  });
}

// The threads stay in chat as history; they just stop reaching anything.
function forgetTask(taskId) {
  const key = String(taskId);
  const entry = _sessions.get(key);
  if (!entry) return;
  if (entry.slackTs) _slackThreadToTask.delete(String(entry.slackTs));
  if (entry.discordThreadId) _discordThreadToTask.delete(String(entry.discordThreadId));
  for (const [messageId, id] of _messageToTask) {
    if (id === key) _messageToTask.delete(messageId);
  }
  _sessions.delete(key);
}

function _reset() {
  _threadOwners.clear();
  _messageToTask.clear();
  _sessions.clear();
  _slackThreadToTask.clear();
  _discordThreadToTask.clear();
  _pending.clear();
}

module.exports = {
  rememberMessage,
  taskForMessage,
  ensureSlackThread,
  ensureDiscordThread,
  taskForSlackThread,
  taskForDiscordThread,
  reattachThread,
  sessionLabel,
  forgetTask,
  _reset,
};
