// Resolve the base (main) repository root for a worktree path.
//
// Every linked worktree shares its parent repo's *common* git dir
// (`git rev-parse --git-common-dir` → `<repo>/.git`), so the repo root is that
// dir's parent. This lets us group sibling worktrees under one repo in the
// sidebar / repo-filter regardless of how the worktree was created or opened.
// Returns null for non-git folders (e.g. plain "Open Folder" tasks).

const path = require('path');
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

module.exports = { baseRepoForWorktree };
