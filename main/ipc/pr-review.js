// All Phase G PR-review IPC handlers (30 pr-* endpoints: list, load, threads,
// checks, merge, checkout, cache, comments, reviews, pop-out, fix-in-terminal,
// etc.) plus the ghJson / ghText helpers they share. State + fetch helpers
// live in main/state/pr-review.js — this file is the API surface the
// renderer talks to.

const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { app, ipcMain, BrowserWindow } = require('electron');
const { loadConfig, saveConfig } = require('../util/config');
const { ghExec, ghExecP, appendStderr, execFileP } = require('../util/exec');
const { instances, spawnInWorktree } = require('../state/instances');
const { hardenWindow } = require('../state/windows');
const {
  prReview,
  broadcastPrReview, sanitizePrReview, currentRepoPath, parseBaseFromUrl,
  pushReviewHistory, fetchThreadsForActive, reloadActivePrReviewMeta,
  findProjectForRepo, findWorktreeForBranch, findWorktreeForBranchAcrossClones,
  ensureWorktreeForActivePr,
} = require('../state/pr-review');
const { execFileSync } = require('child_process');

function ghJson(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error('gh returned non-JSON: ' + stdout.slice(0, 200))); }
    });
  });
}

// reloadActivePrReviewMeta (in state/pr-review.js) needs ghJson. Wire it
// up now that this module defines it — breaks the earlier chicken-and-egg
// without forcing main.js to inject it on our behalf.
require('../state/pr-review').setDeps({ ghJson });

function ghText(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
  });
}

ipcMain.handle('pr-list', async () => {
  const cwd = currentRepoPath();
  if (!cwd) return { error: 'No active project. Add a project first.' };
  try {
    const prs = await ghJson([
      'pr', 'list',
      '--json', 'number,title,author,state,updatedAt,headRefName,baseRefName,isDraft,reviewDecision,url',
      '--limit', '50',
    ], cwd);
    return { prs };
  } catch (err) {
    return { error: (err.stderr || err.message || '').trim() };
  }
});

ipcMain.handle('pr-lookup-url', async (_event, { url }) => {
  // gh just needs a valid cwd (any git repo or non-repo dir works for a
  // URL-targeted call). Falling back to homedir lets reviewers use Klaussy
  // without first adding a klausify project.
  const cwd = currentRepoPath() || require('os').homedir();
  try {
    const meta = await ghJson([
      'pr', 'view', url,
      '--json', 'number,title,author,state,updatedAt,headRefName,baseRefName,isDraft,reviewDecision,url,body,headRepository,headRepositoryOwner',
    ], cwd);
    return { meta };
  } catch (err) {
    return { error: (err.stderr || err.message || '').trim() };
  }
});

ipcMain.handle('pr-load', async (_event, { number, url }) => {
  // URL-form calls don't need an active project — gh derives the repo from
  // the URL. The number-only form (used by the picker's "open in current
  // project" list) does, since gh resolves it against the cwd's origin.
  if (!url && !currentRepoPath()) {
    return { error: 'Add a project to look up PRs by number, or paste a full PR URL.' };
  }
  const cwd = currentRepoPath() || require('os').homedir();
  const target = url || String(number);
  try {
    const [meta, diff] = await Promise.all([
      ghJson([
        'pr', 'view', target,
        '--json', 'number,title,author,state,createdAt,updatedAt,headRefName,baseRefName,headRefOid,isDraft,reviewDecision,url,body,headRepository,headRepositoryOwner,mergeable,mergeStateStatus',
      ], cwd),
      ghText(['pr', 'diff', target], cwd),
    ]);
    const base = parseBaseFromUrl(meta.url);
    const repo = base ? `${base.owner}/${base.name}` : null;
    prReview.active = {
      repo, number: meta.number, meta, diff,
      baseOwner: base ? base.owner : null,
      baseRepo: base ? base.name : null,
      threads: null, // null = loading, [] = loaded-empty
      threadsError: null,
      popout: null,
    };
    broadcastPrReview();

    // Record this PR in review history (most recent first, deduped by URL,
    // capped at 20). Separate from load-path so a storage hiccup can't break
    // the review UI.
    try { pushReviewHistory(meta); } catch (_) {}

    // Fire-and-forget thread fetch; broadcasts again when ready so the renderer
    // can paint the shell immediately without waiting on the GraphQL round-trip.
    fetchThreadsForActive();

    return { ok: true };
  } catch (err) {
    return { error: (err.stderr || err.message || '').trim() };
  }
});

ipcMain.handle('pr-recent', () => {
  const config = loadConfig();
  return { items: config.reviewHistory || [] };
});

ipcMain.handle('pr-refresh-threads', async () => {
  if (!prReview.active) return { error: 'No active PR review' };
  await fetchThreadsForActive();
  return { ok: true };
});

