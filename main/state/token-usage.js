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
// Gemini/Copilot don't surface reliable per-turn usage yet, so they're omitted.
// Other line types (permission-mode, summary, user input, tool results) carry
// no usage field and are skipped.
//
// The full transcript collection is hundreds of MB and grows daily, so we
// keep an incremental cache keyed by absolute file path:
//   { version, files: { <path>: { mtimeMs, size, offset, days, requestIds } } }
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

// Bumped to 2 when requestId dedup landed — v1 caches over-counted by ~2x,
// so we discard them and rescan from scratch.
const CACHE_VERSION = 2;
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');

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

// Per-agent line extractors. Each returns { key, day, tokens } for a usage-
// bearing line, or null to skip. `key` dedupes re-emitted lines within a file.
function extractClaude(obj) {
  const usage = obj && obj.message && obj.message.usage;
  if (!usage) return null;
  // Lines without a requestId are rare (early CLI versions / stray entries) —
  // fall back to uuid so we still dedupe re-emitted content blocks.
  const key = obj.requestId || obj.uuid;
  return { key, day: localDay(obj.timestamp), tokens: tokensFromUsage(usage) };
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
  // Codex has no requestId; token_count events are one-per-turn with distinct
  // timestamps, so timestamp+value is a stable dedupe key across rescans.
  return { key: 'cx:' + obj.timestamp + ':' + tokens, day: localDay(obj.timestamp), tokens };
}

const EXTRACTORS = { claude: extractClaude, codex: extractCodex };

// Walk Claude's per-project dirs (one level) for *.jsonl.
function* claudeFiles() {
  let projects;
  try {
    projects = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true });
  } catch { return; }
  for (const ent of projects) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(CLAUDE_PROJECTS, ent.name);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const name of files) {
      if (name.endsWith('.jsonl')) yield path.join(dir, name);
    }
  }
}

// Codex nests sessions under YYYY/MM/DD/, so walk recursively for *.jsonl.
function* walkJsonl(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkJsonl(p);
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) yield p;
  }
}

// All session files across agents, each tagged with its agent.
function* sessionFiles() {
  for (const file of claudeFiles()) yield { file, agent: 'claude' };
  for (const file of walkJsonl(CODEX_SESSIONS)) yield { file, agent: 'codex' };
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

      const extract = EXTRACTORS[agent];
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
    const extract = EXTRACTORS[agent];
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
        const d = new Date(obj.timestamp);
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
};
