// PR-review Terminal-tab backends: the per-finding "Implement" runs and the
// always-on PR-aware chat session. Both stream a node-pty agent into the
// renderer's shared xterm and survive backgrounding (pop-out, navigate-away)
// by fanning output to a per-run/per-worktree subscriber set. Split out of
// claude-stream-ipc.js; required for its ipcMain.handle side effects.

const { ipcMain, BrowserWindow } = require('electron');
const { prReview, ensureWorktreeForActivePr } = require('../state/pr-review');
const { pickProvider, agentForWorktree, repoIntelFor } = require('../state/agent-select');
const { ensureWorktreeBootstrap } = require('../state/repo-intel');
const { getOrAskRepoConsent, applyWorktreePermissions } = require('../util/worktree-permissions');
const {
  startImplementPty, writeImplementPty, resizeImplementPty, cancelImplementPty,
  getImplementSnapshot, getActiveImplementByWorktree, implementPtySessions,
} = require('../state/pr-implement-pty');
const {
  startOrAttachChat, writeChat, resizeChat, cancelChat,
  getChatSnapshot, chatActiveForWorktree, chatKeyFor,
} = require('../state/pr-chat-pty');

// requestId -> Set<WebContents> currently attached to that run's xterm. A run
// can be viewed by 0..N surfaces (main window + pop-out, or none while
// backgrounded). PTY output is fanned out to whoever is attached; the run
// itself survives even when the set is empty (that's what makes it
// backgroundable + re-attachable — bugs 1/2/5).
const implementSubscribers = new Map();

function implementSubs(requestId) {
  let set = implementSubscribers.get(requestId);
  if (!set) { set = new Set(); implementSubscribers.set(requestId, set); }
  return set;
}

function broadcastToImplementSubs(requestId, channel, payload) {
  const set = implementSubscribers.get(requestId);
  if (!set) return;
  for (const wc of [...set]) {
    if (!wc || wc.isDestroyed()) { set.delete(wc); continue; }
    try { wc.send(channel, payload); } catch {}
  }
}

// Notify every window (regardless of which surface is showing) that a
// backgrounded implement run wants attention — finished, errored, or paused
// after a turn while nobody was watching. app.js turns this into a toast so the
// user knows to reopen the PR.
function notifyImplementAttention(payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) { try { w.webContents.send('pr-implement-attention', payload); } catch {} }
  }
}

