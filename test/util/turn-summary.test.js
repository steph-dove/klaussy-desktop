require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  condenseTurn, isShort, summaryPrompt, cleanSummary, fallbackExcerpt, clipInput,
} = require('../../main/util/turn-summary');
const { saveConfig } = require('../../main/util/config');
const nemesisEvents = require('../../main/util/nemesis-events');
const { publishTurn, setDeps } = require('../../main/state/instances');

const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i} of what the agent printed while it worked.`).join('\n');

test('isShort: a few lines pass through, a long turn does not', () => {
  assert.equal(isShort('Done. Tests pass.'), true);
  assert.equal(isShort(LONG), false);
  assert.equal(isShort('a\nb\nc\nd\ne\nf\ng'), false);
});

test('condenseTurn: short turns skip the summarizer', async () => {
  let called = false;
  const out = await condenseTurn('Pushed the fix.', { summarize: async () => { called = true; return 'x'; } });
  assert.equal(out, 'Pushed the fix.');
  assert.equal(called, false);
});

test('condenseTurn: long turns post the cleaned summary', async () => {
  let seen = null;
  const out = await condenseTurn(LONG, {
    agentName: 'Claude',
    mode: 'claude',
    summarize: async (prompt, mode) => { seen = { prompt, mode }; return "Here's the summary:\n\nNeeds you: pick 1 or 2."; },
  });
  assert.equal(out, 'Needs you: pick 1 or 2.');
  assert.equal(seen.mode, 'claude');
  assert.match(seen.prompt, /Claude/);
  assert.match(seen.prompt, /Line 39 of what/);
});

test('condenseTurn: an empty or failing summarizer falls back to the tail', async () => {
  for (const summarize of [async () => '', async () => { throw new Error('boom'); }, undefined]) {
    const out = await condenseTurn(LONG, { summarize });
    assert.match(out, /Line 39 of what/);
    assert.doesNotMatch(out, /Line 0 of what/);
    assert.match(out, /Full output in Klaussy/);
  }
});

test('cleanSummary: unwraps a fence and caps the length', () => {
  assert.equal(cleanSummary('```markdown\nDid the thing.\n```'), 'Did the thing.');
  const capped = cleanSummary('x'.repeat(2000));
  assert.ok(capped.length <= 901);
  assert.ok(capped.endsWith('…'));
});

test('clipInput: keeps the start and the end of a huge turn', () => {
  const big = `START\n${'y'.repeat(30000)}\nEND`;
  const clipped = clipInput(big);
  assert.ok(clipped.length < 13000);
  assert.ok(clipped.startsWith('START'));
  assert.ok(clipped.endsWith('END'));
});

test('summaryPrompt: asks for what the agent needs first', () => {
  assert.match(summaryPrompt('text', 'Copilot'), /Needs you:/);
});

test('fallbackExcerpt: leaves short text alone', () => {
  assert.equal(fallbackExcerpt('short'), 'short');
});

function capturePublishes() {
  const posted = [];
  const orig = nemesisEvents.publish;
  nemesisEvents.publish = (e) => { posted.push(e); };
  return { posted, restore: () => { nemesisEvents.publish = orig; } };
}

test('publishTurn: posts turns in the order they happened when the first summary is slower', async () => {
  await saveConfig({ notificationGateway: { slackWebhookUrl: 'https://example.invalid/hook' } });
  const delays = [40, 0];
  let n = 0;
  setDeps({
    summarize: (prompt) => new Promise((resolve) => {
      const i = n++;
      setTimeout(() => resolve(`summary ${i}${prompt.includes('FIRST') ? ' first' : ' second'}`), delays[i]);
    }),
  });
  const cap = capturePublishes();
  try {
    const target = {};
    const fields = { containerId: 't1', sessionName: 's', agentName: 'Claude' };
    publishTurn(target, `FIRST\n${LONG}`, fields, { mode: 'claude', live: () => true });
    await publishTurn(target, `SECOND\n${LONG}`, fields, { mode: 'claude', live: () => true });
    assert.deepEqual(cap.posted.map((e) => e.body), ['summary 0 first', 'summary 1 second']);
    assert.equal(cap.posted[0].type, nemesisEvents.EVENT_TYPES.MESSAGE);
    assert.equal(cap.posted[0].containerId, 't1');
  } finally {
    cap.restore();
  }
});

test('publishTurn: drops a summary that lands after the bell went off', async () => {
  await saveConfig({ notificationGateway: { slackWebhookUrl: 'https://example.invalid/hook' } });
  setDeps({ summarize: async () => 'late summary' });
  const cap = capturePublishes();
  try {
    let bell = true;
    const pending = publishTurn({}, LONG, { containerId: 't2' }, { mode: 'claude', live: () => bell });
    bell = false;
    await pending;
    assert.equal(cap.posted.length, 0);
  } finally {
    cap.restore();
  }
});

test('publishTurn: posts in full when summaries are turned off', async () => {
  await saveConfig({ notificationGateway: { slackWebhookUrl: 'https://example.invalid/hook', summarizeMessages: false } });
  setDeps({ summarize: async () => 'should not be used' });
  const cap = capturePublishes();
  try {
    await publishTurn({}, LONG, { containerId: 't3' }, { mode: 'claude', live: () => true });
    assert.equal(cap.posted[0].body, LONG);
  } finally {
    cap.restore();
  }
});
