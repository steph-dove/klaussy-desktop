// ---- Phase G: Review others' PRs ----
//
// prReview.active is the single source of truth so the main-window panel and
// the detached pop-out see the same state (no duplicate fetches, no lost
// pending comments). null = no review open. Exposed as a property on the
// exported `prReview` holder because a naked `let activePrReview` couldn't
// be shared mutably across module boundaries via CommonJS destructuring.
//
// Two deps live in main.js and haven't been factored yet:
//   - ghJson (moves to ipc/pr-review.js in Phase 3)
//   - runKlausifyInit (moves to bootstrap/app-events.js in Phase 4)
// Both injected via setDeps.

const path = require('path');
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const { loadConfig, saveConfig } = require('../util/config');
const { instances } = require('./instances');

const prReview = {
  active: null, // { repo, number, meta, diff, popout: BrowserWindow|null, ... }
};

let _ghJson = async () => { throw new Error('ghJson not injected'); };
let _runKlausifyInit = async () => {};

function setDeps({ ghJson, runKlausifyInit } = {}) {
  if (ghJson) _ghJson = ghJson;
  if (runKlausifyInit) _runKlausifyInit = runKlausifyInit;
}

function broadcastPrReview() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('pr-review-state', prReview.active ? sanitizePrReview(prReview.active) : null);
  }
}

function sanitizePrReview(s) {
  // Strip the BrowserWindow reference — not serializable across IPC.
  const { popout, ...rest } = s;
  return { ...rest, popped: !!popout };
}

function currentRepoPath() {
  const config = loadConfig();
  return config.repoPath || null;
}

// GitHub PR URLs always encode the base repo: /{owner}/{repo}/pull/{n}.
// Using the URL avoids an extra gh call and works for both the picker path
// and the paste-URL path, since `gh pr view --json url` is always populated.
function parseBaseFromUrl(url) {
  if (!url) return null;
  // Match any host (github.com, github.corp.example, etc.) so GHE works too.
  const m = url.match(/https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/);
  if (!m) return null;
  return { owner: m[1], name: m[2].replace(/\.git$/, '') };
}

function pushReviewHistory(meta) {
  if (!meta || !meta.url) return;
  const config = loadConfig();
  const history = (config.reviewHistory || []).filter(e => e.url !== meta.url);
  history.unshift({
    url: meta.url,
    number: meta.number,
    title: meta.title || '',
    author: (meta.author && (meta.author.login || meta.author.name)) || '',
    state: meta.state || '',
    isDraft: !!meta.isDraft,
    headRefName: meta.headRefName || '',
    baseRefName: meta.baseRefName || '',
    viewedAt: new Date().toISOString(),
  });
  config.reviewHistory = history.slice(0, 20);
  saveConfig(config);
}

// GraphQL-backed thread fetch. Scoped to the *base* repo (target), not the
// head repo (fork), because threads live on the target.
//
// Epoch guard: overlapping refreshes (user hits refresh twice; merge-handler
// piggybacks a refresh during the user's manual refresh) can return out of
// order. We only commit results from the most-recent fetch; stale responses
// are silently dropped to avoid overwriting newer data with older data.
let _threadsFetchEpoch = 0;
async function fetchThreadsForActive() {
  if (!prReview.active) return;
  const epoch = ++_threadsFetchEpoch;
  // gh api graphql doesn't need to run inside the target repo — owner/repo
  // are passed as query variables. Falling back to homedir means reviewers
  // without an active klausify project still get threads + comments.
  const cwd = currentRepoPath() || require('os').homedir();
  if (!prReview.active.baseOwner || !prReview.active.baseRepo) {
    prReview.active.threadsError = 'Could not parse base repo from PR url';
    broadcastPrReview();
    return;
  }
  const owner = prReview.active.baseOwner;
  const repo = prReview.active.baseRepo;
  const number = prReview.active.number;
  const stale = () => epoch !== _threadsFetchEpoch
    || !prReview.active
    || prReview.active.number !== number;

  // One round trip for threads + issue-comments + reviews. Conversation tab
  // reads from comments + reviews; Files tab reads from reviewThreads. There's
  // duplication between review.comments and reviewThreads.comments, but the
  // two consumers render different shapes, so we keep both and let them pick.
  const query = 'query($owner: String!, $repo: String!, $number: Int!) {'
    + '  repository(owner: $owner, name: $repo) {'
    + '    pullRequest(number: $number) {'
    + '      reviewThreads(first: 100) {'
    + '        nodes {'
    + '          id isResolved isOutdated path line originalLine startLine originalStartLine diffSide'
    + '          comments(first: 100) { nodes { databaseId author { login } createdAt body diffHunk } }'
    + '        }'
    + '      }'
    + '      comments(first: 100) {'
    + '        nodes { databaseId author { login } createdAt body url }'
    + '      }'
    + '      reviews(first: 100) {'
    + '        nodes {'
    + '          databaseId state body submittedAt author { login }'
    + '          comments(first: 100) { nodes { databaseId body path line diffHunk } }'
    + '        }'
    + '      }'
    + '    }'
    + '  }'
    + '}';

  try {
    const out = await new Promise((resolve, reject) => {
      execFile('gh', [
        'api', 'graphql',
        '-f', 'query=' + query,
        '-f', 'owner=' + owner,
        '-f', 'repo=' + repo,
        '-F', 'number=' + number,
      ], { cwd, maxBuffer: 50 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
        if (err) { err.stderr = stderr; err.stdout = stdout; return reject(err); }
        resolve(stdout);
      });
    });
    const parsed = JSON.parse(out);
    if (parsed.errors && parsed.errors.length) {
      if (stale()) return;
      prReview.active.threadsError = parsed.errors.map(e => e.message).join('; ');
      broadcastPrReview();
      return;
    }
    const pr = parsed.data && parsed.data.repository && parsed.data.repository.pullRequest;
    const threads = (pr && pr.reviewThreads && pr.reviewThreads.nodes) || [];
    const issueComments = (pr && pr.comments && pr.comments.nodes) || [];
    const reviews = (pr && pr.reviews && pr.reviews.nodes) || [];
    // User may have navigated away while we were fetching; bail if the review
    // behind us was swapped for a different PR.
    if (stale()) return;
    prReview.active.threads = threads;
    prReview.active.issueComments = issueComments;
    prReview.active.reviews = reviews;
    prReview.active.threadsError = null;
    broadcastPrReview();
  } catch (err) {
    if (stale()) return;
    // gh api writes error JSON to stdout on non-zero exit
    let msg = (err.stderr || err.message || '').trim();
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout.toString());
        if (parsed.errors) msg = parsed.errors.map(e => e.message).join('; ');
      } catch (_) {}
    }
    prReview.active.threadsError = msg;
    broadcastPrReview();
  }
}

