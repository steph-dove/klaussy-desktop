// Token-usage aggregator.
//
// Walks each supported agent's session logs and sums tokens-per-local-day,
// tagged by agent, across every session on this machine. Used by the sidebar
// leaderboard tile (total chart + per-agent breakdown).
//
// Sources (only agents that expose per-turn usage are parsed):
//   - claude: ~/.claude/projects/**/*.jsonl — one event per line; usage lives
//     at `message.usage` ({ input_tokens, cache_creation_input_tokens,
//     cache_read_input_tokens, output_tokens }).
//   - codex:  ~/.codex/sessions/**/*.jsonl — usage lives on the
//     `event_msg`/`token_count` event at `payload.info.last_token_usage`
//     ({ input_tokens, output_tokens, total_tokens, ... }). `last_` is the
//     per-turn delta; `total_token_usage` is cumulative, so we sum `last_`.
//   - gemini: ~/.gemini/tmp/<project>/chats/session-*.jsonl — each assistant
//     message line carries `tokens: { input, output, cached, thoughts, total }`.
//   - copilot: ~/.copilot/session-state/**/events.jsonl — events carry `usage`
//     ({ input_tokens, output_tokens, total_tokens, ... }).
//   - antigravity: ~/.gemini/antigravity-cli/conversations/*.db — generation
//     turn metadata in `gen_metadata` carrying protobuf-encoded token usage
//     (prompt_token_count, candidates_token_count, cached_content_token_count).
//   - opencode: ~/.local/share/opencode/opencode.db — `part` table records
//     carrying `tokens` metadata on step-finish turns.
// Other line types (permission-mode, summary, user input, tool results) carry
// no usage field and are skipped.
//
// The full transcript collection is hundreds of MB and grows daily, so we
// keep an incremental cache keyed by absolute file path:
//   { version, files: { <path>: { mtimeMs, size, offset, days, requestIds, agent } } }
// On rescan, files unchanged since their cached mtime+size are skipped
// entirely; files that grew are read from cached `offset` forward; files
// that shrank or rotated are re-scanned from byte 0.
//
// IMPORTANT (accuracy): one Claude API turn produces N JSONL lines (one per
// content block), each stamped with the SAME `usage` totals. Summing every
// line over-counts by ~2x. We dedupe by `requestId` per file — the first
// line for a given requestId is counted, the rest are skipped. The set of
// seen requestIds is persisted per file so incremental scans that resume
// mid-turn don't recount on the next pass.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { app } = require('electron');

// Bump whenever a new agent starts being counted: older caches lack its
// history, so they're discarded and rescanned from scratch.
const CACHE_VERSION = 3;

function home() {
  return process.env.HOME || os.homedir();
}

function claudeProjectsDir() { return path.join(home(), '.claude', 'projects'); }
function codexSessionsDir() { return path.join(home(), '.codex', 'sessions'); }
function geminiTmpDir() { return path.join(home(), '.gemini', 'tmp'); }
function copilotDir() { return path.join(home(), '.copilot'); }
function antigravityConversationsDir() { return path.join(home(), '.gemini', 'antigravity-cli', 'conversations'); }
function opencodeDbPath() {
  const xdg = process.env.XDG_DATA_HOME
    || (process.platform === 'win32' ? process.env.LOCALAPPDATA : null)
    || path.join(home(), '.local', 'share');
  return path.join(xdg, 'opencode', 'opencode.db');
}

function cachePath() {
  return path.join(app.getPath('userData'), 'token-usage-cache.json');
}

let memo = null;     // in-memory cache, lazily loaded from disk
let writeQueue = Promise.resolve();
let scanInFlight = null;

function loadCache() {
  if (memo) return memo;
  try {
    const raw = fs.readFileSync(cachePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === CACHE_VERSION && parsed.files) {
      memo = parsed;
      return memo;
    }
  } catch { /* missing / corrupt — fall through to a fresh cache */ }
  memo = { version: CACHE_VERSION, files: {}, lastScanAt: 0 };
  return memo;
}

