require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// NOTE: config.js uses `app.getPath('userData')` which our setup stub routes
// to a single shared tmp dir. Each test that writes a config file MUST reset
// that dir so the migration runs against a clean slate. We do this by
// swapping the stub's return value per test via the fakeApp reference.
const { fakeApp } = require('../setup');
const config = require('../../main/util/config');

function mkTestDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  const origGetPath = fakeApp.getPath;
  fakeApp.getPath = (name) => (name === 'userData' ? d : origGetPath(name));
  return { dir: d, restore: () => { fakeApp.getPath = origGetPath; } };
}

function waitForFlush() {
  // saveConfig queues writes behind a promise; give the queue a chance to
  // drain before inspecting the file. flushSaveConfig() returns that tail.
  return config.flushSaveConfig();
}

test('runConfigMigrations on fresh install stamps CURRENT_SCHEMA_VERSION', async () => {
  const { dir, restore } = mkTestDir();
  try {
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
    config.runConfigMigrations();
    await waitForFlush();
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(parsed.schemaVersion, config.CURRENT_SCHEMA_VERSION);
  } finally { restore(); }
});

test('runConfigMigrations on already-current config is a no-op', async () => {
  const { dir, restore } = mkTestDir();
  try {
    const file = path.join(dir, 'config.json');
    const before = { schemaVersion: config.CURRENT_SCHEMA_VERSION, repoPath: '/x', extra: 'keep me' };
    fs.writeFileSync(file, JSON.stringify(before, null, 2));
    config.runConfigMigrations();
    await waitForFlush();
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(after, before);
  } finally { restore(); }
});

test('runConfigMigrations v0->v1 folds legacy prReviews and drops the key', async () => {
  const { dir, restore } = mkTestDir();
  try {
    const file = path.join(dir, 'config.json');
    // v0 shape: no schemaVersion, has a populated prReviews map.
    const legacy = {
      repoPath: '/x',
      prReviews: {
        'steph-dove/klaussy-agents#42': {
          savedAt: '2025-01-01T00:00:00Z',
          review: 'This is the old review text.',
        },
        'steph-dove/klaussy-agents#43': {
          savedAt: '2025-01-02T00:00:00Z',
          review: 'Another one.',
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
    config.runConfigMigrations();
    await waitForFlush();

    // Config: schemaVersion stamped, prReviews gone.
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.schemaVersion, config.CURRENT_SCHEMA_VERSION);
    assert.equal('prReviews' in after, false);
    assert.equal(after.repoPath, '/x');  // untouched fields preserved

    // Cache: one file per PR in userData/pr-review-cache/.
    const cacheDir = path.join(dir, 'pr-review-cache');
    assert.equal(fs.existsSync(cacheDir), true);
    const entries = fs.readdirSync(cacheDir).sort();
    assert.deepEqual(entries, ['steph-dove-klaussy-agents-42.json', 'steph-dove-klaussy-agents-43.json']);
    const body = JSON.parse(fs.readFileSync(path.join(cacheDir, 'steph-dove-klaussy-agents-42.json'), 'utf8'));
    assert.equal(body.savedAt, '2025-01-01T00:00:00Z');
    assert.equal(body.finalText, 'This is the old review text.');
  } finally { restore(); }
});

test('runConfigMigrations v0->v1 does not clobber existing new-format cache', async () => {
  const { dir, restore } = mkTestDir();
  try {
    const file = path.join(dir, 'config.json');
    const cacheDir = path.join(dir, 'pr-review-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    // A pre-existing new-format entry — the migration must preserve it.
    const existing = { savedAt: '2026-01-01', finalText: 'NEW FORMAT', findingState: 'open' };
    fs.writeFileSync(
      path.join(cacheDir, 'steph-dove-klaussy-agents-42.json'),
      JSON.stringify(existing, null, 2),
    );
    fs.writeFileSync(file, JSON.stringify({
      prReviews: {
        'steph-dove/klaussy-agents#42': { savedAt: '2020-01-01', review: 'STALE' },
      },
    }));
    config.runConfigMigrations();
    await waitForFlush();
    const body = JSON.parse(fs.readFileSync(path.join(cacheDir, 'steph-dove-klaussy-agents-42.json'), 'utf8'));
    assert.equal(body.finalText, 'NEW FORMAT');  // the new cache won
    assert.equal(body.findingState, 'open');     // extra field preserved
  } finally { restore(); }
});

test('runConfigMigrations v0->v1 is a no-op when prReviews is absent', async () => {
  const { dir, restore } = mkTestDir();
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ repoPath: '/x' }));
    config.runConfigMigrations();
    await waitForFlush();
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.schemaVersion, config.CURRENT_SCHEMA_VERSION);
    assert.equal(after.repoPath, '/x');
    assert.equal(fs.existsSync(path.join(dir, 'pr-review-cache')), false);
  } finally { restore(); }
});

test('runConfigMigrations v1->v2 derives defaultProvider from defaultMode', async () => {
  const { dir, restore } = mkTestDir();
  try {
    const file = path.join(dir, 'config.json');
    // v1 shape: legacy defaultMode, no defaultProvider yet.
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, defaultMode: 'shell' }));
    config.runConfigMigrations();
    await waitForFlush();
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.schemaVersion, config.CURRENT_SCHEMA_VERSION);
    assert.equal(after.defaultProvider, 'shell'); // mirrored from defaultMode
    assert.equal(after.defaultMode, 'shell');      // kept one release for downgrade safety
  } finally { restore(); }
});

test('runConfigMigrations v1->v2 defaults defaultProvider to claude when defaultMode absent', async () => {
  const { dir, restore } = mkTestDir();
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1 }));
    config.runConfigMigrations();
    await waitForFlush();
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.defaultProvider, 'claude');
  } finally { restore(); }
});

test('saveConfig is atomic: no .tmp file left behind on success', async () => {
  const { dir, restore } = mkTestDir();
  try {
    config.saveConfig({ theme: { preset: 'dark' } });
    await waitForFlush();
    const entries = fs.readdirSync(dir);
    assert.ok(entries.includes('config.json'));
    assert.ok(!entries.some((n) => n.endsWith('.tmp')));
  } finally { restore(); }
});

test('saveConfig serializes overlapping writes without losing fields', async () => {
  const { dir, restore } = mkTestDir();
  try {
    // Two overlapping calls with disjoint fields — both must land.
    // Pre-fix this was a read-modify-write race where one call would
    // clobber the other's field.
    const a = config.saveConfig({ fieldA: 'a' });
    const b = config.saveConfig({ fieldB: 'b' });
    await Promise.all([a, b]);
    await waitForFlush();
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(parsed.fieldA, 'a');
    assert.equal(parsed.fieldB, 'b');
  } finally { restore(); }
});

test('loadConfig returns {} when the file is missing', () => {
  const { dir, restore } = mkTestDir();
  try {
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
    assert.deepEqual(config.loadConfig(), {});
  } finally { restore(); }
});

test('loadConfig returns {} when the file is malformed JSON', () => {
  const { dir, restore } = mkTestDir();
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{not json');
    assert.deepEqual(config.loadConfig(), {});
  } finally { restore(); }
});
