// PTY-backed "Implement" runner for the PR-review AI tab.
//
// The headless `claude -p` path used to spawn this work hit two walls:
//   1. `-p` mode bills users extra (see memory: project-no-claude-dash-p).
//   2. With no TTY attached, permission prompts for Edit/Write are dropped
//      silently, so Claude reports "haven't granted it yet" and exits.
//
// This module instead runs an interactive `claude` in the PR's worktree
// inside a node-pty so the user can answer prompts in an inline xterm.
// To keep the noise down for the common case (claude wants to edit files
// in the PR worktree), it writes a per-worktree settings.local.json that
// pre-allows Edit/Write on that worktree's path before launch.
// Bash and any non-edit tools still prompt.
//
// The renderer needs structured progress (tool-use chips, final summary,
// usage, "done" signal so finding cards flip to "implemented"). We get
// that by tailing the session's .jsonl in ~/.claude/projects/<encoded
// worktree>/, which Claude writes line-per-content-block. We dedupe
// repeated usage totals by requestId (memory: feedback-jsonl-usage-dedup)
// and treat the latest stop_reason=end_turn as "done".

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const pty = require('node-pty');
const { loadConfig } = require('../util/config');
const { sanitizeExtraEnv } = require('../util/exec');
const { defaultShell, shellRunCmdArgs } = require('../util/platform');
const { getProvider, binFor } = require('./ai-providers');
const { ensureWorktreeConsentSync } = require('../util/agent-consent');
const { beginSession } = require('../util/agent-concurrency');

// requestId -> session record. Keyed by the renderer-supplied requestId so
// the cancel IPC can look up the right PTY without leaking it across runs.
const implementPtySessions = new Map();

// requestId -> { buffer, status, worktreePath, at } for runs that have exited.
// Retained briefly so a renderer that re-opens the PR right after a run
// finishes can still repaint the final output. Pruned by TTL.
const recentImplementRuns = new Map();

const SESSION_DETECT_INTERVAL_MS = 250;
const SESSION_DETECT_TIMEOUT_MS = 30000;
const JSONL_TAIL_INTERVAL_MS = 300;
const CANCEL_GRACE_MS = 2000;
// Cap the replay buffer. Claude's interactive TUI redraws full frames, so the
// tail always reconstructs the current screen even if the head was trimmed; a
// resize-driven repaint on attach cleans up any residue. 1 MB is generous.
const OUTPUT_BUFFER_CAP = 1024 * 1024;
const RECENT_RUN_TTL_MS = 5 * 60 * 1000;

function normWt(p) { return String(p || '').replace(/\/+$/, ''); }

function appendToBuffer(session, data) {
  session.outputBuffer += data;
  if (session.outputBuffer.length > OUTPUT_BUFFER_CAP) {
    session.outputBuffer = session.outputBuffer.slice(session.outputBuffer.length - OUTPUT_BUFFER_CAP);
  }
}

// Live status of a session: cancelling > finished(done) > running.
function liveStatus(session) {
  if (session.cancelled) return 'cancelled';
  if (session.finished) return 'done';
  return 'running';
}

// Snapshot for a (re)attaching renderer: the buffered output + current status,
// from the live session if it's still running, else the retained recent run.
function getImplementSnapshot(requestId) {
  const live = implementPtySessions.get(requestId);
  if (live) {
    return { found: true, live: true, status: liveStatus(live), buffer: live.outputBuffer, worktreePath: live.worktreePath };
  }
  const recent = recentImplementRuns.get(requestId);
  if (recent && Date.now() - recent.at < RECENT_RUN_TTL_MS) {
    return { found: true, live: false, status: recent.status, buffer: recent.buffer, worktreePath: recent.worktreePath };
  }
  return { found: false };
}

// Find the run (live preferred, else recent) for a given worktree so a fresh
// renderer (e.g. a pop-out) can rediscover a run it didn't start.
function getActiveImplementByWorktree(worktreePath) {
  const wt = normWt(worktreePath);
  for (const [requestId, s] of implementPtySessions) {
    if (normWt(s.worktreePath) === wt) return { requestId, status: liveStatus(s), live: true };
  }
  let best = null;
  for (const [requestId, r] of recentImplementRuns) {
    if (normWt(r.worktreePath) === wt && Date.now() - r.at < RECENT_RUN_TTL_MS) {
      if (!best || r.at > best.at) best = { requestId, status: r.status, live: false, at: r.at };
    }
  }
  return best ? { requestId: best.requestId, status: best.status, live: false } : null;
}

