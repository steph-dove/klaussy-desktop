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
