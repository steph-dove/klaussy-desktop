// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// A branch, tag or commit the renderer hands to git as a positional argument.
// git reads anything starting with '-' as an option, so a "branch" of
// `--output=/Users/me/.zshrc` (git show) or `--receive-pack=<cmd>` (git push)
// would rewrite files or run a command. Refs never start with '-' and never
// hold whitespace or control characters, so those are refused outright.

function gitRef(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 255
    && !v.startsWith('-') && !/[\s\x00-\x1f\x7f]/.test(v);
}

const gitRefError = (what) => `That isn't a valid ${what} name`;

module.exports = { gitRef, gitRefError };
