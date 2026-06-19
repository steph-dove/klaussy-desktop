// All 8 Claude streaming IPC surfaces plus the explain-diff helpers and
// the review-prompt builder (buildReviewPrompt). Each start-handler spawns a
// claude stream via spawnClaudeStream (from state/claude-streaming.js) and each
// cancel handler is a thin makeClaudeCancelHandler over the matching
// proc map.

const { ipcMain, BrowserWindow } = require('electron');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { instances, spawnInWorktree } = require('../state/instances');
const { isAgentMode } = require('../state/ai-providers');
const { prReview, ensureWorktreeForActivePr, currentRepoPath } = require('../state/pr-review');
const { execFileP } = require('../util/exec');
const { loadConfig } = require('../util/config');
const { getRepoIntelBlock, ensureRepoIntel } = require('../state/repo-intel');
const { buildReviewPrompt, explainPrompt } = require('../state/review-prompts');

const {
  spawnClaudeStream, makeClaudeCancelHandler,
  debugCheckProcs, fixCheckProcs, inlineEditProcs, inlineCompleteProcs, reviewSurfaceAiProcs,
  explainStreamProcs, aiReviewProcs, commitMsgProcs, reviewChatProcs,
  investigateProcs,
} = require('../state/claude-streaming');
const {
  startImplementPty, writeImplementPty, resizeImplementPty, cancelImplementPty,
  getImplementSnapshot, getActiveImplementByWorktree,
  implementPtySessions,
} = require('../state/pr-implement-pty');
const {
  startOrAttachChat, writeChat, resizeChat, cancelChat,
  getChatSnapshot, chatActiveForWorktree, chatKeyFor,
} = require('../state/pr-chat-pty');
const {
  repoIntelFor, defaultAgentProvider, pickProvider, agentForWorktree,
} = require('../state/agent-select');

const {
  getOrAskRepoConsent, applyWorktreePermissions,
} = require('../util/worktree-permissions');

// Stable, bounded ID for dedupeKey suffixes. Inputs (hunks, finding bodies,
// staged diffs) can be many KB; sha1 keeps keys short and comparable.
function shortHash(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 12);
}


