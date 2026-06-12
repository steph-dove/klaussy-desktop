// Every git IPC handler: status, diff, hunks, branch ops, stage/unstage,
// apply-patch, discard, commit, push/fetch/pull, stash, log/show/blame,
// tags, conflicts, create-pr. Also exports collectWorktreeState — the
// per-worktree aggregator shared with ipc/tasks.js's list-all-dirty-worktrees
// and get-worktree-state handlers.

const { spawn } = require('child_process');
const { ipcMain } = require('electron');
const { execFileP, ghExec } = require('../util/exec');

// ---- Phase 1: Git Status & Diff ----

ipcMain.handle('git-status', async (_event, { worktreePath }) => {
  try {
    const [statusRes, branchRes] = await Promise.all([
      execFileP('git', ['status', '--porcelain'], { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 }),
      execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath }),
    ]);
    const status = statusRes.stdout;
    const branch = branchRes.stdout.trim();
    const files = status.split('\n').filter(Boolean).map(line => {
      const xy = line.substring(0, 2);
      const file = line.substring(3);
      // staged if index column (x) has a status letter
      const staged = xy[0] !== ' ' && xy[0] !== '?';
      return { status: xy, staged, file };
    });
    // Split files that are both staged and unstaged (e.g., "MM")
    const expanded = [];
    for (const f of files) {
      if (f.status[0] !== ' ' && f.status[0] !== '?' && f.status[1] !== ' ' && f.status[1] !== '?') {
        // Both staged and unstaged changes
        expanded.push({ status: f.status[0] + ' ', staged: true, file: f.file });
        expanded.push({ status: ' ' + f.status[1], staged: false, file: f.file });
      } else {
        expanded.push(f);
      }
    }
    return { branch, files: expanded };
  } catch (err) {
    return { error: err.message, branch: '', files: [] };
  }
});

ipcMain.handle('git-diff', async (_event, { worktreePath, file, staged }) => {
  try {
    const args = ['diff'];
    if (staged) args.push('--cached');
    if (file) args.push('--', file);
    const { stdout } = await execFileP('git', args, { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 });
    return { diff: stdout };
  } catch (err) {
    return { diff: '', error: err.message };
  }
});

// K7: parsed hunks for a single file against HEAD (or the index if staged).
// Returns line-level change info for the gutter overlay — renderer turns
// these into Monaco decorations. -U0 gives minimal hunks so the ranges
// don't span unchanged context.
ipcMain.handle('git-file-hunks', async (_event, { worktreePath, file }) => {
  try {
    const { stdout: diff } = await execFileP('git', ['diff', '-U0', 'HEAD', '--', file], {
      cwd: worktreePath, maxBuffer: 5 * 1024 * 1024,
    });
    const hunks = [];
    const hunkRe = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/gm;
    let m;
    while ((m = hunkRe.exec(diff))) {
      const oldCount = m[2] === undefined ? 1 : parseInt(m[2], 10);
      const newStart = parseInt(m[3], 10);
      const newCount = m[4] === undefined ? 1 : parseInt(m[4], 10);
      let type;
      if (oldCount === 0) type = 'added';
      else if (newCount === 0) type = 'deleted';
      else type = 'modified';
      // For pure deletions, newCount is 0 — the gutter marker goes on the
      // line where the deletion was visible (newStart, which is the line
      // after the insertion point). Single-line stub for renderer to draw.
      const from = newStart;
      const to = newCount === 0 ? newStart : newStart + newCount - 1;
      hunks.push({ type, from, to });
    }
    return { hunks };
  } catch (err) {
    // Not in a repo, file is untracked, or unmodified — return empty.
    // execFile's promisified form exposes exit code on err.code.
    if (err.code === 128 || err.code === 1) return { hunks: [] };
    return { hunks: [], error: err.message };
  }
});

// ---- Branch Diff Mode ----

ipcMain.handle('git-branches', async (_event, { worktreePath }) => {
  try {
    const [localRes, remoteRes] = await Promise.all([
      execFileP('git', ['branch', '--format=%(refname:short)'], { cwd: worktreePath }),
      execFileP('git', ['branch', '-r', '--format=%(refname:short)'], { cwd: worktreePath }),
    ]);
    const branches = localRes.stdout.split('\n').filter(Boolean);
    const remotes = remoteRes.stdout.split('\n').filter(Boolean).filter(b => !b.includes('HEAD'));
    return { branches, remotes };
  } catch (err) {
    return { branches: [], remotes: [], error: err.message };
  }
});