async function reloadActivePrReviewMeta() {
  if (!prReview.active) return;
  const { meta: existingMeta } = prReview.active;
  if (!existingMeta || !existingMeta.url) return;
  const cwd = currentRepoPath() || require('os').homedir();
  try {
    const meta = await _ghJson([
      'pr', 'view', existingMeta.url,
      '--json', 'number,title,author,state,createdAt,updatedAt,headRefName,baseRefName,headRefOid,isDraft,reviewDecision,url,body,headRepository,headRepositoryOwner,mergeable,mergeStateStatus',
    ], cwd);
    if (!prReview.active || prReview.active.number !== meta.number) return;
    prReview.active.meta = Object.assign({}, prReview.active.meta, meta);
    broadcastPrReview();
  } catch (_) { /* non-fatal */ }
}

// Walk the user's klausify projects and return the first whose `origin`
// remote points at <owner>/<repo> (GitHub URL, either SSH or HTTPS form).
// Returns null when no project matches — the caller surfaces an explicit
// "add this repo as a project" error.
function findProjectForRepo(owner, repo) {
  const config = loadConfig();
  const projects = config.projects || [];
  const needle = `${owner}/${repo}`;
  for (const p of projects) {
    if (!p || !p.path) continue;
    try {
      const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: p.path, stdio: 'pipe',
      }).toString().trim();
      // Accept https://github.com/owner/repo(.git)? and git@github.com:owner/repo(.git)?
      const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (m && `${m[1]}/${m[2]}` === needle) return p.path;
    } catch (_) { /* skip */ }
  }
  return null;
}

// Scan `git worktree list --porcelain` for the worktree (if any) that has
// `refs/heads/<branch>` checked out. Returns the worktree path or null.
function findWorktreeForBranch(cwd, branch) {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd, stdio: 'pipe',
    }).toString();
    // Entries are blank-line-separated "worktree <path>\nHEAD ...\nbranch ..." blocks.
    const blocks = out.split(/\n\n+/);
    for (const block of blocks) {
      let wtPath = null, wtBranch = null;
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length).trim();
        else if (line.startsWith('branch ')) wtBranch = line.slice('branch '.length).trim();
      }
      if (wtBranch === `refs/heads/${branch}` && wtPath) return wtPath;
    }
  } catch (_) {}
  return null;
}

