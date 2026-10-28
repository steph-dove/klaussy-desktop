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
  assert.equal(t.hasReader('nemesis8'), false);
  assert.equal(t.readNewMessages('nemesis8', {}), null);
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

function opencodeDb(rows) {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-opencode-'));
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec('create table message (id TEXT, session_id TEXT, data TEXT)');
  db.exec('create table part (id TEXT, message_id TEXT, session_id TEXT, data TEXT)');
  let n = 0;
  for (const [role, parts] of rows) {
    const mid = 'msg_' + (++n);
    db.prepare('insert into message (id, session_id, data) values (?, ?, ?)')
      .run(mid, 'ses_x', JSON.stringify({ role }));
    for (const part of parts) {
      db.prepare('insert into part (id, message_id, session_id, data) values (?, ?, ?, ?)')
        .run('prt_' + (++n), mid, 'ses_x', JSON.stringify(part));
    }
  }
  db.close();
  return file + '#ses_x';
}

test('opencode: assistant text is read and its reasoning is not', () => {
  const src = opencodeDb([
    ['user', [{ type: 'text', text: 'read a.txt' }]],
    ['assistant', [
      { type: 'reasoning', text: 'The user wants me to read a file. Let me think.' },
      { type: 'step-start' },
      { type: 'text', text: 'The file says hello.' },
    ]],
  ]);
  const r = t.readNewMessages('opencode', { transcriptFile: src, cursor: 0 });
  assert.equal(r.text, 'The file says hello.');
  assert.doesNotMatch(r.text, /Let me think/, 'reasoning is the scratchpad, never posted');
  assert.doesNotMatch(r.text, /read a\.txt/, 'the user is not the agent talking');
});

test('opencode: the cursor returns only what is new', () => {
  const src = opencodeDb([['assistant', [{ type: 'text', text: 'First.' }]]]);
  const first = t.readNewMessages('opencode', { transcriptFile: src, cursor: 0 });
  assert.equal(first.text, 'First.');
  assert.equal(t.readNewMessages('opencode', { transcriptFile: src, cursor: first.cursor }).text, '');
});

test('opencode: a turn with no spoken text is silence, not a failure', () => {
  const src = opencodeDb([['assistant', [{ type: 'step-start' }, { type: 'step-finish' }]]]);
  const r = t.readNewMessages('opencode', { transcriptFile: src, cursor: 0 });
  assert.equal(r.text, '');
  assert.notEqual(r, null, 'a readable store with nothing said still answers');
});

test('opencode: fromEnd adopts the session without posting it', () => {
  const src = opencodeDb([['assistant', [{ type: 'text', text: 'Said before we bound.' }]]]);
  const r = t.readNewMessages('opencode', { transcriptFile: src, cursor: 0, fromEnd: true });
  assert.equal(r.text, '');
  assert.ok(r.cursor > 0, 'but the position is taken');
});

test('a missing transcript returns null rather than throwing', () => {
  assert.equal(t.readNewMessages('codex', { transcriptFile: '/nope/missing.jsonl', cursor: 0 }), null);
  assert.equal(t.readNewMessages('claude', { worktreePath: '', sessionId: '', cursor: 0 }), null);
  assert.equal(t.readNewMessages('antigravity', { transcriptFile: '/nope/missing.jsonl', cursor: 0 }), null);
});

const copilotSay = (content, timestamp) => ({
  type: 'assistant.message', timestamp, data: { content, toolRequests: [] },
});

test('copilot: assistant messages are read, prompts and tool-only turns are not', () => {
  const file = tmpFile('events.jsonl', [
    { type: 'session.start', data: { context: { cwd: '/w' } } },
    { type: 'system.message', data: { role: 'system', content: 'You are the GitHub Copilot CLI' } },
    { type: 'user.message', data: { content: 'fix the bug' } },
    { type: 'assistant.message', data: { content: '', toolRequests: [{ name: 'bash' }] } },
    copilotSay('Fixed it; the suite passes.'),
  ]);
  const r = t.readNewMessages('copilot', { transcriptFile: file, cursor: 0 });
  assert.equal(r.text, 'Fixed it; the suite passes.');
  appendLine(file, copilotSay('Anything else?'));
  assert.equal(t.readNewMessages('copilot', { transcriptFile: file, cursor: r.cursor }).text, 'Anything else?');
});

test('copilot: a resumed session skips what the earlier run said', () => {
  const file = tmpFile('events.jsonl', [
    copilotSay('From last week.', '2026-01-01T00:00:00.000Z'),
    copilotSay('From this run.', '2026-06-01T00:00:00.000Z'),
  ]);
  const r = t.readNewMessages('copilot', { transcriptFile: file, cursor: 0, sinceMs: Date.parse('2026-05-01') });
  assert.equal(r.text, 'From this run.');
});

