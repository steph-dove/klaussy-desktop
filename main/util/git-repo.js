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

function baseRepoForWorktree(worktreePath) {
  if (!worktreePath) return null;
  try {
    const commonDir = execFileSync(
      'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: worktreePath, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();
    if (!commonDir) return null;
    // commonDir is normally "<repo>/.git"; its parent is the repo root.
    return path.dirname(commonDir);
  } catch {
    return null;
  }
}

// Sibling worktrees in the same multi-repo session (absolute paths, excluding
// this one). Session worktrees live under ~/klaussy/sessions/<name>/<repo>; the
// siblings are the other repo dirs in that <name> folder. Passed to an agent's
// add-directory flag so it can read AND edit its session's other repos rather
// than refusing cross-repo changes. [] for legacy / single-repo / non-session
// worktrees. Best-effort — never throws.
function sessionSiblingWorktrees(worktreePath) {
  try {
    if (typeof worktreePath !== 'string') return [];
    const m = worktreePath.replace(/\/+$/, '').match(/^(.*\/klaussy\/sessions\/[^/]+)\/([^/]+)$/);
    if (!m) return [];
    const sessionDir = m[1];
    const current = m[2];
    return fs.readdirSync(sessionDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== current)
      .map((e) => path.join(sessionDir, e.name));
  } catch {
    return [];
  }
}

module.exports = { baseRepoForWorktree, sessionSiblingWorktrees };
