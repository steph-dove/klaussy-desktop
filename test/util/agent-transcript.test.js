require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const t = require('../../main/util/agent-transcript');

function tmpFile(name, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-transcript-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function appendLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

const claudeSay = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('providers without a readable store fall back', () => {
  assert.equal(t.hasReader('claude'), true);
  assert.equal(t.hasReader('codex'), true);
  assert.equal(t.hasReader('gemini'), false);
  assert.equal(t.readNewMessages('gemini', {}), null);
});

test('codex: assistant turns are read, other roles are not', () => {
  const file = tmpFile('rollout-x.jsonl', [
    { type: 'session_meta', payload: { cwd: '/w' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ text: 'system preamble' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Checking the workflow file.' }] } },
    { type: 'event_msg', payload: { type: 'token_count' } },
  ]);
  const r = t.readNewMessages('codex', { transcriptFile: file, cursor: 0 });
  assert.equal(r.text, 'Checking the workflow file.');
  assert.doesNotMatch(r.text, /preamble/, 'the developer prompt is not the agent talking');
});

test('the cursor only returns what is new', () => {
  const file = tmpFile('rollout-y.jsonl', [
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'First.' }] } },
  ]);
  const first = t.readNewMessages('codex', { transcriptFile: file, cursor: 0 });
  assert.equal(first.text, 'First.');

  assert.equal(t.readNewMessages('codex', { transcriptFile: file, cursor: first.cursor }).text, '',
    're-reading the same file says nothing new');

  appendLine(file, { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Second.' }] } });
  const next = t.readNewMessages('codex', { transcriptFile: file, cursor: first.cursor });
  assert.equal(next.text, 'Second.', 'only the appended turn');
});

// Consuming a line the agent is still writing would drop that record for good.
test('a half-written trailing line is left for the next read', () => {
  const file = tmpFile('rollout-z.jsonl', [
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Complete.' }] } },
  ]);
  fs.appendFileSync(file, '{"type":"response_item","payload":{"type":"mess');
  const r = t.readNewMessages('codex', { transcriptFile: file, cursor: 0 });
  assert.equal(r.text, 'Complete.');

  fs.appendFileSync(file, 'age","role":"assistant","content":[{"text":"Torn."}]}}\n');
  assert.equal(t.readNewMessages('codex', { transcriptFile: file, cursor: r.cursor }).text, 'Torn.');
});

test('a shorter file means a different session and restarts the read', () => {
  const file = tmpFile('rollout-r.jsonl', [
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Old and long.' }] } },
  ]);
  const stale = 9999; // cursor past the end of a replaced file
  const r = t.readNewMessages('codex', { transcriptFile: file, cursor: stale });
  assert.equal(r.text, 'Old and long.', 'reads from the start rather than returning nothing forever');
});

test('claude: text is kept and the private scratchpad is not', () => {
  const file = tmpFile('sess.jsonl', [
    { type: 'user', message: { content: 'do a thing' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'the user probably wants X' },
          { type: 'text', text: 'Here is what I found.' },
          { type: 'tool_use', name: 'Bash', input: {} },
        ],
      },
    },
  ]);
  const r = t.readNewMessages('claude', { transcriptFile: file, cursor: 0 });
  assert.equal(r.text, 'Here is what I found.');
  assert.doesNotMatch(r.text, /probably wants/, 'thinking is never posted');
  assert.doesNotMatch(r.text, /Bash/, 'a tool call is not speech');
});

test('claude: several turns arrive separated, not run together', () => {
  const file = tmpFile('multi.jsonl', [claudeSay('First thing.'), claudeSay('Second thing.')]);
  const r = t.readNewMessages('claude', { transcriptFile: file, cursor: 0 });
  assert.equal(r.text, 'First thing.\n\nSecond thing.');
});

test('antigravity: model planner responses are read from jsonl transcript', () => {
  const file = tmpFile('transcript.jsonl', [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'hello' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'I have analyzed the codebase.' },
    { step_index: 2, source: 'MODEL', type: 'VIEW_FILE', content: 'Created At: 2026-08-09T12:00:00-07:00\ncontent of file' },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Here is the fix.' },
  ]);
  const r = t.readNewMessages('antigravity', { transcriptFile: file, cursor: 0 });
  assert.equal(r.text, 'I have analyzed the codebase.\n\nHere is the fix.');
  assert.doesNotMatch(r.text, /Created At/, 'tool output is filtered out');
});

