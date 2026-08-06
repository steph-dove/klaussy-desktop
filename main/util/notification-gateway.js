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
  // Prefer the bot whenever it's configured: an incoming webhook returns no
  // message ts, and without a ts there is nothing for a threaded reply to
  // attach to. The webhook stays the path for notify-only setups.
  if (cfg.slackInteractive) {
    jobs.push(postSlackAsBot(cfg, formatSlack(decorated)));
  } else if (cfg.slackWebhookUrl) {
    jobs.push(safePost('slack', cfg.slackWebhookUrl, formatSlack(decorated)));
  } else if (cfg.slackBotToken && cfg.slackChannel) {
    jobs.push(postSlackAsBot(cfg, formatSlack(decorated)));
  }
  // Discord is different: a plain channel webhook cannot carry components, so
  // an interactive alert MUST go through the bot API.
  if (cfg.discordInteractive && (approvalToken || !cfg.discordWebhookUrl)) {
    jobs.push(postDiscordAsBot(cfg, formatDiscord(decorated)));
  } else if (cfg.discordWebhookUrl) {
    jobs.push(safePost('discord', cfg.discordWebhookUrl, formatDiscord(decorated)));
  }
  const results = await Promise.all(jobs);
  // Remember which alert belongs to which session so a reply in that thread
  // reaches the same agent. Only bot-sent messages return an id.
  for (const r of results) {
    if (r && r.ok && event.containerId) rememberMessage(r.ts || r.messageId, event.containerId);
  }
  return results;
}

// chat.postMessage instead of the webhook: returns the message ts, which is
// what lets a user reply in-thread to answer this specific session.
async function postSlackAsBot(cfg, payload) {
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + cfg.slackBotToken,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: cfg.slackChannel, ...payload }),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) return { target: 'slack', ok: false, error: body.error || 'chat.postMessage failed' };
    return { target: 'slack', ok: true, status: 200, ts: body.ts };
  } catch (err) {
    return { target: 'slack', ok: false, error: err.message };
  }
}

async function postDiscordAsBot(cfg, payload) {
  try {
    const res = await fetch(`${DISCORD_API}/channels/${cfg.discordChannel}/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bot ' + cfg.discordBotToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { target: 'discord', ok: false, status: res.status, error: text.slice(0, 200) };
    }
    const body = await res.json().catch(() => ({}));
    return { target: 'discord', ok: true, status: res.status, messageId: body.id };
  } catch (err) {
    return { target: 'discord', ok: false, error: err.message };
  }
}

// ---- Lifecycle wiring (idempotent) ----

let _started = false;
let _unsubscribe = null;
let _connection = null;
let _slack = null;
let _discord = null;
// Message id -> task id, so a threaded/replied message reaches the right agent.
const _messageToTask = new Map();
const MAX_TRACKED_MESSAGES = 200;

// Called when a session ends so its alert threads stop routing anywhere, rather
// than waiting to be aged out by the size cap.
function forgetTask(taskId) {
  const key = String(taskId);
  for (const [messageId, id] of _messageToTask) {
    if (String(id) === key) _messageToTask.delete(messageId);
  }
}

function rememberMessage(messageId, taskId) {
  if (!messageId) return;
  _messageToTask.set(String(messageId), taskId);
  // Bounded: oldest-first eviction keeps a long-running app from growing this
  // map forever. Losing an old mapping only means an old thread stops routing.
  if (_messageToTask.size > MAX_TRACKED_MESSAGES) {
    const oldest = _messageToTask.keys().next().value;
    _messageToTask.delete(oldest);
  }
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
  _socketStatus[which] = { ok: !!(s && s.ok), error: (s && s.error) || '', fatal: !!(s && s.fatal) };
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
      postWebhook(parsed.responseUrl, { replace_original: res.ok, text }).catch(() => {});
    }
    return;
  }

  if (parsed.kind === 'message' && parsed.threadTs) {
    const taskId = _messageToTask.get(String(parsed.threadTs));
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
  }).catch(() => {});
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
    respondToInteraction(parsed.interactionId, parsed.interactionToken, text).catch(() => {});
    return;
  }

  if (parsed.kind === 'message' && parsed.referencedMessageId) {
    const taskId = _messageToTask.get(String(parsed.referencedMessageId));
    if (!taskId) return;
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
  }).catch(() => {});
}

// Tear down (tests / shutdown). Restores the pre-started state so ensureStarted
// can wire up cleanly again.
function stop() {
  if (_unsubscribe) { try { _unsubscribe(); } catch {} _unsubscribe = null; }
  if (_connection) { try { _connection.close(); } catch {} _connection = null; }
  if (_slack) { try { _slack.close(); } catch {} _slack = null; }
  if (_discord) { try { _discord.close(); } catch {} _discord = null; }
  _messageToTask.clear();
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
