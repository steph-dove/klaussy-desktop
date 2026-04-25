// Shared primitive for every `claude -p` streaming request the main process
// fires on behalf of a renderer: Cmd+K inline edit, inline completion,
// pr-debug-check, pr-review-ai, pr-review-implement, explain-diff, pr-ai-review,
// and claude-commit-message.
//
// Before this lived as 7 near-identical handler bodies with subtle drift
// (stderr sometimes dropped on zero-exit, some handlers didn't kill the
// subprocess when the renderer went away, exit-branch order varied). One
// helper, one place to fix bugs.
//
// The 8 proc maps track in-flight requests so the matching *-cancel IPC can
// look up the child process and SIGTERM it. Each map is dedicated to one
// feature so there's no cross-feature collision on requestId.

const { spawn } = require('child_process');
const { loadConfig } = require('../util/config');
const { appendStderr } = require('../util/exec');

const debugCheckProcs = new Map();
const inlineEditProcs = new Map();
const inlineCompleteProcs = new Map();
const reviewSurfaceAiProcs = new Map();
const implementProcs = new Map();
const explainStreamProcs = new Map();
const aiReviewProcs = new Map();
const commitMsgProcs = new Map();
const reviewChatProcs = new Map();
const investigateProcs = new Map();

// Channel naming convention:
//   `${channelPrefix}-${streamJson ? 'data' : 'chunk'}-${requestId}` for output
//   `${channelPrefix}-done-${requestId}` for completion/error/cancel
// Callers supply the proc map (so cancel handlers can look up the proc),
// the prompt, the cwd, and any extra fields to merge into the done payload
// on successful (zero-exit) completion.
function spawnClaudeStream({
  requestId,
  procMap,
  channelPrefix,
  sender,
  cwd,
  prompt,
  streamJson = false,
  extraDoneFields = null,
}) {
  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  const args = streamJson
    ? ['-p', prompt, '--output-format', 'stream-json', '--verbose']
    : ['-p', prompt];
  const proc = spawn(claudeBin, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procMap.set(requestId, proc);

  const chunkChannel = `${channelPrefix}-${streamJson ? 'data' : 'chunk'}-${requestId}`;
  const doneChannel = `${channelPrefix}-done-${requestId}`;

  let stderrBuf = '';
  proc.stdout.on('data', (chunk) => {
    if (!sender.isDestroyed()) sender.send(chunkChannel, chunk.toString());
  });
  proc.stderr.on('data', (chunk) => { stderrBuf = appendStderr(stderrBuf, chunk); });
  proc.on('error', (err) => {
    procMap.delete(requestId);
    if (!sender.isDestroyed()) sender.send(doneChannel, { error: err.message });
  });
  proc.on('exit', (code, signal) => {
    procMap.delete(requestId);
    if (sender.isDestroyed()) return;
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      sender.send(doneChannel, { cancelled: true });
    } else if (code !== 0) {
      sender.send(doneChannel, { error: stderrBuf.trim() || `claude exited with code ${code}` });
    } else {
      const payload = { ok: true, stderr: stderrBuf && stderrBuf.trim() ? stderrBuf.trim() : undefined };
      if (extraDoneFields) Object.assign(payload, extraDoneFields);
      sender.send(doneChannel, payload);
    }
  });

  // If the renderer goes away while the stream is in flight (window close,
  // reload, crash), kill the subprocess. Previously the proc would keep
  // running to natural completion, silently eating Anthropic quota.
  sender.once('destroyed', () => {
    if (!proc.killed) { try { proc.kill('SIGTERM'); } catch {} }
  });

  return proc;
}

// Tiny helper that produces the cancel handler function for a given proc map.
// All 7 cancel handlers were identical modulo the map reference.
function makeClaudeCancelHandler(procMap) {
  return (_event, { requestId }) => {
    const proc = procMap.get(requestId);
    if (!proc) return { ok: false };
    try { proc.kill('SIGTERM'); } catch {}
    return { ok: true };
  };
}

module.exports = {
  spawnClaudeStream,
  makeClaudeCancelHandler,
  debugCheckProcs,
  inlineEditProcs,
  inlineCompleteProcs,
  reviewSurfaceAiProcs,
  implementProcs,
  explainStreamProcs,
  aiReviewProcs,
  commitMsgProcs,
  reviewChatProcs,
  investigateProcs,
};
