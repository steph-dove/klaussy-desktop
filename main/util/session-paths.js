// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Where session worktrees live (~/klaussy/sessions/<session>/<worktree>) and
// which paths delete-session may remove by force when git can't.

const fs = require('fs');
const path = require('path');

// How deep `p` sits inside `root`, 0 if it's outside. Measured on the
// normalised path, so '..' can't climb out ('sessions/../..' is $HOME).
function depthUnder(root, p) {
  const rel = path.relative(root, path.resolve(p));
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return 0;
  return rel.split(path.sep).length;
}

// Only a worktree folder Maussian made: <root>/<session>/<worktree>, a real
// directory, with no symlink anywhere along the way (a symlinked <session>
// folder would otherwise send the delete somewhere else).
function isSessionWorktreeDir(root, p) {
  if (depthUnder(root, p) !== 2) return false;
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    const expected = path.join(fs.realpathSync(root), path.relative(path.resolve(root), path.resolve(p)));
    return fs.realpathSync(p) === expected;
  } catch {
    return false;
  }
}

module.exports = { depthUnder, isSessionWorktreeDir };
