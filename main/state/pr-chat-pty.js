// Persistent PR-aware chat session for the PR-review Terminal tab.
//
// Unlike pr-implement-pty (one prompt, runs to end_turn, finalizes, dies), the
// chat session is long-lived: it spawns the user's default agent interactively
// in the PR's worktree, seeds it once with the PR context (title, body, base
// branch, where to find the diff), and then stays open so the reviewer can
// keep chatting about the change. There is at most ONE chat session per
// worktree; remounts / pop-outs / navigate-away-and-back re-attach to the same
// session by its stable worktree-derived key.
//
// This is deliberately simpler than the implement runner: there's no JSONL
// tailing, no structured tool/usage events, and no "done" detection. It's a
// raw interactive terminal — the renderer streams bytes to its xterm and sends
// keystrokes back. Edit-permission prompts (Claude) are answered by the user in
// that same xterm; we do NOT pre-allow edits the way implement does, because a
// chat session is for discussion first.

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

// worktreeKey -> session record.
const chatSessions = new Map();

const OUTPUT_BUFFER_CAP = 1024 * 1024;

function normWt(p) { return String(p || '').replace(/\/+$/, ''); }

// Stable, filesystem-safe id for a worktree so IPC channel names and re-attach
// lookups line up across windows and remounts.
function chatKeyFor(worktreePath) {
  return crypto.createHash('sha1').update(normWt(worktreePath)).digest('hex').slice(0, 12);
}

function appendToBuffer(session, data) {
  session.outputBuffer += data;
  if (session.outputBuffer.length > OUTPUT_BUFFER_CAP) {
    session.outputBuffer = session.outputBuffer.slice(session.outputBuffer.length - OUTPUT_BUFFER_CAP);
  }
}

function getChatByKey(chatKey) {
  for (const s of chatSessions.values()) {
    if (s.chatKey === chatKey) return s;
  }
  return null;
}

// Snapshot for a (re)attaching renderer.
function getChatSnapshot(chatKey) {
  const s = getChatByKey(chatKey);
  if (!s) return { found: false };
  return { found: true, live: true, status: 'running', buffer: s.outputBuffer, worktreePath: s.worktreePath };
}

function chatActiveForWorktree(worktreePath) {
  const s = chatSessions.get(normWt(worktreePath));
  return s ? { chatKey: s.chatKey, worktreePath: s.worktreePath, live: true } : null;
}

