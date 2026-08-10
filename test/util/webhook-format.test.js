require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatSlack, formatDiscord, truncateLogs } = require('../../main/util/webhook-format');
const { EVENT_TYPES } = require('../../main/util/nemesis-events');

const APPROVAL = {
  type: EVENT_TYPES.APPROVAL_REQUIRED,
  containerId: '7',
  workspacePath: '/work/feature-x',
  agentName: 'Claude',
  tool: 'file-write',
  logsTail: 'about to write config.js',
};

const COMPLETED = {
  type: EVENT_TYPES.COMPLETED,
  containerId: '7',
  workspacePath: '/work/feature-x',
  agentName: 'Claude',
  exitCode: 0,
  logsTail: 'done',
};

const FAILED = { ...COMPLETED, type: EVENT_TYPES.FAILED, exitCode: 1, logsTail: 'boom' };

function slackText(payload) {
  // Flatten every string in the blocks so a test can assert on rendered content
  // without coupling to the exact block nesting.
  return JSON.stringify(payload);
}

test('slack approval payload names the tool and offers approve/reject', () => {
  const p = formatSlack(APPROVAL);
  assert.ok(Array.isArray(p.blocks) && p.blocks.length, 'expected slack blocks');
  const flat = slackText(p);
  assert.match(flat, /file-write/, 'tool name present');
  assert.match(flat, /approval/i, 'mentions approval');
  assert.match(flat, /Approve/, 'offers Approve');
  assert.match(flat, /Reject/, 'offers Reject');
  assert.match(flat, /\/work\/feature-x/, 'workspace path present');
  assert.match(p.text, /Claude/, 'fallback text names the agent');
});

test('slack completed vs failed reflect status and exit code', () => {
  assert.match(slackText(formatSlack(COMPLETED)), /completed/i);
  const failed = slackText(formatSlack(FAILED));
  assert.match(failed, /failed/i);
  assert.match(failed, /exit 1/, 'failure includes exit code');
});

test('discord approval embed carries tool, workspace, and color', () => {
  const p = formatDiscord(APPROVAL);
  assert.ok(Array.isArray(p.embeds) && p.embeds.length === 1, 'one embed');
  const embed = p.embeds[0];
  assert.equal(typeof embed.color, 'number', 'embed has a color');
  const flat = JSON.stringify(p);
  assert.match(flat, /file-write/);
  assert.match(flat, /Approve/);
  assert.match(flat, /\/work\/feature-x/);
});

test('discord failed embed differs in color from completed', () => {
  const ok = formatDiscord(COMPLETED).embeds[0].color;
  const bad = formatDiscord(FAILED).embeds[0].color;
  assert.notEqual(ok, bad, 'completed and failed should be visually distinct');
});

test('truncateLogs keeps the tail and marks truncation', () => {
  const big = 'x'.repeat(50) + 'TAIL_MARKER';
  const out = truncateLogs(big, 20);
  assert.ok(out.length < big.length, 'shortened');
  assert.match(out, /TAIL_MARKER/, 'keeps the end of the log');
  assert.match(out, /truncated/i, 'flags truncation');
});

test('truncateLogs leaves short logs untouched', () => {
  assert.equal(truncateLogs('short', 100), 'short');
  assert.equal(truncateLogs('', 100), '');
  assert.equal(truncateLogs(null, 100), '');
});

test('a very long tool name never overflows the slack header limit', () => {
  const p = formatSlack({
    ...APPROVAL,
    tool: 'run ' + 'x'.repeat(500), // pathologically long command
  });
  const header = p.blocks.find((b) => b.type === 'header');
  assert.ok(header, 'has a header block');
  assert.ok(header.text.text.length <= 150, `slack header must be <=150, was ${header.text.text.length}`);
  // The long tool still shows up in full, just in the fields (no length cap).
  assert.match(JSON.stringify(p), /xxxxx/, 'tool detail preserved in fields');
});

