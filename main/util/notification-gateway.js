// Notification gateway: turns Nemesis8 lifecycle events into Slack/Discord
// messages, and routes the replies back. ensureStarted() subscribes to the bus,
// dispatches each event to the configured targets, and — when tokens are
// present — opens the Slack Socket Mode / Discord Gateway sockets that carry
// button clicks and text replies back to the agent. instances.js publishes and
// starts it lazily.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const nemesis = require('./nemesis-events');
const { formatSlack, formatDiscord } = require('./webhook-format');
const { getNotificationConfig } = require('./config');
const threads = require('./session-threads');

const { EVENT_TYPES } = nemesis;
const POST_TIMEOUT_MS = 10000;
const DISCORD_API = 'https://discord.com/api/v10';

// POST a JSON body to a webhook over built-in http/https (no request lib).
// Resolves { status } on any response, rejects on network error or timeout.
function postWebhook(url, payload) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new Error(`invalid webhook url: ${err.message}`));
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = transport.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      },
      (res) => {
        res.resume(); // drain so the socket can be reused / freed
        res.on('end', () => resolve({ status: res.statusCode }));
      },
    );
    req.setTimeout(POST_TIMEOUT_MS, () => req.destroy(new Error('webhook post timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function eventTypeEnabled(event, cfg) {
  switch (event.type) {
    case EVENT_TYPES.COMPLETED: return cfg.events.completed;
    case EVENT_TYPES.FAILED: return cfg.events.failed;
    case EVENT_TYPES.APPROVAL_REQUIRED: return cfg.events.approvalRequired;
    case EVENT_TYPES.STALE: return cfg.events.stale;
    case EVENT_TYPES.MESSAGE: return cfg.events.message;
    default: return false;
  }
}

// Post a formatted payload without letting a single failing webhook reject the
// whole dispatch — one dead Slack URL shouldn't suppress the Discord post, and
// a network error must never bubble into the PTY lifecycle path.
async function safePost(target, url, payload) {
  try {
    const { status } = await postWebhook(url, payload);
    const ok = status >= 200 && status < 300;
    if (!ok) {
      try { console.error(`[notification-gateway] ${target} returned HTTP ${status}`); } catch {}
    }
    return { target, ok, status };
  } catch (err) {
    try { console.error(`[notification-gateway] ${target} post failed:`, err && err.message); } catch {}
    return { target, ok: false, error: err && err.message };
  }
}

// Format an event for every configured + enabled target and post them in
// parallel. Returns the per-target results (empty if the type is muted).
async function dispatchEvent(event, cfg) {
  if (event.notify === false) return []; // session's bell is off
  if (!eventTypeEnabled(event, cfg)) return [];

  // Mint a single-use token so the Approve/Reject buttons can be traced back to
  // this session. Only for approval prompts, and only where a socket exists to
  // hear the click — otherwise the buttons would be dead.
  let approvalToken = '';
  let promptOptions = [];
  let optionsTruncated = false;
  let menuPrompt = false;
  let multiSelect = '';
  let promptQuestion = '';
  const wantsButtons = event.type === EVENT_TYPES.APPROVAL_REQUIRED
    && (cfg.slackInteractive || cfg.discordInteractive)
    && event.containerId;
  if (wantsButtons) {
    // logsTail still holds the prompt, so the options and answering keystrokes
    // are read here and stored with the token rather than guessed at click time.
    const reply = require('./chat-reply');
    const parsed = reply.parsePromptOptions(event.logsTail);
    multiSelect = reply.multiSelectStyle(event.logsTail);
    // A button carries one key, which can't answer a prompt that takes several,
    // so those get told how to answer instead of a button pressing a wrong key.
    promptOptions = multiSelect ? [] : parsed.options;
    optionsTruncated = multiSelect ? false : parsed.truncated;
    // A menu ignores y/n, so Approve/Reject for one would be dead buttons; none
    // is better, since the mirrored turn still shows the choices.
    menuPrompt = reply.hasSelectionFooter(event.logsTail) || promptOptions.length > 0 || !!multiSelect;
    // A hook said what it wants in the agent's own words; the screen is only
    // guessed at when nothing authoritative came with the event.
    promptQuestion = event.promptQuestion || reply.parsePromptQuestion(event.logsTail);
    if (menuPrompt && !promptOptions.length) {
      console.warn('[notification-gateway] selection prompt with no readable options');
    }
    approvalToken = require('./approval-registry').issue(
      event.containerId,
      event.tool || event.step,
      {
        ...reply.keysForPrompt(event.logsTail),
        options: promptOptions,
        // Records which question these keys answer, so the button refuses if the
        // agent has moved on to a different one by the time it is pressed.
        prompt: reply.approvalTail({ recentOutput: event.logsTail }),
      },
    );
  }
  const decorated = approvalToken
    ? { ...event, approvalToken, options: promptOptions, optionsTruncated, menuPrompt, promptQuestion, multiSelect }
    : event;

  const jobs = [];
  // Buttons only go where a socket can hear them: a plain Discord webhook
  // rejects components outright (400), losing the alert.
  const slackEvent = cfg.slackInteractive ? decorated : event;
  const discordEvent = cfg.discordInteractive ? decorated : event;

  const urgent = event.type === EVENT_TYPES.APPROVAL_REQUIRED;

  // Prefer the bot when configured: a webhook can't post into a thread.
  if (cfg.slackInteractive || (cfg.slackBotToken && cfg.slackChannel)) {
    jobs.push(threads.ensureSlackThread(cfg, event)
      .then((ts) => postSlackAsBot(cfg, formatSlack(slackEvent), ts, urgent)));
  } else if (cfg.slackWebhookUrl) {
    jobs.push(safePost('slack', cfg.slackWebhookUrl, formatSlack(slackEvent)));
  }
  // Prefer the bot whenever there is one, as Slack does above: a webhook cannot
  // post into a thread and its posts carry no id to reply to, so a webhook url
  // beside a bot cost every non-approval message its thread.
  if (cfg.discordInteractive) {
    jobs.push(threads.ensureDiscordThread(cfg, event)
      .then((id) => postDiscordAsBot(cfg, formatDiscord(discordEvent), id)));
  } else if (cfg.discordWebhookUrl) {
    jobs.push(safePost('discord', cfg.discordWebhookUrl, formatDiscord(discordEvent)));
  }
  const results = await Promise.all(jobs);
  // Remember what was posted so a reply to it reaches this session even when no
  // thread exists to type in.
  for (const r of results) {
    if (r && r.ok && event.containerId) threads.rememberMessage(r.ts || r.messageId, event.containerId);
  }
  return results;
}

// chat.postMessage instead of the webhook: it can post into the session's
// thread, which a webhook cannot.
async function postSlackAsBot(cfg, payload, threadTs, broadcast) {
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + cfg.slackBotToken,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: cfg.slackChannel,
        ...payload,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        // A thread reply is invisible in the channel until you open the thread,
        // which is the wrong default for something waiting on you.
        ...(threadTs && broadcast ? { reply_broadcast: true } : {}),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) return logPostFailure('slack', body.error || 'chat.postMessage failed');
    return { target: 'slack', ok: true, status: 200, ts: body.ts };
  } catch (err) {
    return logPostFailure('slack', err.message);
  }
}