function saveCache() {
  const snapshot = JSON.stringify(memo);
  writeQueue = writeQueue.then(() => {
    try {
      const p = cachePath();
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, snapshot);
      fs.renameSync(tmp, p);
    } catch (err) {
      console.error('[token-usage] cache write failed:', err.message);
    }
  });
  return writeQueue;
}

// YYYY-MM-DD in the user's local timezone, derived from an ISO-UTC string.
function localDay(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function tokensFromUsage(u) {
  if (!u) return 0;
  return (u.input_tokens || 0)
    + (u.cache_creation_input_tokens || 0)
    + (u.cache_read_input_tokens || 0)
    + (u.output_tokens || 0);
}

// Per-agent line extractors. Each returns { key, day, tokens, timestamp } for a usage-
// bearing line, or null to skip. `key` dedupes re-emitted lines within a file.
function extractClaude(obj) {
  const usage = obj && obj.message && obj.message.usage;
  if (!usage) return null;
  // Lines without a requestId are rare (early CLI versions / stray entries) —
  // fall back to uuid so we still dedupe re-emitted content blocks.
  const key = obj.requestId || obj.uuid;
  const timestamp = obj.timestamp;
  return { key, day: localDay(timestamp), tokens: tokensFromUsage(usage), timestamp };
}

function extractCodex(obj) {
  if (!obj || obj.type !== 'event_msg') return null;
  const payload = obj.payload;
  if (!payload || payload.type !== 'token_count') return null;
  const last = payload.info && payload.info.last_token_usage;
  if (!last) return null;
  const tokens = last.total_tokens != null
    ? last.total_tokens
    : (last.input_tokens || 0) + (last.output_tokens || 0);
  const timestamp = obj.timestamp;
  // Codex has no requestId; token_count events are one-per-turn with distinct
  // timestamps, so timestamp+value is a stable dedupe key across rescans.
  return { key: 'cx:' + timestamp + ':' + tokens, day: localDay(timestamp), tokens, timestamp };
}

function extractGemini(obj) {
  const t = obj && obj.tokens;
  if (!t || typeof t !== 'object') return null;
  const tokens = t.total != null ? t.total : (t.input || 0) + (t.output || 0) + (t.cached || 0);
  const timestamp = obj.timestamp;
  // Each assistant message has a stable id; fall back to timestamp.
  return { key: 'gm:' + (obj.id || timestamp), day: localDay(timestamp), tokens, timestamp };
}

function extractCopilot(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const inner = obj.data || obj.payload || obj.event || obj.message || obj;
  const u = obj.usage || (obj.data && obj.data.usage) || (obj.payload && obj.payload.usage)
    || (obj.info && obj.info.last_token_usage) || obj.tokens || (inner && inner.usage) || (inner && inner.tokens);
  if (!u) return null;

  let tokens = 0;
  if (typeof u === 'number') {
    tokens = u;
  } else if (typeof u === 'object') {
    if (u.total_tokens != null) tokens = u.total_tokens;
    else if (u.total != null) tokens = u.total;
    else {
      const inp = u.input_tokens || u.prompt_tokens || u.input || u.tokens_in || 0;
      const out = u.output_tokens || u.completion_tokens || u.output || u.tokens_out || 0;
      const cached = u.cache_read_input_tokens || u.cached || 0;
      const cacheWrite = u.cache_creation_input_tokens || 0;
      tokens = inp + out + cached + cacheWrite;
    }
  }
  if (!tokens || tokens <= 0) return null;

  const timestamp = obj.timestamp || obj.created_at || obj.time || obj.at
    || (obj.data && (obj.data.timestamp || obj.data.created_at))
    || (obj.payload && (obj.payload.timestamp || obj.payload.created_at))
    || (inner && (inner.timestamp || inner.created_at));
  const day = localDay(timestamp);
  if (!day) return null;

  const key = obj.id || obj.uuid || obj.requestId || (obj.data && obj.data.id) || ('cp:' + timestamp + ':' + tokens);
  return { key, day, tokens, timestamp };
}

// Minimal protobuf wire decoder for Antigravity's gen_metadata binary records.
function parseProto(buf) {
  let pos = 0;
  const out = [];
  while (pos < buf.length) {
    const key = buf[pos++];
    const wireType = key & 7;
    const fieldNum = key >> 3;
    if (wireType === 0) { // varint
      let val = 0n, shift = 0n;
      while (pos < buf.length) {
        const b = buf[pos++];
        val |= BigInt(b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7n;
        if (shift > 63n) return out;
      }
      out.push({ fieldNum, wireType, val: Number(val) });
    } else if (wireType === 2) { // length-delimited
      let len = 0, shift = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        len |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
        if (shift > 28) return out;
      }
      if (pos + len > buf.length) return out;
      const data = buf.subarray(pos, pos + len);
      pos += len;
      out.push({ fieldNum, wireType, data });
    } else if (wireType === 1) { pos += 8; }
    else if (wireType === 5) { pos += 4; }
    else break;
  }
  return out;
}

function extractAntigravityRow(rowBuf) {
  try {
    const top = parseProto(rowBuf);
    const f1 = top.find((x) => x.fieldNum === 1 && x.wireType === 2);
    if (!f1) return null;
    const sub1 = parseProto(f1.data);

    let ts = null;
    const f9 = sub1.find((x) => x.fieldNum === 9 && x.wireType === 2);
    if (f9) {
      const sub9 = parseProto(f9.data);
      const f4 = sub9.find((x) => x.fieldNum === 4 && x.wireType === 2);
      if (f4) {
        const sub4 = parseProto(f4.data);
        const sec = sub4.find((x) => x.fieldNum === 1 && x.wireType === 0);
        if (sec && sec.val > 0) ts = new Date(sec.val * 1000).toISOString();
      }
    }

    const usageMsg = sub1.find((x) => x.fieldNum === 4 && x.wireType === 2) || sub1.find((x) => x.fieldNum === 2 && x.wireType === 2);
    if (!usageMsg) return null;
    const u = parseProto(usageMsg.data);
    const prompt = u.find((x) => x.fieldNum === 2 && x.wireType === 0)?.val || 0;
    const candidates = u.find((x) => x.fieldNum === 3 && x.wireType === 0)?.val || 0;
    const cached = u.find((x) => x.fieldNum === 5 && x.wireType === 0)?.val || 0;
    const respId = u.find((x) => x.fieldNum === 11 && x.wireType === 2)?.data.toString('utf8');
    const tokens = prompt + candidates + cached;
    if (tokens <= 0) return null;
    return { timestamp: ts, tokens, respId };
  } catch {
    return null;
  }
}

function scanAntigravityFile(filePath, fromIdx, seenKeys, onTurn) {
  let db = null;
  try {
    const stat = fs.statSync(filePath);
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(filePath, { readOnly: true });
    const rows = db.prepare('SELECT idx, data FROM gen_metadata WHERE idx >= ? ORDER BY idx').all(fromIdx || 0);
    let maxIdx = (fromIdx || 0) - 1;
    const baseName = path.basename(filePath, '.db');
    for (const r of rows) {
      if (r.idx > maxIdx) maxIdx = r.idx;
      if (!r.data) continue;
      const rec = extractAntigravityRow(Buffer.from(r.data));
      if (!rec || !rec.tokens) continue;
      const key = rec.respId || ('ag:' + baseName + ':' + r.idx);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const day = localDay(rec.timestamp) || localDay(stat.mtime.toISOString());
      if (!day) continue;
      onTurn(day, rec.tokens, key);
    }
    return { offset: maxIdx + 1, mtimeMs: stat.mtimeMs };
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

function scanAntigravityToday(filePath, today, seen, onHour) {
  let db = null;
  try {
    const stat = fs.statSync(filePath);
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(filePath, { readOnly: true });
    const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all();
    const baseName = path.basename(filePath, '.db');
    for (const r of rows) {
      if (!r.data) continue;
      const rec = extractAntigravityRow(Buffer.from(r.data));
      if (!rec || !rec.tokens) continue;
      const key = rec.respId || ('ag:' + baseName + ':' + r.idx);
      if (seen.has(key)) continue;
      seen.add(key);
      const ts = rec.timestamp || stat.mtime.toISOString();
      const day = localDay(ts);
      if (day !== today) continue;
      const d = new Date(ts);
      if (isNaN(d.getTime())) continue;
      onHour(d.getHours(), rec.tokens);
    }
  } catch {}
  finally {
    if (db) { try { db.close(); } catch {} }
  }
}

function scanOpencodeFile(filePath, fromRowid, seenKeys, onTurn) {
  let db = null;
  try {
    const stat = fs.statSync(filePath);
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(filePath, { readOnly: true });
    const rows = db.prepare(`
      SELECT rowid, id, time_created, data FROM part
       WHERE rowid >= ? AND data LIKE '%tokens%'
       ORDER BY rowid
    `).all(fromRowid || 0);
    let maxRowid = (fromRowid || 0) - 1;
    for (const r of rows) {
      if (r.rowid > maxRowid) maxRowid = r.rowid;
      if (!r.data) continue;
      let part;
      try { part = JSON.parse(r.data); } catch { continue; }
      const t = part.tokens;
      if (!t || typeof t !== 'object') continue;
      const tokens = t.total != null
        ? t.total
        : ((t.input || 0) + (t.output || 0) + ((t.cache && t.cache.read) || 0) + ((t.cache && t.cache.write) || 0));
      if (!tokens || tokens <= 0) continue;
      const key = r.id || ('oc:' + r.time_created + ':' + tokens);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const day = localDay(new Date(r.time_created).toISOString());
      if (!day) continue;
      onTurn(day, tokens, key);
    }
    return { offset: maxRowid + 1, mtimeMs: stat.mtimeMs };
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

function scanOpencodeToday(filePath, today, seen, onHour) {
  let db = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(filePath, { readOnly: true });
    const rows = db.prepare(`
      SELECT id, time_created, data FROM part
       WHERE data LIKE '%tokens%'
       ORDER BY rowid
    `).all();
    for (const r of rows) {
      if (!r.data) continue;
      let part;
      try { part = JSON.parse(r.data); } catch { continue; }
      const t = part.tokens;
      if (!t || typeof t !== 'object') continue;
      const tokens = t.total != null
        ? t.total
        : ((t.input || 0) + (t.output || 0) + ((t.cache && t.cache.read) || 0) + ((t.cache && t.cache.write) || 0));
      if (!tokens || tokens <= 0) continue;
      const key = r.id || ('oc:' + r.time_created + ':' + tokens);
      if (seen.has(key)) continue;
      seen.add(key);
      const d = new Date(r.time_created);
      if (isNaN(d.getTime())) continue;
      const day = localDay(d.toISOString());
      if (day !== today) continue;
      onHour(d.getHours(), tokens);
    }
  } catch {}
  finally {
    if (db) { try { db.close(); } catch {} }
  }
}

const EXTRACTORS = {
  claude: extractClaude,
  codex: extractCodex,
  gemini: extractGemini,
  copilot: extractCopilot,
};

// Walk Claude's per-project dirs (one level) for *.jsonl.
function* claudeFiles() {
  const root = claudeProjectsDir();
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch { return; }
  for (const ent of projects) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(root, ent.name);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const name of files) {
      if (name.endsWith('.jsonl')) yield path.join(dir, name);
    }
  }
}

function* walkJsonl(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkJsonl(p);
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) yield p;
  }
}

