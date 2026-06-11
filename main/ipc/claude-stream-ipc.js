// All 8 Claude streaming IPC surfaces plus the explain-diff helpers and
// the PR_REVIEW_TEMPLATE constant. Each start-handler spawns a claude
// stream via spawnClaudeStream (from state/claude-streaming.js) and each
// cancel handler is a thin makeClaudeCancelHandler over the matching
// proc map.

const { ipcMain } = require('electron');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { instances, spawnInWorktree } = require('../state/instances');
const { isAgentMode } = require('../state/ai-providers');
const { prReview, ensureWorktreeForActivePr, currentRepoPath } = require('../state/pr-review');
const { execFileP } = require('../util/exec');
const { loadConfig } = require('../util/config');
const { getRepoIntelBlock, ensureRepoIntel } = require('../state/repo-intel');

// Repo-intel block formatted for template substitution: surrounded by
// newlines when present, empty when not — the templates' {{REPO_SPECIFIC_CHECKS}}
// slots sit on their own lines either way. Also nudges a (re)generation so a
// repo reviewed before any session was opened gets intel for the NEXT run.
// Pass the target agent: claude in a synced worktree gets the slim
// graph-only block (CLAUDE.md/rules load natively there — re-injecting them
// pays their tokens twice in every prompt).
function repoIntelFor(worktreePath, agentMode) {
  try {
    ensureRepoIntel(worktreePath);
    const block = getRepoIntelBlock(worktreePath, agentMode);
    return block ? '\n' + block + '\n' : '';
  } catch (e) {
    console.warn('[repo-intel] substitution failed:', e.message);
    return '';
  }
}
const {
  spawnClaudeStream, makeClaudeCancelHandler,
  debugCheckProcs, fixCheckProcs, inlineEditProcs, inlineCompleteProcs, reviewSurfaceAiProcs,
  explainStreamProcs, aiReviewProcs, commitMsgProcs, reviewChatProcs,
  investigateProcs,
} = require('../state/claude-streaming');
const {
  startImplementPty, writeImplementPty, resizeImplementPty, cancelImplementPty,
  implementPtySessions,
} = require('../state/pr-implement-pty');
const {
  getOrAskRepoConsent, applyWorktreePermissions,
} = require('../util/worktree-permissions');

// Stable, bounded ID for dedupeKey suffixes. Inputs (hunks, finding bodies,
// staged diffs) can be many KB; sha1 keeps keys short and comparable.
function shortHash(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 12);
}

// The editor/diff AI features (inline edit, completion, explain, commit
// message) and the read-only PR-review surfaces run on the user's chosen
// default agent.
function defaultAgentProvider() {
  const c = loadConfig();
  return c.defaultProvider || c.defaultMode || 'claude';
}

// Honor a renderer-chosen agent (from a split-button's agent picker) when it's
// a valid agent id; otherwise use the surface's default resolution.
function pickProvider(passed, fallback) {
  return isAgentMode(passed) ? passed : fallback;
}