// Build the shared "failing CI check" context block — log tail, annotations,
// matching workflow YAML, truncated PR diff. Used by both pr-debug-check-start
// (read-only analysis) and pr-fix-check-start (autonomous edit run). Returns
// either the assembled blocks or { error } for the caller to surface.
function buildFailingCheckContext({ checkLink, checkName, checkRunId, cwd, baseOwner, baseRepo, diff }) {
  if (!checkLink) return { error: 'Check has no run link to fetch logs from' };
  const m = checkLink.match(/\/actions\/runs\/(\d+)\/job\/(\d+)/);
  const runId = m ? m[1] : null;
  const jobId = m ? m[2] : null;
  if (!runId || !jobId) return { error: 'Could not parse run/job id from link: ' + checkLink };

  let logs = '';
  try {
    logs = execFileSync('gh', [
      'api', `/repos/${baseOwner}/${baseRepo}/actions/jobs/${jobId}/logs`,
    ], { cwd, stdio: 'pipe', timeout: 20000, maxBuffer: 50 * 1024 * 1024 }).toString();
  } catch (errA) {
    try {
      logs = execFileSync('gh', [
        'run', 'view', String(runId),
        '-R', `${baseOwner}/${baseRepo}`,
        '--log-failed',
      ], { cwd, stdio: 'pipe', timeout: 30000, maxBuffer: 50 * 1024 * 1024 }).toString();
    } catch (errB) {
      const msg = (errA.stderr ? errA.stderr.toString().trim() : errA.message)
        || (errB.stderr ? errB.stderr.toString().trim() : errB.message);
      return { error: 'Could not fetch logs: ' + msg };
    }
  }
  const logTail = logs.split('\n').slice(-400).join('\n');

  const diffLines = (diff || '').split('\n');
  const diffSnippet = diffLines.slice(0, 600).join('\n')
    + (diffLines.length > 600 ? '\n\n[... diff truncated ...]\n' : '');

  let annotationsBlock = '';
  if (checkRunId) {
    try {
      const annoRaw = execFileSync('gh', [
        'api', `/repos/${baseOwner}/${baseRepo}/check-runs/${checkRunId}/annotations`,
        '--paginate',
      ], { cwd, stdio: 'pipe', timeout: 10000, maxBuffer: 4 * 1024 * 1024 }).toString();
      const annos = JSON.parse(annoRaw);
      if (Array.isArray(annos) && annos.length > 0) {
        const top = annos.slice(0, 10).map((a) => {
          const loc = (a.path ? a.path : '?')
            + (a.start_line ? `:${a.start_line}` : '')
            + (a.end_line && a.end_line !== a.start_line ? `-${a.end_line}` : '');
          return `- [${a.annotation_level || 'notice'}] ${loc} — ${(a.title ? `**${a.title}** ` : '') + (a.message || '')}`.replace(/\n+/g, ' ');
        }).join('\n');
        annotationsBlock = `\n## Annotations (file:line hints from the check run)\n${top}\n`
          + (annos.length > 10 ? `\n[... ${annos.length - 10} more not shown ...]\n` : '');
      }
    } catch (err) {
      console.error('[failing-check-context] annotations fetch failed:',
        ((err && (err.stderr || err.message)) || String(err)).toString().trim());
    }
  }

  let workflowBlock = '';
  try {
    const fs = require('fs');
    const path = require('path');
    const wfDir = path.join(cwd, '.github', 'workflows');
    if (fs.existsSync(wfDir)) {
      const files = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/i.test(f));
      const targetTokens = (checkName || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      let best = null;
      for (const f of files) {
        const full = path.join(wfDir, f);
        const text = fs.readFileSync(full, 'utf8');
        const nameMatch = text.match(/^name\s*:\s*(.+)$/m);
        const wfName = nameMatch ? nameMatch[1].replace(/['"]/g, '').trim().toLowerCase() : f.toLowerCase();
        const score = targetTokens.reduce((acc, t) => acc + (wfName.includes(t) ? 1 : 0), 0);
        if (!best || score > best.score) best = { score, file: f, text };
      }
      if (best && best.score > 0) {
        const truncated = best.text.split('\n').slice(0, 200).join('\n');
        workflowBlock = `\n## Workflow definition (\`.github/workflows/${best.file}\`)\n\`\`\`yaml\n${truncated}\n${best.text.split('\n').length > 200 ? '\n[... truncated ...]\n' : ''}\`\`\`\n`;
      }
    }
  } catch (err) {
    console.error('[failing-check-context] workflow YAML lookup failed:',
      ((err && err.message) || String(err)).toString().trim());
  }

  return { logTail, diffSnippet, annotationsBlock, workflowBlock };
}

// Debug a single failing CI check. Pulls the failing job's logs, builds a
// prompt with PR description + diff + log tail, and streams claude's analysis
// back to the renderer. Same chunk/done event protocol as Explain so the
// renderer can reuse the same UX.
ipcMain.handle('pr-debug-check-start', async (event, { requestId, checkLink, checkName, checkRunId }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (debugCheckProcs.has(requestId)) return { error: 'Already debugging' };
  if (!prReview.active) return { error: 'No active PR review' };
  const { meta, baseOwner, baseRepo, diff } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };

  // Diagnose in the PR's own worktree — NOT currentRepoPath(), which is
  // whatever project/session happens to be active in the app and is usually a
  // different repo entirely. Without this the agent can't read the PR's files
  // and is forced to reason from the pasted log/diff alone (the exact failure
  // we're fixing). ensureWorktreeForActivePr is reuse-first, so this attaches
  // to a worktree already materialized by Fix / AI Review when one exists, and
  // also points .github/workflows lookup at the PR's copy of the YAML.
  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };
  const cwd = ensured.worktreePath;
  const ctx = buildFailingCheckContext({ checkLink, checkName, checkRunId, cwd, baseOwner, baseRepo, diff });
  if (ctx.error) return { error: ctx.error };

  const prompt =
    `A pull request has a failing CI check. Help diagnose it.\n\n`
    + `## PR\n#${meta.number}: ${meta.title || ''}\n`
    + (meta.body ? `\n${meta.body.slice(0, 2000)}\n` : '')
    + `\n## Failing check\nName: ${checkName || '(unnamed)'}\nLink: ${checkLink}\n`
    + ctx.annotationsBlock
    + ctx.workflowBlock
    + `\n## Last lines of the failing job log\n\`\`\`\n${ctx.logTail}\n\`\`\`\n`
    + `\n## PR diff (truncated to 600 lines)\n\`\`\`\n${ctx.diffSnippet}\n\`\`\`\n`
    + `\nAnswer in this structure:\n`
    + `1. **What broke** — one or two sentences naming the actual failure.\n`
    + `2. **Caused by this PR?** — yes / no / likely, with the specific evidence from the diff vs log.\n`
    + `3. **Fix** — concrete, code-level suggestion. Use file:line references when possible.\n`
    + `Keep it tight; no preamble.`
    + repoIntelFor(cwd, defaultAgentProvider());

  spawnClaudeStream({
    requestId, procMap: debugCheckProcs, channelPrefix: 'pr-debug-check',
    provider: defaultAgentProvider(),
    sender: event.sender, cwd, prompt,
    agentMeta: {
      kind: 'pr-debug-check',
      // Same PR + same failing job link = same agent. Re-clicking "Debug"
      // on the same check finds the running/completed agent instead of
      // burning another `gh run view` + claude spawn.
      dedupeKey: `pr-debug-check:${meta.number}:${checkLink}`,
      sourceContext: {
        kind: 'pr-debug-check',
        prNumber: meta.number,
        prTitle: meta.title || '',
        baseOwner, baseRepo,
        checkLink,
        checkName: checkName || '',
        worktreePath: ensured.worktreePath,
      },
    },
  });
  return { ok: true };
});