function* antigravityFiles() {
  const root = antigravityConversationsDir();
  let files;
  try {
    files = fs.readdirSync(root);
  } catch { return; }
  for (const name of files) {
    if (name.endsWith('.db')) yield path.join(root, name);
  }
}

// All session files across agents, each tagged with its agent.
function* sessionFiles() {
  for (const file of claudeFiles()) yield { file, agent: 'claude' };
  for (const file of walkJsonl(codexSessionsDir())) yield { file, agent: 'codex' };
  // Gemini's *.jsonl under tmp are the chat sessions; non-usage lines (e.g.
  // `$set` snapshots) are simply skipped by extractGemini.
  for (const file of walkJsonl(geminiTmpDir())) yield { file, agent: 'gemini' };
  for (const file of walkJsonl(copilotDir())) yield { file, agent: 'copilot' };
  for (const file of antigravityFiles()) yield { file, agent: 'antigravity' };
  const ocDb = opencodeDbPath();
  if (fs.existsSync(ocDb)) yield { file: ocDb, agent: 'opencode' };
}

// Stream a single file from `fromOffset` forward, line-by-line, applying
// `onTurn(day, tokens, requestId)` for each first-seen API turn. The caller
// passes in `seenRequestIds` (a Set, mutated as we go) so dedup state spans
// scan passes. Resolves with the new end-of-file offset so the caller can
// persist it.
function scanFile(filePath, fromOffset, seenRequestIds, extract, onTurn) {
  return new Promise((resolve, reject) => {
    let stat;
    try { stat = fs.statSync(filePath); }
    catch (err) { return reject(err); }

    if (stat.size <= fromOffset) return resolve({ offset: stat.size, mtimeMs: stat.mtimeMs });

    const stream = fs.createReadStream(filePath, { start: fromOffset, encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      const rec = extract(obj);
      if (!rec) return;
      const key = rec.key;
      if (!key || seenRequestIds.has(key)) return;
      seenRequestIds.add(key);
      if (!rec.day || !rec.tokens) return;
      onTurn(rec.day, rec.tokens, key);
    });
    rl.on('close', () => resolve({ offset: stat.size, mtimeMs: stat.mtimeMs }));
    rl.on('error', reject);
  });
}

