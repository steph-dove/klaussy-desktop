// 'ignore' = a stale pty exited after the instance was reattached to a newer
// one; acting on it would clobber the live pty.
function agentExitAction({ isCurrentPty, isAgent, quitting, killed, restarting }) {
  if (!isCurrentPty) return 'ignore';
  if (isAgent && !quitting && !killed && !restarting) return 'convert';
  return 'exit';
}

module.exports = { agentExitAction };