function pruneRecentRuns() {
  const now = Date.now();
  for (const [k, r] of recentImplementRuns) {
    if (now - r.at >= RECENT_RUN_TTL_MS) recentImplementRuns.delete(k);
  }
}

// Tails one session .jsonl file forwards-only, dispatching the provider's
// normalized events ({kind:'usage'|'tool'|'text'|'end_turn'}) back to `emit`.
// Usage is deduped by requestId where the provider supplies one (Claude fires
// N lines per turn with the same totals); providers without a requestId on
// usage lines (Codex emits one token_count per turn) just pass through.
function startJsonlTail(filePath, provider, emit) {
  let offset = 0;
  let leftover = '';
  let stopped = false;
  let timer = null;
  let observedToolUse = false;
  const seenRequestIds = new Set();

  function poll() {
    if (stopped) return;
    fs.stat(filePath, (err, st) => {
      if (stopped) return;
      if (err) { timer = setTimeout(poll, JSONL_TAIL_INTERVAL_MS); return; }
      if (st.size <= offset) { timer = setTimeout(poll, JSONL_TAIL_INTERVAL_MS); return; }
      const stream = fs.createReadStream(filePath, { start: offset, end: st.size });
      let buf = leftover;
      stream.on('data', (chunk) => { buf += chunk.toString('utf-8'); });
      stream.on('end', () => {
        offset = st.size;
        const lines = buf.split('\n');
        leftover = lines.pop(); // last line may be partial
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          handleEvent(ev);
        }
        if (!stopped) timer = setTimeout(poll, JSONL_TAIL_INTERVAL_MS);
      });
      stream.on('error', () => {
        if (!stopped) timer = setTimeout(poll, JSONL_TAIL_INTERVAL_MS);
      });
    });
  }

  function handleEvent(ev) {
    for (const e of provider.sessionLineToEvents(ev)) {
      if (e.kind === 'usage') {
        // Dedupe by requestId when present (Claude repeats totals across the
        // N content-block lines of one turn). Providers without a requestId
        // (Codex) pass each per-turn usage through.
        const rid = e.requestId;
        if (rid) {
          if (seenRequestIds.has(rid)) continue;
          seenRequestIds.add(rid);
        }
        emit({ kind: 'usage', usage: e.usage });
      } else if (e.kind === 'tool') {
        observedToolUse = true;
        emit({ kind: 'tool', name: e.name, hint: e.hint || '' });
      } else if (e.kind === 'text') {
        emit({ kind: 'text', text: e.text });
      } else if (e.kind === 'end_turn') {
        // A turn can end before any tool_use (the agent says "I'll start by
        // reading X" and stops). Only honor end_turn after we've seen a tool,
        // so we don't mark the run done before edits actually happened.
        if (observedToolUse) emit({ kind: 'end_turn' });
      }
    }
  }

  poll();
  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

