// Pre-commit / pre-push agent review: a provider-agnostic, read-only pass
// over a diff that is about to leave the developer's hands. Surfaces:
//   - diff panel Commit button (staged diff; renderer shows findings, user
//     decides fix-first vs commit-anyway)
//   - git pre-commit hook (staged diff; findings print in the committing
//     terminal — the committer, human or agent, fixes or bypasses)
//   - git pre-push hook (the whole push range remoteSha..localSha; catches
//     cross-commit issues and anything that bypassed pre-commit)
//
// Five lenses (silent failures · secrets · debug leftovers · correctness
// landmines · excessive comments) + the repo's real linter, with a visible
// per-lens scorecard on every result. The diff is INLINED into the prompt
// (capped) so every provider behaves identically in headless text mode; the
// repo-intel block rides along so findings respect house conventions.
//
// Canonical source: the lens body and the concise-comment cleanup rules are
// authored in the klaussy-agents <repo>-precommit skill (.claude/skills/
// <repo>-precommit/). When that skill is in the worktree we use it verbatim
// (findRepoPrecommitSkill); the inline PRECOMMIT_LENS_BODY / COMMENT_CLEANUP_RULES
// are the offline fallback. Same prefer-skill-else-builtin pattern as
// review-prompts.js. The machine output contract stays desktop-owned.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { spawnClaudeStream } = require('./claude-streaming');
const { getRepoIntelBlock } = require('./repo-intel');
const { loadConfig } = require('../util/config');

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

// The five-lens body is authored canonically in the klaussy-agents
// <repo>-precommit skill (.claude/skills/<repo>-precommit/SKILL.md). When that
// skill is present in the worktree we use it verbatim (findRepoPrecommitSkill);
// this inline copy is the offline fallback — keep the two in sync. The output
// contract below is desktop-owned (the tooling parses its markers) and is
// appended to whichever lens body we use.
const PRECOMMIT_LENS_BODY = `Apply exactly these five lenses to the CHANGED lines and their immediate context — nothing else.

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

LENS 5 — Excessive comments (Severity: Low):
- Comments on ADDED lines that restate what the code plainly does ("// increment i", "// loop over the items", "// set x to 5"), narrate obvious steps, or just echo the function/variable name.
- Multi-line block comments where a single short line (or no comment) would carry the same information.
- Changelog / narration / "AI-tell" comments ("// Now we handle the case where…", "// This function will…", "// Added to fix the bug").
For each, the fix is: delete it (or condense to a short one-liner). Keep ONLY short comments that explain WHY — non-obvious intent, gotchas, links, or invariants. Do NOT flag: docstrings/JSDoc on public APIs, license/file headers, or genuinely clarifying "why" comments.

Explicitly NOT in scope: naming, formatting, performance, architecture, test coverage, lint-level nits, anything outside the diff. Do not suggest refactors. (Comment hygiene IS in scope — that is lens 5.)

Be precise and skeptical, but only report real issues — a deliberate, well-signposted degradation (comment explains it, user is notified elsewhere) is NOT a finding.`;

// Desktop-owned machine contract. Appended after the lens body (skill or
// fallback) and explicitly supersedes any output format the skill body suggests.
const PRECOMMIT_OUTPUT_CONTRACT = `Regardless of any output format mentioned above, follow this contract exactly (the tooling parses it):
- If there are NO findings, output exactly: ${NO_ISSUES_TOKEN}
- Otherwise output the literal marker <FINDINGS> on its own line, then each finding as:

**[Severity: High | Medium | Low]**
**[Lens: Silent failure | Secrets | Debug leftover | Correctness | Excessive comments]**
**[Location: file_path:line]**
What is wrong, why it matters, and the minimal fix.

then the literal marker </FINDINGS> on its own line. Nothing after it. Keep each finding under 6 lines.`;

function checkPrompt(contextLine, lensBody) {
  return `You are a pre-commit reviewer. ${contextLine}

${lensBody || PRECOMMIT_LENS_BODY}

${PRECOMMIT_OUTPUT_CONTRACT}`;
}