ipcMain.handle('pr-debug-check-cancel', makeClaudeCancelHandler(debugCheckProcs));

// Autonomous fix for a failing CI check. Same context as Debug, but spawned
// in the PR's worktree with edit tools and stream-json output so the renderer
// can show tool-use progress (which files Claude touched). Claude is told NOT
// to commit or push — that step is gated on the user reviewing the diff and
// clicking Push in the panel (commit-local + push-local IPCs handle it).
ipcMain.handle('pr-fix-check-start', async (event, { requestId, checkLink, checkName, checkRunId }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (fixCheckProcs.has(requestId)) return { error: 'Already fixing' };
  if (!prReview.active) return { error: 'No active PR review' };
  const { meta, baseOwner, baseRepo, diff } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };

  // Materialize the worktree first — the prompt instructs Claude to edit
  // files, so we need a writable checkout of the PR branch. Reuses the same
  // helper as pr-review-implement / pr-debug-check-open-task.
  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };

  // Context-gathering uses the worktree cwd so .github/workflows lookup hits
  // the PR's copy of the YAML, not main's. (Logs/annotations come from gh
  // and are repo-scoped, so cwd doesn't affect them.)
  const ctx = buildFailingCheckContext({
    checkLink, checkName, checkRunId,
    cwd: ensured.worktreePath, baseOwner, baseRepo, diff,
  });
  if (ctx.error) return { error: ctx.error };

  const prompt =
    `A pull request has a failing CI check. Apply a focused fix in this worktree.\n\n`
    + `## PR\n#${meta.number}: ${meta.title || ''}\n`
    + (meta.body ? `\n${meta.body.slice(0, 2000)}\n` : '')
    + `\n## Failing check\nName: ${checkName || '(unnamed)'}\nLink: ${checkLink}\n`
    + ctx.annotationsBlock
    + ctx.workflowBlock
    + `\n## Last lines of the failing job log\n\`\`\`\n${ctx.logTail}\n\`\`\`\n`
    + `\n## PR diff so far (truncated to 600 lines)\n\`\`\`\n${ctx.diffSnippet}\n\`\`\`\n`
    + `\nGuidelines:\n`
    + `- Make the smallest focused change that resolves this specific failure.\n`
    + `- Do NOT do unrelated cleanup, refactors, or formatting churn.\n`
    + `- Do NOT run tests, install deps, or run \`git commit\` / \`git push\` — the user will review the diff and push from the UI.\n`
    + `- If the failure isn't fixable from the codebase (e.g. flaky infra, missing secret), say so plainly and stop without editing.\n`
    + `\nAfter editing, output a short summary in this exact structure:\n`
    + `1. **Root cause** — one sentence.\n`
    + `2. **Files changed** — bullet list of \`path\` — what changed.\n`
    + `3. **Why this fixes it** — one or two sentences tying the change back to the failure.\n`
    + repoIntelFor(ensured.worktreePath, defaultAgentProvider());

  spawnClaudeStream({
    requestId, procMap: fixCheckProcs, channelPrefix: 'pr-fix-check',
    sender: event.sender, cwd: ensured.worktreePath, prompt,
    streamJson: true,
    provider: defaultAgentProvider(),
    allowEdits: true,
    extraDoneFields: { worktreePath: ensured.worktreePath },
    agentMeta: {
      kind: 'pr-fix-check',
      dedupeKey: `pr-fix-check:${meta.number}:${checkLink}`,
      sourceContext: {
        kind: 'pr-fix-check',
        prNumber: meta.number,
        prTitle: meta.title || '',
        baseOwner, baseRepo,
        checkLink,
        checkName: checkName || '',
      },
    },
  });
  return { ok: true, worktreePath: ensured.worktreePath };
});

