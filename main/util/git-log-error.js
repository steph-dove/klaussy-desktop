// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Turns a failed `git log` into a short reason for the History tab.

// First useful line of git's stderr, without the "Command failed: ..." wrapper.
function gitErrorReason(err) {
  const stderr = String((err && err.stderr) || '').trim();
  const lines = stderr.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  const line = lines.find(function (l) { return /^(fatal|error):/i.test(l); }) || lines[0];
  if (line) return line.replace(/^(fatal|error):\s*/i, '');
  return String((err && err.message) || 'unknown error').split('\n')[0];
}

module.exports = { gitErrorReason };