// Implement a single finding (or "all findings" via one big prompt) by
// running an interactive `claude` inside a node-pty in the PR's worktree.
// The renderer mounts an xterm.js for the user to answer any prompts
// (Bash, MCP, etc.); Edit/Write on the worktree path are
// pre-allowed via a per-worktree settings.local.json so the common
// case doesn't drown the user in Y/N prompts.
//
// Previously this spawned `claude -p` headless, which (a) billed extra
// against the user's Anthropic account and (b) silently dropped permission
// prompts since there was no TTY — so Edit calls reported "haven't granted
// it yet" and the run hung. See feedback memories on `claude -p` and
// the no-permission-bypass rule.
ipcMain.handle('pr-review-implement-start', async (event, { requestId, mode, body, provider } = {}) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (implementPtySessions.has(requestId)) return { error: 'Already in flight' };
  if (!prReview.active) return { error: 'No active PR review' };
  if (!body || !body.trim()) return { error: 'Empty implement body' };

  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };
  // Give the PR worktree the base repo's skills/slash-commands/rules/CLAUDE.md
  // so the implement agent can find them (it's a freshly cloned worktree, not a
  // normal session, so it doesn't get this otherwise).
  ensureWorktreeBootstrap(ensured.worktreePath);
  // Stash the worktree on the active PR so 'pr-review-implement-active' can
  // match a backgrounded run to this PR (e.g. when a fresh pop-out asks).
  if (prReview.active) prReview.active.worktreePath = ensured.worktreePath;

  // Two prompts depending on whether we're implementing one finding or many.
  // Both share guardrails so claude doesn't drift into unrelated cleanup or
  // start running tests/commits.
  // Structured workflow that forces usage-tracing before edits and a self-
  // review after, so a fix for finding A doesn't ship a regression that a
  // later review round flags as finding B (the "10 rounds of blockers" loop).
  const baseGuardrails =
    `\n\nWorkflow (mandatory):\n\n`
    + `1. **Before editing.** For each symbol you will modify (function, class,\n`
    + `   type, exported constant, IPC channel, config key): grep for every\n`
    + `   usage in the repo and read the full file at each call site. For each\n`
    + `   behavior you will change, trace one realistic call path end-to-end\n`
    + `   and note any caller that depends on the current behavior (return\n`
    + `   shape, null/empty handling, error propagation, ordering, side\n`
    + `   effects). If a symbol crosses an IPC/preload boundary, grep the\n`
    + `   matching channel name in both main and renderer.\n\n`
    + `2. **While editing.**\n`
    + `   - Only change what the finding(s) ask for; no unrelated cleanup.\n`
    + `   - Preserve invariants callers rely on. If a function returns \`null\`\n`
    + `     on miss and callers gate on \`if (x)\`, don't switch to returning\n`
    + `     \`{}\` or throwing. If an event fires once, don't make it fire twice.\n`
    + `   - Match the existing error/null-handling style; don't introduce new\n`
    + `     failure modes the callers won't catch.\n`
    + `   - Do not run tests, install deps, or commit/push.\n\n`
    + `3. **After editing — self-review pass (required).** Re-read every call\n`
    + `   site you found in step 1. For each one, state in one short sentence\n`
    + `   whether the change is safe for that caller and why. If any caller\n`
    + `   needs updating, update it in the same change and re-run this pass\n`
    + `   on the updated caller. If you cannot verify a caller is safe (e.g.\n`
    + `   the symbol crosses a process boundary, is reflected on, or is\n`
    + `   consumed by code outside this repo), say so explicitly and stop —\n`
    + `   surface the uncertainty rather than guess.\n\n`
    + `4. **Summary.** One short bullet per change, prefixed with the file\n`
    + `   path. Be terse. Then list the self-review notes from step 3 under a\n`
    + `   "Call-site check:" heading.\n`;
  // Single-finding mode emits a follow-up PR comment draft between literal
  // markers so the renderer can extract it and present it to the reviewer
  // for approval. Batch "all" mode skips the marker — one comment for a mixed
  // batch of findings wouldn't map cleanly to any one finding card.
  const draftCommentInstruction =
    `\n5. **Draft PR comment.** On a new line, output exactly one block\n`
    + `   delimited by these literal markers:\n\n`
    + `   <DRAFT_PR_COMMENT>\n`
    + `   One or two sentences written as a reply the reviewer could post\n`
    + `   under the finding on GitHub — explain what you fixed and how. Do\n`
    + `   not repeat the finding verbatim. Plain prose, no code fences, no\n`
    + `   bullets.\n`
    + `   </DRAFT_PR_COMMENT>\n`;
  // Prefer an explicit agent from the split-button picker; otherwise follow the
  // agent of the task running on this PR's worktree (then the default).
  const implProvider = pickProvider(provider, agentForWorktree(ensured.worktreePath));

  // Implement runs get the repo's conventions/graph context too — fixes
  // should follow house rules, not generic style. (Provider-aware: claude in
  // a synced worktree gets the slim graph-only block.)
  const implIntel = repoIntelFor(ensured.worktreePath, implProvider);
  const prompt = (mode === 'all'
    ? `Apply the following code-review findings to the codebase:\n\n${body}` + baseGuardrails
    : `Apply the following code-review finding to the codebase:\n\n${body}` + baseGuardrails + draftCommentInstruction)
    + (implIntel ? '\n' + implIntel : '');

  // Permission consent (Claude only): pre-allow file edits scoped to this
  // worktree via settings.local.json (and deny secret files). Other agents
  // (Codex, etc.) prompt for edit approval in the xterm, which the user
  // answers there — so there's nothing to pre-write for them.
  if (implProvider === 'claude') {
    const consent = await getOrAskRepoConsent(ensured.worktreePath);
    if (consent === 'allow') {
      const applyResult = applyWorktreePermissions(ensured.worktreePath);
      if (!applyResult.applied) {
        return { error: `Failed to apply permissions: ${applyResult.reason}` };
      }
    }
  }

  const sender = event.sender;
  const prNumber = prReview.active && prReview.active.number;
  const dataChannel = `pr-review-implement-pty-data-${requestId}`;
  const eventChannel = `pr-review-implement-pty-event-${requestId}`;
  const exitChannel = `pr-review-implement-pty-exit-${requestId}`;

  // The starting window is the first subscriber; more attach via
  // 'pr-review-implement-attach' (pop-out, re-mount). Output fans out to all
  // attached surfaces. Crucially we DON'T cancel the PTY when a surface goes
  // away — the run persists in the background and can be re-attached.
  implementSubs(requestId).add(sender);

  const result = startImplementPty({
    requestId,
    worktreePath: ensured.worktreePath,
    prompt,
    provider: implProvider,
    onData: (data) => broadcastToImplementSubs(requestId, dataChannel, data),
    onEvent: (ev) => {
      broadcastToImplementSubs(requestId, eventChannel, ev);
      // Turn finished with nobody attached. Normally the renderer sends the
      // cleanup Ctrl+C on finalize; with no surface, main MUST wind the PTY
      // down itself — otherwise the idle Claude TUI (and its agent-concurrency
      // slot, released only in onExit) leaks until app quit. cancel → onExit →
      // slot freed + run retained in recentImplementRuns for replay on reopen.
      // The onExit branch fires the single "finished" notification.
      if (ev && ev.kind === 'end_turn' && implementSubs(requestId).size === 0) {
        try { cancelImplementPty(requestId); } catch {}
      }
    },
    onExit: ({ exitCode, signal, status }) => {
      broadcastToImplementSubs(requestId, exitChannel, { exitCode, signal, status });
      // If the run ended while backgrounded, surface it everywhere.
      if (implementSubs(requestId).size === 0) {
        notifyImplementAttention({ requestId, prNumber, status: status || 'done' });
      }
      implementSubscribers.delete(requestId);
    },
  });
  if (result.error) { implementSubscribers.delete(requestId); return { error: result.error }; }

  // A surface going away just detaches it — the run keeps going. (No
  // cancel-on-destroy: that was the cause of runs vanishing on pop-out /
  // space-switch / navigate-away.)
  sender.once('destroyed', () => {
    const set = implementSubscribers.get(requestId);
    if (set) set.delete(sender);
  });

  return { ok: true, worktreePath: ensured.worktreePath, requestId };
});