// Public: rescan everything new since last call. Returns the aggregated
// days map { YYYY-MM-DD: totalTokens } across all files.
async function rescan() {
  if (scanInFlight) return scanInFlight;
  scanInFlight = (async () => {
    const cache = loadCache();
    let dirty = false;

    for (const { file, agent } of sessionFiles()) {
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      const cached = cache.files[file];

      // Unchanged file — skip.
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;

      // Rotated or truncated — start over.
      let fromOffset = 0;
      let days = {};
      let seenRequestIds = new Set();
      if (cached && cached.size <= stat.size && cached.mtimeMs <= stat.mtimeMs) {
        fromOffset = cached.offset || 0;
        days = { ...(cached.days || {}) };
        if (Array.isArray(cached.requestIds)) seenRequestIds = new Set(cached.requestIds);
      }

      if (agent === 'antigravity') {
        try {
          const { offset, mtimeMs } = scanAntigravityFile(file, fromOffset, seenRequestIds, (day, tokens) => {
            days[day] = (days[day] || 0) + tokens;
          });
          cache.files[file] = {
            mtimeMs,
            size: stat.size,
            offset,
            days,
            requestIds: Array.from(seenRequestIds),
            agent,
          };
          dirty = true;
        } catch (err) {
          console.error('[token-usage] scan failed', file, err.message);
        }
      } else if (agent === 'opencode') {
        try {
          const { offset, mtimeMs } = scanOpencodeFile(file, fromOffset, seenRequestIds, (day, tokens) => {
            days[day] = (days[day] || 0) + tokens;
          });
          cache.files[file] = {
            mtimeMs,
            size: stat.size,
            offset,
            days,
            requestIds: Array.from(seenRequestIds),
            agent,
          };
          dirty = true;
        } catch (err) {
          console.error('[token-usage] scan failed', file, err.message);
        }
      } else {
        const extract = EXTRACTORS[agent];
        if (!extract) continue;
        try {
          const { offset, mtimeMs } = await scanFile(file, fromOffset, seenRequestIds, extract, (day, tokens) => {
            days[day] = (days[day] || 0) + tokens;
          });
          cache.files[file] = {
            mtimeMs,
            size: offset,
            offset,
            days,
            requestIds: Array.from(seenRequestIds),
            agent,
          };
          dirty = true;
        } catch (err) {
          console.error('[token-usage] scan failed', file, err.message);
        }
      }
    }

    // Drop entries whose file no longer exists, so the days map stays
    // accurate after manual cleanup.
    for (const file of Object.keys(cache.files)) {
      if (!fs.existsSync(file)) {
        delete cache.files[file];
        dirty = true;
      }
    }

    cache.lastScanAt = Date.now();
    if (dirty) await saveCache();
    return aggregateDays(cache);
  })().finally(() => { scanInFlight = null; });
  return scanInFlight;
}

