// Resolve the per-worktree Claude session directory:
//   ~/.claude/projects/<encoded-cwd>/
//
// Claude Code encodes the launch cwd into that directory name by replacing
// EVERY non-alphanumeric character with '-' — not just '/'. This matters for
// worktrees whose path contains spaces or dots, most notably PR checkouts
// under macOS userData ("~/Library/Application Support/Klaussy/pr-checkouts/…"):
// the space in "Application Support" becomes "Application-Support". A naive
// '/'-only replacement points at a directory that never exists, so session-file
// detection (implement-PTY tail, resume, model lookup) silently finds nothing.

const path = require('path');
const os = require('os');

function home() {
  return process.env.HOME || os.homedir();
}

// Encode an absolute worktree path the way Claude Code names its project dir.
function encodeClaudeProjectPath(worktreePath) {
  return String(worktreePath || '').replace(/[^a-zA-Z0-9]/g, '-');
}

// Absolute path to the worktree's Claude session dir (no existence check).
function claudeProjectDir(worktreePath) {
  return path.join(home(), '.claude', 'projects', encodeClaudeProjectPath(worktreePath));
}

module.exports = { encodeClaudeProjectPath, claudeProjectDir };
