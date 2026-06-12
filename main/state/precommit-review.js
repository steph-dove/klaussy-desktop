// Pre-commit / pre-push agent review: a provider-agnostic, read-only pass
// over a diff that is about to leave the developer's hands. Surfaces:
//   - diff panel Commit button (staged diff; renderer shows findings, user
//     decides fix-first vs commit-anyway)
//   - git pre-commit hook (staged diff; findings print in the committing
//     terminal — the committer, human or agent, fixes or bypasses)
//   - git pre-push hook (the whole push range remoteSha..localSha; catches
//     cross-commit issues and anything that bypassed pre-commit)
//
// Four lenses (silent failures · secrets · debug leftovers · correctness
// landmines) + the repo's real linter, with a visible per-lens scorecard on
// every result. The diff is INLINED into the prompt (capped) so every
// provider behaves identically in headless text mode; the repo-intel block
// rides along so findings respect house conventions.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { spawnClaudeStream } = require('./claude-streaming');
const { getRepoIntelBlock } = require('./repo-intel');

// Live progress to every window — users should SEE reviews running (and
// passing), not infer them from a pause.
function notifyWindows(payload) {
  try {
    const { allWindows } = require('./windows');
    for (const w of allWindows) {
      if (w && !w.isDestroyed()) w.webContents.send('precommit-event', payload);
    }
  } catch { /* early boot — nothing to tell */ }
}

const DIFF_CAP_BYTES = 200 * 1024;   // beyond this the diff is truncated (noted in prompt)
const CHECK_TIMEOUT_MS = 3 * 60 * 1000;
const NO_ISSUES_TOKEN = 'NO_SILENT_FAILURES';

// One in-flight check per (worktree, scope); a second request joins the first.
const inflight = new Map(); // key -> { promise, requestId }
const procMap = new Map();  // requestId -> child proc (spawnClaudeStream contract)

// Agent-agnostic prompt — four lenses, condensed from the silent-failure-
// hunter reviewer we use on this codebase itself. Deliberately excludes
// style/perf/architecture so it stays fast and findings stay actionable.
// (Lint is handled separately by the repo's real linter, not by the agent.)
function checkPrompt(contextLine) {
  return `You are a pre-commit reviewer. ${contextLine} Apply exactly these four lenses to the CHANGED lines and their immediate context — nothing else.

LENS 1 — Silent failures (your primary lens):
- Empty or swallowing catch blocks (caught errors not rethrown, surfaced, or meaningfully handled)
- Catch-and-continue where later code depends on the failed step
- Fallback values that mask failures (return null/[]/default on error with no signal to the caller or user)
- Success reported over partial failure (function returns ok / UI shows success when a sub-step failed)
- Errors logged where nobody looks (console/debug-level) when the user or caller needed to know
- Fire-and-forget promises / missing rejection handlers
- Optional chaining or defaults that convert real bugs into silent no-ops
- Killed/ignored exit codes, suppressed stderr

LENS 2 — Secrets & credentials (always Severity: High):
- API keys, tokens, passwords, private keys, connection strings with credentials, high-entropy literals that look like secrets — in ADDED lines. Placeholder values that are obviously fake (e.g. "YOUR_API_KEY", "xxx") are NOT findings.

LENS 3 — Debug leftovers (Severity: Low):
- Added print-debugging (console.log/print/dbg!) that is clearly scaffolding rather than intentional logging per this repo's conventions
- Newly commented-out blocks of code
- Added TODO/FIXME/HACK markers with no ticket reference

LENS 4 — Blatant correctness landmines (Severity: High ONLY — if you are not CERTAIN it is broken, do not report it):
- Unreachable code introduced by the change
- Conditions that are always true/false, inverted comparisons, assignment-in-condition
- Off-by-default boolean confusion (e.g. flag checked with the opposite sense of every other use in the file)

Explicitly NOT in scope: style, naming, formatting, performance, architecture, test coverage, lint-level nits, anything outside the diff. Do not suggest refactors.

Be precise and skeptical, but only report real issues — a deliberate, well-signposted degradation (comment explains it, user is notified elsewhere) is NOT a finding.

Output contract (the tooling parses this):
- If there are NO findings, output exactly: ${NO_ISSUES_TOKEN}
- Otherwise output the literal marker <FINDINGS> on its own line, then each finding as:

**[Severity: High | Medium | Low]**
**[Lens: Silent failure | Secrets | Debug leftover | Correctness]**
**[Location: file_path:line]**
What is wrong, why it matters, and the minimal fix.

then the literal marker </FINDINGS> on its own line. Nothing after it. Keep each finding under 6 lines.`;
}