ipcMain.handle('pr-fix-check-cancel', makeClaudeCancelHandler(fixCheckProcs));

// Turn a finished debug analysis into a Claude task on the PR's worktree.
// Materializes the worktree if needed, spawns a fresh claude instance, then
// pastes the analysis as the first prompt so the user can ask "apply this fix"
// without re-typing context.
ipcMain.handle('pr-debug-check-open-task', async (event, { analysis, checkName, prNumber }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };
  const { worktreePath, branch } = ensured;
  const taskName = ('Fix CI: ' + (checkName || 'check')).slice(0, 60);

  // Try to reuse an existing alive Claude task on this worktree before spawning
  // a new one — saves an extra terminal in the sidebar and matches what
  // pr-fix-in-terminal already does.
  let target = null;
  for (const [, inst] of instances) {
    if (inst.worktreePath === worktreePath && inst.alive && inst.mode === 'claude') { target = inst; break; }
  }
  if (!target) {
    const result = spawnInWorktree(taskName, worktreePath, branch, 'claude', null, null, prNumber);
    if (result && result.error) return { error: result.error };
    target = instances.get(result.id);
  }
  if (!target || !target.pty) return { error: 'Failed to spawn task on worktree' };

  const BP_START = '\x1b[200~';
  const BP_END = '\x1b[201~';
  const safeAnalysis = String(analysis || '').replace(/\x1b\[20[01]~/g, '');
  const text = 'Help me fix this failing CI check. Below is an analysis produced from the failing job\'s annotations + log + the PR diff. Please propose and apply the fix in this worktree.\n\n'
    + '---\n\n' + safeAnalysis + '\n\n---\n';

  // Write after a short delay so claude has time to render its prompt; if we
  // write too early the bracketed-paste markers land in the splash screen and
  // claude treats them as garbage. 1500ms matches the cadence of other
  // first-prompt writes elsewhere in the app.
  //
  // The handler returns ok:true before this fires, so a silent write failure
  // would leave the user with a blank task and no signal. Log + emit a paste-
  // failed event so the renderer can flip the button state and the failure
  // is recoverable from main.log.
  setTimeout(() => {
    try {
      target.pty.write(BP_START + text + BP_END);
    } catch (err) {
      const msg = (err && err.message) || String(err);
      console.error('[pr-debug-check-open-task] pty.write failed:', msg);
      if (event.sender && !event.sender.isDestroyed()) {
        event.sender.send('pr-debug-check-open-task-paste-failed', {
          taskId: target.id, error: msg,
        });
      }
    }
  }, 1500);

  return { ok: true, taskId: target.id };
});

// K3: inline AI edit — streams a claude -p replacement for a selection.
// Kept deliberately strict: the prompt tells claude to emit ONLY the
// replacement code so the renderer can paste it back verbatim without
// having to strip markdown fences or preamble.
ipcMain.handle('inline-edit-start', (event, { requestId, worktreePath, instruction, selection, languageId, filePath }) => {
  const prompt =
    'You are editing code inline. Apply this instruction to the code below and return ONLY the replacement code.\n\n' +
    'Rules (strict):\n' +
    '- Respond with ONLY the replacement code — no explanations, no markdown code fences, no preamble, no trailing commentary.\n' +
    '- Preserve the indentation style of the original (tabs vs spaces, width).\n' +
    '- Keep the replacement self-contained: it will replace the exact selection in-place.\n' +
    '- Do not add imports unless the instruction requires them; if you do, they belong inside the replacement, not elsewhere.\n\n' +
    (filePath ? `File: ${filePath}\n` : '') +
    (languageId ? `Language: ${languageId}\n\n` : '\n') +
    `Instruction: ${instruction}\n\n` +
    'Original selection:\n' +
    selection + '\n';

  spawnClaudeStream({
    requestId, procMap: inlineEditProcs, channelPrefix: 'inline-edit',
    sender: event.sender,
    cwd: worktreePath || currentRepoPath() || require('os').homedir(),
    prompt,
    provider: defaultAgentProvider(),
  });
  return { ok: true };
});

