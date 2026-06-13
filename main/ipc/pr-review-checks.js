// PR-review CI/checks IPC: the status rollup, required contexts, workflow
// list/dispatch, run log tail/cancel/rerun, and check annotations for the
// PR-review surface. Split out of pr-review.js; required for its
// ipcMain.handle side effects.

const { ipcMain } = require('electron');
const { execFile, execFileSync, spawn } = require('child_process');
const { ghExec, ghExecP, appendStderr, execFileP } = require('../util/exec');
const { ghJson, ghText } = require('../util/gh-json');
const { prReview, currentRepoPath, ensureWorktreeForActivePr } = require('../state/pr-review');
const { bucketFromState, normalizeCheckRun, normalizeStatus } = require('../util/check-normalize');

// G6: CI checks scoped to the PR review surface. `gh pr checks -R …`
// mangles the repo name in its GraphQL query on some gh versions. Using
// `gh pr view -R … --json statusCheckRollup` reads the same rollup through a
// different code path that handles the -R flag cleanly, and reshapes to the
// { name, state, bucket, link, workflow, description } shape the renderer
// already knows how to draw.
ipcMain.handle('pr-review-checks', async () => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { meta, baseOwner, baseRepo } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const sha = meta && meta.headRefOid;
  if (!sha) return { checks: [], error: 'Missing head commit sha' };
  const cwd = currentRepoPath() || require('os').homedir();

  // REST endpoint is more forgiving than gh's GraphQL path for this repo
  // (which throws "Could not resolve to a Repository" on both `gh pr checks`
  // and a custom gh api graphql call). Runs + statuses are separate APIs,
  // so we fetch both in parallel and merge.
  async function run(args) {
    return new Promise((resolve) => {
      execFile('gh', ['api'].concat(args), { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
        (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    });
  }
  const [runsRes, statusRes] = await Promise.all([
    run([`repos/${baseOwner}/${baseRepo}/commits/${sha}/check-runs`, '--paginate']),
    run([`repos/${baseOwner}/${baseRepo}/commits/${sha}/status`]),
  ]);

  const checks = [];
  const parseErrors = [];
  if (!runsRes.err) {
    try {
      const parsed = JSON.parse(runsRes.stdout);
      const runs = parsed.check_runs || [];
      runs.forEach((r) => checks.push(normalizeCheckRun(r)));
    } catch (e) {
      parseErrors.push('check-runs parse: ' + (e.message || String(e)));
      console.error('[pr-review-checks] check-runs parse error:', e.message,
        '— first 200 chars of stdout:', String(runsRes.stdout || '').slice(0, 200));
    }
  }
  if (!statusRes.err) {
    try {
      const parsed = JSON.parse(statusRes.stdout);
      const statuses = parsed.statuses || [];
      statuses.forEach((s) => checks.push(normalizeStatus(s)));
    } catch (e) {
      parseErrors.push('status parse: ' + (e.message || String(e)));
      console.error('[pr-review-checks] status parse error:', e.message,
        '— first 200 chars of stdout:', String(statusRes.stdout || '').slice(0, 200));
    }
  }

  // Only surface an error if BOTH APIs failed — previously `||` meant that
  // a legitimate "no checks" response from one endpoint plus a transient
  // failure on the other was reported as an error, swallowing real data.
  // Also surface JSON parse failures: an HTML auth-redirect coming back as
  // 200 would otherwise look identical to "no checks reported" and silently
  // green-light the required-checks gate.
  if (checks.length === 0) {
    if (runsRes.err && statusRes.err) {
      const first = runsRes.err || statusRes.err;
      const raw = (first.stderr ? first.stderr.toString() : first.message) || '';
      return { checks: [], error: raw.trim() };
    }
    if (parseErrors.length > 0) {
      return { checks: [], error: 'Could not parse GitHub check responses: ' + parseErrors.join('; ') };
    }
  }
  return { checks };
});

// Returns the list of required status-check contexts on the PR's base branch,
// for the "X/Y required passing" gate. A 404 from the protection endpoint just
// means no protection rules — return an empty list rather than an error.
async function fetchRequiredContexts(cwd, baseOwner, baseRepo, baseBranch) {
  if (!baseOwner || !baseRepo || !baseBranch) return { required: [] };
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['api', `repos/${baseOwner}/${baseRepo}/branches/${baseBranch}/protection/required_status_checks`],
      { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 12000 },
      (err, stdout, stderr) => {
        if (err) {
          const raw = (stderr || err.message || '').toString();
          // 404 = no protection or branch not protected. Not an error from the user's POV.
          if (/404|Not Found|HTTP 404/i.test(raw) || /Branch not protected/i.test(raw)) {
            return resolve({ required: [] });
          }
          return resolve({ required: [], error: raw.trim() });
        }
        try {
          const parsed = JSON.parse(stdout);
          resolve({ required: parsed.contexts || [] });
        } catch (e) {
          // Garbage from gh would otherwise be indistinguishable from a 404
          // (no protection) — and the renderer would falsely say "no required
          // checks" + green-light merges. Surface as an error so it can be
          // shown in the gate UI as "unknown" rather than "none".
          console.error('[fetchRequiredContexts] JSON parse error:', e.message,
            '— first 200 chars of stdout:', String(stdout || '').slice(0, 200));
          resolve({ required: [], error: 'Could not parse required-checks response: ' + e.message });
        }
      },
    );
  });
}

