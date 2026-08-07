// Turns a Claude Code hook report into a gateway event, for the session it came
// from. The hook knows things the terminal only hints at: that a prompt is a
// permission ask, and that a turn has genuinely ended.

const { interpret } = require('../util/claude-hooks');
const nemesisEvents = require('../util/nemesis-events');
const agentTranscript = require('../util/agent-transcript');

// A hook reports its cwd; that is the worktree the session runs in.
function instanceForCwd(cwd) {
  if (!cwd) return null;
  const { instances, isAgentInstance } = require('./instances');
  for (const [, inst] of instances) {
    if (inst.worktreePath === cwd && isAgentInstance(inst)) return inst;
  }
  return null;
}

function baseEvent(inst) {
  const { displayNameFor } = require('./ai-providers');
  return {
    containerId: inst.id,
    sessionName: inst.name,
    workspacePath: inst.worktreePath,
    agentName: displayNameFor(inst.originalMode || inst.mode),
    notify: inst.notifyWebhookEnabled === true,
    ts: Date.now(),
  };
}

function handleClaudeHook(payload) {
  const hook = interpret(payload);
  if (!hook) return;
  const inst = instanceForCwd(hook.cwd);
  if (!inst || inst.notifyWebhookEnabled !== true) return;

  // The hook names the transcript, which saves deriving its encoded path and
  // works even before the session sweep has noticed this session.
  if (hook.transcriptPath) inst.transcriptPath = hook.transcriptPath;

  if (hook.kind === 'notification') {
    nemesisEvents.publish({
      ...baseEvent(inst),
      type: hook.isPermission
        ? nemesisEvents.EVENT_TYPES.APPROVAL_REQUIRED
        : nemesisEvents.EVENT_TYPES.MESSAGE,
      // Claude's own wording for what it wants, rather than a screen scrape.
      promptQuestion: hook.isPermission ? (hook.message || hook.title) : '',
      body: hook.isPermission ? '' : (hook.message || hook.title),
      // The options still live on screen: a permission prompt is UI, so the
      // buttons continue to come from the terminal.
      logsTail: inst.recentOutput || '',
    });
    return;
  }

  if (hook.kind === 'turn-end') {
    const read = agentTranscript.readNewMessages('claude', {
      worktreePath: inst.worktreePath,
      sessionId: hook.sessionId || inst.claudeSessionId,
      transcriptFile: inst.transcriptPath,
      cursor: inst.transcriptCursor || 0,
    });
    if (!read || !read.text) return;
    inst.transcriptCursor = read.cursor;
    nemesisEvents.publish({
      ...baseEvent(inst),
      type: nemesisEvents.EVENT_TYPES.MESSAGE,
      body: read.text,
    });
  }
}

module.exports = { handleClaudeHook, instanceForCwd };
