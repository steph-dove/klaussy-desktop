// Resolve the base (main) repository root for a worktree path.
//
// Every linked worktree shares its parent repo's *common* git dir
// (`git rev-parse --git-common-dir` → `<repo>/.git`), so the repo root is that
// dir's parent. This lets us group sibling worktrees under one repo in the
// sidebar / repo-filter regardless of how the worktree was created or opened.
// Returns null for non-git folders (e.g. plain "Open Folder" tasks).

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// The git dir shared by a repo and all of its linked worktrees. A linked
// worktree's own git dir is <repo>/.git/worktrees/<name>, so anything that must
// be visible session-wide has to hang off the common dir, not that one.
function gitCommonDir(worktreePath) {
  if (!worktreePath) return null;
  try {
    const commonDir = execFileSync(
      'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: worktreePath, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();
    return commonDir || null;
  } catch {
    return null;
  }
}

function baseRepoForWorktree(worktreePath) {
  const commonDir = gitCommonDir(worktreePath);
  // commonDir is normally "<repo>/.git"; its parent is the repo root.
  return commonDir ? path.dirname(commonDir) : null;
}

// The `~/klaussy/sessions/<name>` a worktree belongs to, else null. `\`→`/`
// first so Windows session paths match; fs/path accept forward slashes there.
function klaussySessionDir(worktreePath) {
  if (typeof worktreePath !== 'string') return null;
  const m = worktreePath.replace(/\\/g, '/').replace(/\/+$/, '')
    .match(/^(.*\/klaussy\/sessions\/[^/]+)\/([^/]+)$/);
  return m ? { dir: m[1], name: m[1].split('/').pop(), repo: m[2] } : null;
}

// The session's other repo dirs (absolute, excluding this one), for an agent's
// add-directory flag. [] for non-session worktrees; never throws.
function sessionSiblingWorktrees(worktreePath) {
  try {
    const session = klaussySessionDir(worktreePath);
    if (!session) return [];
    const sessionDir = session.dir;
    const current = session.repo;
    return fs.readdirSync(sessionDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== current)
      .map((e) => path.join(sessionDir, e.name));
  } catch {
    return [];
  }
}

// The repo's default branch, from origin/HEAD when the remote publishes it,
// otherwise the first of the usual names that exists locally.
function defaultBranchOf(repoPath) {
  try {
    return execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], {
      cwd: repoPath, stdio: 'pipe',
    }).toString().trim().replace(/^origin\//, '');
  } catch { /* no origin/HEAD — probe the usual names */ }
  for (const c of ['main', 'master', 'dev', 'develop']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', c], { cwd: repoPath, stdio: 'pipe' });
      return c;
    } catch { /* try next */ }
  }
  return 'main';
}

// git allows a branch in one worktree only, so a session holding the default
// branch strands the base checkout. Returns a message, or null if it's fine.
function defaultBranchRefusal(repoPath, branch) {
  if (!repoPath || !branch) return null;
  let def;
  try {
    def = defaultBranchOf(repoPath);
  } catch {
    return null;
  }
  if (!def || String(branch).trim().toLowerCase() !== String(def).trim().toLowerCase()) return null;
  return '"' + branch + '" is this repo\'s default branch, so it has to stay in the base checkout — '
    + 'a session worktree would take it away from there. Pick a different name to branch off "' + def + '" instead.';
}

module.exports = { gitCommonDir, baseRepoForWorktree, klaussySessionDir, sessionSiblingWorktrees, defaultBranchOf, defaultBranchRefusal };