// Shared helper: ensure a worktree exists for prReview.active's PR head and
// return its path. Used by G5 (which then spawns a task) and G7 (which runs
// the AI review there). Resolves cwd in this order:
//   1. active project's origin matches the PR base repo
//   2. another klausify project's origin matches
//   3. auto-clone into userData/pr-checkouts (partial clone)
// Reuses an existing worktree on the branch instead of fighting git when
// the user has it checked out already.
async function ensureWorktreeForActivePr() {
  if (!prReview.active) return { error: 'No active PR review' };
  const { number, meta, baseOwner, baseRepo } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo from PR metadata' };

  const active = currentRepoPath();
  let cwd = null;
  if (active) {
    try {
      const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: active, stdio: 'pipe',
      }).toString().trim();
      const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (m && `${m[1]}/${m[2]}` === `${baseOwner}/${baseRepo}`) cwd = active;
    } catch (_) {}
  }
  if (!cwd) cwd = findProjectForRepo(baseOwner, baseRepo);

  let token = '';
  try {
    token = execFileSync('gh', ['auth', 'token'], { stdio: 'pipe' }).toString().trim();
  } catch (_) {
    return { error: 'Could not read gh auth token — run `gh auth login` first.' };
  }
  const authedUrl = `https://oauth2:${token}@github.com/${baseOwner}/${baseRepo}.git`;
  const scrub = (s) => (s || '').replace(/oauth2:[^@]+@/g, 'oauth2:***@');

  // Token-bearing remote URL: DON'T let git persist this into .git/config.
  // Instead we pass it only for the single clone/fetch call (via argv), then
  // immediately rewrite the stored remote URL to the clean form. This way
  // the token isn't in .git/config forever — and `ps` exposure is bounded
  // to the lifetime of the single operation.
  const cleanUrl = `https://github.com/${baseOwner}/${baseRepo}.git`;

  if (!cwd) {
    const cloneBase = path.join(app.getPath('userData'), 'pr-checkouts');
    const clonePath = path.join(cloneBase, `${baseOwner}-${baseRepo}`);
    if (!fs.existsSync(clonePath)) {
      try { fs.mkdirSync(cloneBase, { recursive: true }); } catch (_) {}
      try {
        execFileSync('git', ['clone', '--filter=blob:none', authedUrl, clonePath], { stdio: 'pipe' });
      } catch (err) {
        const raw = (err.stderr ? err.stderr.toString() : err.message) || '';
        return { error: 'Clone failed: ' + scrub(raw) };
      }
      // Strip token from persisted origin URL.
      try {
        execFileSync('git', ['remote', 'set-url', 'origin', cleanUrl], { cwd: clonePath, stdio: 'pipe' });
      } catch {}
    }
    cwd = clonePath;
  }

  const localBranch = (meta && meta.headRefName) || `pr-${number}`;
  const sanitizedForPath = localBranch.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);

  const existingWorktreePath = findWorktreeForBranch(cwd, localBranch);
  if (existingWorktreePath) {
    // Refresh the existing worktree against the PR's latest commit. We fetch
    // into FETCH_HEAD (not into the branch ref) so this is safe even though
    // the worktree currently has the branch checked out — git refuses to
    // force-update a branch that's checked out anywhere. Then we attempt a
    // fast-forward merge: succeeds when the user has no local commits and a
    // clean working tree, fails (and we leave the worktree alone) when the
    // user has local changes we shouldn't destroy.
    let beforeSha = '';
    try {
      beforeSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: existingWorktreePath, stdio: 'pipe',
      }).toString().trim();
    } catch (_) {}
    let refreshed = 'none'; // 'updated' | 'up-to-date' | 'kept-local' | 'fetch-failed'
    try {
      execFileSync('git', ['fetch', authedUrl, `pull/${number}/head`], {
        cwd: existingWorktreePath, stdio: 'pipe',
      });
      try {
        execFileSync('git', ['merge', '--ff-only', 'FETCH_HEAD'], {
          cwd: existingWorktreePath, stdio: 'pipe',
        });
        let afterSha = '';
        try {
          afterSha = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: existingWorktreePath, stdio: 'pipe',
          }).toString().trim();
        } catch (_) {}
        refreshed = (beforeSha && afterSha && beforeSha !== afterSha) ? 'updated' : 'up-to-date';
      } catch (_) {
        refreshed = 'kept-local';
      }
    } catch (_) {
      refreshed = 'fetch-failed';
    }
    return {
      worktreePath: existingWorktreePath,
      branch: localBranch,
      baseRepoCwd: cwd,
      existed: true,
      refreshed,
    };
  }

  try {
    execFileSync('git', ['fetch', authedUrl, `+refs/pull/${number}/head:refs/heads/${localBranch}`], {
      cwd, stdio: 'pipe',
    });
  } catch (err) {
    const raw = (err.stderr ? err.stderr.toString() : err.message) || '';
    return { error: 'Fetch failed: ' + scrub(raw) };
  }

  const repoBasename = path.basename(cwd);
  const worktreeDir = path.dirname(cwd);
  const worktreePath = path.join(worktreeDir, repoBasename + '-' + sanitizedForPath);

  if (fs.existsSync(worktreePath)) {
    // Stale dir from a prior run we never wired up — reuse silently rather
    // than failing. git worktree add would error if it's still registered.
    return { worktreePath, branch: localBranch, baseRepoCwd: cwd, existed: true };
  }

  try {
    execFileSync('git', ['worktree', 'add', worktreePath, localBranch], { cwd, stdio: 'pipe' });
  } catch (err) {
    return { error: 'Worktree create failed: ' + (err.stderr ? err.stderr.toString() : err.message) };
  }

  try { await _runKlausifyInit(worktreePath); } catch (_) {}
  return { worktreePath, branch: localBranch, baseRepoCwd: cwd, existed: false };
}

module.exports = {
  prReview,
  setDeps,
  broadcastPrReview,
  sanitizePrReview,
  currentRepoPath,
  parseBaseFromUrl,
  pushReviewHistory,
  fetchThreadsForActive,
  reloadActivePrReviewMeta,
  findProjectForRepo,
  findWorktreeForBranch,
  ensureWorktreeForActivePr,
};