ipcMain.handle('inline-edit-cancel', makeClaudeCancelHandler(inlineEditProcs));

// K6: inline AI completion — predicts what comes at the cursor.
// Context-before / context-after let claude see both sides of the insertion
// point so completions respect what already exists on the next line.
ipcMain.handle('inline-complete-start', (event, { requestId, worktreePath, before, after, languageId, filePath }) => {
  const prompt =
    'You are an inline code-completion engine. Predict what belongs at the cursor position.\n\n' +
    'Rules (strict):\n' +
    '- Return ONLY the insertion text — no explanations, no markdown fences, no preamble.\n' +
    '- Keep it concise: a few lines at most; stop when the natural unit ends (statement, block, close paren).\n' +
    '- Do NOT repeat the text that already comes before or after the cursor.\n' +
    '- Match the surrounding indentation style exactly.\n' +
    '- If nothing obvious should go here, return an empty response.\n\n' +
    (filePath ? `File: ${filePath}\n` : '') +
    (languageId ? `Language: ${languageId}\n\n` : '\n') +
    'Before cursor:\n' + before + '\n\n' +
    '<CURSOR>\n\n' +
    'After cursor:\n' + after + '\n';

  spawnClaudeStream({
    requestId, procMap: inlineCompleteProcs, channelPrefix: 'inline-complete',
    sender: event.sender,
    cwd: worktreePath || currentRepoPath() || require('os').homedir(),
    prompt,
    provider: defaultAgentProvider(),
    promptConsent: false, // ghost text fires rapidly — never pop a dialog mid-typing
  });
  return { ok: true };
});

ipcMain.handle('inline-complete-cancel', makeClaudeCancelHandler(inlineCompleteProcs));

// G7: AI review in the PR review surface. Ensures a worktree (auto-cloning
// if needed) and spawns claude with the review prompt (repo-aware skill when
// present, built-in template otherwise), streaming
// stream-json events back to the renderer. Mirrors F6's protocol so the
// renderer can reuse the same chunk parser.
ipcMain.handle('pr-review-ai-start', async (event, { requestId, provider } = {}) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (reviewSurfaceAiProcs.has(requestId)) return { error: 'Already in flight' };
  if (!prReview.active) return { error: 'No active PR review' };

  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };
  const reviewProvider = pickProvider(provider, defaultAgentProvider());

  const baseBranch = (prReview.active.meta && prReview.active.meta.baseRefName) || 'main';
  // Diff against the PR's true fork point (merge-base SHA), not the local base
  // branch ref — the local ref is often stale, which pulls commits that aren't
  // in the PR into `<base>...HEAD`. Fall back to the branch name if the SHA
  // couldn't be resolved (e.g. offline base fetch).
  const baseRef = ensured.baseSha || baseBranch;
  // Function replacements: the intel block is arbitrary repo content — a
  // string replacement would interpret `$&`/`$'`/`$$` in it as patterns and
  // silently mangle the prompt.
  // Prefer the repo's own conventions-aware review skill (.claude/skills/
  // <repo>-review) when present; buildReviewPrompt falls back to the built-in
  // template otherwise. repoIntelFor also kicks off generation, so a repo
  // without a skill yet gets one built for the next run.
  const prompt = buildReviewPrompt({
    worktreePath: ensured.worktreePath,
    baseRef,
    repoSpecificChecks: repoIntelFor(ensured.worktreePath, reviewProvider),
  });

  spawnClaudeStream({
    requestId, procMap: reviewSurfaceAiProcs, channelPrefix: 'pr-review-ai',
    sender: event.sender,
    cwd: ensured.worktreePath,
    prompt,
    streamJson: true,
    provider: reviewProvider,
    agentMeta: {
      kind: 'pr-review-ai',
      // Only one full AI review per PR makes sense — re-clicking "Run AI
      // Review" while one is running attaches to it instead of spawning a
      // duplicate.
      dedupeKey: `pr-review-ai:${prReview.active.meta.number}`,
      sourceContext: {
        kind: 'pr-review-ai',
        prNumber: prReview.active.meta.number,
        prTitle: prReview.active.meta.title || '',
        // baseOwner/baseRepo are required for matching — PR numbers are
        // repo-scoped, so a user with two accounts can have collisions
        // (account1/repo-A#123 and account2/repo-B#123).
        baseOwner: prReview.active.baseOwner,
        baseRepo: prReview.active.baseRepo,
        baseBranch,
        // Needed by the renderer's rehydration path so post-review actions
        // (Implement / Investigate) know which worktree to operate in.
        worktreePath: ensured.worktreePath,
      },
    },
  });
  return { ok: true, worktreePath: ensured.worktreePath };
});

