// Nemesis8 agent-lifecycle event stream, the source the notification gateway
// subscribes to. Embedded by default (instances.js calls publish() off the pty
// lifecycle); connect() attaches to a real SSE endpoint if one is configured.
// Separate from nemesis-client.js, which talks to the sandbox gateway's HTTP API.

const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const EVENT_TYPES = {
  COMPLETED: 'agent:completed',
  FAILED: 'agent:failed',
  APPROVAL_REQUIRED: 'agent:approval-required',
  // Long silence with no prompt, distinct from the 15s local idle notification.
  STALE: 'agent:stale',
};

const VALID_TYPES = new Set(Object.values(EVENT_TYPES));

const bus = new EventEmitter();
// Lifecycle events can fan out to Slack + Discord + a future in-app view; the
// default cap of 10 is easy to trip and only produces a scary warning.
bus.setMaxListeners(50);

// Coerce an arbitrary event-ish object into the shape subscribers rely on.
// Returns null for anything without a recognized type so a malformed event
// from a remote stream can't crash a formatter downstream.
function normalize(event) {
  if (!event || typeof event !== 'object') return null;
  const type = event.type;
  if (!VALID_TYPES.has(type)) return null;
  return {
    type,
    // Identity of the agent that produced the event. containerId keeps the
    // Nemesis8 vocabulary; in embedded mode it's the PTY instance id.
    containerId: event.containerId != null ? String(event.containerId) : '',
    // Carried alongside containerId because an id means nothing to whoever
    // reads the alert.
    sessionName: event.sessionName || '',
    workspacePath: event.workspacePath || '',
    agentName: event.agentName || '',
    // Resolved by the provider at exit time, not reconstructed by consumers.
    sessionId: event.sessionId || '',
    resumeCommand: event.resumeCommand || '',
    resumeExact: event.resumeExact === true,
    // Populated for approval-required: which tool/step wants authorization.
    tool: event.tool || '',
    step: event.step || '',
    // The menu options offered, one button each.
    options: Array.isArray(event.options) ? event.options : [],
    optionsTruncated: event.optionsTruncated === true,
    // Populated for completed/failed.
    exitCode: typeof event.exitCode === 'number' ? event.exitCode : null,
    // Populated for stale: how long the agent had been silent.
    quietMs: typeof event.quietMs === 'number' ? event.quietMs : null,
    logsTail: event.logsTail || '',
    ts: typeof event.ts === 'number' ? event.ts : null,
    // Whether this session opted into webhooks (the sidebar bell). Defaults to
    // true so a remote stream, which has no per-tab toggle, still notifies.
    notify: event.notify !== false,
  };
}

// Publish to all subscribers; returns the normalized event or null if rejected.
// Never throws — a bad publish must not take down the calling PTY path.
function publish(event) {
  const normalized = normalize(event);
  if (!normalized) return null;
  try {
    bus.emit('event', normalized);
  } catch (err) {
    try { console.error('[nemesis] subscriber threw:', err && err.message); } catch {}
  }
  return normalized;
}

function subscribe(handler) {
  bus.on('event', handler);
  return () => bus.off('event', handler);
}

// ---- Connected mode (optional SSE transport) ----

// Minimal SSE reader over built-in http/https (no ws dep): parses `data:` JSON
// frames and republishes them, reconnecting with capped backoff. Blank url = no-op.
function connect(opts = {}) {
  const url = opts.url;
  const handle = { close() { closed = true; if (req) { try { req.destroy(); } catch {} } } };
  let closed = false;
  let req = null;
  let backoff = 1000;
  const MAX_BACKOFF = 30000;

  if (!url) return handle;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    try { console.error('[nemesis] invalid nemesisUrl, staying in embedded mode:', url); } catch {}
    return handle;
  }
  const transport = parsed.protocol === 'https:' ? https : http;

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
    setTimeout(open, delay).unref?.();
  };

  const open = () => {
    if (closed) return;
    req = transport.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        scheduleReconnect();
        return;
      }
      backoff = 1000; // healthy connection — reset backoff
      res.setEncoding('utf8');
      let buffer = '';
      // Guard against a misbehaving endpoint that streams without event
      // separators — don't let the buffer grow without bound.
      const MAX_BUFFER = 1 << 20; // 1 MiB
      res.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
        // SSE events are separated by a blank line; each may carry one or more
        // `data:` lines. We only need the concatenated data payload as JSON.
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const data = raw
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('');
          if (!data) continue;
          try {
            publish(JSON.parse(data));
          } catch {
            // Ignore keep-alives / non-JSON frames.
          }
        }
      });
      res.on('end', scheduleReconnect);
    });
    req.on('error', () => { if (!closed) scheduleReconnect(); });
  };

  open();
  return handle;
}

module.exports = {
  EVENT_TYPES,
  normalize,
  publish,
  subscribe,
  connect,
  // Exposed for tests that need to assert on subscriber count / reset.
  _bus: bus,
};
