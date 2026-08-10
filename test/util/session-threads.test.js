require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const threads = require('../../main/util/session-threads');

const CFG = {
  slackBotToken: 'xoxb-x', slackChannel: 'C1',
  discordBotToken: 'bot-x', discordChannel: 'D1',
};

const EVENT = {
  containerId: '7', workspacePath: '/work/auth-refactor',
  sessionBranch: 'add-oauth', agentName: 'Claude',
};

function stubFetch(handler) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return handler(String(url), calls.length);
  };
  return { calls, restore() { global.fetch = real; } };
}

const okJson = (obj) => ({ ok: true, status: 200, json: async () => obj });

test('sessionLabel names the session, its repo and the agent, capped for Discord', () => {
  assert.equal(threads.sessionLabel(EVENT), 'add-oauth · auth-refactor (Claude)');
  assert.equal(threads.sessionLabel({ ...EVENT, agentName: 'Antigravity CLI' }),
    'add-oauth · auth-refactor (Antigravity CLI)');
  assert.equal(threads.sessionLabel({ ...EVENT, sessionBranch: 'other-work' }),
    'other-work · auth-refactor (Claude)');

  assert.equal(threads.sessionLabel({ workspacePath: '/work/solo', agentName: 'Codex' }),
    'solo (Codex)', 'a session with no name of its own still says where it is');
  assert.equal(threads.sessionLabel({ agentName: 'Codex' }), 'Codex');
  const long = threads.sessionLabel({ workspacePath: '/w/' + 'x'.repeat(200), agentName: 'A' });
  assert.ok(long.length <= 90, 'stays under the 100-char thread name limit');
});

test('slack: one thread per session, reused by later alerts', async () => {
  threads._reset();
  const f = stubFetch(() => okJson({ ok: true, ts: '111.222' }));
  try {
    const first = await threads.ensureSlackThread(CFG, EVENT);
    const second = await threads.ensureSlackThread(CFG, EVENT);
    assert.equal(first, '111.222');
    assert.equal(second, '111.222');
    assert.equal(f.calls.length, 1, 'parent posted once, not per alert');
    assert.equal(threads.taskForSlackThread('111.222'), '7');
  } finally {
    f.restore();
  }
});

// Two alerts can land together (an approval prompt right as the agent exits);
// without a guard each would open its own thread for the same session.
test('slack: concurrent alerts do not open two threads', async () => {
  threads._reset();
  let n = 0;
  const f = stubFetch(async () => {
    n += 1;
    await new Promise((r) => setTimeout(r, 5)); // let the second call overlap
    return okJson({ ok: true, ts: 'ts-' + n });
  });
  try {
    const [a, b] = await Promise.all([
      threads.ensureSlackThread(CFG, EVENT),
      threads.ensureSlackThread(CFG, EVENT),
    ]);
    assert.equal(a, b, 'both alerts share one thread');
    assert.equal(f.calls.length, 1, 'only one parent message posted');
  } finally {
    f.restore();
  }
});

test('discord: anchor message then a thread hung off it', async () => {
  threads._reset();
  const f = stubFetch((url) => {
    if (url.endsWith('/threads')) return okJson({ id: 'T99' });
    return okJson({ id: 'M1' });
  });
  try {
    const id = await threads.ensureDiscordThread(CFG, EVENT);
    assert.equal(id, 'T99');
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls[0].url.endsWith('/channels/D1/messages'), 'anchor in the channel');
    assert.ok(f.calls[1].url.endsWith('/messages/M1/threads'), 'thread hangs off the anchor');
    assert.equal(f.calls[1].body.name, 'add-oauth · auth-refactor (Claude)');
    assert.equal(threads.taskForDiscordThread('T99'), '7');
  } finally {
    f.restore();
  }
});

test('a failed thread creation returns empty rather than throwing', async () => {
  threads._reset();
  const f = stubFetch(() => ({ ok: false, status: 403, json: async () => ({}), text: async () => 'no' }));
  try {
    assert.equal(await threads.ensureDiscordThread(CFG, EVENT), '');
    const slackFail = stubFetch(() => okJson({ ok: false, error: 'not_in_channel' }));
    try {
      assert.equal(await threads.ensureSlackThread(CFG, EVENT), '');
    } finally {
      slackFail.restore();
    }
  } finally {
    f.restore();
  }
});

test('forgetTask stops the thread routing anywhere', async () => {
  threads._reset();
  const f = stubFetch(() => okJson({ ok: true, ts: '5.5' }));
  try {
    await threads.ensureSlackThread(CFG, EVENT);
    assert.equal(threads.taskForSlackThread('5.5'), '7');
    threads.forgetTask(7); // instances.js passes a number
    assert.equal(threads.taskForSlackThread('5.5'), undefined);
  } finally {
    f.restore();
  }
});

test('an event with no session id gets no thread', async () => {
  threads._reset();
  assert.equal(await threads.ensureSlackThread(CFG, { agentName: 'X' }), '');
  assert.equal(await threads.ensureDiscordThread(CFG, { agentName: 'X' }), '');
});

// The thread stays in the channel across a restart, but the instance id it was
// opened against does not. Replying in it then reached nothing at all.
test('a thread survives the restart that forgot it', async () => {
  threads._reset();
  const { instances } = require('../../main/state/instances');
  const f = stubFetch((url) => (url.endsWith('/threads') ? okJson({ id: 'T77' }) : okJson({ id: 'M1' })));
  try {
    await threads.ensureDiscordThread(CFG, { ...EVENT, agentName: 'Claude Code' });
    await require('../../main/util/config').flushSaveConfig();
    // Losing the in-memory map is exactly what a restart does.
    threads._reset();
    assert.equal(threads.taskForDiscordThread('T77'), undefined);

    instances.set(9001, {
      id: 9001, alive: true, mode: 'claude', originalMode: 'claude',
      worktreePath: '/work/auth-refactor', pty: { write: () => {} },
    });
    try {
      assert.equal(threads.reattachThread('T77'), '9001',
        'the thread reattaches to what is running in that session now');
    } finally {
      instances.delete(9001);
    }
  } finally {
    f.restore();
  }
});

test('a thread whose session is gone reattaches to nothing', async () => {
  threads._reset();
  const f = stubFetch((url) => (url.endsWith('/threads') ? okJson({ id: 'T78' }) : okJson({ id: 'M1' })));
  try {
    await threads.ensureDiscordThread(CFG, { ...EVENT, agentName: 'Claude Code' });
    await require('../../main/util/config').flushSaveConfig();
    threads._reset();
    assert.equal(threads.reattachThread('T78'), '', 'no session, no routing');
    assert.equal(threads.reattachThread('never-opened'), '');
  } finally {
    f.restore();
  }
});

// A rejection here used to reject the whole dispatch, taking the Discord post
// down with it: being offline should cost one thread, not every alert.
test('a network failure opening a slack thread does not sink the dispatch', async () => {
  threads._reset();
  const real = global.fetch;
  global.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND slack.com'); };
  try {
    const ts = await threads.ensureSlackThread(CFG, EVENT);
    assert.equal(ts, '', 'resolves empty so the caller posts flat');
  } finally {
    global.fetch = real;
  }
});