// Implement follows the agent of the task you're working this PR in: prefer a
// live agent task on the PR's worktree (its current mode, or the original agent
// if it has since converted to a shell), and fall back to the default agent
// when no task is open on that worktree.
function agentForWorktree(worktreePath) {
  for (const [, inst] of instances) {
    if (inst.worktreePath !== worktreePath) continue;
    if (isAgentMode(inst.mode)) return inst.mode;
    if (isAgentMode(inst.originalMode)) return inst.originalMode;
  }
  return defaultAgentProvider();
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
ipcMain.handle('pr-debug-check-start', (event, { requestId, checkLink, checkName, checkRunId }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (debugCheckProcs.has(requestId)) return { error: 'Already debugging' };
  if (!prReview.active) return { error: 'No active PR review' };
  const { meta, baseOwner, baseRepo, diff } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };

  const cwd = currentRepoPath() || require('os').homedir();
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
ipcMain.handle('pr-debug-check-open-task', async (_event, { analysis, checkName, prNumber }) => {
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
// if needed) and spawns claude with the PR_REVIEW_TEMPLATE, streaming
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
  const prompt = PR_REVIEW_TEMPLATE
    .replace(/\{\{BASE_BRANCH\}\}/g, () => baseRef)
    .replace(/\{\{REPO_SPECIFIC_CHECKS\}\}/g, () => repoIntelFor(ensured.worktreePath, reviewProvider));

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

// Implement a single finding (or "all findings" via one big prompt) by
// running an interactive `claude` inside a node-pty in the PR's worktree.
// The renderer mounts an xterm.js for the user to answer any prompts
// (Bash, MCP, etc.); Edit/Write/MultiEdit on the worktree path are
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
  const dataChannel = `pr-review-implement-pty-data-${requestId}`;
  const eventChannel = `pr-review-implement-pty-event-${requestId}`;
  const exitChannel = `pr-review-implement-pty-exit-${requestId}`;

  const result = startImplementPty({
    requestId,
    worktreePath: ensured.worktreePath,
    prompt,
    provider: implProvider,
    onData: (data) => { if (!sender.isDestroyed()) sender.send(dataChannel, data); },
    onEvent: (ev) => { if (!sender.isDestroyed()) sender.send(eventChannel, ev); },
    onExit: ({ exitCode, signal }) => {
      if (!sender.isDestroyed()) sender.send(exitChannel, { exitCode, signal });
    },
  });
  if (result.error) return { error: result.error };

  // If the renderer that started the run goes away, terminate the PTY —
  // there's no UI left to answer prompts and the user can't see output.
  // This mirrors spawnClaudeStream's foreground behavior.
  sender.once('destroyed', () => {
    if (implementPtySessions.has(requestId)) {
      try { cancelImplementPty(requestId); } catch {}
    }
  });

  return { ok: true, worktreePath: ensured.worktreePath };
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

function explainPrompt(file, hunk) {
  return `Explain this specific code concisely. What does it do and why might it have been written this way?\n\nFile: ${file}\n\nSelected code:\n\`\`\`\n${hunk}\n\`\`\``;
}

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

const PR_REVIEW_TEMPLATE = `You are conducting a thorough PR review. Follow these phases in order.

---

## Phase 1: Context Gathering

1. Run \`git diff --stat {{BASE_BRANCH}}...HEAD\` and count the total lines changed (additions + deletions).
2. Run \`git diff {{BASE_BRANCH}}...HEAD\` to get the full diff.
3. Run \`git log {{BASE_BRANCH}}..HEAD --oneline\` to understand commit history and intent.
4. For each changed file, read the full file (not just the diff hunks) to understand surrounding context.
5. If the branch name contains a ticket reference (e.g. FEAT-1234), note it for context.

Store the diff output, file contents, and commit log — you will need them in the next phase.

---

## Phase 2: Triage

Count the total lines changed from the \`--stat\` output.

- **If < 150 lines changed:** proceed to [Small PR Review](#small-pr-review) below.
- **If >= 150 lines changed:** proceed to [Parallel Review](#parallel-review) below.

---

## Small PR Review

You are a senior/principal-level engineer reviewing a pull request. Treat this as a real production PR. Output ONLY PR-style review comments, as if leaving inline comments on GitHub/GitLab.

### Comment format (required for every comment):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (specific suggestion or alternative)

### Review rules:

- Be skeptical and precise.
- Assume the code will be read and modified by others.
- Quote the **original code being reviewed** in a fenced code block — verbatim from the file, no edits or ellipses, no more than 10 lines. This is what the comment IS ABOUT, not what to do about it.
- Do NOT include a "fix" or "suggested change" in that same code block. If you have a concrete fix to propose, put it in a separate fenced block prefixed with \`Suggested change:\` on its own line above the block. Mixing the two confuses readers about which is which.
- If something relies on an unstated assumption, call it out.
- If behavior is unclear, treat that as a problem.
- Prefer concrete fixes over vague advice.

### What to look for (in order of priority):

1. **Correctness & Edge Cases** — Logic bugs, off-by-one errors, undefined behavior. Error handling gaps, partial failures.
2. **Concurrency & State** — Race conditions, shared mutable state. Thread safety, async misuse, ordering assumptions.
3. **Design & API Boundaries** — Leaky abstractions, tight coupling. Public interfaces that are hard to evolve.
4. **Performance & Scalability** — Inefficient loops, N+1 calls, blocking I/O. Work done in hot paths that doesn't need to be.
5. **Reliability** — Missing retries, timeouts, idempotency. Resource cleanup (connections, files, tasks).
6. **Security** — Input validation, trust boundaries. Logging sensitive data.
7. **Readability & Maintainability** — Ambiguous naming, overly clever code. Comments that explain "what" instead of "why".
8. **Test Coverage** — Were tests added or updated for the changes? Are edge cases covered?
9. **Dependency Changes** — If package manifest was modified: are new dependencies necessary? Are versions pinned? Flag any new dependencies that duplicate existing functionality.
10. **Scope** — Identify the primary intent of the PR. Flag changes unrelated to that intent with **Warn** severity.

{{REPO_SPECIFIC_CHECKS}}

### Tone & standards:

- Assume a high bar (staff/principal quality).
- If something is "technically correct but fragile," say so.
- If something would fail under load or future change, flag it.
- Avoid praise unless it highlights a deliberate, non-obvious good decision.

### Voice & style (applies to the comment body, NOT the headers):

**Hard rule on em dashes (strictest tell):** Do not use em dashes (—) or en dashes (–) anywhere in the comment body. Use periods, commas, or parentheses instead. Before emitting any finding, scan its body for \`—\` and \`–\` and rewrite those phrases without them. This is the single most reliable AI tell and the most common reason a humanized review still reads as AI-written.


Write each finding's prose like a senior engineer leaving it on GitHub — direct, opinionated, terse. The **[Severity]** and **[Location]** lines are formatted output and must stay in the exact bracketed format above; the rules below apply only to the comment body underneath.

- Short. PR comments are 1-4 sentences, not paragraphs. Cut filler instead of rewording it.
- First person where natural ("I'd lift this out", "looks like X is never awaited"). No anecdotes, no hedge essays.
- Real opinions. "This is wrong" is fine; "This is suboptimal" is not.
- No closing summary that restates what you just said.
- No "Great catch!" / "I hope this helps" / "Let me know if..." chatbot scaffolding.

Avoid these AI tells:
- **AI vocabulary**: delve, leverage, navigate (figurative), robust, comprehensive, seamless, meticulous, intricate, underscore, highlight (verb), pivotal, crucial, key (adjective), vital, ensure that, in order to, additionally, furthermore, moreover, notably, valuable, vibrant, foster, garner, align with, tapestry, landscape (figurative), realm.
- **Em dashes** (— or –). Use periods, commas, or parentheses.
- **Filler**: "it's important to note", "it's worth mentioning", "I noticed that", "I've identified that".
- **Excessive hedging**: "could potentially possibly", "may potentially". State it or don't.
- **Rule of three**: don't force findings into triplets to sound thorough.
- **Negative parallelism**: "not just X, it's Y", "It's not merely X, it's Y".
- **Copula avoidance**: prefer "is/are/has" over "serves as", "stands as", "functions as", "represents".
- **Persuasive authority**: "the real question is", "at its core", "fundamentally", "what really matters".
- **Signposting**: "Let me explain", "Here's what's happening", "First, ... Second, ... Finally, ...".
- **Vague attributions**: "best practices suggest", "it's generally recommended". Name the concrete reason or drop the appeal to authority.
- **Inline-header bullets**: don't structure short comments as "**Bold:** sentence" lists; just write the sentence.
- **Passive voice** when active is shorter and the actor is known.
- **Superficial -ing analyses**: "highlighting that...", "ensuring that...", "reflecting...". Cut or rewrite as a real clause.

Examples:

Before: "Additionally, this function leverages the cache to ensure robust handling of concurrent requests, highlighting the importance of proper synchronization."
After: "This reuses the cache to handle concurrent requests safely."

Before: "It's worth noting that this could potentially leak a connection if the request times out — best practices suggest using a defer block."
After: "Leaks a connection if the request times out. Wrap the close in a defer."

Before: "The mutex serves as the gatekeeper, ensuring that only one writer can proceed at a time, reflecting good lock hygiene."
After: "The mutex blocks concurrent writers. Fine."

### Validate findings:

Before writing the final output, validate every finding you produced. For each one:

1. **Read the full file** referenced in the finding (not just the diff hunk).
2. **Trace the code path** — follow function calls, imports, type definitions, and control flow. Read caller and callee files as needed.
3. **Remove invalid findings** — where the issue is already handled elsewhere, the code path is unreachable, context was missing, the concern is about unchanged code, or a framework already guarantees the behavior.
4. **Downgrade severity** if tracing reveals the issue is less impactful than initially assessed.

A shorter, accurate review is far more valuable than a long review with false positives.

### End of review:

After validation, add a final PR summary:

**Overall verdict:** Approve / Request Changes / Block

**Highest-risk issues:**
1. ...
2. ...
3. ...

**Test coverage assessment:**
- [ ] Adequate test coverage for changes
- [ ] Edge cases tested

---

## Parallel Review

This PR is large enough to benefit from focused, parallel review. Use the **Agent tool** to launch all four of the following review agents **simultaneously in a single response**. Pass each agent the full diff, changed file contents, and commit log you gathered in Phase 1.

**Important:** Each agent returns its findings as text. Agents must NOT write any files.

---

### Agent 1: Correctness & Logic

Use the Agent tool with this prompt (include the diff and file contents you gathered):

\`\`\`
You are a senior engineer reviewing a pull request. Your ONLY focus is correctness and concurrency. Ignore all other concerns (design, style, security, etc.) — other reviewers are handling those.

Here is the diff:
[PASTE THE FULL DIFF HERE]

Here is the commit log:
[PASTE THE COMMIT LOG HERE]

Read every changed file in full for surrounding context.

## What to look for:

### Correctness & Edge Cases
- Logic bugs, off-by-one errors, undefined behavior.
- Error handling gaps, partial failures.
- Incorrect return values or wrong types.
- Boundary conditions: empty inputs, nil/null, max values, overflow.
- State mutations that violate invariants.

### Cross-file coupling (do not skip)
- For any exported symbol or shared contract changed in this diff (function signatures, return shapes, IPC channels, event names, config keys, enum variants): grep for usages in the repo and verify every call site still composes correctly. Read the consumer file in full, not just the diff.
- Producer/consumer shape mismatches: when a value is set in one file and read in another, verify the consumer handles every shape/case the producer can now emit (added enum variants, optional fields, null/empty results, error states).
- IPC/preload boundaries: if a handler return shape changed, grep the matching channel name on the other side and confirm every renderer call site still destructures correctly.

### Concurrency & State
- Race conditions, shared mutable state.
- Thread safety, async misuse, ordering assumptions.
- Deadlocks, livelocks, starvation.
- Missing synchronization or incorrect lock scope.
- Assumptions about execution order in async code.

## Output format (required for every finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**Comment:**

- What is wrong, why this is a problem (be specific about the failure mode)
- What should be changed (concrete fix or alternative)

Rules:
- Be skeptical and precise.
- Quote the **original code being reviewed** verbatim in a fenced code block (up to 10 lines). This is what the comment IS ABOUT — not your fix. Do NOT include a suggested change in this block; if you propose a fix, put it in a separate block prefixed with \`Suggested change:\` on its own line.
- If something relies on an unstated assumption, call it out.
- Prefer concrete fixes over vague advice.
- Return ONLY your findings. Do not write any files.
\`\`\`

---

### Agent 2: Architecture & Design

Use the Agent tool with this prompt (include the diff and file contents you gathered):

\`\`\`
You are a senior engineer reviewing a pull request. Your ONLY focus is architecture, design, performance, reliability, and dependency changes. Ignore correctness bugs, style, and security — other reviewers are handling those.

Here is the diff:
[PASTE THE FULL DIFF HERE]

Here is the commit log:
[PASTE THE COMMIT LOG HERE]

Read every changed file in full for surrounding context.

## What to look for:

### Design & API Boundaries
- Leaky abstractions, tight coupling.
- Public interfaces that are hard to evolve.
- Violation of existing architectural patterns in the codebase.
- Responsibilities placed in the wrong layer or module.

### Performance & Scalability
- Inefficient loops, N+1 calls, blocking I/O.
- Work done in hot paths that doesn't need to be.
- Missing pagination, unbounded queries, or unbounded memory growth.
- Allocations or copies that could be avoided.

### Reliability
- Missing retries, timeouts, idempotency.
- Resource cleanup (connections, files, tasks).
- Failure modes that leave the system in an inconsistent state.
- Missing circuit breakers or backpressure for external calls.

### Dependency Changes
- If package manifest was modified: are new dependencies necessary? Are versions pinned?
- Flag any new dependencies that duplicate existing functionality.
- Evaluate transitive dependency impact.

## Output format (required for every finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (concrete fix or alternative)

Rules:
- Be skeptical and precise.
- Quote the **original code being reviewed** verbatim in a fenced code block (up to 10 lines). This is what the comment IS ABOUT — not your fix. Do NOT include a suggested change in this block; if you propose a fix, put it in a separate block prefixed with \`Suggested change:\` on its own line.
- Think about how changes behave at scale and over time.
- Prefer concrete fixes over vague advice.
- Return ONLY your findings. Do not write any files.
\`\`\`

---

### Agent 3: Security & Quality

Use the Agent tool with this prompt (include the diff and file contents you gathered):

\`\`\`
You are a senior engineer reviewing a pull request. Your ONLY focus is security, readability, maintainability, and test coverage. Ignore correctness bugs, architecture, and performance — other reviewers are handling those.

Here is the diff:
[PASTE THE FULL DIFF HERE]

Here is the commit log:
[PASTE THE COMMIT LOG HERE]

Read every changed file in full for surrounding context.

## What to look for:

### Security
- Input validation gaps, trust boundary violations.
- Injection vectors: SQL, command, XSS, path traversal.
- Authentication/authorization bypasses.
- Logging or exposing sensitive data (tokens, passwords, PII).
- Insecure defaults or missing security headers.
- Cryptographic misuse (weak algorithms, hardcoded keys).

### Readability & Maintainability
- Ambiguous naming, overly clever code.
- Comments that explain "what" instead of "why".
- Functions that are too long or do too many things.
- Magic numbers or strings without explanation.
- Dead code or unreachable branches.

### Test Coverage
- Were tests added or updated for the changes?
- Are edge cases covered?
- Are failure paths tested?
- Do tests actually assert meaningful behavior (not just "doesn't crash")?
- Are mocks/stubs appropriate, or do they hide real behavior?

## Output format (required for every finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (concrete fix or alternative)

Rules:
- Be skeptical and precise.
- Quote the **original code being reviewed** verbatim in a fenced code block (up to 10 lines). This is what the comment IS ABOUT — not your fix. Do NOT include a suggested change in this block; if you propose a fix, put it in a separate block prefixed with \`Suggested change:\` on its own line.
- For security issues, describe the attack vector concretely.
- Prefer concrete fixes over vague advice.
- Return ONLY your findings. Do not write any files.
\`\`\`

---

### Agent 4: Scope & Conventions

Use the Agent tool with this prompt (include the diff and file contents you gathered):

\`\`\`
You are a senior engineer reviewing a pull request. Your ONLY focus is scope analysis and adherence to project conventions. Ignore bugs, architecture, security, and style — other reviewers are handling those.

Here is the diff:
[PASTE THE FULL DIFF HERE]

Here is the commit log:
[PASTE THE COMMIT LOG HERE]

Read every changed file in full for surrounding context.

## What to look for:

### Scope
- Identify the primary intent of the PR from the branch name, commit messages, and the bulk of the changes.
- Flag any changes that do not appear related to that primary intent (e.g. drive-by refactors, unrelated formatting, feature creep).
- Use **Warn** severity for unrelated changes — they may be intentional, but should be called out for the author to confirm.
- Check that the PR does one thing well rather than bundling unrelated work.

### Project Conventions
{{REPO_SPECIFIC_CHECKS}}

If no repo-specific checks are listed above, check the CLAUDE.md file in the repository for project conventions, commands, and known pitfalls, and verify the PR adheres to them.

## Output format (required for every finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (concrete fix or alternative)

Rules:
- Be precise about what is out of scope vs. in scope.
- For convention violations, reference the specific convention.
- Prefer concrete fixes over vague advice.
- Return ONLY your findings. Do not write any files.
\`\`\`

---

## Phase 3: Validation

Before synthesizing, validate every finding from the sub-agents. For each finding:

1. **Read the full file** referenced in the finding's location (not just the diff hunk).
2. **Trace the code path** — follow function calls, imports, type definitions, and control flow to understand the full context. Read caller and callee files as needed.
3. **Determine if the finding is still valid** given the full context. Common reasons a finding is invalid:
   - The issue is already handled elsewhere (e.g., validation happens in a caller, error is caught upstream). Verify by reading the caller — do not assume.
   - The code path cannot actually be reached in the way the finding assumes. Verify by tracing — do not assume.
   - The finding misreads the logic due to missing surrounding context.
4. **Do NOT prune a finding just because:**
   - The concern technically lives in unchanged code, if this PR's change exposes it (a new caller now hits an existing latent bug, a new return shape is fed to an old consumer, a new code path now reaches stale logic). The diff made it relevant — keep it.
   - A framework, library, or dependency "probably" handles it. Verify by reading the framework's code or type definitions. Speculation is not validation.
   - The fix would be small or "the author probably knows". Reviewers flag, authors decide.
5. **Remove invalid findings.** Do not include them in the final output. Do not note that they were removed.
6. **Downgrade severity** if tracing reveals the issue is less impactful than initially assessed (e.g., a "High" race condition that only affects a debug-only path should be "Low" or "Nit").

Be thorough — read as many files as needed to verify each finding. A shorter, accurate review is far more valuable than a long review with false positives, but pruning real findings as "out of scope" creates the worse problem: the next review round flags them once the author's own changes expose the underlying issue.

---

## Phase 4: Synthesis

After validation, synthesize the remaining findings:

1. **Deduplicate**: If multiple agents flagged the same issue, keep the most detailed comment and use the highest severity assigned.
2. **Sort by severity**: Blocker > High > Medium > Low > Warn > Nit.
3. **Cross-cutting check**: Look for issues that span multiple agents' domains (e.g., a correctness bug that is also a security vulnerability). Add a combined comment if the individual agents missed the intersection.
4. **Rewrite voice**: The sub-agents tend to produce AI-flavored prose. Before emitting each finding, rewrite the comment body to match the **Voice & style** rules below. Preserve the technical claim exactly — don't soften "leaks a connection" into "might leak", and don't strengthen "may race" into "races". Code references, identifiers, and the bracketed headers stay verbatim.
5. **Assess overall quality**: Consider the findings holistically.

### Comment format (for each finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**[Category: Correctness | Concurrency | Design | Performance | Reliability | Security | Readability | Tests | Dependencies | Scope | Conventions]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (specific suggestion or alternative)

### Voice & style (applies to the comment body, NOT the headers):

**Hard rule on em dashes (strictest tell):** Do not use em dashes (—) or en dashes (–) anywhere in the comment body. Use periods, commas, or parentheses instead. Before emitting any finding, scan its body for \`—\` and \`–\` and rewrite those phrases without them. This is the single most reliable AI tell and the most common reason a humanized review still reads as AI-written.


Each finding's prose should read like a senior engineer leaving it on GitHub — direct, opinionated, terse. The bracketed header lines above must stay verbatim; the rules below apply to the body underneath **Comment:**.

- Short. PR comments are 1-4 sentences, not paragraphs. Cut filler instead of rewording it.
- First person where natural ("I'd lift this out", "looks like X is never awaited"). No anecdotes.
- Real opinions. "This is wrong" is fine; "This is suboptimal" is not.
- No closing summary that restates what you just said.
- No "Great catch!" / "I hope this helps" / "Let me know if..." chatbot scaffolding.

Avoid these AI tells:
- **AI vocabulary**: delve, leverage, navigate (figurative), robust, comprehensive, seamless, meticulous, intricate, underscore, highlight (verb), pivotal, crucial, key (adjective), vital, ensure that, in order to, additionally, furthermore, moreover, notably, valuable, vibrant, foster, garner, align with, tapestry, landscape (figurative), realm.
- **Em dashes** (— or –). Use periods, commas, or parentheses.
- **Filler**: "it's important to note", "it's worth mentioning", "I noticed that", "I've identified that".
- **Excessive hedging**: "could potentially possibly", "may potentially". State it or don't.
- **Rule of three**: don't force findings into triplets to sound thorough.
- **Negative parallelism**: "not just X, it's Y".
- **Copula avoidance**: prefer "is/are/has" over "serves as", "stands as", "functions as", "represents".
- **Persuasive authority**: "the real question is", "at its core", "fundamentally", "what really matters".
- **Signposting**: "Let me explain", "First, ... Second, ... Finally, ...".
- **Vague attributions**: "best practices suggest", "it's generally recommended". Name the concrete reason or drop it.
- **Inline-header bullets**: don't structure short comments as "**Bold:** sentence" lists; just write the sentence.
- **Passive voice** when active is shorter and the actor is known.
- **Superficial -ing analyses**: "highlighting that...", "ensuring that...", "reflecting...". Cut or rewrite as a real clause.

Examples:

Before: "Additionally, this function leverages the cache to ensure robust handling of concurrent requests, highlighting the importance of proper synchronization."
After: "This reuses the cache to handle concurrent requests safely."

Before: "It's worth noting that this could potentially leak a connection if the request times out — best practices suggest using a defer block."
After: "Leaks a connection if the request times out. Wrap the close in a defer."

### Final PR summary:

**Overall verdict:** Approve / Request Changes / Block

**Highest-risk issues:**
1. ...
2. ...
3. ...

**Test coverage assessment:**
- [ ] Adequate test coverage for changes
- [ ] Edge cases tested

**Review method:** Parallel (4 focused sub-agents)

---

## IMPORTANT: Output

Do NOT write any files. Output the final review directly as your response to this prompt. The user will read it from your stdout.

Structure the final response EXACTLY like this (the UI parses it into cards):

1. A short intro/context paragraph (optional).
2. The literal marker \`<FINDINGS>\` on its own line.
3. Every review comment, each starting with its \`**[Severity: …]**\` line, in the comment format defined above.
4. The literal marker \`</FINDINGS>\` on its own line.
5. The final PR summary (**Overall verdict:**, highest-risk issues, etc.) AFTER the closing marker.

Do not put anything between the markers except the findings themselves. If there are zero findings, still emit both markers with nothing in between.`;

// Legacy config.prReviews cache was retired in favor of the file-per-PR cache

ipcMain.handle('pr-ai-review-start', (event, { worktreePath, baseBranch, requestId, provider } = {}) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (aiReviewProcs.has(requestId)) return { error: 'Review already in flight for ' + requestId };

  // Function replacements — see pr-review-ai-start for why.
  const reviewAgent = pickProvider(provider, defaultAgentProvider());
  const prompt = PR_REVIEW_TEMPLATE
    .replace(/\{\{BASE_BRANCH\}\}/g, () => baseBranch || 'main')
    .replace(/\{\{REPO_SPECIFIC_CHECKS\}\}/g, () => repoIntelFor(worktreePath, reviewAgent));

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
