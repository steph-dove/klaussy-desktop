require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const tokenUsage = require('../../main/state/token-usage');
const { _test } = tokenUsage;
const {
  extractClaude,
  extractCodex,
  extractGemini,
  extractCopilot,
  extractAntigravityRow,
  scanFile,
  scanAntigravityFile,
  scanAntigravityToday,
} = _test;

function writeVarint(val) {
  const bytes = [];
  let n = BigInt(val);
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function writeField(fieldNum, wireType, data) {
  const tag = writeVarint((fieldNum << 3) | wireType);
  if (wireType === 0) return Buffer.concat([tag, writeVarint(data)]);
  if (wireType === 2) return Buffer.concat([tag, writeVarint(data.length), Buffer.isBuffer(data) ? data : Buffer.from(data)]);
  throw new Error('unsupported wire type');
}

function buildAgyRow({ prompt = 500, candidates = 200, cached = 100, respId = 'resp_1', sec = 1786641433 } = {}) {
  const secBuf = writeField(1, 0, sec);
  const sub4Buf = writeField(4, 2, secBuf);
  const f9Buf = writeField(9, 2, sub4Buf);

  const promptBuf = writeField(2, 0, prompt);
  const candidatesBuf = writeField(3, 0, candidates);
  const cachedBuf = writeField(5, 0, cached);
  const respIdBuf = writeField(11, 2, respId);
  const usageBuf = writeField(4, 2, Buffer.concat([promptBuf, candidatesBuf, cachedBuf, respIdBuf]));

  return writeField(1, 2, Buffer.concat([f9Buf, usageBuf]));
}

test('extractClaude extracts usage and deduplicates by requestId', () => {
  const line = {
    requestId: 'req_123',
    timestamp: '2026-08-20T14:30:00.000Z',
    message: {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
      },
    },
  };
  const rec = extractClaude(line);
  assert.ok(rec);
  assert.equal(rec.key, 'req_123');
  assert.equal(rec.tokens, 180);
  assert.equal(typeof rec.day, 'string');
  assert.equal(extractClaude({}), null);
});

test('extractCodex extracts usage from event_msg token_count', () => {
  const line = {
    type: 'event_msg',
    timestamp: '2026-08-20T14:30:00.000Z',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 300,
          output_tokens: 75,
        },
      },
    },
  };
  const rec = extractCodex(line);
  assert.ok(rec);
  assert.equal(rec.tokens, 375);
  assert.match(rec.key, /^cx:/);
  assert.equal(extractCodex({ type: 'other' }), null);
});

test('extractGemini extracts usage from tokens object', () => {
  const line = {
    id: 'msg_gemini_1',
    timestamp: '2026-08-20T14:30:00.000Z',
    tokens: { input: 200, output: 80, cached: 50 },
  };
  const rec = extractGemini(line);
  assert.ok(rec);
  assert.equal(rec.tokens, 330);
  assert.equal(rec.key, 'gm:msg_gemini_1');
  assert.equal(extractGemini({}), null);
});

