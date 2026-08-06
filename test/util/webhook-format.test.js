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
  const evt = { ...COMPLETED, logsTail: 'before ``` after' };
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