test('triple backticks in logs cannot break the code fence', () => {
  // An approval still carries its screen; an ended session deliberately doesn't.
  // Needs enough real words to survive the chrome filter.
  const evt = {
    ...APPROVAL,
    logsTail: 'the agent wrote before ``` here\nand carried on after that line',
  };
  // The log section is the block whose text is fenced with ```.
  const section = formatSlack(evt).blocks.find(
    (b) => b.text && typeof b.text.text === 'string' && b.text.text.startsWith('```'),
  );
  assert.ok(section, 'found the fenced log block');
  const inner = section.text.text.slice(3, -3); // strip the outer ``` fences
  assert.ok(inner.includes('before') && inner.includes('after'), 'log content preserved');
  assert.ok(!inner.includes('```'), 'no bare ``` run left inside the fenced body');
  assert.doesNotThrow(() => formatDiscord(evt));
});

test('missing optional fields do not crash formatting', () => {
  const bare = { type: EVENT_TYPES.COMPLETED, containerId: '', workspacePath: '', agentName: '' };
  assert.doesNotThrow(() => formatSlack(bare));
  assert.doesNotThrow(() => formatDiscord(bare));
});

test('an approval token turns the alert into real Approve/Reject buttons', () => {
  const evt = { ...APPROVAL, approvalToken: 'tok123' };

  const slack = formatSlack(evt);
  const actions = slack.blocks.find((b) => b.type === 'actions');
  assert.ok(actions, 'slack gets an actions block');
  assert.deepEqual(actions.elements.map((e) => e.action_id), ['klaussy_approve', 'klaussy_reject']);
  assert.ok(actions.elements.every((e) => e.value === 'tok123'), 'both carry the token');

  const discord = formatDiscord(evt);
  assert.ok(Array.isArray(discord.components), 'discord gets components');
  const buttons = discord.components[0].components;
  assert.deepEqual(buttons.map((b) => b.custom_id),
    ['klaussy_approve:tok123', 'klaussy_reject:tok123']);
  assert.ok(buttons.every((b) => b.custom_id.length <= 100), 'within discord custom_id limit');
});

test('without a token the alert stays read-only and says so', () => {
  const slack = formatSlack(APPROVAL);
  assert.equal(slack.blocks.find((b) => b.type === 'actions'), undefined, 'no dead buttons');
  assert.match(JSON.stringify(slack), /Respond in Klaussy/);

  const discord = formatDiscord(APPROVAL);
  assert.equal(discord.components, undefined);
  assert.match(JSON.stringify(discord), /Respond in Klaussy/);
});

test('completed/failed alerts never get approval buttons', () => {
  const evt = { ...COMPLETED, approvalToken: 'tok123' };
  assert.equal(formatSlack(evt).blocks.find((b) => b.type === 'actions'), undefined);
  assert.equal(formatDiscord(evt).components, undefined);
});

const ENDED = {
  ...COMPLETED,
  sessionName: 'auth-refactor',
  sessionId: 'abc-123',
  resumeCommand: 'claude --resume abc-123',
  resumeExact: true,
};

test('an ended session says how to pick it back up', () => {
  const flat = JSON.stringify(formatSlack(ENDED));
  assert.match(flat, /auth-refactor/, 'names the Klaussy session');
  assert.match(flat, /abc-123/, 'shows the agent session id');
  assert.match(flat, /cd \/work\/feature-x/, 'cd to the worktree first');
  assert.match(flat, /claude --resume abc-123/, 'the provider resume command');
  assert.match(flat, /Pick it back up/);

  const discord = JSON.stringify(formatDiscord(ENDED));
  assert.match(discord, /claude --resume abc-123/);
  assert.match(discord, /cd \/work\/feature-x/);
});

// Without a session id nothing guarantees the same conversation returns, so the
// command is offered as a fresh start rather than described as a resume.
test('no session id is offered as a fresh start, not a resume', () => {
  const noId = {
    ...COMPLETED,
    sessionName: 'x',
    resumeCommand: 'claude',
    resumeExact: false,
  };
  const flat = JSON.stringify(formatSlack(noId));
  assert.doesNotMatch(flat, /Pick it back up/, 'does not promise a restore');
  assert.match(flat, /Start it again/);
  assert.match(flat, /cd \/work\/feature-x/, 'still tells you where to run it');
});

test('an approval alert carries no restart block', () => {
  const flat = JSON.stringify(formatSlack({ ...APPROVAL, ...ENDED, type: EVENT_TYPES.APPROVAL_REQUIRED }));
  // The session hasn't ended, so telling someone how to restart it is noise.
  assert.doesNotMatch(flat, /Pick it back up|Start it again/);
});