// The fire-and-forget dispatch discards these results, so a revoked token or
// wrong channel would otherwise stop alerts with no trace.
function logPostFailure(target, error) {
  try { console.error(`[notification-gateway] ${target} post failed:`, error); } catch {}
  return { target, ok: false, error };
}

// A thread id is a channel id as far as the messages endpoint is concerned.
async function postDiscordAsBot(cfg, payload, threadId) {
  try {
    const target = threadId || cfg.discordChannel;
    const res = await fetch(`${DISCORD_API}/channels/${target}/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bot ' + cfg.discordBotToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return logPostFailure('discord', `HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const body = await res.json().catch(() => ({}));
    return { target: 'discord', ok: true, status: res.status, messageId: body.id };
  } catch (err) {
    return logPostFailure('discord', err.message);
  }
}

// ---- Lifecycle wiring (idempotent) ----

let _started = false;
let _unsubscribe = null;
let _connection = null;
let _slack = null;
let _discord = null;

function forgetTask(taskId) {
  threads.forgetTask(taskId);
}

// Subscribe to the bus once; config is re-read per event so pref changes apply
// without a restart. Also attaches to a Nemesis8 SSE endpoint if one is set.
function ensureStarted() {
  if (_started) return;
  _started = true;

  _unsubscribe = nemesis.subscribe((event) => {
    const cfg = getNotificationConfig();
    if (!cfg.enabled) return;
    // Fire-and-forget: dispatchEvent already swallows its own errors.
    dispatchEvent(event, cfg).catch(() => {});
  });

  try {
    const { nemesisUrl } = getNotificationConfig();
    if (nemesisUrl) _connection = nemesis.connect({ url: nemesisUrl });
  } catch (err) {
    try { console.error('[notification-gateway] nemesis connect failed:', err && err.message); } catch {}
  }

  startInboundSockets();
}

// Open the reply channels. Config is read once here rather than per event: a
// socket is a long-lived connection, so changing tokens needs a restart of the
// gateway (stop() + ensureStarted()), which the prefs save triggers.
function startInboundSockets() {
  const cfg = getNotificationConfig();

  if (cfg.slackInteractive && !_slack) {
    try {
      const { createSlackSocket, parseEnvelope } = require('./slack-socket');
      _slack = createSlackSocket({
        appToken: cfg.slackAppToken,
        onStatus: (s) => logStatus('slack', s),
        onEvent: (frame) => handleSlackFrame(parseEnvelope(frame)),
      });
    } catch (err) {
      console.error('[notification-gateway] slack socket failed:', err.message);
    }
  }

  if (cfg.discordInteractive && !_discord) {
    try {
      const { createDiscordGateway, parseDispatch } = require('./discord-gateway');
      _discord = createDiscordGateway({
        botToken: cfg.discordBotToken,
        onStatus: (s) => logStatus('discord', s),
        onEvent: (frame) => handleDiscordFrame(parseDispatch(frame)),
      });
    } catch (err) {
      console.error('[notification-gateway] discord gateway failed:', err.message);
    }
  }
}

// Last known socket state per platform, for the prefs window: a bad token
// otherwise looks exactly like a working one, since the test button only
// exercises the outbound webhook.
const _socketStatus = { slack: null, discord: null };

const STALE_THREAD_NOTE = 'This thread is no longer connected to a running session, so nothing was sent. Reply in the session’s current thread, or in Klaussy.';

// One note per thread rather than one per message: someone can type several
// lines before they read the first answer.
const _notedThreads = new Set();
const MAX_NOTED_THREADS = 200;

function noteOnce(threadId) {
  const key = String(threadId || '');
  if (!key || _notedThreads.has(key)) return false;
  if (_notedThreads.size >= MAX_NOTED_THREADS) _notedThreads.clear();
  _notedThreads.add(key);
  return true;
}

// Only reached from the alerts channel itself, where an alert posts flat
// because the bot can't open threads. A thread always identifies its own
// session, so an unrecognised one is never resolved this way.
function fallbackTask() {
  try {
    const { notifyingAgentInstances } = require('../state/instances');
    const live = notifyingAgentInstances();
    if (live.length === 1) return { taskId: live[0].id };
    if (live.length > 1) return { ambiguous: live.length };
  } catch { /* instances unavailable */ }
  return {};
}

function getSocketStatus() {
  const cfg = getNotificationConfig();
  return {
    slack: cfg.slackInteractive ? (_socketStatus.slack || { pending: true }) : null,
    discord: cfg.discordInteractive ? (_socketStatus.discord || { pending: true }) : null,
  };
}

function logStatus(which, s) {
  _socketStatus[which] = {
    ok: !!(s && s.ok),
    error: (s && s.error) || '',
    fatal: !!(s && s.fatal),
    degraded: !!(s && s.degraded),
  };
  if (s && s.ok) console.log(`[notification-gateway] ${which} connected`);
  else console.warn(`[notification-gateway] ${which}: ${(s && s.error) || 'disconnected'}`);
}

function handleSlackFrame(parsed) {
  if (!parsed) return;
  const cfg = getNotificationConfig();
  const { applyDecision, applyText } = require('./chat-reply');

  if (parsed.kind === 'action') {
    const res = parsed.actionId.startsWith('klaussy_choice')
      ? (() => {
        const [token, key] = String(parsed.value).split(':');
        return require('./chat-reply').applyChoice({
          token, key, userId: parsed.userId, allowList: cfg.allowList,
        });
      })()
      : applyDecision({
        token: parsed.value,
        decision: parsed.actionId === 'klaussy_approve' ? 'approve' : 'reject',
        userId: parsed.userId,
        allowList: cfg.allowList,
      });
    if (parsed.responseUrl) {
      // Replacing drops the (now single-use) buttons, so name the tool and who
      // clicked or the channel loses the record of what was approved.
      const what = res.tool ? ` — \`${res.tool}\`` : '';
      const text = res.ok
        ? `${res.message} by <@${parsed.userId}>${what}`
        : `Not applied: ${res.message}`;
      postWebhook(parsed.responseUrl, { replace_original: res.ok, text })
        .catch((err) => logAckFailure('slack button ack', err.message));
    }
    return;
  }

  if (parsed.kind === 'message' && parsed.threadTs) {
    const taskId = threads.taskForSlackThread(parsed.threadTs)
      || threads.taskForMessage(parsed.threadTs)
      // A restart empties the map but not the channel, so a thread it no longer
      // knows is reattached to whatever is running in the session it was for.
      || threads.reattachThread(parsed.threadTs);
    if (!taskId) {
      if (noteOnce(parsed.threadTs)) {
        replyInSlackThread(cfg, parsed.channel, parsed.threadTs, STALE_THREAD_NOTE);
      }
      return;
    }
    const res = applyText({ taskId, text: parsed.text, userId: parsed.userId, allowList: cfg.allowList });
    // Silence would look identical to "delivered", so say when it wasn't.
    if (!res.ok) replyInSlackThread(cfg, parsed.channel, parsed.threadTs, res.message);
  }
}

function replyInSlackThread(cfg, channel, threadTs, text) {
  if (!cfg.slackBotToken || !channel) return;
  fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + cfg.slackBotToken,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  })
    .then((res) => res.json().catch(() => ({})))
    .then((body) => { if (!body.ok) logAckFailure('slack thread reply', body.error); })
    .catch((err) => logAckFailure('slack thread reply', err.message));
}