ipcMain.handle('git-branch-files', async (_event, { worktreePath, baseBranch }) => {
  try {
    // Use merge-base to find the branch point, then diff against working tree
    const mbRes = await execFileP('git', ['merge-base', baseBranch, 'HEAD'], { cwd: worktreePath });
    const mergeBase = mbRes.stdout.trim();
    const { stdout: output } = await execFileP('git', ['diff', '--name-status', mergeBase], { cwd: worktreePath });
    const files = output.split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      return { status: parts[0], file: parts.slice(1).join('\t') };
    });
    return { files, mergeBase };
  } catch (err) {
    return { files: [], error: err.message };
  }
});

ipcMain.handle('git-branch-diff', async (_event, { worktreePath, baseBranch, file }) => {
  try {
    const mbRes = await execFileP('git', ['merge-base', baseBranch, 'HEAD'], { cwd: worktreePath });
    const mergeBase = mbRes.stdout.trim();
    const args = ['diff', mergeBase];
    if (file) args.push('--', file);
    const { stdout: diff } = await execFileP('git', args, { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 });
    return { diff };
  } catch (err) {
    return { diff: '', error: err.message };
  }
});

// ---- Phase 2: Git Operations ----

ipcMain.handle('git-stage', async (_event, { worktreePath, files }) => {
  try {
    await execFileP('git', ['add', '--'].concat(files), { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-unstage', async (_event, { worktreePath, files }) => {
  try {
    await execFileP('git', ['reset', 'HEAD', '--'].concat(files), { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-apply-patch', async (_event, { worktreePath, patch, reverse }) => {
  try {
    const args = ['apply', '--cached', '--whitespace=nowarn'];
    if (reverse) args.push('-R');
    // execFile doesn't take `input` the way execFileSync does — spawn, pipe
    // the patch into stdin, and await exit.
    await new Promise((resolve, reject) => {
      const proc = spawn('git', args, { cwd: worktreePath, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (c) => { stderr += c.toString(); });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else { const err = new Error(stderr || `git apply exited ${code}`); err.stderr = stderr; reject(err); }
      });
      proc.stdin.end(patch);
    });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr || err.message };
  }
});

ipcMain.handle('git-discard', async (_event, { worktreePath, files }) => {
  // Branch per-file on status code. Previously this tried `checkout --` and
  // on ANY failure fell back to `clean -f` — which destroys staged-new files
  // (checkout has nothing to revert to for a brand-new add, so it errors, then
  // clean deletes the file entirely along with its staged content).
  const perFile = [];
  for (const file of files) {
    let status = '';
    try {
      const { stdout } = await execFileP('git', ['status', '--porcelain', '--', file], {
        cwd: worktreePath,
      });
      status = stdout;
    } catch (err) {
      perFile.push({ file, error: err.stderr ? err.stderr.toString() : err.message });
      continue;
    }
    // First two chars are XY — X=staged state, Y=unstaged state.
    const xy = status.slice(0, 2);
    try {
      if (xy === '??') {
        // Untracked: remove it.
        await execFileP('git', ['clean', '-f', '--', file], { cwd: worktreePath });
      } else if (xy[0] === 'A') {
        // Staged new file: unstage, then leave the working-tree file alone
        // (user may want to keep the content; `discard` on a new file means
        // "take it back to untracked"). This avoids the prior data-loss case
        // where the staged content was wiped.
        await execFileP('git', ['reset', 'HEAD', '--', file], { cwd: worktreePath });
      } else {
        // Tracked with unstaged and/or staged changes: reset the index to HEAD
        // for this path, then checkout to restore working tree to HEAD.
        try {
          await execFileP('git', ['reset', 'HEAD', '--', file], { cwd: worktreePath });
        } catch {}
        await execFileP('git', ['checkout', '--', file], { cwd: worktreePath });
      }
      perFile.push({ file, ok: true });
    } catch (err) {
      perFile.push({ file, error: err.stderr ? err.stderr.toString() : err.message });
    }
  }
  const failures = perFile.filter((r) => r.error);
  if (failures.length === files.length && files.length > 0) {
    return { error: failures[0].error, files: perFile };
  }
  return { ok: true, files: perFile };
});

ipcMain.handle('git-commit', async (_event, { worktreePath, message }) => {
  try {
    // The app's commit flow runs the review itself (diff panel) — skip the
    // pre-commit hook so the same diff isn't reviewed (and billed) twice.
    // commit-msg/post-commit hooks don't honor this var and still run.
    await execFileP('git', ['commit', '-m', message], {
      cwd: worktreePath,
      env: { ...process.env, KLAUSSY_SKIP_REVIEW: '1' },
    });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-push', async (_event, { worktreePath }) => {
  try {
    const { stdout: br } = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath });
    const branch = br.trim();
    // git writes progress + the "To ...refs..." summary to stderr even on
    // success. Capture it so the renderer can surface a useful "pushed X to
    // origin/Y" toast / log entry instead of pretending nothing happened.
    const { stderr } = await execFileP('git', ['push', '-u', 'origin', branch], {
      cwd: worktreePath, timeout: 30000,
    });
    return { ok: true, branch, output: (stderr || '').trim() };
  } catch (err) {
    return {
      error: err.stderr ? err.stderr.toString().trim() : err.message,
      code: err.code,
      signal: err.signal,
    };
  }
});

ipcMain.handle('create-pr', async (_event, { worktreePath, title, body }) => {
  try {
    const result = ghExec(['pr', 'create', '--title', title, '--body', body || ''], { cwd: worktreePath, stdio: 'pipe', timeout: 30000 }).toString().trim();
    return { url: result };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- Phase D: Git Gaps ----

// D1: Fetch & Pull
ipcMain.handle('git-fetch', async (_event, { worktreePath }) => {
  try {
    await execFileP('git', ['fetch', '--prune'], { cwd: worktreePath, timeout: 30000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-pull', async (_event, { worktreePath }) => {
  try {
    const { stdout } = await execFileP('git', ['pull'], { cwd: worktreePath, timeout: 30000 });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-ahead-behind', async (_event, { worktreePath }) => {
  try {
    // The previous sync version had a dead branch-lookup call before upstream;
    // we drop it here — upstream fails the same way if the repo is broken.
    const { stdout: upstream } = await execFileP(
      'git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd: worktreePath },
    );
    const { stdout: counts } = await execFileP(
      'git', ['rev-list', '--left-right', '--count', upstream.trim() + '...HEAD'],
      { cwd: worktreePath },
    );
    const parts = counts.trim().split(/\s+/);
    return { behind: parseInt(parts[0], 10) || 0, ahead: parseInt(parts[1], 10) || 0 };
  } catch {
    return { behind: 0, ahead: 0 };
  }
});

// ---- H2: Cross-task review inbox aggregator ----
//
// Runs git ops truly in parallel (async execFile) so aggregating N worktrees
// costs ~max(per-worktree) instead of ~sum. Per-worktree errors degrade to a
// zeroed row with `error:` set rather than rejecting the whole Promise.all.
// Exported for ipc/tasks.js's list-all-dirty-worktrees + get-worktree-state.
async function collectWorktreeState(task) {
  const cwd = task.worktreePath;
  try {
    const [statusOut, branchOut, ahead] = await Promise.all([
      execFileP('git', ['status', '--porcelain'], { cwd, maxBuffer: 10 * 1024 * 1024 })
        .then(r => r.stdout).catch(() => ''),
      execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
        .then(r => r.stdout.trim()).catch(() => ''),
      (async () => {
        try {
          const up = (await execFileP('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd })).stdout.trim();
          const counts = (await execFileP('git', ['rev-list', '--left-right', '--count', up + '...HEAD'], { cwd })).stdout.trim();
          const [behind, ahead] = counts.split(/\s+/).map(n => parseInt(n, 10) || 0);
          return { ahead, behind };
        } catch { return { ahead: 0, behind: 0 }; }
      })(),
    ]);
    // Porcelain status: first col = index (staged), second col = worktree (unstaged).
    // "??" is untracked. "MM" etc. counts in both staged and unstaged.
    let staged = 0, unstaged = 0, untracked = 0;
    for (const line of statusOut.split('\n')) {
      if (!line) continue;
      const x = line.charAt(0), y = line.charAt(1);
      if (x === '?' && y === '?') { untracked++; continue; }
      if (x !== ' ' && x !== '?') staged++;
      if (y !== ' ' && y !== '?') unstaged++;
    }
    return {
      taskId: task.id, branch: branchOut,
      staged, unstaged, untracked,
      ahead: ahead.ahead, behind: ahead.behind,
    };
  } catch (err) {
    return {
      taskId: task.id, branch: '',
      staged: 0, unstaged: 0, untracked: 0,
      ahead: 0, behind: 0,
      error: err.message,
    };
  }
}

// D2: Branch checkout
ipcMain.handle('git-checkout', async (_event, { worktreePath, branch }) => {
  try {
    await execFileP('git', ['checkout', branch], { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// D3: Stash
ipcMain.handle('git-stash-push', async (_event, { worktreePath, message }) => {
  try {
    const args = ['stash', 'push'];
    if (message) args.push('-m', message);
    await execFileP('git', args, { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-stash-pop', async (_event, { worktreePath, index }) => {
  try {
    const args = ['stash', 'pop'];
    if (index !== undefined) args.push('stash@{' + index + '}');
    await execFileP('git', args, { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-stash-list', async (_event, { worktreePath }) => {
  try {
    const { stdout } = await execFileP('git', ['stash', 'list', '--format=%gd\t%s'], { cwd: worktreePath });
    const stashes = stdout.split('\n').filter(Boolean).map(function (line) {
      const parts = line.split('\t');
      return { ref: parts[0], message: parts.slice(1).join('\t') };
    });
    return { stashes };
  } catch (err) {
    return { stashes: [], error: err.message };
  }
});

// D4: Commit history
ipcMain.handle('git-log', async (_event, { worktreePath, count }) => {
  try {
    const { stdout } = await execFileP('git', ['log', '--format=%H\t%h\t%an\t%ar\t%s', '-' + (count || 50)], {
      cwd: worktreePath,
    });
    const commits = stdout.split('\n').filter(Boolean).map(function (line) {
      const p = line.split('\t');
      return { hash: p[0], short: p[1], author: p[2], date: p[3], subject: p[4] };
    });
    return { commits };
  } catch (err) {
    return { commits: [], error: err.message };
  }
});

ipcMain.handle('git-show', async (_event, { worktreePath, hash }) => {
  try {
    const { stdout } = await execFileP('git', ['show', '--format=', hash], {
      cwd: worktreePath, maxBuffer: 10 * 1024 * 1024,
    });
    return { diff: stdout };
  } catch (err) {
    return { diff: '', error: err.message };
  }
});

// D5: Blame
ipcMain.handle('git-blame', async (_event, { worktreePath, file }) => {
  try {
    const { stdout: output } = await execFileP('git', ['blame', '--porcelain', file], {
      cwd: worktreePath, maxBuffer: 10 * 1024 * 1024,
    });
    // Parse porcelain blame into per-line annotations
    const lines = [];
    let current = {};
    const commits = {};
    output.split('\n').forEach(function (line) {
      const headerMatch = line.match(/^([0-9a-f]{40}) (\d+) (\d+)/);
      if (headerMatch) {
        current = { hash: headerMatch[1], origLine: parseInt(headerMatch[2]), finalLine: parseInt(headerMatch[3]) };
        return;
      }
      if (line.startsWith('author ')) {
        if (!commits[current.hash]) commits[current.hash] = {};
        commits[current.hash].author = line.substring(7);
      }
      if (line.startsWith('author-time ')) {
        if (!commits[current.hash]) commits[current.hash] = {};
        commits[current.hash].time = parseInt(line.substring(12));
      }
      if (line.startsWith('summary ')) {
        if (!commits[current.hash]) commits[current.hash] = {};
        commits[current.hash].summary = line.substring(8);
      }
      if (line.startsWith('\t')) {
        lines.push({
          line: current.finalLine,
          hash: current.hash.substring(0, 8),
          author: commits[current.hash]?.author || '',
          summary: commits[current.hash]?.summary || '',
          time: commits[current.hash]?.time || 0,
        });
      }
    });
    return { lines };
  } catch (err) {
    return { lines: [], error: err.message };
  }
});

// D7: Conflict detection
ipcMain.handle('git-conflicts', async (_event, { worktreePath }) => {
  try {
    const { stdout } = await execFileP('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd: worktreePath,
    });
    const files = stdout.split('\n').filter(Boolean);
    return { files };
  } catch {
    return { files: [] };
  }
});

// ---- Git Tags (Feature 11) ----

ipcMain.handle('git-tags', async (_event, { worktreePath }) => {
  try {
    const { stdout } = await execFileP('git', ['tag', '-l', '--sort=-creatordate',
      '--format=%(refname:short)\t%(objectname:short)\t%(subject)\t%(creatordate:short)'],
      { cwd: worktreePath, maxBuffer: 5 * 1024 * 1024 });
    const tags = stdout.split('\n').filter(Boolean).map(line => {
      const [name, commit, message, date] = line.split('\t');
      return { name, commit, message: message || '', date: date || '' };
    });
    return { tags };
  } catch (err) {
    return { tags: [], error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-tag-create', async (_event, { worktreePath, name, message, commit }) => {
  try {
    const args = ['tag'];
    if (message) {
      args.push('-a', name, '-m', message);
    } else {
      args.push(name);
    }
    if (commit) args.push(commit);
    await execFileP('git', args, { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-tag-delete', async (_event, { worktreePath, name }) => {
  try {
    await execFileP('git', ['tag', '-d', name], { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-tag-push', async (_event, { worktreePath, name }) => {
  try {
    await execFileP('git', ['push', 'origin', name], { cwd: worktreePath, timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

module.exports = { collectWorktreeState };
