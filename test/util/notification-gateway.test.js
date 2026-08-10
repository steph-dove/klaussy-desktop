require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const gateway = require('../../main/util/notification-gateway');
const nemesis = require('../../main/util/nemesis-events');
const { EVENT_TYPES } = nemesis;
const { saveConfig, flushSaveConfig } = require('../../main/util/config');
const threads = require('../../main/util/session-threads');

// A capturing webhook server. Records every POST (path + parsed JSON body) and
// lets a test await the first request whose path contains a marker.
function makeCaptureServer() {
  const requests = [];
  const waiters = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json = null;
      try { json = JSON.parse(body); } catch {}
      const entry = { path: req.url, body: json };
      requests.push(entry);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (req.url.includes(waiters[i].marker)) {
          waiters[i].resolve(entry);
          waiters.splice(i, 1);
        }
      }
      res.writeHead(200);
      res.end('ok');
    });
  });
  return {
    async start() {
      await new Promise((r) => server.listen(0, r));
      this.base = `http://127.0.0.1:${server.address().port}`;
      return this.base;
    },
    waitFor(marker) {
      const hit = requests.find((r) => r.path.includes(marker));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => waiters.push({ marker, resolve }));
    },
    requests,
    close() { return new Promise((r) => server.close(r)); },
  };
}

const APPROVAL = {
  type: EVENT_TYPES.APPROVAL_REQUIRED,
  containerId: '3',
  workspacePath: '/work/x',
  agentName: 'Claude',
  tool: 'file-write',
  logsTail: 'pending write',
};

function cfg(base, over = {}) {
  return {
    enabled: true,
    slackWebhookUrl: base + '/slack',
    discordWebhookUrl: base + '/discord',
    nemesisUrl: '',
    events: { completed: true, failed: true, approvalRequired: true },
    ...over,
  };
}

test('postWebhook resolves with the HTTP status', async () => {
  const srv = makeCaptureServer();
  const base = await srv.start();
  try {
    const { status } = await gateway.postWebhook(base + '/hook', { hello: 'world' });
    assert.equal(status, 200);
    const rec = await srv.waitFor('/hook');
    assert.deepEqual(rec.body, { hello: 'world' });
  } finally {
    await srv.close();
  }
});

// Verification Plan, Test Cases 1 & 2: an approval-required event reaches the
// registered Slack webhook as a formatted block naming the tool.
test('dispatchEvent posts a formatted approval block to Slack and Discord', async () => {
  const srv = makeCaptureServer();
  const base = await srv.start();
  try {
    const results = await gateway.dispatchEvent(APPROVAL, cfg(base));
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.ok), 'both targets returned 2xx');

    const slack = await srv.waitFor('/slack');
    assert.ok(Array.isArray(slack.body.blocks), 'slack payload uses blocks');
    assert.match(JSON.stringify(slack.body), /file-write/, 'names the tool awaiting approval');
    assert.match(JSON.stringify(slack.body), /Approve/, 'offers an approve/reject action');

    const discord = await srv.waitFor('/discord');
    assert.ok(Array.isArray(discord.body.embeds), 'discord payload uses embeds');
    assert.match(JSON.stringify(discord.body), /file-write/);
  } finally {
    await srv.close();
  }
});

// Verification Plan, Test Case 3: final exit states dispatch completion /
// failure with truncated logs.
test('an ended session is announced without a screen dump', async () => {
  const srv = makeCaptureServer();
  const base = await srv.start();
  try {
    await gateway.dispatchEvent({
      type: EVENT_TYPES.COMPLETED,
      containerId: '3',
      sessionName: 'my-task',
      workspacePath: '/work/x',
      agentName: 'Claude',
      exitCode: 0,
      logsTail: 'ESC soup \u001b[?25h and repaint noise',
      sessionId: 'abc-123',
      resumeCommand: 'claude --resume abc-123',
      resumeExact: true,
    }, cfg(base));
    const slack = await srv.waitFor('/slack');
    const flat = JSON.stringify(slack.body);
    assert.match(flat, /my-task/, 'names the session');
    assert.match(flat, /claude --resume abc-123/, 'says how to resume it');
    assert.doesNotMatch(flat, /repaint noise/, 'the mirror already delivered the session');
  } finally {
    await srv.close();
  }
});

test('a muted event type dispatches nothing', async () => {
  const srv = makeCaptureServer();
  const base = await srv.start();
  try {
    const results = await gateway.dispatchEvent(
      APPROVAL,
      cfg(base, { events: { completed: true, failed: true, approvalRequired: false } }),
    );
    assert.deepEqual(results, [], 'no targets posted for a muted type');
    assert.equal(srv.requests.length, 0);
  } finally {
    await srv.close();
  }
});