// These acks are the only signal in chat, so a failure here is silence on both ends.
function logAckFailure(what, error) {
  try { console.error(`[notification-gateway] ${what} failed:`, error); } catch {}
}

function handleDiscordFrame(parsed) {
  if (!parsed) return;
  const cfg = getNotificationConfig();
  const { applyDecision, applyText } = require('./chat-reply');
  const { respondToInteraction } = require('./discord-gateway');

  if (parsed.kind === 'action') {
    const [action, token, key] = String(parsed.customId).split(':');
    const res = action === 'klaussy_choice'
      ? require('./chat-reply').applyChoice({ token, key, userId: parsed.userId, allowList: cfg.allowList })
      : applyDecision({
        token,
        decision: action === 'klaussy_approve' ? 'approve' : 'reject',
        userId: parsed.userId,
        allowList: cfg.allowList,
      });
    const text = res.ok
      ? `${res.message} by <@${parsed.userId}>`
      : `Not applied: ${res.message}`;
    respondToInteraction(parsed.interactionId, parsed.interactionToken, text)
      .then((r) => { if (r && !r.ok) logAckFailure('discord button ack', 'HTTP ' + r.status); })
      .catch((err) => logAckFailure('discord button ack', err.message));
    return;
  }

  // The thread the message was typed in identifies the session — no need for
  // the sender to reply to a specific alert.
  if (parsed.kind === 'message') {
    let taskId = threads.taskForDiscordThread(parsed.channel)
      || threads.taskForMessage(parsed.referencedMessageId)
      // A restart empties the map but not the channel, so a thread it no longer
      // knows is reattached to whatever is running in the session it was for.
      || threads.reattachThread(parsed.channel);
    // Anywhere but the alerts channel, this is a thread we have no record of:
    // another session's, or one orphaned by a restart. Its session is not
    // whichever one happens to be running now.
    if (!taskId && String(parsed.channel) !== String(cfg.discordChannel || '')) {
      if (noteOnce(parsed.channel)) {
        replyInDiscordChannel(cfg, parsed.channel, parsed.messageId, STALE_THREAD_NOTE);
      }
      return;
    }
    if (!taskId) {
      const fb = fallbackTask();
      if (fb.ambiguous) {
        replyInDiscordChannel(cfg, parsed.channel, parsed.messageId,
          `${fb.ambiguous} sessions are running — reply in the one you mean.`);
        return;
      }
      if (!fb.taskId) return; // nothing is listening
      taskId = fb.taskId;
    }
    const res = applyText({ taskId, text: parsed.text, userId: parsed.userId, allowList: cfg.allowList });
    if (!res.ok) replyInDiscordChannel(cfg, parsed.channel, parsed.messageId, res.message);
  }
}

