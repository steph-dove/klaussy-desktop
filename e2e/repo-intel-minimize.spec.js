// Smoke / regression guard for Item 4 (Smart Context & Token Minimization).
//
// The minimization logic has no UI surface — it shapes the repo-intel block
// injected into agent prompts in the MAIN process. So rather than drive the
// renderer, we exercise the real main-process code path via evaluate(): the
// app boots in this repo (a real git checkout), and repoIntelFor() must run
// its new touched-paths resolution (git status/diff + diff parsing + scoped
// block assembly) without throwing. This catches regressions the unit tests
// can't — broken requires, git invocation, or pr-review wiring inside Electron.

const path = require('path');
const { test, expect } = require('./fixtures');

const agentSelectPath = path.resolve(__dirname, '../main/state/agent-select.js');

test('repoIntelFor resolves touched paths and builds a block without throwing', async ({ electronApp }) => {
  const result = await electronApp.evaluate(async ({ app }, modPath) => {
    // evaluate() runs in a scope without a bound `require`; reach the main
    // entry's require (relative to main.js) to load already-resolvable modules.
    const { repoIntelFor } = process.mainModule.require(modPath);
    // cwd is the repo root (see fixtures), a real git worktree — this drives
    // getTouchedPaths() through actual `git status` / `git diff` calls.
    try {
      const block = repoIntelFor(process.cwd(), 'claude');
      return { ok: true, type: typeof block };
    } catch (e) {
      return { ok: false, error: e && e.message };
    }
  }, agentSelectPath);

  expect(result.ok, `repoIntelFor threw: ${result.error}`).toBe(true);
  // Returns a (possibly empty) string — never undefined/null — so the template
  // substitution that consumes it stays safe.
  expect(result.type).toBe('string');
});

test('parseChangedFilesFromDiff is wired and parses diffs in the Electron main process', async ({ electronApp }) => {
  const files = await electronApp.evaluate(async ({ app }, modPath) => {
    const { parseChangedFilesFromDiff } = process.mainModule.require(modPath);
    const diff = [
      'diff --git a/main/ipc/files.js b/main/ipc/files.js',
      '--- a/main/ipc/files.js',
      '+++ b/main/ipc/files.js',
      'diff --git a/renderer/app.js b/renderer/app.js',
    ].join('\n');
    return parseChangedFilesFromDiff(diff);
  }, agentSelectPath);

  expect(files).toEqual(['main/ipc/files.js', 'renderer/app.js']);
});