// Verbatim shape from a live session: what the agent asks is not prose on the
// record, it is an ask_question call whose `questions` argument is itself JSON.
test('antigravity: a question and its options are what the agent said', () => {
  const file = tmpFile('transcript.jsonl', [
    {
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-08-09T20:52:03Z',
      thinking: 'the user probably wants a hard one',
      tool_calls: [{
        name: 'ask_question',
        args: {
          questions: JSON.stringify([{
            is_multi_select: false,
            options: ['Merge Sort', 'Quick Sort'],
            question: 'Which sort is O(n log n) worst case?',
          }]),
        },
      }],
    },
  ]);
  const r = t.readNewMessages('antigravity', { transcriptFile: file, cursor: 0 });
  assert.equal(r.text, 'Which sort is O(n log n) worst case?\n\n1. Merge Sort\n2. Quick Sort');
  assert.doesNotMatch(r.text, /probably wants/, 'thinking is never posted');
});

// The jsonl holds only the turn in progress and is rewritten each reply, so a
// position in it is meaningless: the same turn was posted over and over.
test('antigravity: a turn already posted is not posted again when rewritten', () => {
  const file = tmpFile('transcript.jsonl', [
    { source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: 'T1', content: 'First answer.' },
  ]);
  const first = t.readNewMessages('antigravity', { transcriptFile: file, cursor: 0 });
  assert.equal(first.text, 'First answer.');
  assert.equal(t.readNewMessages('antigravity', { transcriptFile: file, cursor: first.cursor }).text, '',
    'the same turn on disk says nothing new');

  // The next reply replaces the file rather than appending to it.
  fs.writeFileSync(file, JSON.stringify(
    { source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: 'T2', content: 'Second answer.' },
  ) + '\n');
  assert.equal(t.readNewMessages('antigravity', { transcriptFile: file, cursor: first.cursor }).text,
    'Second answer.', 'a rewritten file still yields the new turn');
});

// Adopting a conversation already under way must not repeat what it said before
// this session claimed it.
test('antigravity: fromEnd adopts the turn on record without posting it', () => {
  const file = tmpFile('transcript.jsonl', [
    { source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: 'T1', content: 'Said before we bound.' },
  ]);
  const r = t.readNewMessages('antigravity', { transcriptFile: file, cursor: 0, fromEnd: true });
  assert.equal(r.text, '');

  fs.writeFileSync(file, JSON.stringify(
    { source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: 'T2', content: 'Ours.' },
  ) + '\n');
  assert.equal(t.readNewMessages('antigravity', { transcriptFile: file, cursor: r.cursor }).text, 'Ours.');
});

// Resuming appends to the transcript the session already had, so the old turns
// have to go — but by age, or the first thing it says next goes with them.
test('claude: resuming skips the old turns and still reports the first new one', () => {
  const at = (ts, text) => ({ ...claudeSay(text), timestamp: ts });
  const file = tmpFile('resumed.jsonl', [
    at('2026-08-09T10:00:00.000Z', 'Said before the resume.'),
    at('2026-08-09T12:00:00.000Z', 'Said right after it.'),
  ]);
  const spawn = Date.parse('2026-08-09T11:00:00.000Z');
  const r = t.readNewMessages('claude', { transcriptFile: file, cursor: 0, sinceMs: spawn });
  assert.equal(r.text, 'Said right after it.');
});

// A worktree can hold more than one claude session, and the newest flips between
// them; a byte offset measured in one names an arbitrary point in the other.
test('claude: fromEnd adopts a transcript without posting what it already holds', () => {
  const file = tmpFile('other-session.jsonl', [claudeSay('Belongs to another session.')]);
  const r = t.readNewMessages('claude', { transcriptFile: file, cursor: 0, fromEnd: true });
  assert.equal(r.text, '');
  assert.equal(r.cursor, fs.statSync(file).size, 'the cursor is the end of that file');

  appendLine(file, claudeSay('Said after we adopted it.'));
  assert.equal(t.readNewMessages('claude', { transcriptFile: file, cursor: r.cursor }).text,
    'Said after we adopted it.');
});

test('codex: fromEnd adopts a rollout without posting what it already holds', () => {
  const file = tmpFile('rollout-adopt.jsonl', [
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Earlier.' }] } },
  ]);
  const r = t.readNewMessages('codex', { transcriptFile: file, cursor: 0, fromEnd: true });
  assert.equal(r.text, '');
  appendLine(file, { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Later.' }] } });
  assert.equal(t.readNewMessages('codex', { transcriptFile: file, cursor: r.cursor }).text, 'Later.');
});

test('a missing transcript returns null rather than throwing', () => {
  assert.equal(t.readNewMessages('codex', { transcriptFile: '/nope/missing.jsonl', cursor: 0 }), null);
  assert.equal(t.readNewMessages('claude', { worktreePath: '', sessionId: '', cursor: 0 }), null);
  assert.equal(t.readNewMessages('antigravity', { transcriptFile: '/nope/missing.jsonl', cursor: 0 }), null);
});