test('copilot: the session is found by its recorded cwd', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-copilot-home-'));
  const mk = (id, cwd) => {
    const dir = path.join(home, '.copilot', 'session-state', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${cwd}\nupdated_at: 2026-06-01T00:00:00.000Z\n`);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
    return path.join(dir, 'events.jsonl');
  };
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-wt-'));
  mk('other', '/somewhere/else');
  const mine = mk('mine', worktree);
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(t.findCopilotEvents(worktree, 0), mine);
    assert.equal(t.findCopilotEvents(worktree, Date.now() + 60_000), '', 'nothing written since the tab began');
  } finally { process.env.HOME = prevHome; }
});

test('copilot: a session another tab already reads is not bound again', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-copilot-home-'));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-wt-'));
  const mk = (id, updated) => {
    const dir = path.join(home, '.copilot', 'session-state', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${worktree}\nupdated_at: ${updated}\n`);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
    return path.join(dir, 'events.jsonl');
  };
  const older = mk('older', '2026-06-01T00:00:00.000Z');
  const newer = mk('newer', '2026-06-02T00:00:00.000Z');
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(t.findCopilotEvents(worktree, 0), newer);
    assert.equal(t.findCopilotEvents(worktree, 0, new Set([newer])), older);
  } finally { process.env.HOME = prevHome; }
});

// Record shapes follow kimi-code 0.29.1's durable wire events.
const kimiPart = (part, time) => ({
  type: 'context.append_loop_event', agentId: 'main', time,
  event: { type: 'content.part', stepUuid: 's1', part },
});

test('kimi: reply text is read, reasoning and tool traffic are not', () => {
  const file = tmpFile('wire.jsonl', [
    { type: 'metadata', protocol_version: '1.5', created_at: 1 },
    { type: 'context.append_message', agentId: 'main', message: { role: 'user', content: [{ type: 'text', text: 'what is a worktree?' }] } },
    kimiPart({ type: 'think', think: 'the user wants a definition' }),
    { type: 'context.append_loop_event', agentId: 'main', event: { type: 'tool.call', toolCallId: 't1', name: 'Bash' } },
    kimiPart({ type: 'text', text: 'A second checkout of the same repo.' }),
  ]);
  const r = t.readNewMessages('kimi', { transcriptFile: file, cursor: 0 });
  assert.equal(r.text, 'A second checkout of the same repo.');
  appendLine(file, kimiPart({ type: 'text', text: 'Anything else?' }));
  assert.equal(t.readNewMessages('kimi', { transcriptFile: file, cursor: r.cursor }).text, 'Anything else?');
});

test('kimi: a resumed session skips what the earlier run said', () => {
  const file = tmpFile('wire.jsonl', [
    kimiPart({ type: 'text', text: 'From last week.' }, 1000),
    kimiPart({ type: 'text', text: 'From this run.' }, 5000),
  ]);
  assert.equal(t.readNewMessages('kimi', { transcriptFile: file, cursor: 0, sinceMs: 2000 }).text, 'From this run.');
});

test('kimi: the session is found through the index by workdir', () => {
  const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-kimi-home-'));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-wt-'));
  const mk = (id, workDir) => {
    const sessionDir = path.join(kimiHome, 'sessions', 'wd_x', id);
    fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'agents', 'main', 'wire.jsonl'), '');
    fs.appendFileSync(path.join(kimiHome, 'session_index.jsonl'), JSON.stringify({ sessionId: id, sessionDir, workDir }) + '\n');
    return path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  };
  const older = mk('session_a', worktree);
  mk('session_b', '/somewhere/else');
  const newer = mk('session_c', worktree);
  const prev = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = kimiHome;
  try {
    assert.equal(t.findKimiWire(worktree, 0), newer);
    assert.equal(t.findKimiWire(worktree, 0, new Set([newer])), older);
  } finally {
    if (prev === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = prev;
  }
});

// Record shapes follow gemini-cli 0.47's ChatRecordingService.
const geminiSay = (id, content, timestamp) => ({ id, type: 'gemini', content, timestamp });

