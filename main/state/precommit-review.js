// Pre-commit silent-failure review: a provider-agnostic, read-only agent
// pass over the STAGED diff, run before a commit lands. Used by two
// surfaces:
//   - the diff panel's Commit button (renderer shows findings; the user
//     decides fix-first vs commit-anyway)
//   - the installed git pre-commit hook (terminal/agent commits phone home
//     over a local socket; findings print in the committing terminal so the
//     committer — human or agent — can fix or bypass)
//
// The diff is INLINED into the prompt (capped) rather than fetched by the
// agent, so every provider behaves identically in headless text mode. The
// repo-intel block rides along so findings respect house conventions.

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { spawnClaudeStream } = require('./claude-streaming');
const { getRepoIntelBlock } = require('./repo-intel');

const DIFF_CAP_BYTES = 200 * 1024;   // beyond this the diff is truncated (noted in prompt)
const CHECK_TIMEOUT_MS = 3 * 60 * 1000;
const NO_ISSUES_TOKEN = 'NO_SILENT_FAILURES';

// One in-flight check per worktree; a second request joins the first.
const inflight = new Map(); // worktreePath -> { promise, requestId }
const procMap = new Map();  // requestId -> child proc (spawnClaudeStream contract)

// Agent-agnostic, single-lens prompt — condensed from the silent-failure-
// hunter reviewer we use on this codebase itself. Deliberately excludes
// style/perf/architecture so it stays fast and findings stay actionable.
const CHECK_PROMPT = `You are a silent-failure hunter. Review ONLY the staged diff below, which is about to be committed. Your single lens: errors that disappear instead of surfacing.

Hunt for, in the CHANGED lines and their immediate context:
- Empty or swallowing catch blocks (caught errors not rethrown, surfaced, or meaningfully handled)
- Catch-and-continue where later code depends on the failed step
- Fallback values that mask failures (return null/[]/default on error with no signal to the caller or user)
- Success reported over partial failure (function returns ok / UI shows success when a sub-step failed)
- Errors logged where nobody looks (console/debug-level) when the user or caller needed to know
- Fire-and-forget promises / missing rejection handlers
- Optional chaining or defaults that convert real bugs into silent no-ops
- Killed/ignored exit codes, suppressed stderr

Explicitly NOT in scope: style, naming, performance, architecture, test coverage, anything outside the diff. Do not suggest refactors.

Be precise and skeptical, but only report real issues — a deliberate, well-signposted degradation (comment explains it, user is notified elsewhere) is NOT a finding.

Output contract (the tooling parses this):
- If there are NO findings, output exactly: ${NO_ISSUES_TOKEN}
- Otherwise output the literal marker <FINDINGS> on its own line, then each finding as:

**[Severity: High | Medium | Low]**
**[Location: file_path:line]**
What is swallowed, why it matters, and the minimal fix.

then the literal marker </FINDINGS> on its own line. Nothing after it. Keep each finding under 6 lines.`;

// { diff } | { empty: true } | { error } — a git failure must NOT read as
// "nothing staged" (that would silently disable the feature on every commit).
function stagedDiff(worktreePath) {
  try {
    const out = execFileSync('git', ['diff', '--cached'], {
      cwd: worktreePath, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024,
    }).toString();
    if (!out.trim()) return { empty: true };
    if (out.length > DIFF_CAP_BYTES) {
      return { diff: out.slice(0, DIFF_CAP_BYTES) + '\n…(diff truncated at 200KB — review the largest files manually)' };
    }
    return { diff: out };
  } catch (e) {
    return { error: 'could not read staged diff: ' + ((e && e.stderr ? String(e.stderr) : e.message) || '').trim().split('\n')[0] };
  }
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

// Run the check. Resolves { skipped:true } when nothing is staged, else
// { text, findingsCount, provider } or { error }. Never rejects.
function runStagedCheck({ worktreePath, provider }) {
  if (!worktreePath) return Promise.resolve({ error: 'no worktree' });
  const existing = inflight.get(worktreePath);
  if (existing) return existing.promise;

  const staged = stagedDiff(worktreePath);
  if (staged.error) return Promise.resolve({ error: staged.error });
  if (staged.empty) return Promise.resolve({ skipped: true, reason: 'nothing staged' });

  const requestId = 'precommit-' + crypto.randomUUID();
  let intel = '';
  try { intel = getRepoIntelBlock(worktreePath, provider) || ''; } catch { /* optional context */ }

  const prompt = CHECK_PROMPT
    + '\n\n## Staged diff\n\n```diff\n' + staged.diff + '\n```\n'
    + (intel ? '\n' + intel + '\n' : '');

  // Register the inflight entry BEFORE the executor runs: spawnClaudeStream
  // can settle synchronously (consent declined, sync throw), and a finish()
  // that runs before registration would leave a permanently stale entry
  // that short-circuits every future check for this worktree.
  const entry = { promise: null, requestId };
  inflight.set(worktreePath, entry);

  const promise = new Promise((resolve) => {
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
        // Never pop a consent dialog from a pre-commit hook context.
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

  entry.promise = promise;
  // Cleanup is keyed to OUR requestId — a check started after this one
  // settles must not have its fresh entry deleted by us.
  promise.then(() => {
    const cur = inflight.get(worktreePath);
    if (cur && cur.requestId === requestId) inflight.delete(worktreePath);
  });
  return promise;
}

// Cancel an in-flight check for a worktree (the renderer's Skip button).
function cancelStagedCheck(worktreePath) {
  const entry = inflight.get(worktreePath);
  if (!entry) return false;
  try {
    const proc = procMap.get(entry.requestId);
    if (proc) proc.kill();
  } catch {}
  return true;
}

module.exports = { runStagedCheck, cancelStagedCheck, NO_ISSUES_TOKEN };
