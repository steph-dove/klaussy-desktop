// Persistent config living at userData/config.json: repo path, project list, UI
// prefs, notify toggles, per-agent CLI paths (claudePath / codexPath /
// geminiPath / antigravityPath / copilotPath / cursorPath / clinePath /

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const CURRENT_SCHEMA_VERSION = 2;

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
// changes, PR-review cache writes, and notify-pref updates. Previously this was
// read-modify-write into the final path with no locking: two overlapping calls
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

// Migrations from version n-1 to version n. Each function mutates the passed
// config object in place and MUST be idempotent — we only run each migration
// once, but migrations can fail mid-way and we'd rather re-run cleanly than
const migrations = [
  // v0 → v1: fold legacy `config.prReviews` (G-series in-config PR review
  // cache) into the file-per-PR store under userData/pr-review-cache/. The
  // legacy cache ran in parallel with the new one for a release, which let
  function v0_to_v1(config) {
    const legacy = config.prReviews;
    if (!legacy || typeof legacy !== 'object' || Object.keys(legacy).length === 0) {
      if ('prReviews' in config) config.prReviews = undefined;
      return;
    }
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
    if (migrated > 0) {
      console.log(`pr-review-cache: migrated ${migrated} legacy entries to userData/pr-review-cache/`);
    }
  },

  // v1 → v2: multi-agent support. `defaultMode` ('claude' | 'shell') becomes
  // `defaultProvider`, which now also accepts 'codex' | 'gemini' |
  // 'antigravity' | 'copilot' | 'cursor' | 'cline'. We keep `defaultMode` in
  function v1_to_v2(config) {
    if (config.defaultProvider === undefined) {
      config.defaultProvider = config.defaultMode || 'claude';
    }
  },
];

// Run on every startup. Fresh installs get stamped with CURRENT_SCHEMA_VERSION
// directly; existing configs get each missing migration applied in order, then
// the new version is written atomically via saveConfig. On failure at step N,
function runConfigMigrations() {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
      // Fresh install — nothing to migrate, just stamp the current version.
      saveConfig({ schemaVersion: CURRENT_SCHEMA_VERSION });
      return;
    }
    const config = loadConfig();
    const from = typeof config.schemaVersion === 'number' ? config.schemaVersion : 0;
    if (from >= CURRENT_SCHEMA_VERSION) return;

    for (let n = from; n < CURRENT_SCHEMA_VERSION; n++) {
      try {
        migrations[n](config);
      } catch (err) {
        console.error(`config migration v${n}->v${n + 1} failed:`, err && err.message);
        return; // Don't stamp — let next startup retry.
      }
    }
    config.schemaVersion = CURRENT_SCHEMA_VERSION;
    saveConfig(config);
  } catch (err) {
    console.error('runConfigMigrations failed:', err && err.message);
  }
}

module.exports = {
  getConfigPath,
  loadConfig,
  saveConfig,
  flushSaveConfig,
  runConfigMigrations,
  CURRENT_SCHEMA_VERSION,
};