ipcMain.handle('pr-review-ai-cancel', makeClaudeCancelHandler(reviewSurfaceAiProcs));


// Discuss a finding with Claude inline — the renderer's "Ask Claude" chat
// panel. Stateless: each turn re-sends the conversation history so Claude
// can respond coherently, and Claude runs read-only (Read/Grep/git OK, no
// edits) so a discussion doesn't accidentally mutate the worktree.
ipcMain.handle('pr-review-chat-start', async (event, { requestId, findingBody, messages, findingId, provider } = {}) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (reviewChatProcs.has(requestId)) return { error: 'Already in flight' };
  if (!prReview.active) return { error: 'No active PR review' };
  if (!findingBody || !findingBody.trim()) return { error: 'Missing finding body' };
  if (!Array.isArray(messages) || messages.length === 0) return { error: 'No messages to send' };

  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };
  const chatProvider = pickProvider(provider, defaultAgentProvider());

  // Serialize the conversation so Claude sees the full arc. Using explicit
  // Human/Assistant labels matches how Claude reads multi-turn transcripts
  // better than a raw concatenation.
  const transcript = messages.map((m) => {
    const label = m.role === 'assistant' ? 'Assistant' : 'Human';
    return `${label}: ${m.content}`;
  }).join('\n\n');

  const prompt =
    `You are discussing a pull-request review finding with the reviewer. ` +
    `Answer concisely. You may read files, grep, and run git commands in the repo to ground your answers — but do NOT edit, create, or delete any files, and do NOT commit or push. ` +
    `If the reviewer wants the fix applied, tell them to click "Implement" on the finding instead.\n\n` +
    `The finding:\n\n${findingBody}\n\n` +
    `Conversation so far:\n\n${transcript}\n\n` +
    `Respond to the most recent Human message.`;

  // findingId comes from the renderer (stable per finding). At most one chat
  // agent per finding at a time — the renderer guards against double-send via
  // f.chatRequestId, and dedupeKey makes the registry the source of truth.
  var fid = findingId || shortHash(findingBody);

  spawnClaudeStream({
    requestId, procMap: reviewChatProcs, channelPrefix: 'pr-review-chat',
    sender: event.sender,
    cwd: ensured.worktreePath,
    prompt,
    streamJson: true,
    provider: chatProvider,
    extraDoneFields: { worktreePath: ensured.worktreePath },
    agentMeta: {
      kind: 'pr-review-chat',
      dedupeKey: `pr-review-chat:${prReview.active.meta.number}:${fid}`,
      sourceContext: {
        kind: 'pr-review-chat',
        prNumber: prReview.active.meta.number,
        prTitle: prReview.active.meta.title || '',
        findingId: fid,
        findingBodyPreview: findingBody.slice(0, 160),
        worktreePath: ensured.worktreePath,
      },
    },
  });
  return { ok: true };
});

ipcMain.handle('pr-review-chat-cancel', makeClaudeCancelHandler(reviewChatProcs));

// One-shot validation of a single finding. Claude reads code + git in the PR
// worktree (read-only) and returns a Verdict/Reasoning/Recommendation block.
// Separate from chat so the renderer can surface a crisp verdict UI without
// conflating it with multi-turn discussion.
ipcMain.handle('pr-review-investigate-start', async (event, { requestId, findingBody, provider } = {}) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (investigateProcs.has(requestId)) return { error: 'Already in flight' };
  if (!prReview.active) return { error: 'No active PR review' };
  if (!findingBody || !findingBody.trim()) return { error: 'Missing finding body' };

  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };
  const investigateProvider = pickProvider(provider, defaultAgentProvider());

  const prompt =
    `You are validating a PR-review finding. Decide whether the concern is real in the current code. ` +
    `You may read files, grep, and run git commands in the repo to ground your answer — but do NOT edit, create, or delete any files, and do NOT commit or push.\n\n` +
    `Answer in this exact shape (Markdown):\n\n` +
    `**Verdict:** Valid / Partially valid / Invalid\n\n` +
    `**Reasoning:** 2-4 sentences with file:line references.\n\n` +
    `**Recommendation:** one line — implement the fix, discuss further, or dismiss.\n\n` +
    `The finding:\n\n${findingBody}`;

  spawnClaudeStream({
    requestId, procMap: investigateProcs, channelPrefix: 'pr-review-investigate',
    sender: event.sender,
    cwd: ensured.worktreePath,
    prompt,
    streamJson: true,
    provider: investigateProvider,
    extraDoneFields: { worktreePath: ensured.worktreePath },
    agentMeta: {
      kind: 'pr-review-investigate',
      dedupeKey: `pr-review-investigate:${prReview.active.meta.number}:${shortHash(findingBody)}`,
      sourceContext: {
        kind: 'pr-review-investigate',
        prNumber: prReview.active.meta.number,
        prTitle: prReview.active.meta.title || '',
        bodyPreview: findingBody.slice(0, 160),
      },
    },
  });
  return { ok: true };
});

