// Discord Gateway: the inbound half for Discord, mirroring slack-socket.js.
//
// Same reason as Slack — no public endpoint on a desktop machine — but Discord
// makes us run the connection ourselves: identify, heartbeat on the interval it
// gives us, and resume with the last sequence number after a drop.

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const API_BASE = 'https://discord.com/api/v10';
const MAX_BACKOFF_MS = 30000;

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

// GUILD_MESSAGES (1<<9) delivers message events; MESSAGE_CONTENT (1<<15) is what
// actually fills in `content` and is privileged — it must be enabled on the bot
// or replies arrive blank. Interactions need no intent at all.
const INTENTS = (1 << 9) | (1 << 15);

function createDiscordGateway({ botToken, onEvent, onStatus, wantMessages = true }) {
  const emitStatus = (s) => { try { if (onStatus) onStatus(s); } catch {} };

  let ws = null;
  let closed = false;
  let attempt = 0;
  let retryTimer = null;
  let heartbeatTimer = null;
  let lastSeq = null;
  let sessionId = null;
  let resumeUrl = null;
  let acked = true;
  // Flipped off after a 4014 so we reconnect without the privileged intent.
  let messagesWanted = wantMessages;

  // A reconnect after 4014 succeeds, so a bare ok:true would report "connected"
  // while text replies are silently dead.
  function readyStatus(extra) {
    const degraded = wantMessages && !messagesWanted;
    return {
      ok: true,
      degraded,
      error: degraded ? 'connected — text replies off (Message Content intent)' : '',
      ...extra,
    };
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function startHeartbeat(intervalMs) {
    stopHeartbeat();
    acked = true;
    heartbeatTimer = setInterval(() => {
      // A missed ACK means the connection is a zombie: the socket looks open but
      // Discord isn't hearing us. Tear it down so the resume path runs.
      if (!acked) { try { ws.close(4000); } catch {} return; }
      acked = false;
      send({ op: OP.HEARTBEAT, d: lastSeq });
    }, intervalMs);
    heartbeatTimer.unref?.();
  }

  function send(payload) {
    if (!ws) return;
    try { ws.send(JSON.stringify(payload)); } catch {}
  }

  function scheduleReconnect() {
    if (closed) return;
    stopHeartbeat();
    const delay = Math.min(1000 * Math.pow(2, attempt++), MAX_BACKOFF_MS);
    retryTimer = setTimeout(connect, delay);
    retryTimer.unref?.();
  }

  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(resumeUrl ? resumeUrl + '/?v=10&encoding=json' : GATEWAY_URL);
    } catch (err) {
      emitStatus({ ok: false, error: err.message });
      scheduleReconnect();
      return;
    }

    ws.addEventListener('message', (ev) => {
      let frame;
      try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (frame.s != null) lastSeq = frame.s;

      switch (frame.op) {
        case OP.HELLO:
          startHeartbeat(frame.d.heartbeat_interval);
          if (sessionId && lastSeq != null) {
            send({ op: OP.RESUME, d: { token: botToken, session_id: sessionId, seq: lastSeq } });
          } else {
            send({
              op: OP.IDENTIFY,
              d: {
                token: botToken,
                intents: messagesWanted ? INTENTS : 0,
                properties: { os: process.platform, browser: 'klaussy', device: 'klaussy' },
              },
            });
          }
          break;
        case OP.HEARTBEAT:
          send({ op: OP.HEARTBEAT, d: lastSeq });
          break;
        case OP.HEARTBEAT_ACK:
          acked = true;
          break;
        case OP.RECONNECT:
          try { ws.close(4000); } catch {}
          break;
        case OP.INVALID_SESSION:
          // Can't resume — drop the session so the next HELLO identifies fresh.
          sessionId = null; lastSeq = null; resumeUrl = null;
          try { ws.close(4000); } catch {}
          break;
        case OP.DISPATCH:
          if (frame.t === 'READY') {
            attempt = 0;
            sessionId = frame.d.session_id;
            resumeUrl = frame.d.resume_gateway_url || null;
            emitStatus(readyStatus({ user: frame.d.user && frame.d.user.username }));
          } else if (frame.t === 'RESUMED') {
            attempt = 0;
            emitStatus(readyStatus({}));
          } else if (frame.t === 'INTERACTION_CREATE' || frame.t === 'MESSAGE_CREATE') {
            try { if (onEvent) onEvent(frame); } catch (err) {
              console.warn('[discord-gateway] handler failed:', err.message);
            }
          }
          break;
        default:
          break;
      }
    });

    ws.addEventListener('close', (ev) => {
      ws = null;
      // 4014 = we asked for a privileged intent the bot isn't approved for.
      // Buttons need no intent, so drop back to interactions-only rather than
      // losing the whole connection over a feature the user may not want.
      if (ev && ev.code === 4014 && messagesWanted) {
        messagesWanted = false;
        sessionId = null; lastSeq = null; resumeUrl = null;
        emitStatus({
          ok: false,
          error: 'Message Content intent is off — buttons will work, text replies will not',
        });
        scheduleReconnect();
        return;
      }
      // 4004 is a bad token; reconnecting will never fix it.
      if (ev && (ev.code === 4004 || ev.code === 4014)) {
        closed = true;
        emitStatus({ ok: false, fatal: true, error: 'invalid bot token' });
        stopHeartbeat();
        return;
      }
      scheduleReconnect();
    });

    ws.addEventListener('error', () => emitStatus({ ok: false, error: 'socket error' }));
  }

  connect();

  return {
    close() {
      closed = true;
      stopHeartbeat();
      if (retryTimer) clearTimeout(retryTimer);
      if (ws) { try { ws.close(); } catch {} ws = null; }
    },
  };
}

// Normalize a dispatch into the same {kind, …} shape slack-socket produces.
function parseDispatch(frame) {
  if (!frame || !frame.d) return null;
  const d = frame.d;

  if (frame.t === 'INTERACTION_CREATE') {
    // type 3 = MESSAGE_COMPONENT (a button click).
    if (d.type !== 3) return null;
    const user = d.member ? d.member.user : d.user;
    return {
      kind: 'action',
      customId: (d.data && d.data.custom_id) || '',
      userId: (user && user.id) || '',
      userName: (user && user.username) || '',
      interactionId: d.id,
      interactionToken: d.token,
      channel: d.channel_id || '',
    };
  }

  if (frame.t === 'MESSAGE_CREATE') {
    // Ignore bots (including ourselves) so answering can't feed itself.
    if (d.author && d.author.bot) return null;
    return {
      kind: 'message',
      text: d.content || '',
      userId: (d.author && d.author.id) || '',
      userName: (d.author && d.author.username) || '',
      channel: d.channel_id || '',
      messageId: d.id,
      // Set when the user used Discord's reply feature, which is how a message
      // is tied back to the specific alert it answers.
      referencedMessageId: (d.message_reference && d.message_reference.message_id) || '',
    };
  }

  return null;
}

// Acknowledge a button click by editing the original message (type 7), so the
// buttons visibly resolve instead of leaving a spinner in the client.
async function respondToInteraction(interactionId, interactionToken, content) {
  const res = await fetch(`${API_BASE}/interactions/${interactionId}/${interactionToken}/callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 7, data: { content, components: [] } }),
  });
  return { ok: res.ok, status: res.status };
}

module.exports = { createDiscordGateway, parseDispatch, respondToInteraction, API_BASE, OP };