// Spawn (or no-op if one already exists) the chat agent for a worktree.
// `onData`/`onExit` are the IPC fan-out callbacks. Returns a descriptor the IPC
// handler hands back to the renderer; `already:true` means an existing session
// was reused (the renderer should pull the buffer via attach instead of
// expecting a fresh banner).
function startOrAttachChat({ worktreePath, provider = 'claude', seedPrompt, onData, onExit }) {
  const wtKey = normWt(worktreePath);
  const existing = chatSessions.get(wtKey);
  if (existing) {
    return { ok: true, already: true, chatKey: existing.chatKey, worktreePath: existing.worktreePath };
  }

  const config = loadConfig();
  const prov = getProvider(provider) || getProvider('claude');
  const bin = binFor(prov.id, config);
  // Gated agents (Gemini) prompt once per worktree for trust + file access.
  const consent = ensureWorktreeConsentSync(prov.id, worktreePath);
  if (!consent.allowed) return { cancelled: true };
  // Token-rotation guard (Codex): warn before a second concurrent session.
  const authSlot = beginSession(prov.id);
  if (!authSlot.ok) return { cancelled: true };

  const userShell = defaultShell();
  const extraEnv = sanitizeExtraEnv({});

  // Stage the seed prompt in a tempfile and feed it as the first positional
  // arg, same trick as implement: avoids quoting newlines / metacharacters.
  const promptDir = path.join(os.tmpdir(), 'klaussy-chat-prompts');
  try { fs.mkdirSync(promptDir, { recursive: true }); } catch (err) {
    console.warn('[pr-chat-pty] mkdir failed for', promptDir, err.message);
  }
  const chatKey = chatKeyFor(worktreePath);
  const promptFile = path.join(promptDir, `${chatKey}-${crypto.randomBytes(4).toString('hex')}.txt`);
  const seed = seedPrompt || 'You are helping me review this pull request. Ask me what I need.';
  try {
    fs.writeFileSync(promptFile, seed);
  } catch (err) {
    authSlot.release();
    return { error: `Failed to stage chat prompt: ${err.message}` };
  }

  const model = (config.agentModel || {})[prov.id] || '';
  const agentCmd = prov.buildInteractiveCmd(bin, { trust: consent.trust, model });
  const promptFlag = prov.interactivePromptFlag ? `${prov.interactivePromptFlag} ` : '';
  const quotedPrompt = `"$(cat '${promptFile.replace(/'/g, "'\\''")}')"`;
  const shellCmd = `${agentCmd} ${promptFlag}${quotedPrompt}`;
  const args = shellRunCmdArgs(userShell, shellCmd);

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
    try { fs.unlinkSync(promptFile); } catch {}
    authSlot.release();
    return { error: `Failed to spawn chat PTY: ${err.message}` };
  }

  const session = {
    chatKey,
    worktreePath,
    pty: ptyProc,
    promptFile,
    authSlot,
    provider: prov.id,
    outputBuffer: '',
    promptSent: false,
    observedBytes: 0,
    lastActivityAt: Date.now(),
  };
  chatSessions.set(wtKey, session);

  ptyProc.onData((data) => {
    session.observedBytes += data.length;
    appendToBuffer(session, data);
    session.lastActivityAt = Date.now();
    onData(data);
  });
  ptyProc.onExit(({ exitCode, signal }) => {
    try { fs.unlinkSync(promptFile); } catch {}
    authSlot.release();
    chatSessions.delete(wtKey);
    onExit({ exitCode, signal });
  });

  // Fallback paste: if the positional-arg seed didn't take (custom wrapper /
  // agent that ignores argv) and nothing meaningful printed, type it in. Same
  // 15s "truly idle" guard as implement so we don't double-send.
  setTimeout(() => {
    if (session.promptSent || !chatSessions.has(wtKey)) return;
    if (session.observedBytes > 200) { session.promptSent = true; return; }
    try { ptyProc.write(seed); ptyProc.write('\r'); session.promptSent = true; } catch (err) {
      console.warn('[pr-chat-pty] fallback seed-paste failed', err.message);
    }
  }, 15000);

  // Agents whose TUI doesn't auto-run the positional prompt (Codex) need an
  // Enter once the TUI has rendered.
  if (prov.needsEnterToSubmit) {
    for (const ms of [3500, 8000]) {
      setTimeout(() => {
        if (!chatSessions.has(wtKey) || session.observedBytes > 400) return;
        try { ptyProc.write('\r'); } catch {}
      }, ms);
    }
  }

  return { ok: true, already: false, chatKey, worktreePath };
}

function writeChat(chatKey, data) {
  const s = getChatByKey(chatKey);
  if (!s) return { error: 'No chat session' };
  try { s.pty.write(data); } catch {}
  return { ok: true };
}

function resizeChat(chatKey, cols, rows) {
  const s = getChatByKey(chatKey);
  if (!s) return { error: 'No chat session' };
  try { s.pty.resize(cols, rows); } catch {}
  return { ok: true };
}

// Cancel: Ctrl+C then a SIGTERM grace, like implement's cancel. The session is
// removed from the map by the onExit handler.
function cancelChat(chatKey) {
  const s = getChatByKey(chatKey);
  if (!s) return { ok: true };
  try { s.pty.write('\x03'); } catch {}
  setTimeout(() => {
    if (getChatByKey(chatKey)) { try { s.pty.kill(); } catch {} }
  }, 1500);
  return { ok: true };
}

module.exports = {
  chatKeyFor,
  startOrAttachChat,
  writeChat,
  resizeChat,
  cancelChat,
  getChatSnapshot,
  chatActiveForWorktree,
};