ipcMain.handle('pr-review-investigate-cancel', makeClaudeCancelHandler(investigateProcs));

// ---- Explain Diff ----


ipcMain.handle('explain-diff', async (_event, { worktreePath, file, hunk }) => {
  // PR review mode calls this without a worktree — fall back to the current
  // project path (or the user's home as a last resort) since execFile insists
  // on a valid cwd. Claude doesn't actually need repo context for this prompt.
  const cwd = worktreePath || currentRepoPath() || require('os').homedir();
  return new Promise((resolve) => {
    execFile('claude', ['-p', explainPrompt(file, hunk)], {
      cwd,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: stderr || err.message });
      } else {
        resolve({ explanation: stdout.trim() });
      }
    });
  });
});

// Streaming variant. Pipes claude stdout to the renderer in real time so the
// user sees tokens as they arrive instead of staring at a 10-second spinner.
// Callers pass a requestId; chunks arrive on `explain-diff-chunk-<id>` and
// completion on `explain-diff-done-<id>`.
ipcMain.handle('explain-diff-stream-start', (event, { requestId, worktreePath, file, hunk, prNumber }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (explainStreamProcs.has(requestId)) return { error: 'Already streaming' };
  spawnClaudeStream({
    requestId, procMap: explainStreamProcs, channelPrefix: 'explain-diff',
    sender: event.sender,
    cwd: worktreePath || currentRepoPath() || require('os').homedir(),
    prompt: explainPrompt(file, hunk),
    provider: defaultAgentProvider(),
    agentMeta: {
      kind: 'explain-diff',
      // Lookup-friendly key (no hashing): the renderer computes the same
      // string before starting an explain so it can find an existing
      // agent and attach instead of spawning a duplicate. Long hunks make
      // this string big, but Map keys handle that fine.
      dedupeKey: `explain-diff::${file}::${hunk}`,
      sourceContext: {
        kind: 'explain-diff',
        worktreePath: worktreePath || null,
        // prNumber is set when the explain originated from a PR review surface
        // (no worktree). Lets the agent router open the right PR on "Open".
        prNumber: prNumber || null,
        file,
        // Full hunk so the renderer can find the matching diff-line range on
        // re-mount and re-anchor the explanation to its original position.
        hunk: hunk || '',
        hunkPreview: (hunk || '').split('\n').slice(0, 3).join('\n').slice(0, 200),
      },
    },
  });
  return { ok: true };
});

