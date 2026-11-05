require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseEnvelope } = require('../../main/util/slack-socket');
const { parseDispatch } = require('../../main/util/discord-gateway');

test('slack: a block_actions envelope yields the action, user and response url', () => {
  const parsed = parseEnvelope({
    type: 'interactive',
    payload: {
      actions: [{ action_id: 'klaussy_approve', value: 'abc123' }],
      user: { id: 'U1', username: 'sam' },
      response_url: 'https://hooks.slack.com/actions/x',
      channel: { id: 'C1' },
    },
  });
  assert.equal(parsed.kind, 'action');
  assert.equal(parsed.actionId, 'klaussy_approve');
  assert.equal(parsed.value, 'abc123');
  assert.equal(parsed.userId, 'U1');
  assert.equal(parsed.responseUrl, 'https://hooks.slack.com/actions/x');
});

test('slack: our own bot posts are ignored so replies cannot loop', () => {
  const fromBot = parseEnvelope({
    type: 'events_api',
    payload: { event: { type: 'message', bot_id: 'B1', text: 'Approved by <@U1>' } },
  });
  assert.equal(fromBot, null);
  // Edits/joins carry a subtype and are not user replies either.
  const edited = parseEnvelope({
    type: 'events_api',
    payload: { event: { type: 'message', subtype: 'message_changed', text: 'x' } },
  });
  assert.equal(edited, null);
});

test('slack: a human threaded reply is parsed with its thread id', () => {
  const parsed = parseEnvelope({
    type: 'events_api',
    payload: { event: { type: 'message', user: 'U1', text: '1', thread_ts: '111.222', ts: '333.444' } },
  });
  assert.equal(parsed.kind, 'message');
  assert.equal(parsed.text, '1');
  assert.equal(parsed.threadTs, '111.222');
});

test('slack: unrelated frames parse to null', () => {
  assert.equal(parseEnvelope(null), null);
  assert.equal(parseEnvelope({ type: 'hello' }), null);
  assert.equal(parseEnvelope({ type: 'interactive', payload: { actions: [] } }), null);
});

test('discord: a button interaction yields custom_id, user and callback ids', () => {
  const parsed = parseDispatch({
    t: 'INTERACTION_CREATE',
    d: {
      type: 3,
      id: 'i1',
      token: 'tok',
      data: { custom_id: 'klaussy_reject:abc123' },
      member: { user: { id: '42', username: 'sam' } },
      channel_id: 'c1',
    },
  });
  assert.equal(parsed.kind, 'action');
  assert.equal(parsed.customId, 'klaussy_reject:abc123');
  assert.equal(parsed.userId, '42');
  assert.equal(parsed.interactionId, 'i1');
  assert.equal(parsed.interactionToken, 'tok');
});

test('discord: non-component interactions are ignored', () => {
  // type 2 = slash command, which this feature does not handle.
  assert.equal(parseDispatch({ t: 'INTERACTION_CREATE', d: { type: 2, id: 'x' } }), null);
});

test('discord: bot messages are ignored, human replies keep their reference', () => {
  assert.equal(parseDispatch({
    t: 'MESSAGE_CREATE', d: { content: 'hi', author: { id: '1', bot: true } },
  }), null);

  const parsed = parseDispatch({
    t: 'MESSAGE_CREATE',
    d: {
      content: 'yes go ahead', id: 'm2', channel_id: 'c1',
      author: { id: '42', username: 'sam' },
      message_reference: { message_id: 'm1' },
    },
  });
  assert.equal(parsed.kind, 'message');
  assert.equal(parsed.text, 'yes go ahead');
  assert.equal(parsed.referencedMessageId, 'm1');
});

// Records every socket opened and lets a test fire a late close like a dead link's.
function fakeWebSocket() {
  const opened = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.closedWith = null;
      opened.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, ev) { for (const fn of this.listeners[type] || []) fn(ev); }
    send() {}
    close(code) { this.closedWith = code ?? 1000; }
  }
  return { FakeSocket, opened };
}

test('discord: reconnect opens a fresh socket and the old one closing later is ignored', () => {
  const { createDiscordGateway } = require('../../main/util/discord-gateway');
  const realWs = global.WebSocket;
  const { FakeSocket, opened } = fakeWebSocket();
  global.WebSocket = FakeSocket;
  const gw = createDiscordGateway({ botToken: 't', onEvent() {}, onStatus() {} });
  try {
    assert.equal(opened.length, 1);
    gw.reconnect();
    assert.equal(opened.length, 2, 'a new socket opens without waiting for the old close');
    assert.equal(opened[0].closedWith, 4000, 'a non-1000 close keeps the session resumable');
    opened[0].emit('close', { code: 1006 });
    assert.equal(opened.length, 2, 'the replaced socket closing does not schedule another');
  } finally {
    gw.close();
    global.WebSocket = realWs;
  }
});

test('slack: reconnect opens a fresh socket and the old one closing later is ignored', async () => {
  const { createSlackSocket } = require('../../main/util/slack-socket');
  const realWs = global.WebSocket;
  const realFetch = global.fetch;
  const { FakeSocket, opened } = fakeWebSocket();
  global.WebSocket = FakeSocket;
  global.fetch = async () => ({ json: async () => ({ ok: true, url: 'wss://example.test/' }) });
  const sock = createSlackSocket({ appToken: 'xapp', onEvent() {}, onStatus() {} });
  const settle = () => new Promise((r) => setImmediate(r));
  try {
    await settle();
    assert.equal(opened.length, 1);
    sock.reconnect();
    await settle();
    assert.equal(opened.length, 2);
    assert.ok(opened[0].closedWith, 'the stale socket is closed');
    opened[0].emit('close', {});
    await settle();
    assert.equal(opened.length, 2, 'the replaced socket closing does not schedule another');
  } finally {
    sock.close();
    global.WebSocket = realWs;
    global.fetch = realFetch;
  }
});

test('discord: a button interaction carries the id of the message it sits on', () => {
  const parsed = parseDispatch({
    t: 'INTERACTION_CREATE',
    d: { type: 3, id: 'i1', token: 'tok', data: { custom_id: 'x' }, user: { id: '1' }, channel_id: 'c1', message: { id: 'm7' } },
  });
  assert.equal(parsed.messageId, 'm7');
});