test('one dead target does not suppress the other', async () => {
  const srv = makeCaptureServer();
  const base = await srv.start();
  try {
    // Discord URL points at a closed port; Slack should still succeed.
    const results = await gateway.dispatchEvent(APPROVAL, cfg(base, {
      discordWebhookUrl: 'http://127.0.0.1:1/discord',
    }));
    const slack = results.find((r) => r.target === 'slack');
    const discord = results.find((r) => r.target === 'discord');
    assert.ok(slack.ok, 'slack delivered');
    assert.equal(discord.ok, false, 'discord failed but did not throw');
    await srv.waitFor('/slack');
  } finally {
    await srv.close();
  }
});

// End-to-end: a published lifecycle event (as instances.js would emit) flows
// through the started gateway to a real webhook, driven entirely by config.
test('ensureStarted wires published events to the configured webhook', async () => {
  const srv = makeCaptureServer();
  const base = await srv.start();
  try {
    saveConfig({
      notificationGateway: {
        slackWebhookUrl: base + '/slack',
        events: { completed: true, failed: true, approvalRequired: true },
      },
    });
    await flushSaveConfig();

    gateway.ensureStarted();
    nemesis.publish({
      type: EVENT_TYPES.APPROVAL_REQUIRED,
      containerId: '99',
      workspacePath: '/work/e2e',
      agentName: 'Claude',
      tool: 'shell-exec',
      logsTail: 'run rm -rf?',
    });

    const slack = await srv.waitFor('/slack');
    assert.match(JSON.stringify(slack.body), /shell-exec/, 'the published tool reached Slack');
  } finally {
    gateway.stop();
    await srv.close();
  }
});

test('a session with its bell off is skipped even when the type is enabled', async () => {
  const srv = makeCaptureServer();
  const base = await srv.start();
  try {
    const results = await gateway.dispatchEvent({ ...APPROVAL, notify: false }, cfg(base));
    assert.deepEqual(results, [], 'no targets posted');
    assert.equal(srv.requests.length, 0, 'nothing hit the wire');
  } finally {
    await srv.close();
  }
});

// A remote Nemesis8 stream has no per-tab bell, so an event that never mentions
// `notify` must still post rather than being silently dropped.
test('an event with no notify field still posts', async () => {
  const srv = makeCaptureServer();
  const base = await srv.start();
  try {
    const results = await gateway.dispatchEvent(APPROVAL, cfg(base));
    assert.ok(results.length > 0 && results.every((r) => r.ok));
  } finally {
    await srv.close();
  }
});

test('normalize defaults notify to true but preserves an explicit false', () => {
  const on = nemesis.normalize({ type: EVENT_TYPES.COMPLETED, containerId: '1' });
  assert.equal(on.notify, true);
  const off = nemesis.normalize({ type: EVENT_TYPES.COMPLETED, containerId: '1', notify: false });
  assert.equal(off.notify, false);
});

// Discord rejects components on a plain channel webhook (HTTP 400), so an
// approval alert would vanish whenever Slack is interactive but Discord is not.
test('buttons only go to the platform that can hear them', async () => {
  const srv = makeCaptureServer();
  const base = await srv.start();
  // The bot post goes to slack.com; stub it so this stays an offline test.
  threads._reset(); // thread state is module-level; don't inherit another test's
  const realFetch = global.fetch;
  const botPosts = [];
  global.fetch = async (url, opts) => {
    botPosts.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, ts: '1.1' }) };
  };
  try {
    await gateway.dispatchEvent(APPROVAL, cfg(base, {
      slackInteractive: true, slackBotToken: 'xoxb-x', slackChannel: 'C1',
      slackWebhookUrl: '', discordInteractive: false,
    }));
    const discord = await srv.waitFor('/discord');
    assert.equal(discord.body.components, undefined,
      'a webhook-only Discord target must not receive components');
    const slackPosts = botPosts.filter((p) => p.url.includes('chat.postMessage'));
    // First post opens the session thread; the alert follows inside it.
    assert.equal(slackPosts.length, 2, 'thread parent + alert');
    assert.ok(!slackPosts[0].body.thread_ts, 'parent is top-level');
    const alert = slackPosts[1];
    assert.equal(alert.body.thread_ts, '1.1', 'alert posted into the session thread');
    assert.ok(alert.body.blocks.some((b) => b.type === 'actions'), 'slack kept its buttons');
    assert.equal(alert.body.reply_broadcast, true, 'an approval is surfaced in-channel too');
  } finally {
    global.fetch = realFetch;
    await srv.close();
  }
});