// (Re)attach a surface to a run: register it as a subscriber and hand back the
// buffered output + current status so it can repaint. Used on remount, pop-out,
// and refocus. Returns { found:false } if the run is gone (older than the
// recent-run TTL).
ipcMain.handle('pr-review-implement-attach', (event, { requestId } = {}) => {
  if (!requestId) return { found: false };
  const sender = event.sender;
  // Subscribe BEFORE snapshotting the buffer: any byte emitted in the gap is
  // then duplicated into the replay (a harmless TUI redraw) rather than missed.
  if (implementPtySessions.has(requestId)) {
    implementSubs(requestId).add(sender);
    sender.once('destroyed', () => {
      const set = implementSubscribers.get(requestId);
      if (set) set.delete(sender);
    });
  }
  const snap = getImplementSnapshot(requestId);
  if (!snap.found) {
    const set = implementSubscribers.get(requestId);
    if (set) set.delete(sender);
    return { found: false };
  }
  return { found: true, live: snap.live, status: snap.status, buffer: snap.buffer };
});

// Detach without cancelling — the surface is going away but the run continues.
ipcMain.handle('pr-review-implement-detach', (event, { requestId } = {}) => {
  if (!requestId) return { ok: false };
  const set = implementSubscribers.get(requestId);
  if (set) set.delete(event.sender);
  return { ok: true };
});

// Discover a backgrounded run for the active PR (so a fresh surface — e.g. a
// pop-out — can find a run it didn't start). Matches by the PR's worktree.
ipcMain.handle('pr-review-implement-active', () => {
  if (!prReview.active) return { active: null };
  const wt = prReview.active.worktreePath;
  if (!wt) return { active: null };
  return { active: getActiveImplementByWorktree(wt) };
});

ipcMain.handle('pr-review-implement-input', (_event, { requestId, data }) => {
  if (!requestId || typeof data !== 'string') return { error: 'Bad args' };
  return writeImplementPty(requestId, data);
});

ipcMain.handle('pr-review-implement-resize', (_event, { requestId, cols, rows }) => {
  if (!requestId) return { error: 'Bad args' };
  return resizeImplementPty(requestId, cols, rows);
});

ipcMain.handle('pr-review-implement-cancel', (_event, { requestId }) => {
  if (!requestId) return { ok: false };
  return cancelImplementPty(requestId);
});

// ---- Persistent PR-aware terminal chat (Terminal tab) ----
//
// One long-lived agent session per PR worktree, seeded with the PR context so
// the reviewer can just start chatting about the change. Distinct from the
// per-finding 'pr-review-chat-start' below (that's a stateless one-finding
// discussion); this is the always-on terminal. Output fans out to every
// attached surface (main + pop-out) keyed by the worktree-derived chatKey.
const tchatSubscribers = new Map();
function tchatSubs(chatKey) {
  let set = tchatSubscribers.get(chatKey);
  if (!set) { set = new Set(); tchatSubscribers.set(chatKey, set); }
  return set;
}
function broadcastToTchatSubs(chatKey, channel, payload) {
  const set = tchatSubscribers.get(chatKey);
  if (!set) return;
  for (const wc of [...set]) {
    if (!wc || wc.isDestroyed()) { set.delete(wc); continue; }
    try { wc.send(channel, payload); } catch {}
  }
}

