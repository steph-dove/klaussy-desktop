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
  const wantsButtons = event.type === EVENT_TYPES.APPROVAL_REQUIRED
    && (cfg.slackInteractive || cfg.discordInteractive)
    && event.containerId;
  if (wantsButtons) {
    approvalToken = require('./approval-registry').issue(event.containerId, event.tool || event.step);
  }
  const decorated = approvalToken ? { ...event, approvalToken } : event;

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
  if (cfg.discordInteractive && (approvalToken || !cfg.discordWebhookUrl)) {
    jobs.push(threads.ensureDiscordThread(cfg, event)
      .then((id) => postDiscordAsBot(cfg, formatDiscord(discordEvent), id)));
  } else if (cfg.discordWebhookUrl) {
    jobs.push(safePost('discord', cfg.discordWebhookUrl, formatDiscord(discordEvent)));
  }
  return Promise.all(jobs);
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
    const decision = parsed.actionId === 'klaussy_approve' ? 'approve' : 'reject';
    const res = applyDecision({
      token: parsed.value, decision, userId: parsed.userId, allowList: cfg.allowList,
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
    const taskId = threads.taskForSlackThread(parsed.threadTs);
    if (!taskId) return; // a thread we don't own
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
    const [action, token] = String(parsed.customId).split(':');
    const decision = action === 'klaussy_approve' ? 'approve' : 'reject';
    const res = applyDecision({ token, decision, userId: parsed.userId, allowList: cfg.allowList });
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
    const taskId = threads.taskForDiscordThread(parsed.channel);
    if (!taskId) return; // a channel/thread we don't own
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
function stop() {
  if (_unsubscribe) { try { _unsubscribe(); } catch {} _unsubscribe = null; }
  if (_connection) { try { _connection.close(); } catch {} _connection = null; }
  if (_slack) { try { _slack.close(); } catch {} _slack = null; }
  if (_discord) { try { _discord.close(); } catch {} _discord = null; }
  threads._reset();
  _started = false;
}

// Re-read config and rebuild the sockets — called after a prefs save so new
// tokens take effect without restarting the app.
function restart() {
  stop();
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