test('a stale alert says how long it has been quiet', () => {
  const stale = {
    type: EVENT_TYPES.STALE,
    containerId: '7',
    sessionName: 'auth-refactor',
    workspacePath: '/work/feature-x',
    agentName: 'Claude',
    quietMs: 180000,
    logsTail: 'Here is a long summary you should read.\nIt continues onto a second line of prose.',
  };
  const flat = JSON.stringify(formatSlack(stale));
  assert.match(flat, /gone quiet/);
  assert.match(flat, /no output for 3m/);
  assert.match(flat, /auth-refactor/);
  assert.match(flat, /long summary/, 'carries the output waiting to be read');
  // It has not ended, so restart steps would be wrong.
  assert.doesNotMatch(flat, /Pick it back up|Start it again/);

  assert.match(JSON.stringify(formatDiscord(stale)), /no output for 3m/);
});

test('a stale alert under a minute reports seconds', () => {
  const flat = JSON.stringify(formatSlack({
    type: EVENT_TYPES.STALE, containerId: '1', agentName: 'Codex', quietMs: 45000,
  }));
  assert.match(flat, /no output for 45s/);
});

test('a stale alert with no duration still renders', () => {
  assert.doesNotThrow(() => formatSlack({ type: EVENT_TYPES.STALE, containerId: '1' }));
  assert.doesNotMatch(JSON.stringify(formatSlack({ type: EVENT_TYPES.STALE, containerId: '1' })), /no output for/);
});

test('an unreadable menu gets no buttons rather than useless ones', () => {
  const evt = { ...APPROVAL, approvalToken: 'tok', options: [], menuPrompt: true };
  const slack = formatSlack(evt);
  assert.equal(slack.blocks.find((b) => b.type === 'actions'), undefined);
  assert.equal(formatDiscord(evt).components, undefined);
});

test('a plain y/n prompt still gets Approve and Reject', () => {
  const evt = { ...APPROVAL, approvalToken: 'tok', options: [], menuPrompt: false };
  const actions = formatSlack(evt).blocks.find((b) => b.type === 'actions');
  assert.deepEqual(actions.elements.map((e) => e.action_id), ['klaussy_approve', 'klaussy_reject']);
  assert.equal(formatDiscord(evt).components[0].components.length, 2);
});

// Captured from a live Antigravity screen: rules, prompts and a half-typed word.
test('an unreadable screen is not pasted into the alert', () => {
  const screen = [
    '────────────', '>', '────────────',
    '(Google AI Pro)', 's', '', '  ⋮  Generating...',
    'esc to cancel', 'Gemini 3.6 Flash · high',
  ].join('\n');
  const flat = JSON.stringify(formatSlack({ ...APPROVAL, promptQuestion: '', logsTail: screen }));
  assert.doesNotMatch(flat, /Google AI Pro|esc to cancel|Generating/, 'no framebuffer');
  assert.match(flat, /waiting for approval/, 'it still says what happened');
});

test('a multi-select prompt renders choice buttons and hints without approve/reject fallback', () => {
  const evt = {
    ...APPROVAL,
    approvalToken: 'tok',
    options: [
      { key: '1', label: 'Feature A' },
      { key: '2', label: 'Feature B' },
    ],
    menuPrompt: true,
    isMultiSelect: true,
  };
  const slack = formatSlack(evt);
  const actions = slack.blocks.find((b) => b.type === 'actions');
  assert.equal(actions.elements.length, 2);
  assert.equal(actions.elements[0].text.text, '1. Feature A');
  assert.match(JSON.stringify(slack), /Select choices by clicking buttons/);

  const discord = formatDiscord(evt);
  assert.equal(discord.components[0].components.length, 2);
  assert.match(JSON.stringify(discord), /Select choices below or reply in chat/);
});

test('a screen with real prose is still worth showing', () => {
  const screen = [
    'I found three issues in the design spec.',
    'The first is a missing token in the light preset.',
  ].join('\n');
  assert.match(
    JSON.stringify(formatSlack({ ...APPROVAL, promptQuestion: '', logsTail: screen })),
    /three issues/,
  );
});