test('gemini: replies are read, prompts and empty tool turns are not', () => {
  const file = tmpFile('session-x.jsonl', [
    { sessionId: 's', projectHash: 'h', startTime: '2026-06-01T00:00:00.000Z' },
    { id: 'u1', type: 'user', content: [{ text: 'what is a worktree?' }] },
    geminiSay('g0', ''),
    geminiSay('g1', 'A second checkout of the same repo.'),
    { $set: { lastUpdated: '2026-06-01T00:00:01.000Z' } },
  ]);
  const r = t.readNewMessages('gemini', { transcriptFile: file, cursor: 0 });
  assert.equal(r.text, 'A second checkout of the same repo.');
});

test('gemini: a message re-appended with its token counts is not posted twice', () => {
  const file = tmpFile('session-x.jsonl', [geminiSay('g1', 'Done.')]);
  const r = t.readNewMessages('gemini', { transcriptFile: file, cursor: 0 });
  assert.equal(r.text, 'Done.');
  appendLine(file, { ...geminiSay('g1', 'Done.'), tokens: { total: 12 } });
  appendLine(file, geminiSay('g2', 'Next answer.'));
  assert.equal(t.readNewMessages('gemini', { transcriptFile: file, cursor: r.cursor }).text, 'Next answer.');
});

test('gemini: the chat is found through the project registry', () => {
  const gHome = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-gemini-home-'));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-wt-'));
  const chats = path.join(gHome, '.gemini', 'tmp', 'my-proj', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(gHome, '.gemini', 'projects.json'), JSON.stringify({ projects: { [worktree]: 'my-proj' } }));
  const chat = path.join(chats, 'session-2026-06-01T00-00-abcd1234.jsonl');
  fs.writeFileSync(chat, '');
  const prev = process.env.GEMINI_CLI_HOME;
  process.env.GEMINI_CLI_HOME = gHome;
  try {
    assert.equal(t.findGeminiChat(worktree, 0), chat);
    assert.equal(t.findGeminiChat(worktree, 0, new Set([chat])), '');
    assert.equal(t.findGeminiChat('/not/a/project', 0), '');
  } finally {
    if (prev === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = prev;
  }
});

// Shapes follow the cline CLI's sessions/<id>/<id>.messages.json.
test('cline: reply text is read, thinking and tool calls are not, and the cursor moves on', () => {
  const doc = (messages) => ({ version: 1, sessionId: 's', messages });
  const file = tmpFile('s.messages.json', []);
  const first = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'run the tests' }], ts: 100 },
    { id: 'a1', role: 'assistant', ts: 200, content: [
      { type: 'thinking', thinking: 'I should run npm test' },
      { type: 'tool_use', name: 'bash', input: { command: 'npm test' } },
      { type: 'text', text: 'All 40 tests pass.' },
    ] },
  ];
  fs.writeFileSync(file, JSON.stringify(doc(first)));
  const r = t.readNewMessages('cline', { transcriptFile: file, cursor: 0 });
  assert.equal(r.text, 'All 40 tests pass.');
  // The whole file is rewritten on each save.
  fs.writeFileSync(file, JSON.stringify(doc([...first, { id: 'a2', role: 'assistant', ts: 300, content: [{ type: 'text', text: 'Done.' }] }])));
  assert.equal(t.readNewMessages('cline', { transcriptFile: file, cursor: r.cursor }).text, 'Done.');
  assert.equal(t.readNewMessages('cline', { transcriptFile: file, cursor: 0, fromEnd: true }).text, '', 'adopting a session posts nothing');
});

test('cline: the session is found by its workspace and start time', () => {
  const prevHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-cline-home-'));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-wt-'));
  const mk = (id, root, started) => {
    const dir = path.join(home, '.cline', 'data', 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ session_id: id, cwd: root, workspace_root: root, started_at: started }));
    return path.join(dir, `${id}.messages.json`);
  };
  mk('old', worktree, '2026-01-01T00:00:00.000Z');
  mk('elsewhere', '/somewhere/else', '2026-06-02T00:00:00.000Z');
  const mine = mk('mine', worktree, '2026-06-01T00:00:00.000Z');
  process.env.HOME = home;
  try {
    assert.equal(t.findClineSession(worktree, Date.parse('2026-05-01')), mine);
    assert.equal(t.findClineSession(worktree, Date.parse('2026-05-01'), new Set([mine])), '');
  } finally { process.env.HOME = prevHome; }
});

// Written by aider 0.86.2's own InputOutput (user_input, tool_output, tool_error, ai_output).
const AIDER_HISTORY = [
  '',
  '# aider chat started at 2026-10-27 20:32:50',
  '',
  '> Aider v0.86.2  ',
  '> Model: ollama/qwen2.5-coder:7b with whole edit format  ',
  '',
  '#### what is a git worktree?  ',
  '#### keep it short  ',
  '',
  'A **git worktree** is a second checkout of the same repo.',
  '',
  '> It shares history with the main one.',
  '',
  'Use `git worktree add`.',
  '',
  '> Tokens: 1.2k sent, 40 received.  ',
  '> Cost: $0.00  ',
  '',
  '#### thanks  ',
  '',
  'You are welcome.',
  '',
  '',
].join('\n');

