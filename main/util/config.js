// Persistent config living at userData/config.json: repo path, project list,
// UI prefs, notify toggles, claudePath, theme, and (historically) a PR-review
// cache that has since moved to its own file-per-PR store.
//
// saveConfig has ~64 call sites (prefs changes, PR cache writes, notify pref
// updates, the 10s auto-save timer). Writes are atomic (tmp+rename) and
// serialized behind a single in-flight promise so overlapping callers
// coalesce to sequential merge+write passes. shutdownAndSave awaits the
// tail of that queue via flushSaveConfig() before quitting.

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Persist repo path in a simple JSON file in userData
function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
  } catch {
    return {};
  }
}

// `saveConfig` has ~64 call sites including a 10s auto-save timer, prefs
// changes, PR-review cache writes, and notify-pref updates. Previously this
// was read-modify-write into the final path with no locking: two overlapping
// calls could each read the same prior state, merge their own field, and
// whoever wrote last would lose the first caller's field. A crash mid-write
// would also truncate config.json and wipe every saved session / project.
//
// Fix: atomic writes via tmp+rename, serialized behind a single in-flight
// promise so overlapping callers coalesce to sequential write passes. The
// read inside each pass sees the freshly-written state from the previous
// pass, so field merges compose correctly.
let _saveConfigQueue = Promise.resolve();
function saveConfig(config) {
  _saveConfigQueue = _saveConfigQueue.then(() => {
    try {
      const configPath = getConfigPath();
      let merged;
      try {
        const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        merged = Object.assign(existing, config);
      } catch {
        merged = config;
      }
      const tmp = configPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
      fs.renameSync(tmp, configPath);
    } catch (err) {
      // Surface to the log ring so disk-full / permission issues aren't silent.
      try { console.error('saveConfig failed:', err.message); } catch {}
    }
  });
  return _saveConfigQueue;
}

// shutdownAndSave awaits this promise before quitting so the final write
// (which may still be in-flight when Cmd+Q fires) has a chance to land.
function flushSaveConfig() { return _saveConfigQueue; }

// One-time migration: the original PR review cache (G-series) stored reviews
// under `config.prReviews[owner/repo#n] = { review, savedAt }`. The current
// cache (G7) is file-per-PR at `userData/pr-review-cache/<owner>-<repo>-<n>.json`
// with a richer shape. We ran both in parallel for a release, which let saves
// from one path invisibly diverge from the other. Bring the legacy entries
// forward on startup and drop the config key so there's exactly one cache.
function migratePrReviewCache() {
  try {
    const config = loadConfig();
    const legacy = config.prReviews;
    if (!legacy || typeof legacy !== 'object' || Object.keys(legacy).length === 0) return;

    const dir = path.join(app.getPath('userData'), 'pr-review-cache');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    let migrated = 0;
    for (const [key, value] of Object.entries(legacy)) {
      // Legacy key shape: "owner/repo#n"
      const hashAt = key.lastIndexOf('#');
      if (hashAt <= 0) continue;
      const repoFull = key.slice(0, hashAt);
      const number = key.slice(hashAt + 1);
      const slashAt = repoFull.indexOf('/');
      if (slashAt <= 0) continue;
      const owner = repoFull.slice(0, slashAt);
      const repo = repoFull.slice(slashAt + 1);
      if (!owner || !repo || !number) continue;

      const safe = `${owner}-${repo}-${number}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const target = path.join(dir, safe + '.json');
      // Don't clobber the new-format cache if it's already populated — the
      // new data is strictly richer (findingState, per-finding usage, etc.)
      // and a legacy write here would overwrite it.
      if (fs.existsSync(target)) continue;

      const out = {
        savedAt: (value && value.savedAt) || new Date().toISOString(),
        finalText: (value && value.review) || '',
      };
      try {
        fs.writeFileSync(target, JSON.stringify(out, null, 2));
        migrated++;
      } catch {}
    }

    // saveConfig merges via Object.assign. To actually remove `prReviews`
    // from disk we set it to undefined (copied by Object.assign, dropped by
    // JSON.stringify) rather than deleting the key locally.
    config.prReviews = undefined;
    saveConfig(config);
    if (migrated > 0) {
      console.log(`pr-review-cache: migrated ${migrated} legacy entries to userData/pr-review-cache/`);
    }
  } catch (err) {
    console.error('pr-review-cache migration failed:', err && err.message);
  }
}

module.exports = {
  getConfigPath,
  loadConfig,
  saveConfig,
  flushSaveConfig,
  migratePrReviewCache,
};
