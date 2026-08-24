// The saver only describes worktrees open right now, so overwriting the stored
// list with that snapshot drops closed sessions and their agent — which is what
// made a closed Copilot session come back as Claude.
function mergeSavedSessions(described, previous) {
  const describedPaths = new Set((described || []).map((s) => s && s.worktreePath));
  const untouched = (previous || []).filter((s) => s && !describedPaths.has(s.worktreePath));
  return (described || []).concat(untouched);
}

module.exports = { mergeSavedSessions };
