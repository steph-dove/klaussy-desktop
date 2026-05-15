// Token-usage aggregator.
//
// Walks ~/.claude/projects/**/*.jsonl and sums tokens-per-local-day across
// every Claude Code session on this machine. Used by the sidebar leaderboard
// tile.
//
// Each Claude JSONL line is one event; the ones we care about have shape:
//   { timestamp, message: { model, usage: { input_tokens, cache_creation_input_tokens,
//                                            cache_read_input_tokens, output_tokens } } }
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

// Walk one project directory and return its *.jsonl absolute paths.
function* jsonlFiles() {
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
      if (!name.endsWith('.jsonl')) continue;
      yield path.join(dir, name);
    }
  }
}

// Stream a single file from `fromOffset` forward, line-by-line, applying
// `onTurn(day, tokens, requestId)` for each first-seen API turn. The caller
// passes in `seenRequestIds` (a Set, mutated as we go) so dedup state spans
// scan passes. Resolves with the new end-of-file offset so the caller can
// persist it.
function scanFile(filePath, fromOffset, seenRequestIds, onTurn) {
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
      const usage = obj && obj.message && obj.message.usage;
      if (!usage) return;
      const rid = obj.requestId;
      // Lines without a requestId are rare (early CLI versions, or stray
      // entries) — fall back to uuid so we still dedupe, since the same
      // content block isn't re-emitted with a fresh uuid.
      const key = rid || obj.uuid;
      if (!key || seenRequestIds.has(key)) return;
      seenRequestIds.add(key);
      const day = localDay(obj.timestamp);
      if (!day) return;
      const tokens = tokensFromUsage(usage);
      if (!tokens) return;
      onTurn(day, tokens, key);
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

    for (const file of jsonlFiles()) {
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

      try {
        const { offset, mtimeMs } = await scanFile(file, fromOffset, seenRequestIds, (day, tokens) => {
          days[day] = (days[day] || 0) + tokens;
        });
        cache.files[file] = {
          mtimeMs,
          size: offset,
          offset,
          days,
          requestIds: Array.from(seenRequestIds),
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

// Public: aggregated days from the cached state (no I/O). Useful when the
// renderer wants a cheap refresh between rescans.
function snapshot() {
  return aggregateDays(loadCache());
}

function todayKey() {
  return localDay(new Date().toISOString());
}

module.exports = {
  rescan,
  snapshot,
  todayKey,
};
