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
      step_index: 0,
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

// The store accumulates (measured: 1039 rows, step_index 0-1038, monotonic).
// Deduping on a digest of the first 4000 characters froze once a conversation
// passed 4000 characters, and the session went silent for good.
const agySay = (step_index, content) => ({ step_index, source: 'MODEL', type: 'PLANNER_RESPONSE', content });

test('antigravity: only what was said after the cursor is posted', () => {
  const file = tmpFile('transcript.jsonl', [agySay(0, 'First answer.')]);
  const first = t.readNewMessages('antigravity', { transcriptFile: file, cursor: 0 });
  assert.equal(first.text, 'First answer.');
  assert.equal(t.readNewMessages('antigravity', { transcriptFile: file, cursor: first.cursor }).text, '',
    'nothing new to say');

  appendLine(file, agySay(1, 'Second answer.'));
  const next = t.readNewMessages('antigravity', { transcriptFile: file, cursor: first.cursor });
  assert.equal(next.text, 'Second answer.', 'the new turn only, not the conversation');
});

// A digest of the head stops changing once a conversation is long enough, which
// is what silenced it; and the head is the wrong half to keep, since a question
// and its numbered options sit at the end of a turn.
test('antigravity: a long conversation keeps saying new things, and keeps the end', () => {
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(agySay(i, `Paragraph ${i}. ` + 'x'.repeat(200)));
  const file = tmpFile('transcript.jsonl', lines);
  const first = t.readNewMessages('antigravity', { transcriptFile: file, cursor: 0 });
  assert.ok(first.text.length > 0, 'a conversation past 4000 chars still reports');
  assert.match(first.text, /Paragraph 59/, 'the end is kept, not the opening');

  appendLine(file, agySay(60, 'Which option do you want?'));
  const next = t.readNewMessages('antigravity', { transcriptFile: file, cursor: first.cursor });
  assert.equal(next.text, 'Which option do you want?', 'and the next turn still arrives');
});

// protobuf-scan's contract: a miss means "cannot read this", never "the agent
// said nothing". Reporting silence would suppress the screen fallback and leave
// the session permanently mute after any upstream rename.
test('antigravity: an unrecognised record shape falls back rather than reporting silence', () => {
  const file = tmpFile('transcript.jsonl', [
    { step_index: 0, source: 'MODEL', type: 'RENAMED_UPSTREAM', content: 'Something it said.' },
    { step_index: 1, source: 'SYSTEM', type: 'CONVERSATION_HISTORY' },
  ]);
  assert.equal(t.readNewMessages('antigravity', { transcriptFile: file, cursor: 0 }), null,
    'null, so the caller falls back to the screen');
});

// Adopting a conversation already under way must not repeat what it said before
// this session claimed it.
test('antigravity: fromEnd adopts the conversation without posting it', () => {
  const file = tmpFile('transcript.jsonl', [agySay(0, 'Said before we bound.')]);
  const r = t.readNewMessages('antigravity', { transcriptFile: file, cursor: 0, fromEnd: true });
  assert.equal(r.text, '');

  appendLine(file, agySay(1, 'Ours.'));
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
