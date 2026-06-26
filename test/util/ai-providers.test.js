require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

// Smoke tests for the AI provider registry — the single source of truth wiring
// every coding agent Klaussy can drive. These assert the *contract* every
// provider must satisfy (so a half-wired new provider fails CI), plus a couple
// of provider-specific checks for the command shapes the spawn path depends on.
const providers = require('../../main/state/ai-providers');

const ALL = providers.PROVIDER_IDS;
const VALID_OUTPUT_MODES = new Set(['passthrough', 'json-text', 'json-translate']);

test('registry exposes the expected providers', () => {
  // Order-independent membership check — guards against a provider being
  // dropped from the registry object or PROVIDER_IDS drifting out of sync.
  for (const id of ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'cline']) {
    assert.ok(ALL.includes(id), `missing provider: ${id}`);
  }
});

test('every provider satisfies the registry contract', () => {
  for (const id of ALL) {
    const p = providers.getProvider(id);
    assert.ok(p, `getProvider(${id}) returned null`);
    assert.equal(p.id, id, `${id}: id mismatch`);
    assert.equal(providers.isAgentMode(id), true, `${id}: not recognized as agent mode`);

    // Required metadata used by detection, the picker, and the sidebar.
    for (const field of ['displayName', 'shortLabel', 'defaultBin', 'configPathKey']) {
      assert.ok(p[field] && typeof p[field] === 'string', `${id}: missing ${field}`);
    }
    assert.ok(Array.isArray(p.versionArgs) && p.versionArgs.length, `${id}: bad versionArgs`);

    // binFor: bare default when unconfigured, configured path when set.
    assert.equal(providers.binFor(id, {}), p.defaultBin, `${id}: binFor default`);
    const override = `/custom/bin/${id}`;
    assert.equal(providers.binFor(id, { [p.configPathKey]: override }), override, `${id}: binFor override`);

    // Display helpers must round-trip.
    assert.equal(providers.shortLabelFor(id), p.shortLabel, `${id}: shortLabelFor`);
    assert.equal(providers.displayNameFor(id), p.displayName, `${id}: displayNameFor`);

    // Model metadata: always at least a "Default" entry and a flag string.
    const models = providers.modelsFor(id);
    assert.ok(Array.isArray(models) && models.length, `${id}: no models`);
    assert.ok(models.some((m) => m.id === ''), `${id}: no default (id:'') model`);
    assert.ok(typeof providers.modelFlagFor(id) === 'string', `${id}: no model flag`);

    // Install command is either a non-empty string or null (never undefined).
    const install = providers.installCommandFor(id);
    assert.ok(install === null || (typeof install === 'string' && install.length), `${id}: bad install command`);
  }
});

test('buildInteractiveCmd returns a runnable shell string for every provider', () => {
  for (const id of ALL) {
    const p = providers.getProvider(id);
    const bin = providers.binFor(id, {});

    const fresh = p.buildInteractiveCmd(bin, {});
    assert.ok(typeof fresh === 'string' && fresh.startsWith(bin), `${id}: fresh cmd should start with bin`);

    // Resume + model must not throw and must still reference the binary.
    const resumed = p.buildInteractiveCmd(bin, { resumeSessionId: 'sess-123', resumeLatest: true, model: 'a model', trust: true, sessionDirs: ['/tmp/sib'] });
    assert.ok(typeof resumed === 'string' && resumed.includes(bin), `${id}: resumed cmd should reference bin`);
  }
});

test('buildHeadlessRun returns a valid {args, outputMode} carrying the prompt', () => {
  const PROMPT = 'smoke-test-prompt-token';
  for (const id of ALL) {
    const p = providers.getProvider(id);
    for (const mode of ['text', 'stream']) {
      const run = p.buildHeadlessRun(p.defaultBin, { prompt: PROMPT, mode, allowEdits: true, trust: true });
      assert.ok(run && Array.isArray(run.args), `${id}/${mode}: args not an array`);
      assert.ok(VALID_OUTPUT_MODES.has(run.outputMode), `${id}/${mode}: bad outputMode ${run.outputMode}`);
      assert.ok(run.args.includes(PROMPT), `${id}/${mode}: prompt not passed through`);
    }
  }
});

test('stream/session parsers are total — never throw on junk input', () => {
  const junk = [null, undefined, {}, { type: 'nonsense' }, 'a string', 42, []];
  for (const id of ALL) {
    const p = providers.getProvider(id);
    for (const obj of junk) {
      assert.ok(Array.isArray(p.parseStreamLine(obj)), `${id}: parseStreamLine not array`);
      assert.ok(Array.isArray(p.sessionLineToEvents(obj)), `${id}: sessionLineToEvents not array`);
      // usageFromSessionLine returns null or a usage object — just must not throw.
      p.usageFromSessionLine(obj);
    }
    // Session-detection stubs must be safe to call with a real-looking path.
    assert.ok(p.snapshotSessions('/tmp/nope') instanceof Set, `${id}: snapshotSessions not a Set`);
    p.findNewSession('/tmp/nope', new Set());
  }
});

// ---- Provider-specific shapes the spawn path depends on ----

test('cursor builds the documented cursor-agent command shapes', () => {
  const p = providers.getProvider('cursor');
  assert.equal(p.defaultBin, 'cursor-agent');
  assert.equal(p.memoryFile, '.cursorrules');

  assert.equal(p.buildInteractiveCmd('cursor-agent', {}), 'cursor-agent');
  assert.match(p.buildInteractiveCmd('cursor-agent', { resumeSessionId: 'abc' }), /--resume abc/);
  assert.match(p.buildInteractiveCmd('cursor-agent', { resumeLatest: true }), /--continue/);

  const stream = p.buildHeadlessRun('cursor-agent', { prompt: 'x', mode: 'stream', allowEdits: true });
  assert.deepEqual(stream.args, ['-p', 'x', '--force', '--output-format', 'stream-json']);
  assert.equal(stream.outputMode, 'json-translate');

  const text = p.buildHeadlessRun('cursor-agent', { prompt: 'x' });
  assert.deepEqual(text.args, ['-p', 'x']);
  assert.equal(text.outputMode, 'passthrough');

  // Installed via Cursor's curl script, not npm.
  assert.match(providers.installCommandFor('cursor', 'darwin'), /cursor\.com\/install/);
});

test('cline builds the documented cline command shapes', () => {
  const p = providers.getProvider('cline');
  assert.equal(p.defaultBin, 'cline');
  assert.equal(p.memoryFile, '.clinerules');

  assert.equal(p.buildInteractiveCmd('cline', {}), 'cline');
  assert.match(p.buildInteractiveCmd('cline', { resumeSessionId: 'abc' }), /--id abc/);
  // No "continue latest" flag exists — resumeLatest must fall back to a fresh session.
  assert.equal(p.buildInteractiveCmd('cline', { resumeLatest: true }), 'cline');

  const stream = p.buildHeadlessRun('cline', { prompt: 'x', mode: 'stream', allowEdits: true });
  assert.deepEqual(stream.args, ['--yolo', '--json', 'x']);
  assert.equal(stream.outputMode, 'json-translate');

  // Installed via npm.
  assert.equal(providers.installCommandFor('cline'), 'npm install -g cline');

  // The documented NDJSON event shape extracts agent text.
  const events = p.parseStreamLine({ type: 'agent_event', event: { text: 'hello' } });
  assert.deepEqual(events, [{ kind: 'text', text: 'hello' }]);
});