// Load the repo's canonical pre-commit skill (klaussy-agents installs it at
// .claude/skills/<repo>-precommit/). Returns { lensBody, cleanupBody } with the
// SKILL.md frontmatter stripped, or null when the skill isn't present (the
// offline-fallback path). Mirrors review-prompts.js:findRepoReviewSkill — match
// by the `-precommit` suffix rather than reconstructing the sanitized repo name.
function findRepoPrecommitSkill(worktreePath) {
  if (!worktreePath) return null;
  try {
    const skillsDir = path.join(worktreePath, '.claude', 'skills');
    for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.endsWith('-precommit')) continue;
      const skillMd = path.join(skillsDir, e.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const lensBody = fs.readFileSync(skillMd, 'utf-8')
        .replace(/^---\n[\s\S]*?\n---\n+/, '').trim();
      if (!lensBody) continue;
      let cleanupBody = null;
      try {
        cleanupBody = fs.readFileSync(path.join(skillsDir, e.name, 'comment-cleanup.md'), 'utf-8').trim() || null;
      } catch { /* aux file optional — strip pass uses its inline fallback */ }
      return { lensBody, cleanupBody };
    }
  } catch { /* no .claude/skills — repo not klaussy-initialized */ }
  return null;
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
  const skill = findRepoPrecommitSkill(worktreePath);
  const prompt = checkPrompt(contextLine, skill && skill.lensBody)
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

// ---- Concise-comment pass (on by default; config.stripComments === false off)
// The review's LENS 5 flags excessive/narrating comments but only REPORTS them,
// so the user has to keep telling the agent to clean up. Instead we run a
// focused edit pass FIRST that enforces concise comments — regular comments ≤2
// sentences (ideally 1), docstrings ≤5, deleting ones that only restate the
// code — and re-stages, so the commit lands clean. Safety: only touches staged
// code files that have NO unstaged changes (so re-staging can't sweep in
// partial-stage edits); the prompt forbids code changes; and the review pass
// still runs afterward as a backstop. Best-effort — failure leaves the diff
// untouched.
const STRIP_CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|scala|sh|bash|lua|vue|svelte)$/;

// { eligible, skippedUnstaged }: staged code files we can safely tidy vs. those
// bypassed because they also have unstaged changes (re-staging would sweep in
// partial edits). The caller surfaces skippedUnstaged so they don't slip the gate
// silently.
function eligibleStripFiles(worktreePath) {
  let staged;
  try {
    staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      cwd: worktreePath, stdio: 'pipe',
    }).toString().split('\n').filter(Boolean);
  } catch { return { eligible: [], skippedUnstaged: [] }; }
  let unstaged = new Set();
  try {
    unstaged = new Set(execFileSync('git', ['diff', '--name-only'], {
      cwd: worktreePath, stdio: 'pipe',
    }).toString().split('\n').filter(Boolean));
  } catch { /* none */ }
  const codeFiles = staged.filter((f) =>
    STRIP_CODE_EXT.test(f) && fs.existsSync(path.join(worktreePath, f)));
  return {
    eligible: codeFiles.filter((f) => !unstaged.has(f)),
    skippedUnstaged: codeFiles.filter((f) => unstaged.has(f)),
  };
}

// Canonical cleanup rules live in the <repo>-precommit skill's comment-cleanup.md
// aux file; this inline copy is the offline fallback — keep them in sync. The
// mechanical wrapper (file list, "don't run git", diff, summary line) is
// desktop-owned and lives in stripPrompt below, not in this rules block.
const COMMENT_CLEANUP_RULES = `THE RULE: regular comments may be at most TWO sentences (aim for ONE); docstrings may be at most FIVE. Always as short as possible. Apply it like this:
- A regular comment longer than two sentences → tighten to one or two sentences keeping only the non-obvious WHY (intent, gotcha, invariant, link). Drop narration and restated mechanics.
- A comment that only restates what the code plainly does, narrates obvious steps, echoes a name, or is changelog/"AI-tell" filler ("// Now we handle…", "// This function will…", "// Added to fix the bug", "// increment i") → delete it entirely; it carries nothing worth one sentence.
- A docstring / JSDoc / public-API doc comment → condense to AT MOST five sentences and as short as possible: keep params, returns, and the why; cut narration and the obvious. Don't pad to five — shorter is better.
- A comment already within its limit and genuinely useful → leave it as is.

KEEP — never touch or shorten these:
- License or file-header comments
- Functional comments: shebang (#!), eslint-disable, @ts-ignore / @ts-expect-error, prettier-ignore, // @flow, # noqa, # type:, and similar pragmas; TODO/FIXME that carry real content

NOT A COMMENT — never touch these, no matter how long or prose-like they look:
- String and template literals: anything inside quotes or backticks. This includes multi-line PROMPT / instruction strings, SQL, HTML, regexes, and message text. A long prompt template is DATA the program uses at runtime, not a verbose comment — leave every character of it. The "//", "#", or "*" inside a string or a URL is not a comment marker.
- Commented-out code: a comment whose body is itself valid code. Leave it; it may be intentional. (You shorten prose comments, not code.)
- Anything that is actual code.
If you are not 100% certain a line is a natural-language source comment, leave it untouched.`;