function replyInDiscordChannel(cfg, channel, replyToId, text) {
  if (!cfg.discordBotToken || !channel) return;
  fetch(`${DISCORD_API}/channels/${channel}/messages`, {
    method: 'POST',
    headers: {
      authorization: 'Bot ' + cfg.discordBotToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content: text, message_reference: { message_id: replyToId } }),
  })
    .then((res) => { if (!res.ok) logAckFailure('discord reply', 'HTTP ' + res.status); })
    .catch((err) => logAckFailure('discord reply', err.message));
}

// Tear down (tests / shutdown). Restores the pre-started state so ensureStarted
// can wire up cleanly again.
function stop({ keepThreads = false } = {}) {
  if (_unsubscribe) { try { _unsubscribe(); } catch {} _unsubscribe = null; }
  if (_connection) { try { _connection.close(); } catch {} _connection = null; }
  if (_slack) { try { _slack.close(); } catch {} _slack = null; }
  if (_discord) { try { _discord.close(); } catch {} _discord = null; }
  if (!keepThreads) threads._reset();
  _notedThreads.clear();
  _started = false;
}

// Re-read config and rebuild the sockets after a prefs save. The thread map
// outlives them: its sessions are still running, and forgetting them would
// strand their threads and open a second one for each.
function restart() {
  stop({ keepThreads: true });
  ensureStarted();
}

module.exports = {
  postWebhook,
  dispatchEvent,
  eventTypeEnabled,
  ensureStarted,
  restart,
  handleSlackFrame,
  handleDiscordFrame,
  forgetTask,
  getSocketStatus,
  stop,
};
