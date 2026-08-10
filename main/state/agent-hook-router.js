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

// The hooks live in the worktree, so every Claude there fires them with the same
// cwd, a second one opened as a tab included. The session id tells them apart;
// an ambiguous hook is dropped rather than answered on the wrong terminal.
function targetForHook(hook) {
  const { instances, isAgentInstance } = require('./instances');
  const inWorktree = [];
  for (const [, inst] of instances) {
    if (hook.sessionId && inst.claudeSessionId === hook.sessionId) return inst;
    for (const sub of (inst.subTerminals || [])) {
      if (sub.alive && sub.mirror && hook.sessionId && sub.claudeSessionId === hook.sessionId) {
        return sub.mirror;
      }
      if (sub.alive && sub.mirror && sub.mode === 'claude' && inst.worktreePath === hook.cwd) {
        inWorktree.push(sub.mirror);
      }
    }
    if (inst.worktreePath === hook.cwd && isAgentInstance(inst)) inWorktree.push(inst);
  }
  return inWorktree.length === 1 ? inWorktree[0] : null;
}

// A sub-terminal's mirror carries no bell of its own; the session it belongs to
// owns that switch.
function bellOn(target) {
  if (target.notifyWebhookEnabled === true) return true;
  const { instances } = require('./instances');
  const parentId = Number(String(target.id).split(':')[0]);
  const parent = instances.get(parentId);
  return !!parent && parent.notifyWebhookEnabled === true;
}

function baseEvent(inst) {
  const { displayNameFor } = require('./ai-providers');
  return {
    containerId: inst.id,
    sessionName: inst.name,
    workspacePath: inst.worktreePath,
    sessionBranch: inst.branch || '',
    agentName: displayNameFor(inst.originalMode || inst.mode),
    notify: true,
    ts: Date.now(),
  };
}

function handleClaudeHook(payload) {
  const hook = interpret(payload);
  if (!hook) return;
  const inst = targetForHook(hook);
  if (!inst || !bellOn(inst)) return;

  // The hook names the transcript, before the sweep has noticed the session. The
  // cursor counts into that file, so both move together or the poll path rewinds
  // to zero and posts the turn twice.
  if (hook.transcriptPath && hook.transcriptPath !== inst.transcriptFile) {
    inst.transcriptPath = hook.transcriptPath;
    inst.transcriptFile = hook.transcriptPath;
    inst.transcriptCursor = 0;
  }

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
      // Resuming appends to the transcript the session already had, so without
      // this the first hook posts the start of the previous conversation.
      sinceMs: inst.spawnTime,
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

module.exports = { handleClaudeHook, instanceForCwd, targetForHook };
