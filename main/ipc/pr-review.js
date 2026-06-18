// All Phase G PR-review IPC handlers (30 pr-* endpoints: list, load, threads,
// checks, merge, checkout, cache, comments, reviews, pop-out, fix-in-terminal,
// etc.) plus the ghJson / ghText helpers they share. State + fetch helpers
// live in main/state/pr-review.js — this file is the API surface the
// renderer talks to.

const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { app, ipcMain, BrowserWindow, webContents } = require('electron');
const { loadConfig, saveConfig } = require('../util/config');
const { ghExec, ghExecP, appendStderr, execFileP, ghEnvForAccount } = require('../util/exec');
const { instances, spawnInWorktree } = require('../state/instances');
const { hardenWindow } = require('../state/windows');
const {
  prReview,
  broadcastPrReview, sanitizePrReview, currentRepoPath, parseBaseFromUrl,
  pushReviewHistory, fetchThreadsForActive, reloadActivePrReviewMeta,
  findProjectForRepo, findWorktreeForBranch, findWorktreeForBranchAcrossClones,
  ensureWorktreeForActivePr, switchGhForReview, restoreGhAfterReview,
} = require('../state/pr-review');
const { ghJson, ghText } = require('../util/gh-json');
const { classifyGhError } = require('../util/gh-error');
const { humanizeComment } = require('../util/humanize-comment');
const { bucketFromState, normalizeStatus, parseCheckRunsJsonl } = require('../util/check-normalize');
const { execFileSync } = require('child_process');


// reloadActivePrReviewMeta (in state/pr-review.js) needs ghJson. Wire it
// up now that this module defines it — breaks the earlier chicken-and-egg
// without forcing main.js to inject it on our behalf.
require('../state/pr-review').setDeps({ ghJson });


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
    // Classify so the picker can render an access failure (the active gh
    // account can't see this project's repo) as a soft hint rather than a
    // scary GraphQL error — the recent list still works regardless.
    const raw = (err.stderr || err.message || '').trim();
    const cls = classifyGhError(raw, {});
    return { error: raw, errorKind: cls.kind, errorSummary: cls.summary, errorFix: cls.fix };
  }
});

// Account-scoped review dashboard for the picker: the up-to-5 most recently
// pushed repos the ACTIVE gh account can see (own + collaborator + org member),
// each with its 5 most recent open PRs. Independent of the current project, so
// switching gh accounts surfaces that account's repos+PRs instead of failing on
// a repo the active account can't access.
ipcMain.handle('pr-recent-repos', async (_event, { account } = {}) => {
  const cwd = currentRepoPath() || require('os').homedir();
  // Run as the picker's selected account via a token, so browsing the lists
  // never flips gh's global active account (only opening a review does).
  const env = ghEnvForAccount(account);
  let repos;
  try {
    // Pull more than 5 so we can skip repos with no open PRs and still fill up
    // to 5 with reviewable ones. sort=pushed = most recently active first.
    const raw = await ghJson([
      'api', '/user/repos?sort=pushed&per_page=12&affiliation=owner,collaborator,organization_member',
    ], cwd, env);
    repos = (Array.isArray(raw) ? raw : []).map((r) => r.full_name).filter(Boolean);
  } catch (err) {
    const msg = (err.stderr || err.message || '').trim();
    const cls = classifyGhError(msg, {});
    return { error: msg, errorKind: cls.kind, errorSummary: cls.summary, errorFix: cls.fix };
  }

  const withPrs = await Promise.all(repos.map(async (full) => {
    try {
      const prs = await ghJson([
        'pr', 'list', '-R', full, '--state', 'open', '--limit', '5',
        '--json', 'number,title,author,state,url,updatedAt,isDraft',
      ], cwd, env);
      return { repo: full, prs: prs || [] };
    } catch {
      return { repo: full, prs: [] }; // a single repo's failure shouldn't sink the list
    }
  }));
  return { repos: withPrs.filter((r) => r.prs.length > 0).slice(0, 5) };
});