// Streams a suggested commit message for the staged changes into the diff
// panel. Renderer shows a sparkle button next to the commit input; the result
// is editable before the user actually commits. Pulls the last few commit
// subjects so claude can match the repo's tone (conventional / prefix / etc.)
// without us prescribing a style.
ipcMain.handle('claude-commit-message-start', async (event, { requestId, worktreePath }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (commitMsgProcs.has(requestId)) return { error: 'Already generating' };
  if (!worktreePath) return { error: 'Missing worktreePath' };

  let diff = '';
  try {
    const { stdout } = await execFileP('git', ['diff', '--cached'], {
      cwd: worktreePath, maxBuffer: 5 * 1024 * 1024,
    });
    diff = stdout;
  } catch (err) {
    return { error: 'Could not read staged diff: ' + (err.stderr || err.message) };
  }
  if (!diff.trim()) return { error: 'No staged changes to summarize' };

  // Cap diff to keep the prompt inside a reasonable budget. If the staged diff
  // is huge, trim and tell claude we truncated so it doesn't hallucinate whole
  // regions of the change.
  const MAX = 80 * 1024;
  const diffForPrompt = diff.length > MAX
    ? diff.slice(0, MAX) + '\n\n[... diff truncated ...]\n'
    : diff;

  let recent = '';
  try {
    const { stdout } = await execFileP('git', ['log', '-n', '10', '--format=%s'], {
      cwd: worktreePath,
    });
    recent = stdout.trim();
  } catch { /* brand-new repo or no commits; omit style sample */ }

  const prompt =
    'Write a commit message for the staged changes below.\n\n' +
    'Rules (strict):\n' +
    '- Output ONLY the commit message — no explanations, no code fences, no preamble.\n' +
    '- First line is the subject: imperative mood, under 72 chars, no trailing period.\n' +
    '- If the change is non-trivial, add a blank line and a short body explaining the "why".\n' +
    '- Match the style (prefix conventions, length, tone) of the recent subjects shown below.\n\n' +
    (recent ? 'Recent commit subjects (for style only):\n' + recent + '\n\n' : '') +
    'Staged diff:\n' + diffForPrompt;

  spawnClaudeStream({
    requestId, procMap: commitMsgProcs, channelPrefix: 'claude-commit-message',
    sender: event.sender,
    cwd: worktreePath,
    prompt,
    provider: defaultAgentProvider(),
    agentMeta: {
      kind: 'commit-message',
      // One commit-message generation per worktree at a time — re-clicking
      // the sparkle while one is running attaches instead of double-running.
      dedupeKey: `commit-message:${worktreePath}`,
      sourceContext: {
        kind: 'commit-message',
        worktreePath,
      },
    },
  });
  return { ok: true };
});

ipcMain.handle('claude-commit-message-cancel', makeClaudeCancelHandler(commitMsgProcs));

ipcMain.handle('explain-diff-stream-cancel', makeClaudeCancelHandler(explainStreamProcs));


// Legacy config.prReviews cache was retired in favor of the file-per-PR cache

ipcMain.handle('pr-ai-review-start', (event, { worktreePath, baseBranch, requestId, provider } = {}) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (aiReviewProcs.has(requestId)) return { error: 'Review already in flight for ' + requestId };

  // Prefer the repo's conventions-aware review skill when present; fall back to
  // the built-in template. See pr-review-ai-start for the repo-aware rationale.
  const reviewAgent = pickProvider(provider, defaultAgentProvider());
  const prompt = buildReviewPrompt({
    worktreePath,
    baseRef: baseBranch || 'main',
    repoSpecificChecks: repoIntelFor(worktreePath, reviewAgent),
  });

  // stream-json gives us a JSONL event per assistant/tool/result block so we
  // can surface progress in the UI instead of a 15-minute silent spinner.
  spawnClaudeStream({
    requestId, procMap: aiReviewProcs, channelPrefix: 'pr-ai-review',
    sender: event.sender,
    cwd: worktreePath,
    prompt,
    streamJson: true,
    provider: pickProvider(provider, defaultAgentProvider()),
    agentMeta: {
      kind: 'pr-ai-review',
      // One AI review per (worktree, base) — re-running while it's still
      // in flight attaches to the existing run.
      dedupeKey: `pr-ai-review:${worktreePath}:${baseBranch || 'main'}`,
      sourceContext: {
        kind: 'pr-ai-review',
        worktreePath,
        baseBranch: baseBranch || 'main',
      },
    },
  });
  return { ok: true };
});

ipcMain.handle('pr-ai-review-cancel', makeClaudeCancelHandler(aiReviewProcs));

ipcMain.handle('pr-ai-review-comment', async (_event, { worktreePath, prTitle, prBody, commentAuthor, commentBody, filePath, diffHunk }) => {
  let context = `PR Title: ${prTitle}\n`;
  if (prBody) context += `PR Description: ${prBody}\n`;
  if (filePath) context += `File: ${filePath}\n`;
  if (diffHunk) context += `Code context:\n\`\`\`\n${diffHunk}\n\`\`\`\n`;

  const prompt = `You are reviewing a PR comment. Analyze whether the comment raises a valid concern, and draft a concise reply.

${context}
Comment by ${commentAuthor}:
"${commentBody}"

Respond in this exact format:
VALIDITY: [Valid / Partially Valid / Not Valid] — one sentence explaining why.
SUGGESTED REPLY:
[Your drafted reply to post on the PR. Be professional, concise, and constructive. If the concern is valid, acknowledge it and describe how you'll address it. If not, explain why politely.]`;

  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  return new Promise((resolve) => {
    execFile(claudeBin, ['-p', prompt], {
      cwd: worktreePath,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: stderr || err.message });
      } else {
        resolve({ review: stdout.trim() });
      }
    });
  });
});
