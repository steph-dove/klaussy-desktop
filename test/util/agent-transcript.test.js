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

test('a missing transcript returns null rather than throwing', () => {
  assert.equal(t.readNewMessages('codex', { transcriptFile: '/nope/missing.jsonl', cursor: 0 }), null);
  assert.equal(t.readNewMessages('claude', { worktreePath: '', sessionId: '', cursor: 0 }), null);
});