// { diff } | { empty: true } | { error } — a git failure must NOT read as
// "nothing to review" (that would silently disable the feature).
// `range` null = staged diff (pre-commit); otherwise e.g. "abc123..def456".
function diffFor(worktreePath, range) {
  try {
    const args = range ? ['diff', range] : ['diff', '--cached'];
    const out = execFileSync('git', args, {
      cwd: worktreePath, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024,
    }).toString();
    if (!out.trim()) return { empty: true };
    if (out.length > DIFF_CAP_BYTES) {
      return { diff: out.slice(0, DIFF_CAP_BYTES) + '\n…(diff truncated at 200KB — review the largest files manually)' };
    }
    return { diff: out };
  } catch (e) {
    return { error: 'could not read diff: ' + ((e && e.stderr ? String(e.stderr) : e.message) || '').trim().split('\n')[0] };
  }
}

// Run the repo's REAL linter on the changed files (deterministic, fast, no
// tokens) — agent-judged linting would be slow and flaky. Targeted at the
// changed files only so monorepo-wide lint runs don't stall the gate.
// Returns { tool, errors, output } when a linter ran and found problems,
// { tool, errors: 0 } when it ran clean, or null when no linter applies /
// the linter itself broke (lint infra failure must never block).
function lintChanged(worktreePath, range) {
  return new Promise((resolve) => {
    let files;
    try {
      const args = range
        ? ['diff', range, '--name-only', '--diff-filter=ACMR']
        : ['diff', '--cached', '--name-only', '--diff-filter=ACMR'];
      files = execFileSync('git', args, {
        cwd: worktreePath, stdio: 'pipe',
      }).toString().split('\n').filter(Boolean);
    } catch {
      return resolve(null);
    }
    // Only lint files that still exist at the current checkout.
    files = files.filter((f) => fs.existsSync(path.join(worktreePath, f)));
    if (!files.length) return resolve(null);

    const jsFiles = files.filter((f) => /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(f)).slice(0, 50);
    const pyFiles = files.filter((f) => /\.py$/.test(f)).slice(0, 50);

    const eslintBin = path.join(worktreePath, 'node_modules', '.bin', 'eslint');
    const run = (cmd, args, tool) => {
      execFile(cmd, args, { cwd: worktreePath, timeout: 45000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve({ tool, errors: 0 });
        // Exit 1 = lint findings; anything else (config error, crash,
        // timeout) = infra failure → don't block, don't report.
        if (err.code === 1) {
          const output = (String(stdout) + '\n' + String(stderr)).trim();
          const counted = (output.match(/^\s*\d+:\d+|error/gmi) || []).length;
          return resolve({ tool, errors: Math.max(1, counted), output: output.slice(0, 8000) });
        }
        resolve(null);
      });
    };

    if (jsFiles.length && fs.existsSync(eslintBin)) {
      return run(eslintBin, ['--no-warn-ignored', ...jsFiles], 'eslint');
    }
    if (pyFiles.length) {
      // ruff is fast enough to just attempt; ENOENT lands in the infra path.
      return run('ruff', ['check', '--quiet', ...pyFiles], 'ruff');
    }
    resolve(null);
  });
}

// Per-lens tallies from the agent's [Lens: …] tags, for the visible
// checklist. Untagged findings land in `other` so they're never hidden.
function lensCountsOf(text, totalAgentFindings) {
  const counts = { silent: 0, secrets: 0, debug: 0, correctness: 0, other: 0 };
  const tags = (text || '').match(/\[Lens:\s*([^\]]+)\]/gi) || [];
  for (const t of tags) {
    const v = t.toLowerCase();
    if (/silent/.test(v)) counts.silent++;
    else if (/secret|credential/.test(v)) counts.secrets++;
    else if (/debug|leftover/.test(v)) counts.debug++;
    else if (/correct|landmine/.test(v)) counts.correctness++;
    else counts.other++;
  }
  const tagged = counts.silent + counts.secrets + counts.debug + counts.correctness + counts.other;
  if (totalAgentFindings > tagged) counts.other += totalAgentFindings - tagged;
  return counts;
}