// Polls for a session file that didn't exist when we spawned the PTY, using
// the provider's detection (Claude: newest .jsonl in the per-worktree project
// dir; Codex: newest rollout in the global tree whose cwd matches). Used to
// attach the JSONL tail once the agent has actually started writing.
function waitForNewSessionFile(provider, worktreePath, preSnapshot, onFound, onTimeout) {
  const start = Date.now();
  let timer = null;
  let stopped = false;

  function check() {
    if (stopped) return;
    const found = provider.findNewSession(worktreePath, preSnapshot);
    if (found) {
      onFound(found.filePath, found.sessionId);
      return;
    }
    if (Date.now() - start > SESSION_DETECT_TIMEOUT_MS) {
      onTimeout();
      return;
    }
    timer = setTimeout(check, SESSION_DETECT_INTERVAL_MS);
  }
  check();
  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

// Public entry point for the IPC layer.
//
// Spawns the chosen agent interactively in `worktreePath` with `prompt` as the
// initial message. `onData` is raw PTY bytes for the inline xterm; `onEvent`
// receives normalized JSONL events; `onExit` fires once when the PTY exits.
// `provider` selects the agent (default 'claude').
// Caller is responsible for resolving the user's permission consent and
// applying the worktree settings.local.json BEFORE calling this (Claude only) —
// see util/worktree-permissions.js. Other agents prompt for edit approval in
// the xterm, which the user answers there.
function startImplementPty({ requestId, worktreePath, prompt, provider = 'claude', onData, onEvent, onExit }) {
  if (implementPtySessions.has(requestId)) {
    return { error: 'Already in flight' };
  }

  const config = loadConfig();
  const prov = getProvider(provider) || getProvider('claude');
  const bin = binFor(prov.id, config);
  // Gated agents (Gemini) prompt once per worktree for trust + file access.
  const consent = ensureWorktreeConsentSync(prov.id, worktreePath);
  if (!consent.allowed) return { cancelled: true };
  // Token-rotation guard: warn before a second concurrent Codex session.
  const authSlot = beginSession(prov.id);
  if (!authSlot.ok) return { cancelled: true };
  const userShell = defaultShell();
  const extraEnv = sanitizeExtraEnv({});

  // Pass the implement prompt as the first positional arg to the agent so it
  // lands as the initial user message in the interactive session. Inlining the
  // prompt into the shell command would require escaping quotes, backticks,
  // newlines and shell metacharacters reliably — too many edge cases. Instead:
  // write the prompt to a tempfile and use a `"$(cat …)"` substitution that the
  // shell expands into a single arg. The tempfile is removed when the PTY exits.
  const promptDir = path.join(os.tmpdir(), 'klaussy-implement-prompts');
  try { fs.mkdirSync(promptDir, { recursive: true }); } catch (err) {
    console.warn('[pr-implement-pty] mkdir failed for', promptDir, err.message);
  }
  const promptFile = path.join(promptDir, `${requestId}-${crypto.randomBytes(4).toString('hex')}.txt`);
  try {
    fs.writeFileSync(promptFile, prompt);
  } catch (err) {
    return { error: `Failed to stage implement prompt: ${err.message}` };
  }

  // Launch via the user's login shell (matches spawnInWorktree's PATH/nvm
  // resolution). buildInteractiveCmd gives the base agent command; we append
  // the prompt arg. Single-quote the tempfile path so a worktree with $ or `
  // doesn't trigger unwanted expansion.
  const model = (config.agentModel || {})[prov.id] || '';
  const agentCmd = prov.buildInteractiveCmd(bin, { trust: consent.trust, model });
  // Most agents take the prompt as a bare positional arg (Claude, Codex). Some
  // need a flag to execute it interactively (Gemini: `-i`). interactivePromptFlag
  // supplies that; default is none.
  const promptFlag = prov.interactivePromptFlag ? `${prov.interactivePromptFlag} ` : '';
  const quotedPrompt = `"$(cat '${promptFile.replace(/'/g, "'\\''")}')"`;
  const shellCmd = `${agentCmd} ${promptFlag}${quotedPrompt}`;
  const args = shellRunCmdArgs(userShell, shellCmd);

  const preSnapshot = prov.snapshotSessions(worktreePath);
  let ptyProc;
  try {
    ptyProc = pty.spawn(userShell, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: worktreePath,
      env: { ...process.env, TERM: 'xterm-256color', ...(extraEnv || {}) },
    });
  } catch (err) {
    // node-pty can throw on missing native bindings / bad shell path.
    // Clean up the staged prompt so /tmp doesn't accumulate orphans.
    try { fs.unlinkSync(promptFile); } catch {}
    authSlot.release(); // never spawned — free the concurrency slot
    return { error: `Failed to spawn implement PTY: ${err.message}` };
  }

  // Capture the JSONL stop so the IPC handler can clean up when cancel
  // fires before claude has written a session file.
  const session = {
    requestId,
    pty: ptyProc,
    worktreePath,
    promptFile,
    stopSessionWait: null,
    stopJsonlTail: null,
    sessionId: null,
    finished: false,
    cancelled: false,
    killTimer: null,
    promptSent: false,
    // Re-attach support: a rolling copy of the raw PTY output so a renderer
    // that remounts / pops out / refocuses can repaint without losing the run.
    outputBuffer: '',
    lastActivityAt: Date.now(),
  };
  implementPtySessions.set(requestId, session);

  let observedBytes = 0;
  ptyProc.onData((data) => {
    observedBytes += data.length;
    appendToBuffer(session, data);
    session.lastActivityAt = Date.now();
    onData(data);
  });
  ptyProc.onExit(({ exitCode, signal }) => {
    if (session.killTimer) { clearTimeout(session.killTimer); session.killTimer = null; }
    if (session.stopSessionWait) { try { session.stopSessionWait(); } catch {} }
    if (session.stopJsonlTail) { try { session.stopJsonlTail(); } catch {} }
    try { fs.unlinkSync(promptFile); } catch {}
    authSlot.release(); // free the concurrency slot (Codex token-rotation guard)
    // Retain the buffer + final status briefly so a re-opening renderer can
    // still show the completed run. `finished` wins over `cancelled` because
    // the renderer sends a cleanup Ctrl+C right after a normal end_turn — that
    // shouldn't relabel a completed run as cancelled.
    const finalStatus = session.finished ? 'done'
      : session.cancelled ? 'cancelled'
      : exitCode === 0 ? 'done' : 'error';
    pruneRecentRuns();
    recentImplementRuns.set(requestId, {
      buffer: session.outputBuffer, status: finalStatus, worktreePath, at: Date.now(),
    });
    implementPtySessions.delete(requestId);
    // Always emit exit now (even on a "finished" run) so detached/re-attached
    // renderers learn the PTY is gone; the renderer dedupes its own done state.
    onExit({ exitCode, signal, status: finalStatus });
  });

  // Fallback paste: if the arg-form prompt didn't take after 15s and
  // claude wrote nothing of substance to the PTY, type the prompt in
  // directly. The previous 6s timer was racy — a slow JSONL write
  // could trip the fallback after claude already had the prompt as
  // argv, double-typing it. Now we require BOTH "no JSONL session
  // appeared" AND "no meaningful PTY output", a state that only holds
  // when claude truly isn't running (custom wrapper, missing binary).
  setTimeout(() => {
    if (session.promptSent || !implementPtySessions.has(requestId)) return;
    if (session.sessionId || observedBytes > 200) { session.promptSent = true; return; }
    try {
      ptyProc.write(prompt);
      ptyProc.write('\r');
      session.promptSent = true;
    } catch (err) {
      console.warn('[pr-implement-pty] fallback prompt-paste failed', err.message);
    }
  }, 15000);

  session.stopSessionWait = waitForNewSessionFile(
    prov, worktreePath, preSnapshot,
    (filePath, sessionId) => {
      session.sessionId = sessionId;
      session.stopJsonlTail = startJsonlTail(filePath, prov, (ev) => {
        session.gotAgentEvent = true;
        if (ev.kind === 'end_turn') {
          // Mark the run finished here, but let the user keep the PTY
          // open so they can read the agent's output. The IPC handler
          // will close it on cancel or when the renderer dismisses.
          session.finished = true;
        }
        onEvent(ev);
      });
    },
    () => {
      // Couldn't find a session file in 30s — the agent probably failed
      // to start. Let the user see the PTY output anyway; the IPC
      // handler will still emit an exit event when the PTY dies.
    },
  );

  // Submit the pre-filled positional prompt for agents whose TUI doesn't
  // auto-run it (Codex). Claude auto-runs, so this stays off for it. We send
  // once the TUI has had time to render, and retry once if no agent event has
  // arrived yet (an extra Enter after the turn is already running is a no-op).
  if (prov.needsEnterToSubmit) {
    for (const ms of [3500, 8000]) {
      setTimeout(() => {
        if (!implementPtySessions.has(requestId) || session.finished || session.gotAgentEvent) return;
        try { ptyProc.write('\r'); } catch (err) {
          console.warn('[pr-implement-pty] submit-enter failed', err.message);
        }
      }, ms);
    }
  }

  return { ok: true };
}