function stripPrompt(files, diff, cleanupRules) {
  return `You are a pre-commit comment editor. Edit the staged files IN PLACE so every comment that was ADDED in this change is concise. This is a mechanical cleanup, not a review.

${cleanupRules || COMMENT_CLEANUP_RULES}

HARD RULES:
- Only edit real source-code comments (the parts the language's parser treats as comments). Never change, move, rename, or reformat any code, string, or literal.
- Only touch comments on lines ADDED in the change below — leave pre-existing comments alone.
- Edit ONLY these files: ${files.join(', ')}
- Do not run git, tests, or any other commands.

Staged change for context (added lines start with +):

${diff}

When done, print one short line per file describing what you condensed or removed, or "comments already concise" if there was nothing to do.`;
}

// Run the edit pass, then re-stage exactly the files the pass modified.
// Resolves to { stripped: <fileCount> } — never rejects.
function stripStagedComments({ worktreePath, provider }) {
  return new Promise((resolve) => {
    const { eligible: files, skippedUnstaged } = eligibleStripFiles(worktreePath);
    // Files with unstaged edits bypass the pass (re-staging would sweep in partial
    // edits). Surface that instead of dropping it silently — the committer should
    // know those files weren't tidied and may still carry verbose comments.
    if (skippedUnstaged.length) {
      notifyWindows({ type: 'comments-skipped', worktreePath, wtName: path.basename(worktreePath), count: skippedUnstaged.length, files: skippedUnstaged });
    }
    if (!files.length) return resolve({ stripped: 0, skippedUnstaged: skippedUnstaged.length });
    const d = diffFor(worktreePath, null);
    if (d.empty || d.error || !d.diff) return resolve({ stripped: 0, skippedUnstaged: skippedUnstaged.length });
    const skill = findRepoPrecommitSkill(worktreePath);

    const requestId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    let text = '';
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; resolve(val); };
    const timer = setTimeout(() => finish({ stripped: 0, timedOut: true }), CHECK_TIMEOUT_MS);

    const restageChanged = () => {
      let changed = 0;
      for (const f of files) {
        // `git diff --quiet` exits 1 when the working file differs from the
        // index — i.e. the pass actually edited it. Re-stage only those.
        try {
          execFileSync('git', ['diff', '--quiet', '--', f], { cwd: worktreePath, stdio: 'pipe' });
        } catch {
          try { execFileSync('git', ['add', '--', f], { cwd: worktreePath, stdio: 'pipe' }); changed++; } catch {}
        }
      }
      return changed;
    };

    const sender = {
      isDestroyed: () => false,
      once: () => {},
      send: (channel, payload) => {
        if (channel.startsWith('comment-strip-chunk-')) {
          if (typeof payload === 'string') text += payload;
        } else if (channel.startsWith('comment-strip-done-')) {
          clearTimeout(timer);
          if (payload && (payload.error || payload.cancelled)) return finish({ stripped: 0 });
          const changed = restageChanged();
          if (changed) notifyWindows({ type: 'comments-stripped', worktreePath, wtName: path.basename(worktreePath), count: changed });
          finish({ stripped: changed, skippedUnstaged: skippedUnstaged.length, summary: text.trim() });
        }
      },
    };

    try {
      const started = spawnClaudeStream({
        requestId,
        procMap,
        channelPrefix: 'comment-strip',
        sender,
        cwd: worktreePath,
        prompt: stripPrompt(files, d.diff, skill && skill.cleanupBody),
        streamJson: false,
        provider: provider || 'claude',
        allowEdits: true,            // the whole point — it edits the staged files
        promptConsent: false,        // never pop a dialog from a hook context
      });
      if (started === null) { clearTimeout(timer); finish({ stripped: 0 }); }
    } catch (e) {
      clearTimeout(timer);
      finish({ stripped: 0, error: e.message });
    }
  });
}

// Staged-diff gate (Commit button + pre-commit hook). When stripComments is on,
// clean verbose comments out of the staged code BEFORE reviewing, so the review
// (and the commit) see the tidied diff.
async function runStagedCheck({ worktreePath, provider }) {
  let cfg = {};
  try { cfg = loadConfig(); } catch { /* defaults below */ }
  // On by default — only an explicit false opts out.
  if (cfg.stripComments !== false) {
    try { await stripStagedComments({ worktreePath, provider }); } catch { /* never block the commit */ }
  }
  // Strip can be enabled without the review; in that case there's nothing to
  // report (the strip already tidied the diff), so skip the review pass.
  if (cfg.preCommitReview === false) return { skipped: true, reason: 'review disabled' };
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