// One-time context the chat agent is seeded with. Tells it which PR it's
// looking at and where to find the diff; the agent runs the git commands
// itself (keeps the seed small even for huge PRs).
function buildChatSeedPrompt() {
  const a = prReview.active;
  const meta = (a && a.meta) || {};
  const base = meta.baseRefName || 'the base branch';
  const head = meta.headRefName || 'this branch';
  const num = (a && a.number) || meta.number || '';
  const title = meta.title || '';
  let body = (meta.body || '').trim();
  if (body.length > 1200) body = body.slice(0, 1200) + '\n...(truncated)';
  const lines = [];
  lines.push(`I'm reviewing pull request #${num}${title ? `: "${title}"` : ''}.`);
  lines.push(`It merges ${head} into ${base}, and that branch is checked out in this worktree.`);
  if (body) lines.push(`\nPR description:\n${body}`);
  lines.push(`\nTo see the change: \`git diff ${base}...HEAD\` for the full diff, \`git diff --stat ${base}...HEAD\` for the file list, \`git log ${base}..HEAD --oneline\` for the commits. Read whatever files you need for context.`);
  lines.push(`\nI'll ask you questions about this PR. Keep answers short and direct, like a colleague at a desk. Don't commit or push. Wait for my first question, a one-line "ready" is enough to start.`);
  return lines.join('\n');
}

ipcMain.handle('pr-review-tchat-start', async (event, { provider } = {}) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };
  // Sync the base repo's skills/slash-commands/rules/CLAUDE.md into the PR
  // worktree so the chat agent can find them (same gap as the implement path).
  ensureWorktreeBootstrap(ensured.worktreePath);
  if (prReview.active) prReview.active.worktreePath = ensured.worktreePath;

  const chatProvider = pickProvider(provider, agentForWorktree(ensured.worktreePath));
  const sender = event.sender;

  // chatKey is deterministic from the worktree, so we can compute the channel
  // names up front (and they line up on re-attach). Subscribe BEFORE spawning
  // so we don't miss the agent's first bytes.
  const chatKey = chatKeyFor(ensured.worktreePath);
  const dataChannel = `pr-review-tchat-data-${chatKey}`;
  const exitChannel = `pr-review-tchat-exit-${chatKey}`;
  tchatSubs(chatKey).add(sender);
  sender.once('destroyed', () => {
    const set = tchatSubscribers.get(chatKey);
    if (set) set.delete(sender);
  });

  const result = startOrAttachChat({
    worktreePath: ensured.worktreePath,
    provider: chatProvider,
    seedPrompt: buildChatSeedPrompt(),
    onData: (data) => broadcastToTchatSubs(chatKey, dataChannel, data),
    onExit: (info) => {
      broadcastToTchatSubs(chatKey, exitChannel, info);
      tchatSubscribers.delete(chatKey);
    },
  });
  if (result.cancelled) { tchatSubs(chatKey).delete(sender); return { cancelled: true }; }
  if (result.error) { tchatSubs(chatKey).delete(sender); return { error: result.error }; }
  return { ok: true, chatKey, worktreePath: ensured.worktreePath, already: !!result.already, provider: chatProvider };
});

// (Re)attach a surface: register it and hand back the buffered scrollback +
// status so it can repaint a session it didn't start (pop-out, remount).
ipcMain.handle('pr-review-tchat-attach', (event, { chatKey } = {}) => {
  if (!chatKey) return { found: false };
  const snap = getChatSnapshot(chatKey);
  if (!snap.found) return { found: false };
  const sender = event.sender;
  tchatSubs(chatKey).add(sender);
  sender.once('destroyed', () => {
    const set = tchatSubscribers.get(chatKey);
    if (set) set.delete(sender);
  });
  return { found: true, live: snap.live, status: snap.status, buffer: snap.buffer };
});

ipcMain.handle('pr-review-tchat-detach', (event, { chatKey } = {}) => {
  if (!chatKey) return { ok: false };
  const set = tchatSubscribers.get(chatKey);
  if (set) set.delete(event.sender);
  return { ok: true };
});

// Discover a backgrounded chat for the active PR so a fresh surface can find
// the session it didn't start.
ipcMain.handle('pr-review-tchat-active', () => {
  if (!prReview.active || !prReview.active.worktreePath) return { active: null };
  return { active: chatActiveForWorktree(prReview.active.worktreePath) };
});

ipcMain.handle('pr-review-tchat-input', (_event, { chatKey, data } = {}) => {
  if (!chatKey || typeof data !== 'string') return { error: 'Bad args' };
  return writeChat(chatKey, data);
});

ipcMain.handle('pr-review-tchat-resize', (_event, { chatKey, cols, rows } = {}) => {
  if (!chatKey) return { error: 'Bad args' };
  return resizeChat(chatKey, cols, rows);
});

ipcMain.handle('pr-review-tchat-cancel', (_event, { chatKey } = {}) => {
  if (!chatKey) return { ok: false };
  return cancelChat(chatKey);
});