function writeImplementPty(requestId, data) {
  const session = implementPtySessions.get(requestId);
  if (!session) return { error: 'Not found' };
  try { session.pty.write(data); } catch {}
  return { ok: true };
}

function resizeImplementPty(requestId, cols, rows) {
  const session = implementPtySessions.get(requestId);
  if (!session) return { error: 'Not found' };
  try { session.pty.resize(cols, rows); } catch {}
  return { ok: true };
}

// Cancel: send Ctrl+C first (lets claude clean up the in-flight tool
// call and write a final assistant block to the JSONL), then SIGTERM
// after 2s if the PTY is still alive.
function cancelImplementPty(requestId) {
  const session = implementPtySessions.get(requestId);
  if (!session) return { error: 'Not found' };
  session.cancelled = true;
  try {
    session.pty.write('\x03');
  } catch (err) {
    console.warn('[pr-implement-pty] Ctrl+C write failed for', requestId, err.message);
  }
  session.killTimer = setTimeout(() => {
    const s = implementPtySessions.get(requestId);
    if (!s) return;
    try {
      s.pty.kill();
    } catch (err) {
      console.error('[pr-implement-pty] SIGTERM failed for', requestId, err.message);
    }
  }, CANCEL_GRACE_MS);
  return { ok: true };
}

module.exports = {
  startImplementPty,
  writeImplementPty,
  resizeImplementPty,
  cancelImplementPty,
  getImplementSnapshot,
  getActiveImplementByWorktree,
  implementPtySessions,
};