// "Pull updates" — re-fetch meta+diff from GitHub, refresh comment threads,
// and (if the PR has an existing worktree) fast-forward it to the latest
// commit. Single round-trip the renderer can wire to a button.
ipcMain.handle('pr-pull-updates', async () => {
  if (!prReview.active) return { error: 'No active PR review' };
  const url = prReview.active.meta && prReview.active.meta.url;
  if (!url) return { error: 'Active PR has no URL' };
  const cwd = currentRepoPath() || require('os').homedir();

  let metaError = null;
  try {
    const [meta, diff] = await Promise.all([
      ghJson([
        'pr', 'view', url,
        '--json', 'number,title,author,state,createdAt,updatedAt,headRefName,baseRefName,headRefOid,isDraft,reviewDecision,url,body,headRepository,headRepositoryOwner,mergeable,mergeStateStatus',
      ], cwd),
      ghText(['pr', 'diff', url], cwd),
    ]);
    // Bail if the active PR changed underneath us mid-fetch.
    if (!prReview.active || prReview.active.meta.url !== url) {
      return { error: 'Active PR changed during refresh' };
    }
    prReview.active.meta = Object.assign({}, prReview.active.meta, meta);
    prReview.active.diff = diff;
    broadcastPrReview();
  } catch (err) {
    metaError = (err.stderr || err.message || '').trim();
  }

  // Threads — fire-and-await so the toast we return reflects post-refresh state.
  try { await fetchThreadsForActive(); } catch (_) {}

  // Worktree refresh — only if one already exists. We reach into
  // ensureWorktreeForActivePr's "existing worktree" branch by calling it; it
  // returns refreshed: 'updated' | 'up-to-date' | 'kept-local' | 'fetch-failed'
  // when existed=true, undefined when it had to create one.
  let worktreeRefreshed = 'no-worktree';
  try {
    const ensured = await ensureWorktreeForActivePr();
    if (!ensured.error && ensured.existed && ensured.refreshed) {
      worktreeRefreshed = ensured.refreshed;
    }
  } catch (_) {}

  return { ok: true, metaError, worktreeRefreshed };
});

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
  if (!runsRes.err) {
    try {
      const parsed = JSON.parse(runsRes.stdout);
      const runs = parsed.check_runs || [];
      runs.forEach((r) => checks.push(normalizeCheckRun(r)));
    } catch (_) {}
  }
  if (!statusRes.err) {
    try {
      const parsed = JSON.parse(statusRes.stdout);
      const statuses = parsed.statuses || [];
      statuses.forEach((s) => checks.push(normalizeStatus(s)));
    } catch (_) {}
  }

  // Only surface an error if BOTH APIs failed — previously `||` meant that
  // a legitimate "no checks" response from one endpoint plus a transient
  // failure on the other was reported as an error, swallowing real data.
  if (checks.length === 0 && runsRes.err && statusRes.err) {
    const first = runsRes.err || statusRes.err;
    const raw = (first.stderr ? first.stderr.toString() : first.message) || '';
    return { checks: [], error: raw.trim() };
  }
  return { checks };
});

function bucketFromState(rawState) {
  const s = (rawState || '').toLowerCase();
  if (s === 'success' || s === 'neutral') return 'pass';
  if (s === 'failure' || s === 'timed_out' || s === 'action_required' || s === 'error') return 'fail';
  if (s === 'cancelled') return 'cancel';
  if (s === 'skipped') return 'skipping';
  if (['queued', 'in_progress', 'pending', 'waiting', 'expected', 'requested'].includes(s)) return 'pending';
  return 'pending';
}

function normalizeCheckRun(r) {
  // GitHub REST check-run: { name, status, conclusion, details_url, output: {...}, app: { name }, ... }
  const rawState = (r.conclusion || r.status || '').toLowerCase();
  return {
    name: r.name || '(unnamed)',
    state: rawState,
    bucket: bucketFromState(rawState),
    link: r.details_url || r.html_url || '',
    workflow: (r.app && r.app.name) || '',
    description: (r.output && r.output.title) || '',
  };
}

function normalizeStatus(s) {
  // Legacy REST status: { context, state, target_url, description, ... }
  return {
    name: s.context || '(unnamed)',
    state: (s.state || '').toLowerCase(),
    bucket: bucketFromState(s.state),
    link: s.target_url || '',
    workflow: '',
    description: s.description || '',
  };
}