test('ollama (aider): the reply is read, prompts and aider output are not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-aider-'));
  const file = path.join(dir, '.aider.chat.history.md');
  fs.writeFileSync(file, AIDER_HISTORY);
  const r = t.readNewMessages('ollama', { transcriptFile: file, cursor: 0 });
  assert.equal(r.text, 'A **git worktree** is a second checkout of the same repo.\n\n> It shares history with the main one.\n\nUse `git worktree add`.\n\nYou are welcome.');
  fs.appendFileSync(file, '#### and a branch?  \n\nOne branch per worktree.\n\n');
  assert.equal(t.readNewMessages('ollama', { transcriptFile: file, cursor: r.cursor }).text, 'One branch per worktree.');
});

test('ollama (aider): a multi-line tool message is aider talking, not the model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-aider-'));
  const file = path.join(dir, '.aider.chat.history.md');
  fs.writeFileSync(file, '> Applied edit to\nsrc/a.js  \n\nEdited the file.\n\n');
  assert.equal(t.readNewMessages('ollama', { transcriptFile: file, cursor: 0 }).text, 'Edited the file.');
});

test('ollama (aider): the history file is found at the worktree root, once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-aider-'));
  assert.equal(t.findAiderHistory(dir, 0), '', 'no history yet');
  const file = path.join(dir, '.aider.chat.history.md');
  fs.writeFileSync(file, '');
  assert.equal(t.findAiderHistory(dir, 0), file);
  assert.equal(t.findAiderHistory(dir, 0, new Set([file])), '', 'a second aider tab writes the same file');
});

// Shapes follow cursor-agent 2026.06's agent-transcripts JSONL.
const cursorSay = (...content) => ({ role: 'assistant', message: { content } });

test('cursor: reply text is read, tool calls and redacted reasoning are not', () => {
  const file = tmpFile('a.jsonl', [
    { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nadd a cli\n</user_query>' }] } },
    cursorSay({ type: 'text', text: '[REDACTED]' }, { type: 'tool_use', name: 'Read', input: {} }),
    cursorSay({ type: 'text', text: 'Verifying it runs:\n\n[REDACTED]' }, { type: 'tool_use', name: 'Shell', input: {} }),
    cursorSay({ type: 'text', text: 'The CLI is in place.' }),
  ]);
  const r = t.readNewMessages('cursor', { transcriptFile: file, cursor: 0 });
  assert.equal(r.text, 'Verifying it runs:\n\nThe CLI is in place.');
  assert.equal(r.cursor, 4);
});

test('cursor: a checkpoint rewrite only posts the lines it added', () => {
  const first = [cursorSay({ type: 'text', text: 'One.' })];
  const file = tmpFile('a.jsonl', first);
  const r = t.readNewMessages('cursor', { transcriptFile: file, cursor: 0 });
  fs.writeFileSync(file, [...first, cursorSay({ type: 'text', text: 'Two.' })].map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(t.readNewMessages('cursor', { transcriptFile: file, cursor: r.cursor }).text, 'Two.');
});

test('cursor: the transcript is found under the slugged workspace path', () => {
  assert.equal(t.cursorProjectSlug('/Users/me/Projects/cursor-prep'), 'Users-me-Projects-cursor-prep');
  const prevHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-cursor-home-'));
  const worktree = '/work/my repo';
  const dir = path.join(home, '.cursor', 'projects', 'work-my-repo', 'agent-transcripts', 'abc');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'abc.jsonl');
  fs.writeFileSync(file, '');
  process.env.HOME = home;
  try {
    assert.equal(t.findCursorTranscript(worktree, 0), file);
    assert.equal(t.findCursorTranscript(worktree, 0, new Set([file])), '');
  } finally { process.env.HOME = prevHome; }
});

test('ollama (aider): a tool message with blank lines inside is still aider talking', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-aider-'));
  const file = path.join(dir, '.aider.chat.history.md');
  fs.writeFileSync(file, 'Fixed the import.\n\n> ## Running: flake8 a.py\n\na.py:1:1: F401 unused\n\nFix lint errors in a.py? (Y)es/(N)o [Yes]: y  \n\n');
  assert.equal(t.readNewMessages('ollama', { transcriptFile: file, cursor: 0 }).text, 'Fixed the import.');
});
