// One chat thread per agent session, on both platforms: routing follows the
// thread you typed in, so no capped message->task map can forget an old alert.

const path = require('path');

const DISCORD_API = 'https://discord.com/api/v10';
const THREAD_ARCHIVE_MINUTES = 1440; // 24h; a new alert un-archives it anyway

// In-flight creations are kept as promises so two alerts arriving together
// can't open two threads for one session.
const _sessions = new Map();
const _slackThreadToTask = new Map();
const _discordThreadToTask = new Map();
const _pending = new Map();

function sessionLabel(event) {
  const dir = event.workspacePath ? path.basename(event.workspacePath) : '';
  const agent = event.agentName || 'Agent';
  const label = dir ? `${dir} (${agent})` : agent;
  return label.slice(0, 90); // Discord caps thread names at 100
}

function entryFor(taskId) {
  let e = _sessions.get(String(taskId));
  if (!e) { e = {}; _sessions.set(String(taskId), e); }
  return e;
}

function taskForSlackThread(ts) { return _slackThreadToTask.get(String(ts)); }
function taskForDiscordThread(id) { return _discordThreadToTask.get(String(id)); }

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
    return body.ts;
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
        console.error('[session-threads] discord thread failed: HTTP', threadRes.status);
        return '';
      }
      const thread = await threadRes.json();
      entryFor(taskId).discordThreadId = thread.id;
      _discordThreadToTask.set(String(thread.id), taskId);
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
  _sessions.delete(key);
}

function _reset() {
  _sessions.clear();
  _slackThreadToTask.clear();
  _discordThreadToTask.clear();
  _pending.clear();
}

module.exports = {
  ensureSlackThread,
  ensureDiscordThread,
  taskForSlackThread,
  taskForDiscordThread,
  sessionLabel,
  forgetTask,
  _reset,
};
