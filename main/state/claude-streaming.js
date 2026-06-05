// Shared primitive for every `claude -p` streaming request the main process
// fires on behalf of a renderer: Cmd+K inline edit, inline completion,
// pr-debug-check, pr-review-ai, explain-diff, pr-ai-review, and
// claude-commit-message. (pr-review-implement runs in an interactive PTY
// instead — see main/state/pr-implement-pty.js.)
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
const { getProvider, binFor } = require('./ai-providers');
const { getStored, ensureWorktreeConsentSync } = require('../util/agent-consent');
const { beginSession } = require('../util/agent-concurrency');

const debugCheckProcs = new Map();
const fixCheckProcs = new Map();
const inlineEditProcs = new Map();
const inlineCompleteProcs = new Map();
const reviewSurfaceAiProcs = new Map();
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

// Serialize one normalized adapter event ({kind:'text'|'tool'|'usage'|...})
// into the Claude stream-json shape the PR-review renderer already parses, so
// non-Claude providers can drive that UI unchanged. Returns null for events
// with no Claude-json equivalent (end_turn — done is signaled by process exit).
function normalizedToClaudeStreamJson(ev) {
  if (!ev) return null;
  if (ev.kind === 'text' && ev.text) {
    return { type: 'assistant', message: { content: [{ type: 'text', text: ev.text }] } };
  }
  if (ev.kind === 'tool' && ev.name) {
    return { type: 'assistant', message: { content: [{ type: 'tool_use', name: ev.name, input: ev.hint ? { description: ev.hint } : {} }] } };
  }
  if (ev.kind === 'usage' && ev.usage) {
    const u = ev.usage;
    // The renderer reports input as input_tokens + cache_creation + cache_read.
    // Collapse everything non-output into input_tokens and zero the cache
    // fields, so providers whose input already includes cached tokens (Codex)
    // aren't double-counted.
    const input = Math.max(0, (u.totalTokens || 0) - (u.outputTokens || 0));
    return { type: 'result', usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: u.outputTokens || 0 } };
  }
  return null;
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
  // Which AI CLI runs this request. Defaults to Claude so any surface that
  // doesn't pass a provider keeps its exact behavior. The generalized surfaces
  // pass the user's default provider.
  provider = 'claude',
  // Autonomous-edit surfaces (pr-fix-check) set this so non-Claude agents get
  // the scoped write permission they need (e.g. Codex --sandbox workspace-write).
  allowEdits = false,
  // Whether to prompt for a gated agent's worktree consent if none is stored.
  // User-initiated surfaces (review, ask, commit message, inline edit, …)
  // prompt; rapid auto-fire surfaces (inline completion / ghost text) pass
  // false and reuse stored consent only, so a prompt never pops mid-typing.
  promptConsent = true,
  extraDoneFields = null,
  agentMeta = null,
}) {
  const config = loadConfig();
  const prov = getProvider(provider) || getProvider('claude');
  const bin = binFor(prov.id, config);
  const mode = streamJson ? 'stream' : 'text';
  const isBackground = !!agentMeta;
  const chunkChannel = `${channelPrefix}-${streamJson ? 'data' : 'chunk'}-${requestId}`;
  const doneChannel = `${channelPrefix}-done-${requestId}`;

  // Gated agents (Gemini) need worktree trust to run at all. Prompt for it
  // (once per worktree) on user-initiated surfaces; otherwise use stored
  // consent. If the user declines, bail before spawning and tell the renderer.
  let trust;
  if (promptConsent) {
    const consent = ensureWorktreeConsentSync(prov.id, cwd);
    if (!consent.allowed) {
      if (isBackground) broadcastToAllWindows(doneChannel, { cancelled: true });
      else if (!sender.isDestroyed()) sender.send(doneChannel, { cancelled: true });
      return null;
    }
    trust = consent.trust;
  } else {
    trust = getStored(cwd, prov.id) === 'allow';
  }

  // Token-rotation guard: warn before a second concurrent Codex run (e.g. a
  // Codex review while a Codex terminal is live). Only prompts when another
  // Codex session is already active; no-op for Claude/Gemini/Copilot.
  const authSlot = beginSession(prov.id);
  if (!authSlot.ok) {
    if (isBackground) broadcastToAllWindows(doneChannel, { cancelled: true });
    else if (!sender.isDestroyed()) sender.send(doneChannel, { cancelled: true });
    return null;
  }

  // Pinned model/version for this agent (Gemini today), '' = the agent default.
  const model = (config.agentModel || {})[prov.id] || '';
  const run = prov.buildHeadlessRun(bin, { prompt, mode, allowEdits, trust, model });
  let proc;
  try {
    proc = spawn(bin, run.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    authSlot.release(); // never spawned — free the concurrency slot
    throw err;
  }
  procMap.set(requestId, proc);

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

  // Emit a piece of clean answer text to the chunk channel (and the agent
  // registry for backgroundable agents).
  const emitText = (text) => {
    if (!text) return;
    if (isBackground) agentRegistry.appendText(requestId, text);
    sendChunk(text);
  };

  // Providers whose stdout is JSONL (Codex always; Gemini/Copilot in stream
  // mode) are parsed line-by-line. 'json-text' surfaces only the agent's text
  // (clean answer, like a raw `-p` provider); 'json-translate' re-serializes
  // each event into Claude stream-json so the PR-review renderer parses one
  // format. A line buffer handles JSON lines split across stdout chunks.
  const jsonMode = run.outputMode === 'json-text' || run.outputMode === 'json-translate';
  let lineBuf = '';
  // The PR-review renderer treats each assistant text block as the full answer
  // so far (it assigns, not appends). Some agents stream partial text deltas
  // (Gemini's delta:true messages), so we accumulate them and emit the full
  // running text each time. Non-delta text (a complete message) replaces it.
  let textAcc = '';
  const consumeJsonLine = (line) => {
    if (!line.trim()) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    for (const ev of prov.parseStreamLine(obj)) {
      if (run.outputMode === 'json-translate') {
        if (ev.kind === 'text') {
          textAcc = ev.delta ? (textAcc + (ev.text || '')) : (ev.text || '');
          emitText(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: textAcc }] } }) + '\n');
        } else {
          const cj = normalizedToClaudeStreamJson(ev);
          if (cj) emitText(JSON.stringify(cj) + '\n');
        }
      } else if (ev.kind === 'text') {
        emitText(ev.text);
      }
    }
  };

  proc.stdout.on('data', (chunk) => {
    const str = chunk.toString();
    if (jsonMode) {
      lineBuf += str;
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        consumeJsonLine(lineBuf.slice(0, nl));
        lineBuf = lineBuf.slice(nl + 1);
      }
    } else {
      emitText(str);
    }
  });
  proc.stderr.on('data', (chunk) => { stderrBuf = appendStderr(stderrBuf, chunk); });
  proc.on('error', (err) => {
    procMap.delete(requestId);
    authSlot.release(); // free the concurrency slot (Codex token-rotation guard)
    if (isBackground) agentRegistry.markError(requestId, err.message);
    sendDone({ error: err.message });
  });
  proc.on('exit', (code, signal) => {
    procMap.delete(requestId);
    authSlot.release(); // free the concurrency slot (Codex token-rotation guard)
    // Flush a final JSONL line that wasn't newline-terminated.
    if (jsonMode && lineBuf.trim()) {
      consumeJsonLine(lineBuf);
      lineBuf = '';
    }
    // 143 = 128 + 15 (SIGTERM) and 137 = 128 + 9 (SIGKILL): claude traps the
    // signal and exits cleanly with the conventional code, so Node reports
    // code instead of signal. Either way it's a cancellation, not an error.
    var wasSignalled = signal === 'SIGTERM' || signal === 'SIGKILL' || code === 143 || code === 137;
    if (wasSignalled) {
      if (isBackground) agentRegistry.markCancelled(requestId);
      sendDone({ cancelled: true });
    } else if (code !== 0) {
      const errMsg = stderrBuf.trim() || `${prov.displayName} exited with code ${code}`;
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
  fixCheckProcs,
  inlineEditProcs,
  inlineCompleteProcs,
  reviewSurfaceAiProcs,
  explainStreamProcs,
  aiReviewProcs,
  commitMsgProcs,
  reviewChatProcs,
  investigateProcs,
};
