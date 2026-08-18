require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const providers = require('../../main/state/ai-providers');
const ollama = require('../../main/state/ollama');
const { loadConfig, saveConfig } = require('../../main/util/config');
const { runHeadless } = require('../../main/state/session-handoff');

// Point the claude provider at a stub script so the test controls exit code and
// stdout without needing the real CLI. binFor is destructured at require time,
// so patch what it reads (defaultBin) rather than binFor itself.
function withStubClaude(script, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-cli-'));
  const bin = path.join(dir, 'stub');
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  const provider = providers.getProvider('claude');
  const origBuild = provider.buildHeadlessRun;
  const origBin = provider.defaultBin;
  provider.buildHeadlessRun = () => ({ args: [], outputMode: 'passthrough' });
  provider.defaultBin = bin;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      provider.buildHeadlessRun = origBuild;
      provider.defaultBin = origBin;
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

// The local model answers first by default, so a test about the CLI path has to
// say so — otherwise it silently measures Ollama instead.
async function withConfig(patch, run) {
  const cfg = loadConfig();
  await saveConfig({ ...cfg, ...patch });
  try {
    return await run();
  } finally {
    // saveConfig MERGES, so a key cannot be unset by omitting it — restore each
    // patched key explicitly, to its old value or the default it had when absent.
    const restore = {};
    for (const key of Object.keys(patch)) restore[key] = cfg[key] === undefined ? true : cfg[key];
    await saveConfig({ ...cfg, ...restore });
  }
}

function withStubLocal(reply, run) {
  const orig = ollama.generateText;
  ollama.generateText = async () => reply;
  return Promise.resolve().then(run).finally(() => { ollama.generateText = orig; });
}

test('a clean run returns its output', async () => {
  await withConfig({ summarizeLocally: false }, () =>
    withStubClaude('#!/bin/sh\necho "the nav is being restructured"\n', async () => {
      assert.equal(await runHeadless('anything', 'claude'), 'the nav is being restructured');
    }));
});

// A failing CLI that still prints to stdout — "Not logged in · Please run
// /login" — was being written into the shared notes channel as if it were a
// summary.
test('a failed run returns nothing even when it printed to stdout', async () => {
  await withConfig({ summarizeLocally: false }, () =>
    withStubLocal('', () =>
      withStubClaude('#!/bin/sh\necho "Not logged in · Please run /login"\nexit 1\n', async () => {
        assert.equal(await runHeadless('anything', 'claude'), '');
      })));
});

// The registry always HAS a claude provider, installed or not. Picking it
// blindly meant a machine running only Codex/opencode/Kimi got no summary.
test('falls through to an installed agent when claude is missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-fallthrough-'));
  const bin = path.join(dir, 'stub');
  fs.writeFileSync(bin, '#!/bin/sh\necho "codex summarized it"\n');
  fs.chmodSync(bin, 0o755);

  const claude = providers.getProvider('claude');
  const codex = providers.getProvider('codex');
  const origClaudeBin = claude.defaultBin;
  const origCodexBin = codex.defaultBin;
  const origCodexBuild = codex.buildHeadlessRun;
  claude.defaultBin = path.join(dir, 'definitely-not-installed');
  codex.defaultBin = bin;
  codex.buildHeadlessRun = () => ({ args: [], outputMode: 'passthrough' });
  try {
    await withConfig({ summarizeLocally: false }, async () => {
      assert.equal(await runHeadless('anything', 'codex'), 'codex summarized it');
    });
  } finally {
    claude.defaultBin = origClaudeBin;
    codex.defaultBin = origCodexBin;
    codex.buildHeadlessRun = origCodexBuild;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Routine summarizing stays on the machine and costs nothing, so the local
// model answers even when a cloud agent is sitting right there.
test('the local model is preferred over an installed agent', async () => {
  await withStubLocal('summarized locally', () =>
    withStubClaude('#!/bin/sh\necho "summarized by claude"\n', async () => {
      assert.equal(await runHeadless('anything', 'claude'), 'summarized locally');
    }));
});

// Ollama stopped, or only base models installed: the installed agent covers it
// rather than the summary silently going missing.
test('an installed agent covers for a local model that cannot answer', async () => {
  await withStubLocal('', () =>
    withStubClaude('#!/bin/sh\necho "summarized by claude"\n', async () => {
      assert.equal(await runHeadless('anything', 'claude'), 'summarized by claude');
    }));
});

test('preferring the cloud still falls back to local when nothing is installed', async () => {
  const missing = path.join(os.tmpdir(), 'no-such-agent-binary');
  const saved = [];
  for (const id of providers.PROVIDER_IDS) {
    const p = providers.getProvider(id);
    saved.push([p, p.defaultBin]);
    p.defaultBin = missing;
  }
  try {
    await withConfig({ summarizeLocally: false }, () =>
      withStubLocal('local rescue', async () => {
        assert.equal(await runHeadless('anything', 'claude'), 'local rescue');
      }));
  } finally {
    for (const [p, bin] of saved) p.defaultBin = bin;
  }
});
