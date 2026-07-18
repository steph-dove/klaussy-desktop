// Notification gateway: turns Nemesis8 lifecycle events into Slack/Discord
// webhook posts. ensureStarted() subscribes to the bus once and dispatches each
// event to the configured targets; instances.js publishes and starts it lazily.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const nemesis = require('./nemesis-client');
const { formatSlack, formatDiscord } = require('./webhook-format');
const { getNotificationConfig } = require('./config');

const { EVENT_TYPES } = nemesis;
const POST_TIMEOUT_MS = 10000;

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
  if (!eventTypeEnabled(event, cfg)) return [];
  const jobs = [];
  if (cfg.slackWebhookUrl) jobs.push(safePost('slack', cfg.slackWebhookUrl, formatSlack(event)));
  if (cfg.discordWebhookUrl) jobs.push(safePost('discord', cfg.discordWebhookUrl, formatDiscord(event)));
  return Promise.all(jobs);
}

// ---- Lifecycle wiring (idempotent) ----

let _started = false;
let _unsubscribe = null;
let _connection = null;

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
}

// Tear down (tests / shutdown). Restores the pre-started state so ensureStarted
// can wire up cleanly again.
function stop() {
  if (_unsubscribe) { try { _unsubscribe(); } catch {} _unsubscribe = null; }
  if (_connection) { try { _connection.close(); } catch {} _connection = null; }
  _started = false;
}

module.exports = {
  postWebhook,
  dispatchEvent,
  eventTypeEnabled,
  ensureStarted,
  stop,
};
