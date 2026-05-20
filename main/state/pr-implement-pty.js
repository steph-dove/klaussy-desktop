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
// pre-allows Edit/Write/MultiEdit on that worktree's path before launch.
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
const {
  snapshotSessionIds,
  detectClaudeSessionId,
  listSessionFiles,
} = require('./instances');

// requestId -> session record. Keyed by the renderer-supplied requestId so
// the cancel IPC can look up the right PTY without leaking it across runs.
const implementPtySessions = new Map();

const SESSION_DETECT_INTERVAL_MS = 250;
const SESSION_DETECT_TIMEOUT_MS = 30000;
const JSONL_TAIL_INTERVAL_MS = 300;
const CANCEL_GRACE_MS = 2000;

// Encodes a worktree path the same way claude does when picking the
// project directory under ~/.claude/projects. Used for the JSONL tail.
function claudeProjectDirFor(worktreePath) {
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.claude', 'projects', worktreePath.replace(/\//g, '-'));
}

function sumUsage(u) {
  if (!u) return null;
  return {
    inputTokens: u.input_tokens || 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens || 0,
    cacheReadInputTokens: u.cache_read_input_tokens || 0,
    outputTokens: u.output_tokens || 0,
  };
}

// Tails one .jsonl file forwards-only. Skips repeated `usage` totals
// (same requestId fires N lines, one per content block) so we don't
// double-emit progress. Dispatches normalized events back to the
// caller-supplied `emit`.
function startJsonlTail(filePath, emit) {
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
    const reqId = ev && ev.requestId;
    const msg = ev && ev.message;
    if (!msg) return;

    // One turn = many JSONL lines (one per content block) all sharing
    // the same usage totals. Dedupe by requestId so we only emit usage
    // once per turn.
    if (msg.usage && reqId && !seenRequestIds.has(reqId)) {
      seenRequestIds.add(reqId);
      emit({ kind: 'usage', usage: sumUsage(msg.usage) });
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block) continue;
        if (block.type === 'tool_use' && block.name) {
          observedToolUse = true;
          const inp = block.input || {};
          const hint = inp.file_path || inp.command || inp.pattern || '';
          emit({ kind: 'tool', name: block.name, hint: typeof hint === 'string' ? hint : '' });
        } else if (block.type === 'text' && block.text) {
          emit({ kind: 'text', text: block.text });
        }
      }
    }

    // `stop_reason` may live on the message or one rung higher depending
    // on the line shape; check both. end_turn = claude finished an
    // assistant turn, but a turn can end with `end_turn` BEFORE any
    // tool_use (e.g. claude says "I'll start by reading X" and stops).
    // For implement runs we only honor end_turn after we've seen at
    // least one tool_use — otherwise an early end_turn would mark the
    // run done while the actual edits haven't happened.
    const stopReason = msg.stop_reason || ev.stop_reason;
    if (stopReason === 'end_turn' && observedToolUse) {
      emit({ kind: 'end_turn' });
    }
  }

  poll();
  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

// Polls the project directory for a session file that didn't exist
// when we spawned the PTY. Used to attach the JSONL tail once claude
// has actually started writing.
function waitForNewSessionFile(worktreePath, preSpawnIds, onFound, onTimeout) {
  const start = Date.now();
  const projectDir = claudeProjectDirFor(worktreePath);
  let timer = null;
  let stopped = false;

  function check() {
    if (stopped) return;
    const files = listSessionFiles(worktreePath)
      .filter(f => !preSpawnIds.has(f.sessionId))
      .sort((a, b) => {
        if (a.ctimeNs < b.ctimeNs) return -1;
        if (a.ctimeNs > b.ctimeNs) return 1;
        return 0;
      });
    if (files.length > 0) {
      onFound(path.join(projectDir, files[0].name), files[0].sessionId);
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
// Spawns an interactive claude in `worktreePath`, then writes `prompt`
// followed by Enter so the user sees the prompt body as the first line
// of the turn. `onData` is called with raw PTY bytes for the inline
// xterm; `onEvent` receives normalized JSONL events; `onExit` fires
// once when the PTY exits.
// Caller is responsible for resolving the user's permission consent and
// applying the worktree settings.local.json BEFORE calling this — see
// util/worktree-permissions.js. We trust whatever permission setup is in
// place when this runs.
function startImplementPty({ requestId, worktreePath, prompt, onData, onEvent, onExit }) {
  if (implementPtySessions.has(requestId)) {
    return { error: 'Already in flight' };
  }

  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  const userShell = defaultShell();
  const extraEnv = sanitizeExtraEnv({});

  // Pass the implement prompt as the first positional arg to `claude` so
  // it lands as the initial user message in the interactive session.
  // Inlining the prompt into the shell command would require escaping
  // quotes, backticks, newlines and shell metacharacters reliably — too
  // many edge cases. Instead: write the prompt to a tempfile and use a
  // `"$(cat …)"` substitution that the shell expands into a single arg.
  // The tempfile lives under the OS temp dir and is removed when the
  // PTY exits (best-effort).
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

  // Use the user's login shell to launch claude — matches how PR-review
  // worktree tasks are spawned (instances.js:spawnInWorktree) so the
  // claude resolution behavior is identical (PATH, nvm, etc.).
  // Single-quote the path so a worktree with $ or ` (rare but possible)
  // doesn't trigger unwanted expansion.
  const shellCmd = `${claudeBin} "$(cat '${promptFile.replace(/'/g, "'\\''")}')"`;
  const args = shellRunCmdArgs(userShell, shellCmd);

  const preSpawnIds = snapshotSessionIds(worktreePath);
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
    killTimer: null,
    promptSent: false,
  };
  implementPtySessions.set(requestId, session);

  let observedBytes = 0;
  ptyProc.onData((data) => {
    observedBytes += data.length;
    onData(data);
  });
  ptyProc.onExit(({ exitCode, signal }) => {
    if (session.killTimer) { clearTimeout(session.killTimer); session.killTimer = null; }
    if (session.stopSessionWait) { try { session.stopSessionWait(); } catch {} }
    if (session.stopJsonlTail) { try { session.stopJsonlTail(); } catch {} }
    try { fs.unlinkSync(promptFile); } catch {}
    implementPtySessions.delete(requestId);
    if (!session.finished) onExit({ exitCode, signal });
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
    worktreePath, preSpawnIds,
    (filePath, sessionId) => {
      session.sessionId = sessionId;
      session.stopJsonlTail = startJsonlTail(filePath, (ev) => {
        if (ev.kind === 'end_turn') {
          // Mark the run finished here, but let the user keep the PTY
          // open so they can read claude's output. The IPC handler
          // will close it on cancel or when the renderer dismisses.
          session.finished = true;
        }
        onEvent(ev);
      });
    },
    () => {
      // Couldn't find a session file in 30s — claude probably failed
      // to start. Let the user see the PTY output anyway; the IPC
      // handler will still emit an exit event when the PTY dies.
    },
  );

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
  implementPtySessions,
};
