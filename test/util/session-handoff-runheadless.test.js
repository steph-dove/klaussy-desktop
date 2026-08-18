require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const providers = require('../../main/state/ai-providers');
const { runHeadless } = require('../../main/state/session-handoff');

// Point the claude provider at a stub script so the test controls exit code and
// stdout without needing the real CLI.
function withStubClaude(script, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-cli-'));
  const bin = path.join(dir, 'stub');
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  const provider = providers.getProvider('claude');
  const origBuild = provider.buildHeadlessRun;
  // binFor is destructured at require time, so patch what it reads instead.
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

test('a clean run returns its output', async () => {
  await withStubClaude('#!/bin/sh\necho "the nav is being restructured"\n', async () => {
    assert.equal(await runHeadless('anything', 'claude'), 'the nav is being restructured');
  });
});

// A failing CLI that still prints to stdout — "Not logged in · Please run
// /login" — was being written into the shared notes channel as if it were a
// summary.
test('a failed run returns nothing even when it printed to stdout', async () => {
  await withStubClaude('#!/bin/sh\necho "Not logged in · Please run /login"\nexit 1\n', async () => {
    assert.equal(await runHeadless('anything', 'claude'), '');
  });
});

// The registry always has a claude provider, so picking it blindly left a
// machine running only Codex/opencode/Kimi with no summary at all.
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
    assert.equal(await runHeadless('anything', 'codex'), 'codex summarized it');
  } finally {
    claude.defaultBin = origClaudeBin;
    codex.defaultBin = origCodexBin;
    codex.buildHeadlessRun = origCodexBuild;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// aider ('ollama' in the registry) is excluded from summarizing because it edits files.
test('falls back to the local Ollama server when nothing is installed', async () => {
  const ollama = require('../../main/state/ollama');
  const providers2 = require('../../main/state/ai-providers');
  const origGen = ollama.generateText;
  const missing = path.join(os.tmpdir(), 'no-such-agent-binary');
  const saved = [];
  for (const id of providers2.PROVIDER_IDS) {
    const p = providers2.getProvider(id);
    saved.push([p, p.defaultBin]);
    p.defaultBin = missing;
  }
  let sawPrompt = null;
  ollama.generateText = async (prompt) => { sawPrompt = prompt; return 'summarized locally by ollama'; };
  try {
    assert.equal(await runHeadless('condense this', 'ollama'), 'summarized locally by ollama');
    assert.equal(sawPrompt, 'condense this');
  } finally {
    ollama.generateText = origGen;
    for (const [p, bin] of saved) p.defaultBin = bin;
  }
});
