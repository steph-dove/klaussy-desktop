// Slack Socket Mode: the inbound half of the notification gateway. A desktop
// app has no public endpoint for Slack to POST interactions to, so we hold a
// WebSocket open instead. Needs an app-level token (xapp-…), not the bot token.

const { EventEmitter } = require('events');

const CONNECTIONS_OPEN = 'https://slack.com/api/apps.connections.open';
const MAX_BACKOFF_MS = 30000;

// Token problems, as opposed to the transient failures worth retrying.
const FATAL_AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked']);

// Slack closes a Socket Mode connection roughly hourly (and warns first with a
// `disconnect` frame), so reconnecting is the normal path, not just error
// recovery.
function createSlackSocket({ appToken, onEvent, onStatus }) {
  const bus = new EventEmitter();
  const emitStatus = (s) => { try { if (onStatus) onStatus(s); } catch {} };

  let ws = null;
  let closed = false;
  let attempt = 0;
  let retryTimer = null;

  async function openUrl() {
    const res = await fetch(CONNECTIONS_OPEN, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + appToken,
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error(body.error || 'apps.connections.open failed');
    return body.url;
  }

  function scheduleReconnect() {
    if (closed) return;
    const delay = Math.min(1000 * Math.pow(2, attempt++), MAX_BACKOFF_MS);
    retryTimer = setTimeout(connect, delay);
    retryTimer.unref?.();
  }

  async function connect() {
    if (closed) return;
    let url;
    try {
      url = await openUrl();
    } catch (err) {
      // A rejected token never becomes valid by retrying — stop, the way the
      // Discord gateway does on 4004, instead of polling this endpoint forever.
      if (FATAL_AUTH_ERRORS.has(err.message)) {
        closed = true;
        emitStatus({ ok: false, fatal: true, error: 'invalid Slack app-level token' });
        return;
      }
      emitStatus({ ok: false, error: err.message });
      scheduleReconnect();
      return;
    }
    try {
      ws = new WebSocket(url);
    } catch (err) {
      emitStatus({ ok: false, error: err.message });
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => { attempt = 0; emitStatus({ ok: true }); });

    ws.addEventListener('message', (ev) => {
      let frame;
      try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (!frame || !frame.type) return;

      // Slack expects the envelope acknowledged within 3s or it redelivers.
      // Ack before doing the work so a slow PTY write can't cause a duplicate.
      if (frame.envelope_id) {
        try { ws.send(JSON.stringify({ envelope_id: frame.envelope_id })); } catch {}
      }
      if (frame.type === 'disconnect') {
        try { ws.close(); } catch {}
        return;
      }
      if (frame.type === 'hello') return;

      try {
        if (onEvent) onEvent(frame);
      } catch (err) {
        console.warn('[slack-socket] handler failed:', err.message);
      }
    });

    ws.addEventListener('close', () => { ws = null; scheduleReconnect(); });
    ws.addEventListener('error', () => { emitStatus({ ok: false, error: 'socket error' }); });
  }

  connect();

  return {
    bus,
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (ws) { try { ws.close(); } catch {} ws = null; }
    },
  };
}

// Pull the fields we act on out of a Socket Mode envelope. Returns null for
// frames we don't handle, so the caller has one shape to branch on.
function parseEnvelope(frame) {
  if (!frame || !frame.payload) return null;
  const p = frame.payload;

  if (frame.type === 'interactive' && Array.isArray(p.actions) && p.actions.length) {
    const action = p.actions[0];
    return {
      kind: 'action',
      actionId: action.action_id || '',
      value: action.value || '',
      userId: (p.user && p.user.id) || '',
      userName: (p.user && (p.user.username || p.user.name)) || '',
      responseUrl: p.response_url || '',
      channel: (p.channel && p.channel.id) || '',
    };
  }

  if (frame.type === 'events_api' && p.event && p.event.type === 'message') {
    const e = p.event;
    // bot_id filters out our own posts, which would otherwise loop straight
    // back in as a "reply" the moment we answer someone.
    if (e.bot_id || e.subtype) return null;
    return {
      kind: 'message',
      text: e.text || '',
      userId: e.user || '',
      channel: e.channel || '',
      threadTs: e.thread_ts || '',
      ts: e.ts || '',
    };
  }

  return null;
}

module.exports = { createSlackSocket, parseEnvelope };