test('extractCopilot extracts usage across various Copilot event shapes', () => {
  const shape1 = {
    type: 'assistant.message',
    id: 'cp_turn_1',
    timestamp: '2026-08-20T14:30:00.000Z',
    usage: {
      input_tokens: 400,
      output_tokens: 120,
      cache_read_input_tokens: 30,
    },
  };
  const rec1 = extractCopilot(shape1);
  assert.ok(rec1);
  assert.equal(rec1.key, 'cp_turn_1');
  assert.equal(rec1.tokens, 550);

  const shape2 = {
    type: 'message',
    created_at: '2026-08-20T15:00:00.000Z',
    usage: {
      prompt_tokens: 250,
      completion_tokens: 50,
    },
  };
  const rec2 = extractCopilot(shape2);
  assert.ok(rec2);
  assert.equal(rec2.tokens, 300);

  const shape3 = {
    id: 'cp_total_1',
    timestamp: '2026-08-20T16:00:00.000Z',
    usage: {
      total_tokens: 1250,
    },
  };
  const rec3 = extractCopilot(shape3);
  assert.ok(rec3);
  assert.equal(rec3.tokens, 1250);

  const shape4 = {
    type: 'event',
    data: {
      id: 'cp_nested_1',
      timestamp: '2026-08-20T17:00:00.000Z',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };
  const rec4 = extractCopilot(shape4);
  assert.ok(rec4);
  assert.equal(rec4.tokens, 150);

  assert.equal(extractCopilot({}), null);
  assert.equal(extractCopilot({ type: 'user.message' }), null);
});

test('extractAntigravityRow decodes protobuf-encoded gen_metadata row', () => {
  const rowBuf = buildAgyRow({ prompt: 600, candidates: 150, cached: 50, respId: 'resp_agy_123', sec: 1786641433 });
  const rec = extractAntigravityRow(rowBuf);
  assert.ok(rec);
  assert.equal(rec.tokens, 800);
  assert.equal(rec.respId, 'resp_agy_123');
  assert.equal(rec.timestamp, new Date(1786641433 * 1000).toISOString());

  assert.equal(extractAntigravityRow(Buffer.from([0x00, 0x01])), null);
  assert.equal(extractAntigravityRow(Buffer.alloc(0)), null);
});

test('scanFile streams JSONL and deduplicates turns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-token-test-'));
  const file = path.join(dir, 'events.jsonl');
  const lines = [
    JSON.stringify({ id: '1', timestamp: '2026-08-20T10:00:00Z', usage: { input_tokens: 100, output_tokens: 20 } }),
    JSON.stringify({ id: '1', timestamp: '2026-08-20T10:00:00Z', usage: { input_tokens: 100, output_tokens: 20 } }), // duplicate
    JSON.stringify({ id: '2', timestamp: '2026-08-20T11:00:00Z', usage: { input_tokens: 50, output_tokens: 10 } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const seen = new Set();
  const turns = [];
  const res = await scanFile(file, 0, seen, extractCopilot, (day, tokens, key) => {
    turns.push({ day, tokens, key });
  });

  assert.equal(turns.length, 2);
  assert.equal(turns[0].tokens, 120);
  assert.equal(turns[1].tokens, 60);
  assert.equal(res.offset, fs.statSync(file).size);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanAntigravityFile reads SQLite gen_metadata and extracts token usage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-agy-test-'));
  const file = path.join(dir, 'conv-1.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)');

  const r1 = buildAgyRow({ prompt: 1000, candidates: 200, cached: 100, respId: 'r1', sec: 1786641433 });
  const r2 = buildAgyRow({ prompt: 500, candidates: 50, cached: 0, respId: 'r2', sec: 1786641435 });
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(0, r1, r1.length);
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(1, r2, r2.length);
  db.close();

  const seen = new Set();
  const turns = [];
  const res = scanAntigravityFile(file, 0, seen, (day, tokens, key) => {
    turns.push({ day, tokens, key });
  });

  assert.equal(turns.length, 2);
  assert.equal(turns[0].tokens, 1300);
  assert.equal(turns[0].key, 'r1');
  assert.equal(turns[1].tokens, 550);
  assert.equal(turns[1].key, 'r2');
  assert.equal(res.offset, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanAntigravityToday filters to today and buckets by hour', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-agy-today-'));
  const file = path.join(dir, 'conv-today.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)');

  const now = new Date();
  const sec = Math.floor(now.getTime() / 1000);
  const rToday = buildAgyRow({ prompt: 400, candidates: 100, cached: 0, respId: 'today_1', sec });
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(0, rToday, rToday.length);
  db.close();

  const todayKey = tokenUsage.todayKey();
  const seen = new Set();
  const hours = [];
  scanAntigravityToday(file, todayKey, seen, (h, tokens) => {
    hours.push({ h, tokens });
  });

  assert.equal(hours.length, 1);
  assert.equal(hours[0].h, now.getHours());
  assert.equal(hours[0].tokens, 500);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanOpencodeFile reads SQLite opencode.db part table and extracts token usage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-oc-test-'));
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');

  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run('p1', 'm1', 's1', 1787227200000, 1787227200000, JSON.stringify({
      type: 'step-finish',
      tokens: { total: 1500, input: 1400, output: 100 },
    }));
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run('p2', 'm1', 's1', 1787227250000, 1787227250000, JSON.stringify({
      type: 'text',
      text: 'hello',
    }));
  db.close();

  const seen = new Set();
  const turns = [];
  const res = _test.scanOpencodeFile(file, 0, seen, (day, tokens, key) => {
    turns.push({ day, tokens, key });
  });

  assert.equal(turns.length, 1);
  assert.equal(turns[0].tokens, 1500);
  assert.equal(turns[0].key, 'p1');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('rescan aggregates tokens from Claude, Codex, Gemini, Copilot, Antigravity, and OpenCode', async () => {
  const prevHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-all-agents-'));
  process.env.HOME = tempHome;

  try {
    const claudeDir = path.join(tempHome, '.claude', 'projects', 'proj1');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'session1.jsonl'), JSON.stringify({
      requestId: 'cl_1',
      timestamp: '2026-08-20T10:00:00.000Z',
      message: { usage: { input_tokens: 100, output_tokens: 50 } },
    }) + '\n');

    const codexDir = path.join(tempHome, '.codex', 'sessions', '2026', '08', '20');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'rollout-1.jsonl'), JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-20T11:00:00.000Z',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 200, output_tokens: 80 } } },
    }) + '\n');

    const geminiDir = path.join(tempHome, '.gemini', 'tmp', 'proj1', 'chats');
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(path.join(geminiDir, 'session-1.jsonl'), JSON.stringify({
      id: 'gm_1',
      timestamp: '2026-08-20T12:00:00.000Z',
      tokens: { input: 300, output: 50, cached: 20 },
    }) + '\n');

    const copilotDir = path.join(tempHome, '.copilot', 'session-state', 'ses-1');
    fs.mkdirSync(copilotDir, { recursive: true });
    fs.writeFileSync(path.join(copilotDir, 'events.jsonl'), JSON.stringify({
      id: 'cp_1',
      timestamp: '2026-08-20T13:00:00.000Z',
      usage: { input_tokens: 400, output_tokens: 100 },
    }) + '\n');

    const agyDir = path.join(tempHome, '.gemini', 'antigravity-cli', 'conversations');
    fs.mkdirSync(agyDir, { recursive: true });
    const agyDb = path.join(agyDir, 'conv-1.db');
    const db = new DatabaseSync(agyDb);
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)');
    const r1 = buildAgyRow({ prompt: 500, candidates: 150, cached: 50, respId: 'ag_resp_1', sec: 1787227200 }); // 2026-08-20
    db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(0, r1, r1.length);
    db.close();

    const ocDir = path.join(tempHome, '.local', 'share', 'opencode');
    fs.mkdirSync(ocDir, { recursive: true });
    const ocDb = path.join(ocDir, 'opencode.db');
    const dbOc = new DatabaseSync(ocDb);
    dbOc.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
    dbOc.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)')
      .run('oc_p1', 'm1', 's1', 1787227200000, 1787227200000, JSON.stringify({
        type: 'step-finish',
        tokens: { total: 950, input: 900, output: 50 },
      }));
    dbOc.close();

    const days = await tokenUsage.rescan();
    const byAgent = tokenUsage.snapshotByAgent();

    assert.ok(byAgent.claude, 'claude should be in breakdown');
    assert.ok(byAgent.codex, 'codex should be in breakdown');
    assert.ok(byAgent.gemini, 'gemini should be in breakdown');
    assert.ok(byAgent.copilot, 'copilot should be in breakdown');
    assert.ok(byAgent.antigravity, 'antigravity should be in breakdown');
    assert.ok(byAgent.opencode, 'opencode should be in breakdown');

    const claudeTotal = Object.values(byAgent.claude).reduce((a, b) => a + b, 0);
    const codexTotal = Object.values(byAgent.codex).reduce((a, b) => a + b, 0);
    const geminiTotal = Object.values(byAgent.gemini).reduce((a, b) => a + b, 0);
    const copilotTotal = Object.values(byAgent.copilot).reduce((a, b) => a + b, 0);
    const agyTotal = Object.values(byAgent.antigravity).reduce((a, b) => a + b, 0);
    const ocTotal = Object.values(byAgent.opencode).reduce((a, b) => a + b, 0);

    assert.equal(claudeTotal, 150);
    assert.equal(codexTotal, 280);
    assert.equal(geminiTotal, 370);
    assert.equal(copilotTotal, 500);
    assert.equal(agyTotal, 700);
    assert.equal(ocTotal, 950);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

