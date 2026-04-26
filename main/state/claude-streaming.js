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
//
// When `agentMeta` is provided the request becomes a "backgroundable agent":
//   * registered in agent-registry so the global Agents panel sees it
//   * stdout chunks broadcast to every BrowserWindow (not just the sender)
//     so a re-mounting consumer in any window can attach to the live stream
//   * proc lifecycle decouples from sender 'destroyed' — closing the
//     originating surface no longer kills the agent
//   * accumulated text lives in the registry so a late-mounting consumer
//     can render the catch-up content immediately

const { spawn } = require('child_process');
const { loadConfig } = require('../util/config');
const { appendStderr } = require('../util/exec');
const agentRegistry = require('./agent-registry');

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

// Lazy require to avoid a circular import between this module and windows.js
// (windows.js doesn't import this today, but defer anyway for robustness).
let _windows = null;
function broadcastToAllWindows(channel, payload) {
  if (!_windows) _windows = require('./windows');
  for (const win of _windows.allWindows) {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

// Channel naming convention:
//   `${channelPrefix}-${streamJson ? 'data' : 'chunk'}-${requestId}` for output
//   `${channelPrefix}-done-${requestId}` for completion/error/cancel
// Callers supply the proc map (so cancel handlers can look up the proc),
// the prompt, the cwd, and any extra fields to merge into the done payload
// on successful (zero-exit) completion.
//
// agentMeta (optional): { kind, sourceContext, dedupeKey }. When set, the
// request is registered with agent-registry and chunks broadcast to all
// windows instead of just the sender.
function spawnClaudeStream({
  requestId,
  procMap,
  channelPrefix,
  sender,
  cwd,
  prompt,
  streamJson = false,
  extraDoneFields = null,
  agentMeta = null,
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
  const isBackground = !!agentMeta;

  if (isBackground) {
    agentRegistry.register({
      id: requestId,
      kind: agentMeta.kind,
      channelPrefix,
      sourceContext: agentMeta.sourceContext || null,
      dedupeKey: agentMeta.dedupeKey || null,
      isStreamJson: streamJson,
      proc,
    });
  }

  const sendChunk = (payload) => {
    if (isBackground) broadcastToAllWindows(chunkChannel, payload);
    else if (!sender.isDestroyed()) sender.send(chunkChannel, payload);
  };
  const sendDone = (payload) => {
    if (isBackground) broadcastToAllWindows(doneChannel, payload);
    else if (!sender.isDestroyed()) sender.send(doneChannel, payload);
  };

  let stderrBuf = '';
  proc.stdout.on('data', (chunk) => {
    const str = chunk.toString();
    if (isBackground) agentRegistry.appendText(requestId, str);
    sendChunk(str);
  });
  proc.stderr.on('data', (chunk) => { stderrBuf = appendStderr(stderrBuf, chunk); });
  proc.on('error', (err) => {
    procMap.delete(requestId);
    if (isBackground) agentRegistry.markError(requestId, err.message);
    sendDone({ error: err.message });
  });
  proc.on('exit', (code, signal) => {
    procMap.delete(requestId);
    // 143 = 128 + 15 (SIGTERM) and 137 = 128 + 9 (SIGKILL): claude traps the
    // signal and exits cleanly with the conventional code, so Node reports
    // code instead of signal. Either way it's a cancellation, not an error.
    var wasSignalled = signal === 'SIGTERM' || signal === 'SIGKILL' || code === 143 || code === 137;
    if (wasSignalled) {
      if (isBackground) agentRegistry.markCancelled(requestId);
      sendDone({ cancelled: true });
    } else if (code !== 0) {
      const errMsg = stderrBuf.trim() || `claude exited with code ${code}`;
      if (isBackground) agentRegistry.markError(requestId, errMsg);
      sendDone({ error: errMsg });
    } else {
      const payload = { ok: true, stderr: stderrBuf && stderrBuf.trim() ? stderrBuf.trim() : undefined };
      if (extraDoneFields) Object.assign(payload, extraDoneFields);
      if (isBackground) agentRegistry.markDone(requestId, payload);
      sendDone(payload);
    }
  });

  // Foreground requests die with their originating sender — closing the window
  // shouldn't keep eating Anthropic quota. Backgroundable agents survive the
  // sender intentionally; the registry owns their lifecycle and the user can
  // cancel them from the Agents panel.
  if (!isBackground) {
    sender.once('destroyed', () => {
      if (!proc.killed) { try { proc.kill('SIGTERM'); } catch {} }
    });
  }

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