ipcMain.handle('pr-review-required-checks', async () => {
  if (!prReview.active) return { required: [] };
  const { meta, baseOwner, baseRepo } = prReview.active;
  const baseBranch = meta && meta.baseRefName;
  const cwd = currentRepoPath() || require('os').homedir();
  return fetchRequiredContexts(cwd, baseOwner, baseRepo, baseBranch);
});

ipcMain.handle('pr-required-checks', async (_event, { worktreePath, prNumber }) => {
  try {
    const meta = JSON.parse(ghExec(
      ['pr', 'view', String(prNumber), '--json', 'baseRefName'],
      { cwd: worktreePath, stdio: 'pipe', timeout: 10000 },
    ).toString());
    const repoResult = JSON.parse(ghExec(
      ['repo', 'view', '--json', 'nameWithOwner'],
      { cwd: worktreePath, stdio: 'pipe', timeout: 10000 },
    ).toString());
    const [baseOwner, baseRepo] = (repoResult.nameWithOwner || '').split('/');
    return fetchRequiredContexts(worktreePath, baseOwner, baseRepo, meta.baseRefName);
  } catch (err) {
    return { required: [], error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// Rerun all failed jobs in a workflow run. Maps to `gh run rerun --failed`.
ipcMain.handle('pr-review-run-rerun-failed', async (_event, { runId }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo } = prReview.active;
  if (!runId) return { error: 'Missing runId' };
  const cwd = currentRepoPath() || require('os').homedir();
  try {
    ghExec(['run', 'rerun', String(runId), '--failed', '-R', `${baseOwner}/${baseRepo}`], {
      cwd, stdio: 'pipe', timeout: 30000,
    });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// List active workflows on the base repo for manual dispatch. Filters to
// state=active so disabled workflows don't show up in the picker.
ipcMain.handle('pr-review-workflows-list', async () => {
  if (!prReview.active) return { workflows: [] };
  const { baseOwner, baseRepo } = prReview.active;
  if (!baseOwner || !baseRepo) return { workflows: [], error: 'Could not determine base repo' };
  const cwd = currentRepoPath() || require('os').homedir();
  try {
    const { stdout } = await execFileP(
      'gh', ['api', `repos/${baseOwner}/${baseRepo}/actions/workflows`, '--paginate'],
      { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 15000 },
    );
    const parsed = JSON.parse(stdout);
    const list = (parsed.workflows || []).filter((w) => w.state === 'active').map((w) => ({
      id: w.id, name: w.name, path: w.path, state: w.state,
    }));
    return { workflows: list };
  } catch (err) {
    return { workflows: [], error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// Manually dispatch a workflow_dispatch-eligible workflow. `inputs` is a JSON
// object of string values keyed by the input names the workflow declares.
// GitHub returns 422 if the workflow doesn't have workflow_dispatch enabled
// or if required inputs are missing.
ipcMain.handle('pr-review-workflow-dispatch', async (_event, { workflowId, ref, inputs }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, meta } = prReview.active;
  if (!workflowId) return { error: 'Missing workflowId' };
  const useRef = (ref && ref.trim()) || (meta && meta.headRefName) || '';
  if (!useRef) return { error: 'Missing ref' };
  const cwd = currentRepoPath() || require('os').homedir();

  // gh api -X POST with `--input -` reads a JSON body from stdin. We build
  // the body ourselves so input types beyond strings (numbers/booleans) round-trip
  // correctly even though GitHub coerces everything to strings on the workflow side.
  const body = JSON.stringify({ ref: useRef, inputs: inputs || {} });
  return new Promise((resolve) => {
    const child = execFile(
      'gh', ['api', '-X', 'POST',
        `repos/${baseOwner}/${baseRepo}/actions/workflows/${workflowId}/dispatches`,
        '--input', '-'],
      { cwd, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) return resolve({ error: (stderr || err.message || '').toString().trim() });
        resolve({ ok: true });
      },
    );
    child.stdin.write(body);
    child.stdin.end();
  });
});

// In-progress workflow run log tail. Polls `gh run view --log` every 3s and
// emits deltas to the renderer. Stops when the run completes, the log exceeds
// 10 MB, or the renderer explicitly stops the watcher. Tier-2 feature — the
// full log is re-downloaded each tick because there's no incremental endpoint.
const watchedRunLogs = new Map(); // requestId -> { stop }

ipcMain.handle('pr-review-run-log-watch-start', async (event, { requestId, runId }) => {
  if (!requestId || !runId) return { error: 'Missing requestId or runId' };
  if (watchedRunLogs.has(requestId)) return { error: 'Already watching this requestId' };
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo } = prReview.active;
  const cwd = currentRepoPath() || require('os').homedir();
  const sender = event.sender;

  let lastLen = 0;
  let stopped = false;
  let timer = null;
  // Track consecutive failures across both subcalls so a sustained problem
  // (auth error, 403 rate limit, wrong runId, gh missing) ends the watcher
  // with a real error instead of spinning forever showing no output. A run
  // that hasn't started its first job will return errors transiently — the
  // counter resets on any healthy tick.
  const MAX_CONSECUTIVE_FAILURES = 3;
  let consecutiveFailures = 0;
  let lastFailureMsg = '';

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    watchedRunLogs.delete(requestId);
  }

  function fail(reason) {
    if (!sender.isDestroyed()) {
      sender.send(`pr-review-run-log-done-${requestId}`, {
        error: 'Log tail failed: ' + (reason || 'unknown error'),
      });
    }
    stop();
  }

  async function tick() {
    if (stopped) return;
    let tickHadFailure = false;
    try {
      const { stdout } = await execFileP(
        'gh', ['run', 'view', String(runId), '-R', `${baseOwner}/${baseRepo}`, '--log'],
        { cwd, maxBuffer: 12 * 1024 * 1024, timeout: 15000 },
      );
      if (stopped) return;
      const text = String(stdout || '');
      if (text.length > 10 * 1024 * 1024) {
        sender.send(`pr-review-run-log-done-${requestId}`, {
          truncated: true,
          message: 'Log exceeded 10 MB; stopped tailing.',
        });
        stop();
        return;
      }
      if (text.length > lastLen) {
        const delta = text.slice(lastLen);
        lastLen = text.length;
        if (!sender.isDestroyed()) {
          sender.send(`pr-review-run-log-chunk-${requestId}`, delta);
        }
      }
    } catch (err) {
      tickHadFailure = true;
      lastFailureMsg = ((err && (err.stderr || err.message)) || String(err)).toString().trim();
      console.error('[pr-review-run-log-watch] log fetch failed:', lastFailureMsg);
    }

    if (stopped) return;
    // Poll status separately so a still-fetching log doesn't keep the watcher
    // alive past completion.
    try {
      const { stdout: statusOut } = await execFileP(
        'gh', ['run', 'view', String(runId), '-R', `${baseOwner}/${baseRepo}`,
          '--json', 'status,conclusion'],
        { cwd, timeout: 8000 },
      );
      const meta = JSON.parse(statusOut);
      if (meta.status === 'completed') {
        if (!sender.isDestroyed()) {
          sender.send(`pr-review-run-log-done-${requestId}`, {
            status: meta.status, conclusion: meta.conclusion,
          });
        }
        stop();
        return;
      }
      // Status poll worked. If log fetch also worked this tick the run is
      // healthy — reset the counter. If only the log fetch failed, the run
      // is live and the log endpoint is just flaky; don't burn the budget
      // on that.
      if (!tickHadFailure) consecutiveFailures = 0;
    } catch (err) {
      tickHadFailure = true;
      lastFailureMsg = ((err && (err.stderr || err.message)) || String(err)).toString().trim();
      console.error('[pr-review-run-log-watch] status poll failed:', lastFailureMsg);
    }

    if (stopped) return;
    if (tickHadFailure) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        fail(lastFailureMsg);
        return;
      }
    }
    timer = setTimeout(tick, 3000);
  }

  watchedRunLogs.set(requestId, { stop });
  tick();
  return { ok: true };
});

ipcMain.handle('pr-review-run-log-watch-stop', (_event, { requestId }) => {
  const w = watchedRunLogs.get(requestId);
  if (!w) return { ok: true };
  w.stop();
  return { ok: true };
});

// Cancel an in-progress workflow run. Maps to `gh run cancel`.
ipcMain.handle('pr-review-run-cancel', async (_event, { runId }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo } = prReview.active;
  if (!runId) return { error: 'Missing runId' };
  const cwd = currentRepoPath() || require('os').homedir();
  try {
    ghExec(['run', 'cancel', String(runId), '-R', `${baseOwner}/${baseRepo}`], {
      cwd, stdio: 'pipe', timeout: 30000,
    });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// Lazy fetch of check-run annotations for a single failing check. Renderer
// calls this when the user expands a failing row, so we don't pay N round-trips
// on every Checks-tab open.
ipcMain.handle('pr-review-check-annotations', async (_event, { checkRunId }) => {
  if (!prReview.active) return { annotations: [] };
  const { baseOwner, baseRepo } = prReview.active;
  if (!baseOwner || !baseRepo || !checkRunId) {
    return { annotations: [], error: 'Missing repo or check id' };
  }
  const cwd = currentRepoPath() || require('os').homedir();
  // Drop --paginate: the annotations endpoint returns a single JSON array
  // (no Link header on the typical first-page-and-only-page response), and
  // some gh versions exit non-zero when there's nothing to paginate.
  const args = ['api', `repos/${baseOwner}/${baseRepo}/check-runs/${checkRunId}/annotations`];
  try {
    const { stdout } = await execFileP('gh', args, {
      cwd, maxBuffer: 4 * 1024 * 1024, timeout: 10000,
    });
    const arr = JSON.parse(stdout);
    return {
      annotations: (Array.isArray(arr) ? arr : []).map((a) => ({
        path: a.path || '',
        startLine: a.start_line || null,
        endLine: a.end_line || null,
        level: a.annotation_level || 'notice',
        title: a.title || '',
        message: a.message || '',
        rawDetails: a.raw_details || '',
      })),
    };
  } catch (err) {
    // gh exits non-zero on 403 (token scope), 404 (no annotations / wrong id),
    // and on plain network failures. Surface the *useful* part of stderr —
    // err.stderr usually has the actual gh message; err.message tends to be
    // "Command failed: gh api … — exit code 1" which tells the user nothing.
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    const message = err.message || '';
    console.error('[pr-review-check-annotations] gh failed:',
      'cmd=', 'gh ' + args.join(' '),
      'stderr=', stderr || '(empty)',
      'message=', message);
    let userMsg = stderr || message || 'Annotations fetch failed';
    if (/HTTP 404|Not Found/i.test(userMsg)) {
      // 404 on this endpoint means "no annotations on this check-run."
      // Treat as empty rather than an error — common, not a problem.
      return { annotations: [] };
    }
    if (/HTTP 403/i.test(userMsg)) {
      userMsg = 'Permission denied — token may need the `checks:read` scope. ('
        + userMsg.replace(/\s+/g, ' ').slice(0, 200) + ')';
    } else if (/exit (status |code )?1/i.test(userMsg) && !stderr) {
      userMsg = 'gh exited with code 1 (no stderr). Try running this manually:\n'
        + '  gh ' + args.join(' ');
    }
    return { annotations: [], error: userMsg };
  }
});
