// All 8 Claude streaming IPC surfaces plus the explain-diff helpers and
// the PR_REVIEW_TEMPLATE constant. Each start-handler spawns a claude
// stream via spawnClaudeStream (from state/claude-streaming.js) and each
// cancel handler is a thin makeClaudeCancelHandler over the matching
// proc map.

const { ipcMain } = require('electron');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { instances } = require('../state/instances');
const { prReview, ensureWorktreeForActivePr, currentRepoPath } = require('../state/pr-review');
const { execFileP } = require('../util/exec');
const { loadConfig } = require('../util/config');
const {
  spawnClaudeStream, makeClaudeCancelHandler,
  debugCheckProcs, inlineEditProcs, inlineCompleteProcs, reviewSurfaceAiProcs,
  implementProcs, explainStreamProcs, aiReviewProcs, commitMsgProcs, reviewChatProcs,
  investigateProcs,
} = require('../state/claude-streaming');

// Stable, bounded ID for dedupeKey suffixes. Inputs (hunks, finding bodies,
// staged diffs) can be many KB; sha1 keeps keys short and comparable.
function shortHash(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 12);
}

// Debug a single failing CI check. Pulls the failing job's logs, builds a
// prompt with PR description + diff + log tail, and streams claude's analysis
// back to the renderer. Same chunk/done event protocol as Explain so the
// renderer can reuse the same UX.
ipcMain.handle('pr-debug-check-start', (event, { requestId, checkLink, checkName }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (debugCheckProcs.has(requestId)) return { error: 'Already debugging' };
  if (!prReview.active) return { error: 'No active PR review' };
  const { meta, baseOwner, baseRepo, diff } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  if (!checkLink) return { error: 'Check has no run link to fetch logs from' };

  // GitHub job links look like:
  //   https://github.com/<owner>/<repo>/actions/runs/<runId>/job/<jobId>
  const m = checkLink.match(/\/actions\/runs\/(\d+)\/job\/(\d+)/);
  const runId = m ? m[1] : null;
  const jobId = m ? m[2] : null;
  if (!runId || !jobId) return { error: 'Could not parse run/job id from link: ' + checkLink };

  const cwd = currentRepoPath() || require('os').homedir();
  const sender = event.sender;

  // Fetch logs. gh run view follows the 302-to-download redirect properly,
  // unlike the bare `gh api .../jobs/{id}/logs` call which often surfaces
  // as HTTP 404. Fall back to the api endpoint if `gh run view` fails (e.g.
  // wrong repo, expired retention).
  let logs = '';
  try {
    logs = execFileSync('gh', [
      'run', 'view', String(runId),
      '-R', `${baseOwner}/${baseRepo}`,
      '--log-failed',
    ], { cwd, stdio: 'pipe', timeout: 30000, maxBuffer: 50 * 1024 * 1024 }).toString();
  } catch (errA) {
    try {
      logs = execFileSync('gh', [
        'api', `/repos/${baseOwner}/${baseRepo}/actions/jobs/${jobId}/logs`,
      ], { cwd, stdio: 'pipe', timeout: 20000, maxBuffer: 50 * 1024 * 1024 }).toString();
    } catch (errB) {
      const msg = (errA.stderr ? errA.stderr.toString().trim() : errA.message)
        || (errB.stderr ? errB.stderr.toString().trim() : errB.message);
      return { error: 'Could not fetch logs: ' + msg };
    }
  }
  const logLines = logs.split('\n');
  const logTail = logLines.slice(-400).join('\n');

  // Truncate diff too — long PRs can easily exceed the prompt budget. The
  // file list + first ~600 lines is usually enough to let claude judge
  // whether the PR caused the failure; full diff is rarely needed.
  const diffSnippet = (diff || '').split('\n').slice(0, 600).join('\n')
    + ((diff || '').split('\n').length > 600 ? '\n\n[... diff truncated ...]\n' : '');

  const prompt =
    `A pull request has a failing CI check. Help diagnose it.\n\n`
    + `## PR\n#${meta.number}: ${meta.title || ''}\n`
    + (meta.body ? `\n${meta.body.slice(0, 2000)}\n` : '')
    + `\n## Failing check\nName: ${checkName || '(unnamed)'}\nLink: ${checkLink}\n`
    + `\n## Last lines of the failing job log\n\`\`\`\n${logTail}\n\`\`\`\n`
    + `\n## PR diff (truncated to 600 lines)\n\`\`\`\n${diffSnippet}\n\`\`\`\n`
    + `\nAnswer in this structure:\n`
    + `1. **What broke** — one or two sentences naming the actual failure.\n`
    + `2. **Caused by this PR?** — yes / no / likely, with the specific evidence from the diff vs log.\n`
    + `3. **Fix** — concrete, code-level suggestion. Use file:line references when possible.\n`
    + `Keep it tight; no preamble.`;

  spawnClaudeStream({
    requestId, procMap: debugCheckProcs, channelPrefix: 'pr-debug-check',
    sender, cwd, prompt,
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
  });
  return { ok: true };
});