// The visible scorecard — users should see the full list of what was
// checked, pass or fail, on every gate.
function buildChecklist(lensCounts, lintErrors, lintTool) {
  const row = (n, label) => (n ? `  ✗ ${label} — ${n} issue${n === 1 ? '' : 's'}` : `  ✓ ${label} — clean`);
  const lines = [
    row(lensCounts.silent, 'silent failures'),
    row(lensCounts.secrets, 'secrets & credentials'),
    row(lensCounts.debug, 'debug leftovers'),
    row(lensCounts.correctness, 'correctness landmines'),
  ];
  if (lensCounts.other) lines.push(`  ✗ other findings — ${lensCounts.other}`);
  if (lintTool) lines.push(row(lintErrors, `lint (${lintTool})`));
  else lines.push('  – lint — no linter detected for the changed files');
  return lines.join('\n');
}

// The <FINDINGS> marker is ground truth: agents deviate from the exact
// severity format often enough (see the F6 parser history) that counting
// only severity tags would convert malformed findings into a clean bill of
// health. Marker present → at least 1 finding, NO_ISSUES_TOKEN honored only
// when the marker is absent.
function countFindings(text) {
  if (!text) return 0;
  const hasMarker = text.includes('<FINDINGS>');
  if (!hasMarker && text.includes(NO_ISSUES_TOKEN)) return 0;
  const m = text.match(/\*{0,2}\[Severity:/g);
  if (hasMarker) return Math.max(1, m ? m.length : 0);
  return m ? m.length : 0;
}

// Core runner shared by the staged (pre-commit) and range (pre-push) gates.
// Resolves { skipped:true } when there's nothing to review, else
// { text, checklist, findingsCount, lintErrors, lintTool, provider } or
// { error }. Never rejects.
function runCheck({ worktreePath, provider, range, kind }) {
  if (!worktreePath) return Promise.resolve({ error: 'no worktree' });
  const flightKey = worktreePath + ' ' + (range || 'staged');
  const existing = inflight.get(flightKey);
  if (existing) return existing.promise;

  const d = diffFor(worktreePath, range);
  if (d.error) return Promise.resolve({ error: d.error });
  if (d.empty) return Promise.resolve({ skipped: true, reason: 'nothing to review' });

  const requestId = 'precommit-' + crypto.randomUUID();
  let intel = '';
  try { intel = getRepoIntelBlock(worktreePath, provider) || ''; } catch { /* optional context */ }

  const contextLine = range
    ? 'Review ONLY the branch diff below — the full set of changes about to be PUSHED.'
    : 'Review ONLY the staged diff below, which is about to be committed.';
  const prompt = checkPrompt(contextLine)
    + '\n\n## Diff under review\n\n```diff\n' + d.diff + '\n```\n'
    + (intel ? '\n' + intel + '\n' : '');

  // Register the inflight entry BEFORE the executor runs: spawnClaudeStream
  // can settle synchronously (consent declined, sync throw), and a finish()
  // that runs before registration would leave a permanently stale entry
  // that short-circuits every future check for this scope.
  const entry = { promise: null, requestId };
  inflight.set(flightKey, entry);

  const wtName = path.basename(worktreePath);
  notifyWindows({ type: 'started', kind: kind || 'commit', worktreePath, wtName, provider: provider || 'claude' });

  const agentPromise = new Promise((resolve) => {
    let text = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        const proc = procMap.get(requestId);
        if (proc) {
          proc.kill();
          // Escalate: a CLI that ignores SIGTERM must not run forever.
          setTimeout(() => {
            try {
              const p2 = procMap.get(requestId);
              if (p2) p2.kill('SIGKILL');
            } catch {}
          }, 5000);
        }
      } catch {}
      finish({ error: 'review timed out after 3 minutes' });
    }, CHECK_TIMEOUT_MS);

    // Stub sender: spawnClaudeStream streams to renderer webContents; here we
    // just accumulate the text and resolve on done. Must cover the full
    // surface the streamer touches: isDestroyed/send/once('destroyed').
    const sender = {
      isDestroyed: () => false,
      once: () => {}, // no 'destroyed' event for a stub — process cleanup is ours
      send: (channel, payload) => {
        if (channel.startsWith('precommit-check-chunk-')) {
          if (typeof payload === 'string') text += payload;
        } else if (channel.startsWith('precommit-check-done-')) {
          if (payload && payload.error) {
            finish({ error: String(payload.error) });
          } else if (payload && payload.cancelled) {
            finish({ cancelled: true });
          } else {
            finish({ text, findingsCount: countFindings(text), provider: provider || 'claude' });
          }
        }
      },
    };

    try {
      const started = spawnClaudeStream({
        requestId,
        procMap,
        channelPrefix: 'precommit-check',
        sender,
        cwd: worktreePath,
        prompt,
        streamJson: false,
        provider: provider || 'claude',
        allowEdits: false,
        // Never pop a consent dialog from a hook context.
        promptConsent: false,
      });
      // spawnClaudeStream returns the child proc or null. The null paths
      // send done({cancelled}) synchronously themselves; this is the
      // backstop in case a future null path doesn't.
      if (started === null) finish({ cancelled: true });
    } catch (e) {
      finish({ error: e.message });
    }
  });

  // Real linter runs in parallel with the agent pass; results merge into one
  // report. Lint findings block like agent findings; lint INFRA failures
  // never do (lintChanged returns null for those).
  const lintPromise = lintChanged(worktreePath, range).catch(() => null);
  const combined = (async () => {
    const [agent, lint] = await Promise.all([agentPromise, lintPromise]);
    const lintErrors = lint && lint.errors ? lint.errors : 0;
    const lintText = lintErrors
      ? '## Lint (' + lint.tool + '): ' + lintErrors + ' problem(s) in changed files\n\n```\n' + lint.output + '\n```'
      : '';
    const lintTool = (lint && lint.tool) || null;
    const agentCount = (!agent.error && !agent.cancelled && !agent.skipped && agent.findingsCount) || 0;
    const lensCounts = lensCountsOf(agent.text || '', agentCount);
    const checklist = buildChecklist(lensCounts, lintErrors, lintTool);
    if (agent.error || agent.cancelled || agent.skipped) {
      // Agent pass didn't produce findings — but real lint errors still count.
      if (lintErrors) {
        return { ...agent, error: undefined, cancelled: undefined, skipped: undefined,
          text: checklist + '\n\n' + lintText, checklist, findingsCount: lintErrors, lintErrors, lintTool,
          agentUnavailable: agent.error || (agent.cancelled ? 'cancelled' : 'skipped') };
      }
      return agent;
    }
    return {
      ...agent,
      text: checklist + '\n\n' + (lintText ? lintText + '\n\n' : '') + (agent.text || ''),
      checklist,
      findingsCount: (agent.findingsCount || 0) + lintErrors,
      lintErrors,
      lintTool,
    };
  })();

  entry.promise = combined;
  // Cleanup is keyed to OUR requestId — a check started after this one
  // settles must not have its fresh entry deleted by us.
  combined.then((result) => {
    const cur = inflight.get(flightKey);
    if (cur && cur.requestId === requestId) inflight.delete(flightKey);
    notifyWindows({
      type: result.error ? 'error' : result.cancelled ? 'cancelled'
        : result.findingsCount ? 'findings' : 'passed',
      kind: kind || 'commit',
      worktreePath,
      wtName,
      findingsCount: result.findingsCount || 0,
      lintErrors: result.lintErrors || 0,
      error: result.error || null,
    });
  });
  return combined;
}

// Staged-diff gate (Commit button + pre-commit hook).
function runStagedCheck({ worktreePath, provider }) {
  return runCheck({ worktreePath, provider, range: null, kind: 'commit' });
}

// Push-range gate (pre-push hook). `range` like "<remoteSha>..<localSha>".
function runRangeCheck({ worktreePath, provider, range }) {
  if (!range) return Promise.resolve({ error: 'no range' });
  return runCheck({ worktreePath, provider, range, kind: 'push' });
}

// Cancel an in-flight staged check for a worktree (the renderer's Skip button).
function cancelStagedCheck(worktreePath) {
  const entry = inflight.get(worktreePath + ' staged');
  if (!entry) return false;
  try {
    const proc = procMap.get(entry.requestId);
    if (proc) proc.kill();
  } catch {}
  return true;
}

module.exports = { runStagedCheck, runRangeCheck, cancelStagedCheck, NO_ISSUES_TOKEN };