// A webhook cannot post into a thread and its posts carry no id to reply to, so
// anything it sends is unanswerable. With a bot configured, a webhook url on the
// side used to take every non-approval message down that dead end.
test('an ordinary message goes through the bot, into its session thread', async () => {
  threads._reset();
  const realFetch = global.fetch;
  const posts = [];
  global.fetch = async (url, opts) => {
    posts.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (String(url).endsWith('/threads')) return { ok: true, json: async () => ({ id: 'T5' }) };
    return { ok: true, status: 200, json: async () => ({ id: 'M5' }) };
  };
  try {
    await gateway.dispatchEvent(
      { type: 'agent:message', containerId: '7', workspacePath: '/w/proj', agentName: 'Claude Code', body: 'Done.', notify: true },
      cfg('', {
        events: { completed: true, failed: true, approvalRequired: true, message: true },
        discordInteractive: true, discordBotToken: 'bot-x', discordChannel: 'D1',
        discordWebhookUrl: 'https://discord.com/api/webhooks/should-not-be-used',
        slackInteractive: false, slackBotToken: '', slackChannel: '', slackWebhookUrl: '',
      }),
    );
    assert.ok(!posts.some((p) => p.url.includes('/webhooks/')), 'the webhook was not used');
    assert.ok(posts.some((p) => p.url.endsWith('/channels/T5/messages')),
      'the message landed in the session thread');
  } finally {
    global.fetch = realFetch;
  }
});

// An alert posts flat in the channel when the bot can't open threads, so a
// channel-level reply has no thread to identify — the one live session is it.
test('a channel reply with nothing to match reaches the only live session', async () => {
  const { instances } = require('../../main/state/instances');
  const threads = require('../../main/util/session-threads');
  threads._reset();
  const written = [];
  instances.set(8801, {
    id: 8801, name: 't', alive: true, mode: 'claude', originalMode: 'claude',
    notifyWebhookEnabled: true, spawnTime: 1, pty: { write: (d) => written.push(d) },
  });
  try {
    saveConfig({ notificationGateway: { allowList: ['U1'], discordChannel: 'DCHAN' } });
    await flushSaveConfig();
    gateway.handleDiscordFrame({
      kind: 'message', text: 'give me a new one', userId: 'U1',
      channel: 'DCHAN', messageId: 'm9', referencedMessageId: 'never-seen',
    });
    assert.ok(written.join('').includes('give me a new one'),
      'the reply reached the agent despite matching no thread or message');
  } finally {
    instances.delete(8801);
  }
});

// A restart empties the thread map, leaving every earlier thread unrecognised.
// Answering them from whatever is running now types into a session that never
// asked the question — which is what the user sees as a thread coming alive.
test('a reply in an unrecognised thread reaches nothing', async () => {
  const { instances } = require('../../main/state/instances');
  const threads = require('../../main/util/session-threads');
  threads._reset();
  const written = [];
  instances.set(8804, {
    id: 8804, name: 't', alive: true, mode: 'claude', originalMode: 'claude',
    notifyWebhookEnabled: true, spawnTime: 1, pty: { write: (d) => written.push(d) },
  });
  try {
    saveConfig({ notificationGateway: { allowList: ['U1'], discordChannel: 'DCHAN' } });
    await flushSaveConfig();
    gateway.handleDiscordFrame({
      kind: 'message', text: 'b', userId: 'U1',
      channel: 'some-old-thread', messageId: 'm9', referencedMessageId: 'never-seen',
    });
    assert.deepEqual(written, [], 'an orphaned thread drives no session at all');
  } finally {
    instances.delete(8804);
  }
});

test('with two sessions running it asks rather than guessing', () => {
  const { instances } = require('../../main/state/instances');
  const written = [];
  for (const id of [8802, 8803]) {
    instances.set(id, {
      id, name: 't' + id, alive: true, mode: 'claude', originalMode: 'claude',
      notifyWebhookEnabled: true, spawnTime: id, pty: { write: (d) => written.push(d) },
    });
  }
  try {
    gateway.handleDiscordFrame({
      kind: 'message', text: 'which one', userId: 'U1',
      channel: 'DCHAN', messageId: 'm', referencedMessageId: 'none',
    });
    assert.deepEqual(written, [], 'ambiguity is never resolved by picking one');
  } finally {
    instances.delete(8802);
    instances.delete(8803);
  }
});