ipcMain.handle('inline-complete-cancel', makeClaudeCancelHandler(inlineCompleteProcs));

// G7: AI review in the PR review surface. Ensures a worktree (auto-cloning
// if needed) and spawns claude with the PR_REVIEW_TEMPLATE, streaming
// stream-json events back to the renderer. Mirrors F6's protocol so the
// renderer can reuse the same chunk parser.
ipcMain.handle('pr-review-ai-start', async (event, { requestId }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (reviewSurfaceAiProcs.has(requestId)) return { error: 'Already in flight' };
  if (!prReview.active) return { error: 'No active PR review' };

  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };

  const baseBranch = (prReview.active.meta && prReview.active.meta.baseRefName) || 'main';
  const prompt = PR_REVIEW_TEMPLATE
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch)
    .replace(/\{\{REPO_SPECIFIC_CHECKS\}\}/g, '');

  spawnClaudeStream({
    requestId, procMap: reviewSurfaceAiProcs, channelPrefix: 'pr-review-ai',
    sender: event.sender,
    cwd: ensured.worktreePath,
    prompt,
    streamJson: true,
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

// G7: implement a single finding (or "all findings" via one big prompt) by
// spawning claude in the PR's worktree with edit tools. Mirrors the AI-review
// streaming protocol so the renderer can show progress chips + result.
ipcMain.handle('pr-review-implement-start', async (event, { requestId, mode, body }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (implementProcs.has(requestId)) return { error: 'Already in flight' };
  if (!prReview.active) return { error: 'No active PR review' };
  if (!body || !body.trim()) return { error: 'Empty implement body' };

  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };

  // Two prompts depending on whether we're implementing one finding or many.
  // Both share guardrails so claude doesn't drift into unrelated cleanup or
  // start running tests/commits.
  const baseGuardrails =
    `\n\nGuidelines:\n`
    + `- Only change what the finding(s) ask for; do not add unrelated cleanup.\n`
    + `- Do not run tests, install deps, or commit/push.\n`
    + `- After making the changes, summarize each change in one short bullet,\n`
    + `  prefixed with the file path. Be terse.\n`;
  // Single-finding mode emits a follow-up PR comment draft between literal
  // markers so the renderer can extract it and present it to the reviewer
  // for approval. Batch "all" mode skips the marker — one comment for a mixed
  // batch of findings wouldn't map cleanly to any one finding card.
  const draftCommentInstruction =
    `- Then, on a new line, output exactly one block delimited by these literal markers:\n`
    + `    <DRAFT_PR_COMMENT>\n`
    + `    One or two sentences written as a reply the reviewer could post under\n`
    + `    the finding on GitHub — explain what you fixed and how. Do not repeat\n`
    + `    the finding verbatim. Plain prose, no code fences, no bullets.\n`
    + `    </DRAFT_PR_COMMENT>\n`;
  const prompt = mode === 'all'
    ? `Apply the following code-review findings to the codebase:\n\n${body}` + baseGuardrails
    : `Apply the following code-review finding to the codebase:\n\n${body}` + baseGuardrails + draftCommentInstruction;

  spawnClaudeStream({
    requestId, procMap: implementProcs, channelPrefix: 'pr-review-implement',
    sender: event.sender,
    cwd: ensured.worktreePath,
    prompt,
    streamJson: true,
    extraDoneFields: { worktreePath: ensured.worktreePath },
    agentMeta: {
      kind: 'pr-review-implement',
      dedupeKey: `pr-review-implement:${prReview.active.meta.number}:${mode}:${shortHash(body)}`,
      sourceContext: {
        kind: 'pr-review-implement',
        prNumber: prReview.active.meta.number,
        prTitle: prReview.active.meta.title || '',
        mode,
        bodyPreview: body.slice(0, 160),
      },
    },
  });
  return { ok: true, worktreePath: ensured.worktreePath };
});

ipcMain.handle('pr-review-implement-cancel', makeClaudeCancelHandler(implementProcs));

// Discuss a finding with Claude inline — the renderer's "Ask Claude" chat
// panel. Stateless: each turn re-sends the conversation history so Claude
// can respond coherently, and Claude runs read-only (Read/Grep/git OK, no
// edits) so a discussion doesn't accidentally mutate the worktree.
ipcMain.handle('pr-review-chat-start', async (event, { requestId, findingBody, messages, findingId }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (reviewChatProcs.has(requestId)) return { error: 'Already in flight' };
  if (!prReview.active) return { error: 'No active PR review' };
  if (!findingBody || !findingBody.trim()) return { error: 'Missing finding body' };
  if (!Array.isArray(messages) || messages.length === 0) return { error: 'No messages to send' };

  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };

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
ipcMain.handle('pr-review-investigate-start', async (event, { requestId, findingBody }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (investigateProcs.has(requestId)) return { error: 'Already in flight' };
  if (!prReview.active) return { error: 'No active PR review' };
  if (!findingBody || !findingBody.trim()) return { error: 'Missing finding body' };

  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };

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
- Repeat the code to help pinpoint the issue. No more than 10 lines.
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
- Repeat the relevant code (up to 10 lines) to pinpoint the issue.
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
- Repeat the relevant code (up to 10 lines) to pinpoint the issue.
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
- Repeat the relevant code (up to 10 lines) to pinpoint the issue.
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
   - The issue is already handled elsewhere (e.g., validation happens in a caller, error is caught upstream).
   - The code path cannot actually be reached in the way the finding assumes.
   - The finding misreads the logic due to missing surrounding context.
   - The concern is about code that was not changed in this PR and is out of scope.
   - A dependency or framework already guarantees the behavior the finding questions.
4. **Remove invalid findings.** Do not include them in the final output. Do not note that they were removed.
5. **Downgrade severity** if tracing reveals the issue is less impactful than initially assessed (e.g., a "High" race condition that only affects a debug-only path should be "Low" or "Nit").

Be thorough — read as many files as needed to verify each finding. A shorter, accurate review is far more valuable than a long review with false positives.

---

## Phase 4: Synthesis

After validation, synthesize the remaining findings:

1. **Deduplicate**: If multiple agents flagged the same issue, keep the most detailed comment and use the highest severity assigned.
2. **Sort by severity**: Blocker > High > Medium > Low > Warn > Nit.
3. **Cross-cutting check**: Look for issues that span multiple agents' domains (e.g., a correctness bug that is also a security vulnerability). Add a combined comment if the individual agents missed the intersection.
4. **Assess overall quality**: Consider the findings holistically.

### Comment format (for each finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**[Category: Correctness | Concurrency | Design | Performance | Reliability | Security | Readability | Tests | Dependencies | Scope | Conventions]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (specific suggestion or alternative)

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

Do NOT write any files. Output the final review directly as your response to this prompt. The user will read it from your stdout.`;

// Legacy config.prReviews cache was retired in favor of the file-per-PR cache

ipcMain.handle('pr-ai-review-start', (event, { worktreePath, baseBranch, requestId }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (aiReviewProcs.has(requestId)) return { error: 'Review already in flight for ' + requestId };

  const prompt = PR_REVIEW_TEMPLATE
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch || 'main')
    .replace(/\{\{REPO_SPECIFIC_CHECKS\}\}/g, '');

  // stream-json gives us a JSONL event per assistant/tool/result block so we
  // can surface progress in the UI instead of a 15-minute silent spinner.
  spawnClaudeStream({
    requestId, procMap: aiReviewProcs, channelPrefix: 'pr-ai-review',
    sender: event.sender,
    cwd: worktreePath,
    prompt,
    streamJson: true,
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