// Open PRs the ACTIVE gh account authored, most recently opened first, across
// every repo it can see. Lets the picker offer a quick "jump back to a PR you
// opened" section.
ipcMain.handle('pr-authored', async (_event, { account } = {}) => {
  const cwd = currentRepoPath() || require('os').homedir();
  try {
    const prs = await ghJson([
      'search', 'prs', '--author=@me', '--state', 'open', '--sort', 'created', '--limit', '8',
      '--json', 'number,title,url,state,repository,createdAt,isDraft',
    ], cwd, ghEnvForAccount(account));
    return { prs: prs || [] };
  } catch (err) {
    const msg = (err.stderr || err.message || '').trim();
    return { error: msg, errorKind: classifyGhError(msg, {}).kind };
  }
});

ipcMain.handle('pr-lookup-url', async (_event, { url }) => {
  // gh just needs a valid cwd (any git repo or non-repo dir works for a
  // URL-targeted call). Falling back to homedir lets reviewers use Klaussy
  // without first adding a klaussy project.
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

ipcMain.handle('pr-load', async (event, { number, url, account } = {}) => {
  // URL-form calls don't need an active project — gh derives the repo from
  // the URL. The number-only form (used by the picker's "open in current
  // project" list) does, since gh resolves it against the cwd's origin.
  if (!url && !currentRepoPath()) {
    return { error: 'Add a project to look up PRs by number, or paste a full PR URL.' };
  }
  // Opening a review: make the chosen account globally active for the session
  // (the agent terminals + git need the ambient account). The prior account is
  // remembered and restored when the review closes.
  if (account) switchGhForReview(account);
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
    // If a DIFFERENT window owned the previous review, tell it (and its
    // pop-out) to exit — the review is single-active global state, so it can't
    // keep showing a review it no longer owns.
    const prev = prReview.active;
    if (prev && prev.ownerWcId != null && prev.ownerWcId !== event.sender.id) {
      const prevWc = webContents.fromId(prev.ownerWcId);
      if (prevWc && !prevWc.isDestroyed()) { try { prevWc.send('pr-review-state', null); } catch (_) {} }
      if (prev.popout && !prev.popout.isDestroyed()) { try { prev.popout.webContents.send('pr-review-state', null); } catch (_) {} }
    }
    prReview.active = {
      repo, number: meta.number, meta, diff,
      account: account || null, // gh account this review is being run under
      baseOwner: base ? base.owner : null,
      baseRepo: base ? base.name : null,
      threads: null, // null = loading, [] = loaded-empty
      threadsError: null,
      popout: null,
      // The window that opened this review owns it — broadcastPrReview targets
      // only this window (+ its pop-out), so other windows aren't pulled into
      // PR-review mode.
      ownerWcId: event.sender.id,
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
    const raw = (err.stderr || err.message || '').trim();
    // "Could not resolve to a Repository" almost always means the active gh
    // account can't see the repo (wrong account for a work/org PR). Classify so
    // the picker can show an account-aware, actionable message + fix instead of
    // the raw GraphQL error.
    const m = (url || '').match(/[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/pull\/\d+/);
    const cls = classifyGhError(raw, { target: m ? m[1] + '/' + m[2] : null });
    return { error: raw, errorSummary: cls.summary, errorFix: cls.fix, errorKind: cls.kind };
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
  restoreGhAfterReview();
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


ipcMain.handle('pr-review-state', () => prReview.active ? sanitizePrReview(prReview.active) : null);

ipcMain.handle('pr-review-close', () => {
  if (prReview.active && prReview.active.popout && !prReview.active.popout.isDestroyed()) {
    prReview.active.popout.close();
  }
  prReview.active = null;
  restoreGhAfterReview();
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
      '-f', 'body=' + humanizeComment(body),
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
      '-f', 'body=' + humanizeComment(body),
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
  // Use `gh api` rather than `gh pr checks` so the renderer gets the full
  // check-run shape (id, runId, jobId, started_at, completed_at, output.summary,
  // app.slug). `gh pr checks` is pre-normalized and drops everything we need
  // for the required-checks gate, per-job grouping, and annotations features.
  try {
    const meta = JSON.parse(ghExec(
      ['pr', 'view', String(prNumber), '--json', 'baseRefName,headRefOid,headRepository,headRepositoryOwner'],
      { cwd: worktreePath, stdio: 'pipe', timeout: 15000 }
    ).toString());
    // Base repo, not head: checks live on the base repo for fork PRs.
    const repoResult = JSON.parse(ghExec(
      ['repo', 'view', '--json', 'nameWithOwner'],
      { cwd: worktreePath, stdio: 'pipe', timeout: 10000 },
    ).toString());
    const [baseOwner, baseRepo] = (repoResult.nameWithOwner || '').split('/');
    const sha = meta.headRefOid;
    if (!baseOwner || !baseRepo || !sha) return { checks: [], error: 'Could not resolve base repo or head sha' };

    function run(args) {
      return new Promise((resolve) => {
        execFile('gh', ['api'].concat(args), { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
          (err, stdout, stderr) => resolve({ err, stdout, stderr }));
      });
    }
    const [runsRes, statusRes] = await Promise.all([
      // `--jq '.check_runs[]'` → one check-run per line (JSONL), merged across
      // pages; plain `--paginate` concatenates a JSON object per page, which
      // JSON.parse can't read once a commit has >30 check runs. See
      // parseCheckRunsJsonl.
      run([`repos/${baseOwner}/${baseRepo}/commits/${sha}/check-runs`, '--paginate', '--jq', '.check_runs[]']),
      run([`repos/${baseOwner}/${baseRepo}/commits/${sha}/status`]),
    ]);

    const checks = [];
    const parseErrors = [];
    if (!runsRes.err) {
      const { checks: runChecks, errors } = parseCheckRunsJsonl(runsRes.stdout);
      runChecks.forEach((c) => checks.push(c));
      if (errors.length) {
        parseErrors.push(...errors);
        console.error('[pr-checks] check-runs parse errors:', errors.join('; '),
          '— first 200 chars of stdout:', String(runsRes.stdout || '').slice(0, 200));
      }
    }
    if (!statusRes.err) {
      try {
        const parsed = JSON.parse(statusRes.stdout);
        (parsed.statuses || []).forEach((s) => checks.push(normalizeStatus(s)));
      } catch (e) {
        parseErrors.push('status parse: ' + (e.message || String(e)));
        console.error('[pr-checks] status parse error:', e.message,
          '— first 200 chars of stdout:', String(statusRes.stdout || '').slice(0, 200));
      }
    }
    // Distinguish "no checks reported" from "we couldn't read what GitHub returned".
    // The latter must surface as an error so the renderer doesn't falsely show
    // "No checks reported" + falsely green-light merges via the required-checks gate.
    if (checks.length === 0) {
      if (runsRes.err && statusRes.err) {
        const first = runsRes.err || statusRes.err;
        const raw = (first.stderr ? first.stderr.toString() : first.message) || '';
        if (/no checks reported/i.test(raw)) return { checks: [] };
        return { checks: [], error: raw.trim() };
      }
      if (parseErrors.length > 0) {
        return { checks: [], error: 'Could not parse GitHub check responses: ' + parseErrors.join('; ') };
      }
    }
    return { checks };
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : err.message;
    if (msg && /no checks reported/i.test(msg)) return { checks: [] };
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
    ghExec(['pr', 'comment', String(prNumber), '--body', humanizeComment(body)], {
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
    if (body) args.push('--body', humanizeComment(body));
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
      // os.devNull is `/dev/null` on POSIX and `\\.\nul` on Windows — git for
      // Windows accepts the latter natively, so the diff works on both.
      const devNull = require('os').devNull;
      const untracked = files.filter((f) => f.status === '??').map((f) => f.file);
      for (const u of untracked) {
        try {
          const { stdout: nd } = await execFileP('git', ['diff', '--no-index', devNull, u], {
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
