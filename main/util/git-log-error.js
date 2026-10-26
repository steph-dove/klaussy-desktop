// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Classifies a failed `git log` so the History tab can tell an unborn branch
// (no commits yet) from a real failure.

function isNoCommitsError(err) {
  const text = String((err && (err.stderr || err.message)) || '');
  return /does not have any commits yet/i.test(text);
}

// First useful line of git's stderr, without the "Command failed: ..." wrapper.
function gitErrorReason(err) {
  const stderr = String((err && err.stderr) || '').trim();
  const line = stderr.split('\n').map(function (l) { return l.trim(); }).filter(Boolean)[0];
  if (line) return line.replace(/^fatal:\s*/i, '');
  return String((err && err.message) || 'unknown error').split('\n')[0];
}

module.exports = { isNoCommitsError, gitErrorReason };