// Merge per-file day buckets into a single map.
function aggregateDays(cache) {
  const merged = {};
  for (const entry of Object.values(cache.files)) {
    if (!entry || !entry.days) continue;
    for (const [day, tokens] of Object.entries(entry.days)) {
      merged[day] = (merged[day] || 0) + tokens;
    }
  }
  return merged;
}

// Merge per-file day buckets into a per-agent map: { agent: { day: tokens } }.
// Legacy cache entries (written before agent tagging) are all Claude.
function aggregateByAgent(cache) {
  const out = {};
  for (const entry of Object.values(cache.files)) {
    if (!entry || !entry.days) continue;
    const agent = entry.agent || 'claude';
    const days = out[agent] || (out[agent] = {});
    for (const [day, tokens] of Object.entries(entry.days)) {
      days[day] = (days[day] || 0) + tokens;
    }
  }
  return out;
}

// Public: aggregated days from the cached state (no I/O). Useful when the
// renderer wants a cheap refresh between rescans.
function snapshot() {
  return aggregateDays(loadCache());
}

// Public: per-agent day buckets from the cached state (no I/O).
function snapshotByAgent() {
  return aggregateByAgent(loadCache());
}

// Today's usage bucketed by local hour (24 slots) plus today's per-agent
// totals. The day cache has no sub-day granularity, so we re-read the raw
// lines — but only from files modified today (others can't hold today's
// entries), so it stays cheap. Used by the 1-day chart view.
async function todayByHour() {
  const today = todayKey();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  const hours = new Array(24).fill(0);
  const byAgent = {};

  for (const { file, agent } of sessionFiles()) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.mtimeMs < startMs) continue; // can't contain today's entries

    if (agent === 'antigravity') {
      const seen = new Set();
      scanAntigravityToday(file, today, seen, (h, tokens) => {
        hours[h] += tokens;
        byAgent[agent] = (byAgent[agent] || 0) + tokens;
      });
      continue;
    }

    if (agent === 'opencode') {
      const seen = new Set();
      scanOpencodeToday(file, today, seen, (h, tokens) => {
        hours[h] += tokens;
        byAgent[agent] = (byAgent[agent] || 0) + tokens;
      });
      continue;
    }

    const extract = EXTRACTORS[agent];
    if (!extract) continue;
    const seen = new Set();
    await new Promise((resolve) => {
      const rl = readline.createInterface({
        input: fs.createReadStream(file, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
      });
      rl.on('line', (line) => {
        if (!line) return;
        let obj;
        try { obj = JSON.parse(line); } catch { return; }
        const rec = extract(obj);
        if (!rec || !rec.key || seen.has(rec.key)) return;
        seen.add(rec.key);
        if (rec.day !== today || !rec.tokens) return;
        const ts = rec.timestamp || obj.timestamp || obj.created_at || (obj.data && (obj.data.timestamp || obj.data.created_at)) || (obj.payload && (obj.payload.timestamp || obj.payload.created_at));
        const d = new Date(ts);
        if (isNaN(d.getTime())) return;
        hours[d.getHours()] += rec.tokens;
        byAgent[agent] = (byAgent[agent] || 0) + rec.tokens;
      });
      rl.on('close', resolve);
      rl.on('error', resolve);
    });
  }
  return { hours, byAgent };
}

function todayKey() {
  return localDay(new Date().toISOString());
}

module.exports = {
  rescan,
  snapshot,
  snapshotByAgent,
  todayByHour,
  todayKey,
  _test: {
    extractClaude,
    extractCodex,
    extractGemini,
    extractCopilot,
    extractAntigravityRow,
    parseProto,
    scanFile,
    scanAntigravityFile,
    scanAntigravityToday,
    scanOpencodeFile,
    scanOpencodeToday,
  },
};