ipcMain.handle('pr-review-merge', async (_event, { strategy }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const flag = { merge: '--merge', squash: '--squash', rebase: '--rebase' }[strategy];
  if (!flag) return { error: 'Unknown merge strategy: ' + strategy };
  const { meta } = prReview.active;
  if (!meta || !meta.url) return { error: 'Could not determine PR URL' };
  const cwd = currentRepoPath() || require('os').homedir();
  try {
    // URL form bypasses gh's buggy -R repo resolution (see pr-review-checks
    // for the failure mode we're avoiding).
    ghExec(['pr', 'merge', meta.url, flag], {
      cwd, stdio: 'pipe', timeout: 30000,
    });
    await reloadActivePrReviewMeta();
    fetchThreadsForActive();
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// G5: materialize the PR as a worktree + spawn a task in it.
ipcMain.handle('pr-checkout-locally', async () => {
  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };
  const { worktreePath, branch } = ensured;
  const { number, baseOwner, baseRepo } = prReview.active;

  // Already tracked as a task? Focus it instead of spawning a duplicate.
  const existingTask = Array.from(instances.values()).find(i => i.worktreePath === worktreePath);
  let payload;
  if (existingTask) {
    if (!existingTask.prNumber) existingTask.prNumber = number;
    if (!existingTask.prBaseOwner) existingTask.prBaseOwner = baseOwner;
    if (!existingTask.prBaseRepo) existingTask.prBaseRepo = baseRepo;
    payload = {
      id: existingTask.id, name: existingTask.name,
      worktreePath: existingTask.worktreePath, branch: existingTask.branch, mode: existingTask.mode,
    };
  } else {
    const task = spawnInWorktree(branch, worktreePath, branch, 'claude', null, null, number);
    const inst = instances.get(task.id);
    if (inst) {
      inst.prBaseOwner = baseOwner;
      inst.prBaseRepo = baseRepo;
    }
    payload = task;
  }

  // Exit review mode first so the task grid is visible again, THEN announce
  // the new task so the main-window listener can focus it without fighting
  // the review-mode takeover.
  if (prReview.active && prReview.active.popout && !prReview.active.popout.isDestroyed()) {
    prReview.active.popout.close();
  }
  prReview.active = null;
  broadcastPrReview();

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('pr-checkout-ready', payload);
  }
  return { ok: true, task: payload, reused: !!existingTask, refreshed: ensured.refreshed };
});



// G7 persistence: cache a PR's AI review + per-finding state by
// (owner, repo, number) so re-opening a PR (or restarting the app) restores
// the prior review and the user's Ignore / Implemented marks.
function reviewCachePathFor(owner, repo, number) {
  const dir = path.join(app.getPath('userData'), 'pr-review-cache');
  const safe = `${owner}-${repo}-${number}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return { dir, file: path.join(dir, safe + '.json') };
}

// Read a file inside the PR review's worktree. Used by the renderer to
// verify that AI-reported line numbers actually contain the quoted snippet —
// LLMs routinely get line numbers wrong, and reading the file lets us snap
// the finding to the real line before posting. Hard-scoped to worktreePath:
// the resolved absolute path must start with the resolved worktreePath, or
// we refuse (blocks `..` traversal and symlink games).
ipcMain.handle('pr-review-read-file', (_event, { worktreePath, relPath }) => {
  if (!worktreePath || !relPath) return { error: 'Missing worktreePath or relPath' };
  try {
    const rootReal = fs.realpathSync(worktreePath);
    const target = path.resolve(rootReal, relPath);
    const targetReal = fs.existsSync(target) ? fs.realpathSync(target) : target;
    if (!targetReal.startsWith(rootReal + path.sep) && targetReal !== rootReal) {
      return { error: 'Path outside worktree' };
    }
    if (!fs.existsSync(targetReal)) return { error: 'File not found' };
    const stat = fs.statSync(targetReal);
    // Guard against pathologically large files — line verification only
    // needs the first ~2MB of text content.
    if (stat.size > 2 * 1024 * 1024) return { error: 'File too large' };
    const content = fs.readFileSync(targetReal, 'utf8');
    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('pr-review-cache-get-by-pr', (_event, { owner, repo, number }) => {
  if (!owner || !repo || !number) return { cached: null };
  const { file } = reviewCachePathFor(owner, repo, number);
  try {
    if (!fs.existsSync(file)) return { cached: null };
    const raw = fs.readFileSync(file, 'utf8');
    return { cached: JSON.parse(raw) };
  } catch (err) {
    return { cached: null, error: err.message };
  }
});

ipcMain.handle('pr-review-cache-save-by-pr', (_event, { owner, repo, number, data }) => {
  if (!owner || !repo || !number) return { ok: false, error: 'Missing key' };
  const { dir, file } = reviewCachePathFor(owner, repo, number);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('pr-review-cache-clear-by-pr', (_event, { owner, repo, number }) => {
  if (!owner || !repo || !number) return { ok: false };
  const { file } = reviewCachePathFor(owner, repo, number);
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
  return { ok: true };
});

// G4: post all pending review comments + decision as one review. The GitHub
// REST endpoint accepts `comments` inline so we only make one network call.
// Piping JSON on stdin avoids shell-escaping pain for multiline comment
// bodies.
// General issue comment on the PR — no line context, just a body.
ipcMain.handle('pr-add-issue-comment', async (_event, { body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/issues/${number}/comments`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.

  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try {
            const parsed = JSON.parse(stdoutBuf);
            if (parsed.message) msg = parsed.message;
          } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

// Patch an existing issue comment. `commentId` is the REST numeric id
// (GraphQL exposes it as databaseId). Posts to the `/issues/comments/{id}`
// REST endpoint — distinct from review comments which live under `/pulls/`.
ipcMain.handle('pr-edit-issue-comment', async (_event, { commentId, body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const id = parseInt(commentId, 10);
  if (!id) return { error: 'Missing or invalid comment id' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/issues/comments/${id}`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.
  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'PATCH', '--input', '-'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try { const p = JSON.parse(stdoutBuf); if (p.message) msg = p.message; } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true, body });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

// Patch an existing inline/review comment. Separate endpoint from issue
// comments: `/repos/{o}/{r}/pulls/comments/{id}`.
ipcMain.handle('pr-edit-review-comment', async (_event, { commentId, body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const id = parseInt(commentId, 10);
  if (!id) return { error: 'Missing or invalid comment id' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/comments/${id}`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.
  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'PATCH', '--input', '-'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try { const p = JSON.parse(stdoutBuf); if (p.message) msg = p.message; } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true, body });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

// Cache the current gh-authed user so we only show the edit control on
// comments this user can actually modify. gh api /user is the cheap
// canonical endpoint; we call it once per review session.
let cachedCurrentUser = null;
ipcMain.handle('pr-current-user', async () => {
  if (cachedCurrentUser) return { login: cachedCurrentUser };
  try {
    const out = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      stdio: 'pipe', timeout: 10000,
    }).toString().trim();
    if (out) cachedCurrentUser = out;
    return { login: cachedCurrentUser };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// Reply to a specific review comment (threaded). `inReplyTo` is the parent
// comment's REST databaseId — the same id GraphQL returns on each review
// comment so we can thread using data we already fetch. Uses GitHub's
// dedicated replies endpoint so we don't have to fake a new-comment shape.
ipcMain.handle('pr-reply-to-review-comment', async (_event, { inReplyTo, body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const parentId = parseInt(inReplyTo, 10);
  if (!parentId) return { error: 'Missing or invalid parent comment id' };
  if (!body || !body.trim()) return { error: 'Reply body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/${number}/comments/${parentId}/replies`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.

  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try {
            const parsed = JSON.parse(stdoutBuf);
            if (parsed.message) msg = parsed.message + (parsed.errors ? ': ' + JSON.stringify(parsed.errors) : '');
          } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

ipcMain.handle('pr-submit-review', async (_event, { event, body, comments }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  if (!event) return { error: 'Missing review event (APPROVE / REQUEST_CHANGES / COMMENT)' };

  // Split incoming drafts: inline review comments go in the review payload;
  // issueComment:true drafts (Claude-implement follow-ups whose location
  // couldn't be verified) post after the review as general PR comments.
  const rawComments = comments || [];
  const inlineComments = rawComments.filter((c) => !c.issueComment);
  const issueCommentDrafts = rawComments.filter((c) => c.issueComment);

  const payload = {
    event,
    body: body || '',
    comments: inlineComments.map((c) => {
      const out = {
        path: c.path,
        body: c.body,
        side: c.side || 'RIGHT',
      };
      // GitHub requires `line` always; `start_line` only for multi-line.
      if (typeof c.line === 'number') out.line = c.line;
      if (typeof c.startLine === 'number' && c.startLine !== c.line) {
        out.start_line = c.startLine;
        out.start_side = c.startSide || out.side;
      }
      return out;
    }),
  };

  const cwd = currentRepoPath() || require('os').homedir();
  const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/${number}/reviews`;
  // `spawn` is imported at the top of the file.

  const reviewResult = await new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        // gh often writes JSON errors to stdout on non-zero exit.
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try {
            const parsed = JSON.parse(stdoutBuf);
            if (parsed.message) msg = parsed.message + (parsed.errors ? ': ' + JSON.stringify(parsed.errors) : '');
          } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true });
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
  if (reviewResult.error) return reviewResult;

  // Post any queued issue-comment drafts sequentially. Failures don't roll
  // back the review; surface them as a partial-success warning so the user
  // can retry manually.
  const issueEndpoint = `repos/${baseOwner}/${baseRepo}/issues/${number}/comments`;
  const issueCommentFailures = [];
  for (const draft of issueCommentDrafts) {
    if (!draft.body || !draft.body.trim()) continue;
    const res = await new Promise((resolve) => {
      const proc = spawn('gh', ['api', issueEndpoint, '--method', 'POST', '--input', '-'], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdoutBuf = '', stderrBuf = '';
      proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
      proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
      proc.on('error', (err) => resolve({ error: err.message }));
      proc.on('exit', (code) => {
        if (code !== 0) {
          let msg = stderrBuf.trim();
          if (stdoutBuf) {
            try {
              const parsed = JSON.parse(stdoutBuf);
              if (parsed.message) msg = parsed.message;
            } catch (_) {}
          }
          resolve({ error: msg || ('gh exited with code ' + code) });
          return;
        }
        resolve({ ok: true });
      });
      proc.stdin.write(JSON.stringify({ body: draft.body }));
      proc.stdin.end();
    });
    if (res.error) issueCommentFailures.push(res.error);
  }

  if (issueCommentFailures.length) {
    return {
      ok: true,
      warning: `Review posted, but ${issueCommentFailures.length} follow-up comment(s) failed: ${issueCommentFailures.join('; ')}`,
    };
  }
  return { ok: true };
});

ipcMain.handle('pr-review-state', () => prReview.active ? sanitizePrReview(prReview.active) : null);

ipcMain.handle('pr-review-close', () => {
  if (prReview.active && prReview.active.popout && !prReview.active.popout.isDestroyed()) {
    prReview.active.popout.close();
  }
  prReview.active = null;
  broadcastPrReview();
  return { ok: true };
});

ipcMain.handle('pop-out-pr-review', () => {
  if (!prReview.active) return { error: 'No active PR review' };
  if (prReview.active.popout && !prReview.active.popout.isDestroyed()) {
    prReview.active.popout.focus();
    return { ok: true };
  }

  const popout = new BrowserWindow({
    width: 1100,
    height: 800,
    title: `Review \u2014 #${prReview.active.number} ${prReview.active.meta.title || ''}`,
    icon: path.join(__dirname, '..', '..', 'icon.icns'),
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(popout);

  popout.loadFile(path.join(__dirname, '..', '..', 'renderer', 'pr-review.html'));
  prReview.active.popout = popout;
  broadcastPrReview();

  popout.on('closed', () => {
    if (prReview.active && prReview.active.popout === popout) {
      prReview.active.popout = null;
      broadcastPrReview();
    }
  });

  return { ok: true };
});

ipcMain.handle('pop-in-pr-review', () => {
  if (prReview.active && prReview.active.popout && !prReview.active.popout.isDestroyed()) {
    prReview.active.popout.close();
  }
  return { ok: true };
});




// ---- Whole-PR AI Review ----

// in userData/pr-review-cache/. Legacy in-config entries are brought forward
// on startup by the v0→v1 config migration (see util/config.js); the
// file-per-PR handlers above are the current read/write path.

// Send text to the Claude terminal for a given worktree (via bracketed paste,
// so multi-line content doesn't submit partial lines). Returns the task id.
ipcMain.handle('pr-fix-in-terminal', (_event, { worktreePath, text }) => {
  // Prefer an alive claude-mode instance; fall back to any alive instance.
  let target = null;
  for (const [, inst] of instances) {
    if (inst.worktreePath === worktreePath && inst.alive && inst.mode === 'claude') { target = inst; break; }
  }
  if (!target) {
    for (const [, inst] of instances) {
      if (inst.worktreePath === worktreePath && inst.alive) { target = inst; break; }
    }
  }
  if (!target) return { error: 'No active task for this worktree. Start a Claude task first.' };

  const BP_START = '\x1b[200~';
  const BP_END = '\x1b[201~';
  // `text` is PR-comment / AI-finding content from untrusted GitHub. If it
  // contains \x1b[201~ (the paste end marker), the shell exits paste mode
  // mid-write and treats the remainder as typed input — which would execute
  // injected commands. Strip the paste-mode sequences from `text` so they
  // cannot break out of the bracket we wrap it in.
  const safeText = typeof text === 'string'
    ? text.replace(/\x1b\[20[01]~/g, '')
    : '';
  try {
    target.pty.write(BP_START + safeText + BP_END);
    return { ok: true, taskId: target.id, mode: target.mode };
  } catch (err) {
    return { error: err.message };
  }
});


// ---- PR Comment AI Review ----


// ---- PR Threaded Reply ----

ipcMain.handle('pr-reply-to-comment', async (_event, { worktreePath, prNumber, commentId, body }) => {
  try {
    const repoResult = ghExec(['repo', 'view', '--json', 'nameWithOwner'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const repo = JSON.parse(repoResult).nameWithOwner;
    ghExec(['api', '-X', 'POST',
      'repos/' + repo + '/pulls/' + prNumber + '/comments',
      '-F', 'in_reply_to=' + commentId,
      '-f', 'body=' + body,
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- PR Interaction ----

ipcMain.handle('pr-for-branch', async (_event, { worktreePath }) => {
  const jsonFields = 'number,title,state,body,url,headRefName,baseRefName,headRefOid,additions,deletions,reviewDecision,comments,reviews,mergeable,mergeStateStatus,isDraft';

  // G5 fast path: if this worktree was created from "Check out locally",
  // look up the PR by its recorded number + base repo. Avoids gh's default
  // branch-matching lookup which fails for cross-repo (fork) PRs and for
  // any situation where the local branch name doesn't match the head ref.
  let hintedInst = null;
  for (const inst of instances.values()) {
    if (inst.worktreePath === worktreePath && inst.prNumber) { hintedInst = inst; break; }
  }
  if (hintedInst) {
    try {
      const args = ['pr', 'view', String(hintedInst.prNumber), '--json', jsonFields];
      if (hintedInst.prBaseOwner && hintedInst.prBaseRepo) {
        args.push('-R', `${hintedInst.prBaseOwner}/${hintedInst.prBaseRepo}`);
      }
      const result = ghExec(args, { cwd: worktreePath, stdio: 'pipe', timeout: 15000 }).toString();
      return { pr: JSON.parse(result) };
    } catch (err) {
      // Fall through to branch-matching lookup if the hinted one errors.
    }
  }

  try {
    const result = ghExec([
      'pr', 'view', '--json', jsonFields,
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 15000 }).toString();
    return { pr: JSON.parse(result) };
  } catch (err) {
    const msg = (err.stderr ? err.stderr.toString() : err.message) || '';
    if (msg.includes('no pull requests found')) {
      return { pr: null };
    }
    if (msg.includes('Could not resolve')) {
      return { pr: null, error: 'Cannot access this repository. Check that `gh` is authenticated with the correct GitHub account.' };
    }
    return { pr: null, error: msg };
  }
});

ipcMain.handle('pr-add-review-comment', async (_event, { worktreePath, prNumber, body, path: filePath, line, side, startLine, startSide, commitId }) => {
  try {
    const repoResult = ghExec(['repo', 'view', '--json', 'nameWithOwner'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const repo = JSON.parse(repoResult).nameWithOwner;
    const args = [
      'api', '--method', 'POST',
      `repos/${repo}/pulls/${prNumber}/comments`,
      '-f', 'body=' + body,
      '-f', 'path=' + filePath,
      '-F', 'line=' + line,
      '-f', 'side=' + (side || 'RIGHT'),
      '-f', 'commit_id=' + commitId,
    ];
    if (startLine && startLine !== line) {
      args.push('-F', 'start_line=' + startLine);
      args.push('-f', 'start_side=' + (startSide || side || 'RIGHT'));
    }
    ghExec(args, { cwd: worktreePath, stdio: 'pipe', timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('pr-merge', async (_event, { worktreePath, prNumber, strategy }) => {
  const flag = { merge: '--merge', squash: '--squash', rebase: '--rebase' }[strategy];
  if (!flag) return { error: 'Unknown merge strategy: ' + strategy };
  try {
    ghExec(['pr', 'merge', String(prNumber), flag], {
      cwd: worktreePath, stdio: 'pipe', timeout: 30000
    });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('pr-checks', async (_event, { worktreePath, prNumber }) => {
  try {
    const out = ghExec(
      ['pr', 'checks', String(prNumber), '--json', 'name,state,bucket,link,workflow,description'],
      { cwd: worktreePath, stdio: 'pipe', timeout: 15000 }
    ).toString();
    return { checks: JSON.parse(out) };
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : err.message;
    // `gh pr checks` exits non-zero when checks are failing — the JSON still
    // prints to stdout. Try to recover from err.stdout before giving up.
    if (err.stdout) {
      try { return { checks: JSON.parse(err.stdout.toString()) }; } catch {}
    }
    // "no checks reported" is not an error
    if (msg && /no checks reported/i.test(msg)) {
      return { checks: [] };
    }
    return { checks: [], error: msg };
  }
});

ipcMain.handle('pr-review-threads', async (_event, { worktreePath, prNumber }) => {
  try {
    const repoResult = ghExec(['repo', 'view', '--json', 'nameWithOwner'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const [owner, repo] = JSON.parse(repoResult).nameWithOwner.split('/');
    const query = 'query($owner: String!, $repo: String!, $number: Int!) {'
      + '  repository(owner: $owner, name: $repo) {'
      + '    pullRequest(number: $number) {'
      + '      reviewThreads(first: 100) {'
      + '        nodes {'
      + '          id isResolved isOutdated path line originalLine startLine originalStartLine diffSide'
      + '          comments(first: 100) { nodes { databaseId author { login } createdAt body diffHunk } }'
      + '        }'
      + '      }'
      + '    }'
      + '  }'
      + '}';
    const out = ghExec([
      'api', 'graphql',
      '-f', 'query=' + query,
      '-f', 'owner=' + owner,
      '-f', 'repo=' + repo,
      '-F', 'number=' + prNumber,
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 15000 }).toString();
    const parsed = JSON.parse(out);
    if (parsed && parsed.errors && parsed.errors.length) {
      return { threads: [], error: parsed.errors.map(e => e.message).join('; ') };
    }
    const threads = (parsed && parsed.data && parsed.data.repository && parsed.data.repository.pullRequest
      && parsed.data.repository.pullRequest.reviewThreads && parsed.data.repository.pullRequest.reviewThreads.nodes) || [];
    return { threads };
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    // `gh api graphql` often writes the JSON error body to stdout even on non-zero exit
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout.toString());
        if (parsed.errors && parsed.errors.length) {
          return { threads: [], error: parsed.errors.map(e => e.message).join('; ') };
        }
      } catch {}
    }
    return { threads: [], error: stderr || err.message };
  }
});

function resolveOrUnresolveThread(worktreePath, threadId, resolve) {
  const mutation = resolve
    ? 'mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }'
    : 'mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }';
  try {
    ghExec([
      'api', 'graphql',
      '-f', 'query=' + mutation,
      '-F', 'id=' + threadId,
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
}

ipcMain.handle('pr-resolve-thread', (_event, { worktreePath, threadId }) => {
  return resolveOrUnresolveThread(worktreePath, threadId, true);
});

ipcMain.handle('pr-unresolve-thread', (_event, { worktreePath, threadId }) => {
  return resolveOrUnresolveThread(worktreePath, threadId, false);
});

ipcMain.handle('pr-add-comment', async (_event, { worktreePath, prNumber, body }) => {
  try {
    ghExec(['pr', 'comment', String(prNumber), '--body', body], {
      cwd: worktreePath, stdio: 'pipe', timeout: 15000
    });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('pr-review', async (_event, { worktreePath, prNumber, event, body }) => {
  try {
    const args = ['pr', 'review', String(prNumber), '--' + event];
    if (body) args.push('--body', body);
    ghExec(args, { cwd: worktreePath, stdio: 'pipe', timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- Local-changes panel: view/commit/push edits made by Claude implements ----
//
// After the user clicks "Implement" on a finding, Claude edits files in the
// PR's worktree but does not commit or push. These three handlers surface
// the resulting working-tree diff and let the user commit + push back to the
// PR's head branch (the contributor's fork's branch — possibly the user's
// own fork, since most reviewers using this on their own PRs).
//
// Lookup-only worktree resolution: ensureWorktreeForActivePr would create a
// worktree as a side effect of opening this panel, which is wrong. We use
// findWorktreeForBranchAcrossClones (introduced for the duplicate-worktree
// fix) and return null when no worktree exists yet.

// Resolve the worktree associated with the active PR. Hint comes from the
// renderer (which captured ensure-worktree's response from a prior implement
// call). The hint is authoritative when it points at a real directory: it
// avoids a cross-clone scan and works when the user's only matching clone
// has its origin set to the head fork (self-PR case), which the
// origin-matches-base lookup misses.
function activePrWorktree(worktreeHint) {
  if (!prReview.active) return null;
  const { number, meta, baseOwner, baseRepo } = prReview.active;
  const branch = (meta && meta.headRefName) || `pr-${number}`;
  if (worktreeHint && fs.existsSync(worktreeHint)) {
    return { worktreePath: worktreeHint, branch };
  }
  if (!baseOwner || !baseRepo) return null;
  const found = findWorktreeForBranchAcrossClones(baseOwner, baseRepo, branch);
  return found ? { worktreePath: found.worktreePath, branch } : null;
}

ipcMain.handle('pr-review-local-state', async (_event, args) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const hint = args && args.worktreeHint;
  const wt = activePrWorktree(hint);
  if (!wt) return { worktreePath: null };
  const { meta } = prReview.active;
  const headRefOid = meta && meta.headRefOid;

  let files = [];
  let diff = '';
  let unpushed = [];
  let unpushedKnown = true;
  let localHead = '';
  let localBranch = wt.branch;

  try {
    const { stdout } = await execFileP('git', ['status', '--porcelain'], {
      cwd: wt.worktreePath, maxBuffer: 5 * 1024 * 1024,
    });
    files = stdout.split('\n').filter(Boolean).map((line) => ({
      status: line.substring(0, 2),
      file: line.substring(3),
    }));
  } catch (err) {
    return { error: 'git status failed: ' + (err.stderr || err.message) };
  }

  if (files.length > 0) {
    try {
      // Combine staged + unstaged so the user sees everything Claude touched.
      const { stdout } = await execFileP('git', ['diff', 'HEAD', '--'], {
        cwd: wt.worktreePath, maxBuffer: 10 * 1024 * 1024,
      });
      diff = stdout;
      // Untracked files (status starts with "??") aren't in `git diff HEAD`.
      // Append a synthetic "new file" diff for each so they're visible too.
      const untracked = files.filter((f) => f.status === '??').map((f) => f.file);
      for (const u of untracked) {
        try {
          const { stdout: nd } = await execFileP('git', ['diff', '--no-index', '/dev/null', u], {
            cwd: wt.worktreePath, maxBuffer: 5 * 1024 * 1024,
          });
          diff += nd;
        } catch (err) {
          // git diff --no-index returns exit 1 when files differ — that's
          // expected, the diff is on stdout.
          if (err.stdout) diff += err.stdout;
        }
      }
    } catch (err) {
      return { error: 'git diff failed: ' + (err.stderr || err.message) };
    }
  }

  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: wt.worktreePath });
    localHead = stdout.trim();
  } catch (_) {}

  if (headRefOid) {
    try {
      const { stdout } = await execFileP(
        'git', ['log', '--format=%H\t%h\t%s', `${headRefOid}..HEAD`],
        { cwd: wt.worktreePath },
      );
      unpushed = stdout.split('\n').filter(Boolean).map((line) => {
        const [hash, short, ...subjectParts] = line.split('\t');
        return { hash, short, subject: subjectParts.join('\t') };
      });
    } catch (_) {
      // Missing the headRefOid commit locally (e.g., user hasn't fetched
      // since the PR was force-pushed) — we can't enumerate the diverging
      // commits, but if HEAD differs from headRefOid we still know the
      // worktree has work the PR hasn't seen. Mark it unknown-but-diverged
      // so the renderer can offer a push button without a commit list.
      unpushedKnown = false;
    }
  }

  // When we couldn't enumerate but the SHAs differ, surface that so the
  // user can still push. (No SHA → no enumeration possible at all → leave
  // unpushed empty and unpushedKnown true.)
  const diverged = !!(headRefOid && localHead && localHead !== headRefOid);

  return {
    worktreePath: wt.worktreePath,
    branch: localBranch,
    files,
    diff,
    unpushed,
    unpushedKnown,
    diverged,
    localHead,
    headRefOid: headRefOid || null,
  };
});

ipcMain.handle('pr-review-commit-local', async (_event, { message, worktreeHint }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  if (!message || !message.trim()) return { error: 'Commit message required' };
  const wt = activePrWorktree(worktreeHint);
  if (!wt) return { error: 'No worktree for this PR yet' };

  try {
    await execFileP('git', ['add', '-A'], { cwd: wt.worktreePath });
  } catch (err) {
    return { error: 'git add failed: ' + (err.stderr || err.message) };
  }
  try {
    // --allow-empty=false is the default; if there's nothing to commit, fail
    // loudly rather than silently producing a no-op commit message.
    const { stdout } = await execFileP('git', ['commit', '-m', message], {
      cwd: wt.worktreePath,
    });
    return { ok: true, output: (stdout || '').trim() };
  } catch (err) {
    return { error: 'git commit failed: ' + (err.stderr || err.message) };
  }
});

ipcMain.handle('pr-review-push-local', async (_event, args) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { meta } = prReview.active;
  const wt = activePrWorktree(args && args.worktreeHint);
  if (!wt) return { error: 'No worktree for this PR yet' };

  // Push target = the PR's head repo + branch. For self-PRs that's the user's
  // fork; for contributor PRs with "Allow edits from maintainers" enabled,
  // it's the contributor's fork. We push by URL+refspec rather than mucking
  // with named remotes so we don't pollute the worktree's remote config.
  const headOwner = meta && meta.headRepositoryOwner && meta.headRepositoryOwner.login;
  const headRepoName = meta && meta.headRepository && meta.headRepository.name;
  const headBranch = meta && meta.headRefName;
  if (!headOwner || !headRepoName || !headBranch) {
    return { error: 'PR head repository/branch missing from metadata — cannot determine push target.' };
  }

  let token = '';
  try {
    token = execFileSync('gh', ['auth', 'token'], { stdio: 'pipe' }).toString().trim();
  } catch (_) {
    return { error: 'Could not read gh auth token — run `gh auth login` first.' };
  }
  const authedUrl = `https://oauth2:${token}@github.com/${headOwner}/${headRepoName}.git`;
  const scrub = (s) => (s || '').replace(/oauth2:[^@]+@/g, 'oauth2:***@');

  try {
    // HEAD:refs/heads/<branch> — pushes the worktree's current commit to the
    // PR branch on the head fork. Non-force: GitHub will reject if the PR
    // has been advanced upstream (force-pushed by the author). The user can
    // re-fetch via the existing "Pull updates" button to recover.
    const { stderr } = await execFileP(
      'git', ['push', authedUrl, `HEAD:refs/heads/${headBranch}`],
      { cwd: wt.worktreePath, timeout: 60000 },
    );
    return {
      ok: true,
      target: `${headOwner}/${headRepoName}:${headBranch}`,
      output: scrub((stderr || '').trim()),
    };
  } catch (err) {
    const raw = err.stderr ? err.stderr.toString() : err.message;
    return { error: scrub(raw) };
  }
});
