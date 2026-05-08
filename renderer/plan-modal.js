window.ActionModal = (function () {
  var overlay = document.getElementById('plan-modal-overlay');
  var titleEl = document.getElementById('plan-modal-title');
  var textarea = document.getElementById('plan-modal-text');
  var fileBtn = document.getElementById('plan-file-btn');
  var fileInput = document.getElementById('plan-file-input');
  var fileDisplay = document.getElementById('plan-file-display');
  var fileList = document.getElementById('plan-file-list');
  var errorEl = document.getElementById('plan-modal-error');
  var cancelBtn = document.getElementById('plan-modal-cancel');
  var submitBtn = document.getElementById('plan-modal-submit');
  var subHint = overlay ? overlay.querySelector('.plan-modal-sub') : null;
  var tabs = overlay ? overlay.querySelectorAll('.plan-modal-tab') : [];
  var contents = overlay ? overlay.querySelectorAll('.plan-tab-content') : [];

  // Plan flow runs locally (no cloud round-trip), so it gets the full prompt
  // inlined the same way Review does. The earlier `/ultraplan` slash command
  // launched a remote session which has no access to the user's chat context
  // (or any uncommitted code) — for a worktree-scoped tab that's the wrong
  // shape. Debug stays as a local slash command since `/debug` ships with
  // Claude Code itself.
  //
  // The prompt itself is intentionally project-agnostic: Klaussy users invoke
  // it from their own repos, not from this one, so anything Klaussy-specific
  // would be wrong advice in the spawned tab. Shape borrowed from the official
  // `feature-dev` skill (parallel exploration, multi-architect compare,
  // post-implementation review) plus universal craft rules (YAGNI, grep
  // callers before changing public shapes, no silent error swallowing, manual
  // UI verification). The prompt instructs Claude to read the target repo's
  // CLAUDE.md / README / CONTRIBUTING for project-specific rules. References
  // specialized subagents by name when available; falls back to
  // `general-purpose` otherwise.
  var PLAN_PROMPT = [
    'You are helping plan and implement a task. Follow these phases in order — do NOT skip Phase 3 (clarifying questions).',
    '',
    'Use TodoWrite throughout: create one task per phase up front, mark each in_progress when starting and completed when done. The flow is long-running, and the todo list keeps the user oriented.',
    '',
    '## Phase 1 — Discovery',
    '',
    'Restate the user\'s request in your own words: what is being built, what problem it solves, what success looks like. Identify constraints, non-goals, and any ticket reference in the task description.',
    '',
    'If the request is genuinely ambiguous at the surface level (you can\'t even tell what the feature *is*), ask a quick first round before exploring. Phase 3 covers the deeper "what should error handling do" / "what about edge case X" questions; Phase 1 is just "do I understand what they want."',
    '',
    'Confirm with the user before continuing.',
    '',
    '## Phase 2 — Understand (parallel exploration)',
    '',
    'Launch 2–3 explore subagents IN PARALLEL via the Agent tool. Use specialized subagents when available (`subagent_type: code-explorer`); fall back to `general-purpose`. Mark this phase\'s todo in_progress when the agents are dispatched.',
    '',
    '### Analysis approach (every explore agent uses this)',
    '',
    '- **Feature Discovery**: Find entry points (UI components, IPC handlers, CLI commands). Locate core implementation files. Map feature boundaries and configuration.',
    '- **Code Flow Tracing**: Follow call chains from entry to output. Trace data transformations at each step. Identify dependencies and integrations. Document state changes and side effects.',
    '- **Architecture Analysis**: Map abstraction layers (presentation → business logic → data, or this project\'s equivalent — name them in terms of the codebase you actually find). Identify design patterns and architectural decisions. Document interfaces between components. Note cross-cutting concerns (auth, logging, caching).',
    '- **Implementation Details**: Key algorithms and data structures. Error handling and edge cases. Performance considerations. Technical debt or improvement areas.',
    '',
    '### Required output (every explore agent)',
    '',
    '- Specific file:line refs for entry points and key components.',
    '- Step-by-step execution flow with data transformations.',
    '- A list of the 5–10 files most essential for understanding this surface.',
    '- Strengths, issues, or opportunities relevant to the task.',
    '',
    '### Per-agent angles',
    '',
    '- Agent A — *Similar features*: "Find features in this codebase that already do something analogous to the user\'s task. Pick the closest match and trace its implementation comprehensively using the analysis approach above. Identify what we can reuse vs. what would need to change."',
    '- Agent B — *Architecture & conventions*: "Map the architecture for the area this task touches using the analysis approach above. Identify existing patterns, naming conventions, and any project-doc guidelines (CLAUDE.md, README, CONTRIBUTING, AGENTS.md, etc.) that constrain or shape the solution."',
    '- Agent C — *(when relevant)* UI / testing patterns: "Identify UI patterns, testing approaches, or extension points relevant to this task."',
    '',
    'When the agents return, READ the key files they identified before designing. Agent summaries describe intent, not implementation — you will miss subtleties otherwise.',
    '',
    '## Phase 3 — Clarifying questions (CRITICAL — do not skip)',
    '',
    'List the ambiguities, edge cases, scope boundaries, error-handling preferences, and integration points the task description and Phase 1 confirmation did not specify. Present a clear, numbered list to the user and wait for answers before designing.',
    '',
    'If the user replies "your call" or "no preference," commit to a recommendation and explicitly confirm it.',
    '',
    '## Phase 4 — Design (parallel architectures)',
    '',
    'Launch 2–3 architect subagents IN PARALLEL with different priorities (`subagent_type: code-architect` if available; otherwise `general-purpose`). Pass each agent the user\'s task, the answers from Phase 3, and the file list and findings from Phase 2.',
    '',
    '### Architect process (every architect uses this)',
    '',
    '- **Pattern analysis**: Re-confirm the existing patterns and conventions you will integrate with. Cite file:line refs.',
    '- **Architecture decision**: Pick ONE approach (do not hedge with "or maybe X"). State it clearly and own the trade-offs.',
    '- **Component design**: Each component with file path, responsibilities, dependencies, interface signature.',
    '- **Implementation map**: Specific files to create/modify with detailed change descriptions.',
    '- **Data flow**: End-to-end flow from entry point through transformations to output/storage.',
    '- **Build sequence**: Phased implementation steps as a checklist.',
    '- **Critical details**: Error handling, state management, testing, performance, and security considerations relevant to this task.',
    '',
    '### Per-architect priorities',
    '',
    '- Architect A — *Minimal change*: smallest diff, maximum reuse of existing code, fewest new files. Refactor only when forced.',
    '- Architect B — *Clean architecture*: clear abstractions, ergonomic for future change. May refactor more aggressively.',
    '- Architect C — *Pragmatic balance*: speed + good-enough quality. Pick the best ideas from A and B without over-investing.',
    '',
    'After agents return, present the user a brief summary of each blueprint, the trade-offs, and your recommendation with reasoning. Ask which they want.',
    '',
    '## Phase 5 — Approval gate',
    '',
    'Enter plan mode, write the chosen plan to the plan file, and call ExitPlanMode to request approval. Do NOT edit any files until the user approves.',
    '',
    '## Phase 6 — Implementation',
    '',
    'Work in small, independently-shippable batches. Update TodoWrite as each batch starts and completes. After each batch:',
    '- Verify the code parses / compiles / lints (`node -c`, `tsc --noEmit`, `cargo check`, etc., as the language requires).',
    '- Briefly state what changed (1–2 sentences).',
    '- Pause if the next batch touches a different surface area or needs a separate user decision.',
    '',
    'For UI work, do not report a feature as complete without manually exercising it — or, if you cannot (no fixture data, no running services, etc.), flag the verification gap explicitly.',
    '',
    '## Phase 7 — Quality review (parallel)',
    '',
    'After implementation, launch 3 reviewer subagents IN PARALLEL over the diff.',
    '',
    '### Reviewer process (every reviewer uses this)',
    '',
    '- Read the diff AND the surrounding context (full file, callers, callees) — issues hide in the parts the diff does not show.',
    '- Validate every finding by tracing the code path. Drop findings that are wrong because (a) the issue is already handled elsewhere, (b) the path is unreachable, (c) a framework guarantees the behavior, or (d) the concern is about unchanged code.',
    '- For each surviving finding: severity (Blocker / High / Medium / Low / Nit), file:line + code snippet, what is wrong + why, what to do.',
    '- Prefer a short accurate review over a long one with false positives.',
    '',
    '### Per-reviewer focuses',
    '',
    '- Reviewer A — *Simplicity / DRY / readability* (`subagent_type: code-reviewer` if available): Is the code as simple as it can be? Are there abstractions that should be inlined or duplications that should be extracted? Is naming clear? Are comments explaining "why" not "what"?',
    '- Reviewer B — *Bugs / silent failures / inadequate error handling* (`subagent_type: silent-failure-hunter` if available): Empty `catch` blocks on user-initiated actions, broad catches that hide unrelated errors, missing logging, fallbacks that mask real problems, JSON parse errors swallowed into "no data," edge cases.',
    '- Reviewer C — *Project conventions and the anti-patterns below*: Did we hit any of the universal anti-patterns? Did we follow this project\'s docs (CLAUDE.md / README / CONTRIBUTING / equivalent)? Are public API shapes consistent? Are the project-specific invariants this codebase relies on still intact?',
    '',
    'Consolidate findings, present high-severity issues to the user, and ask whether to fix now, defer to a follow-up, or proceed as-is.',
    '',
    '## Phase 8 — Summary',
    '',
    'Write a 3–5 line summary: what was built, key decisions, files modified, suggested next steps. Mark all TodoWrite tasks complete.',
    '',
    '## Anti-patterns to avoid (universal craft rules)',
    '',
    'These apply regardless of the project. ALSO read this codebase\'s CLAUDE.md / README / CONTRIBUTING (or equivalent) early in Phase 2 to pick up project-specific rules and add them to your working list — local conventions usually beat generic advice when they conflict.',
    '',
    '- Skipping Phase 3 because the task "seems clear." Most clear-looking tasks have hidden ambiguities. Ask anyway.',
    '- Adding features, abstractions, or refactors beyond what the task requires. YAGNI.',
    '- New abstractions for code with only one or two callsites. Three similar lines is fine.',
    '- Backwards-compatibility shims for code that has no other callers.',
    '- Comments that explain "what" the code does. Only "why," and only when it is non-obvious.',
    '- Changing a public function, API, or return-shape without grepping all callers first.',
    '- Silent error swallowing in catch blocks that masks real failures from the user.',
    '- Reporting UI work as complete without manually testing it (or explicitly flagging that you could not).',
    '',
    '---',
    '',
    '## Task',
    '',
    '{{TASK}}',
  ].join('\n');

  // Per-action config — title shown at the top of the modal, the submission
  // builder for the new Claude tab, and a human label for the tab itself.
  // Review runs a fixed multi-phase prompt and skips the modal entirely, so
  // it has no entry here.
  var ACTIONS = {
    plan: {
      label: 'Plan',
      title: 'Plan a task',
      submitLabel: 'Plan',
      hint: 'Provide details. A new Claude tab opens on this worktree and runs a multi-agent flow: discovery → parallel exploration → clarify → parallel architectures → approve → implement → parallel review → summary. All local, no cloud round-trip.',
      buildSubmission: function (content) {
        return PLAN_PROMPT.replace('{{TASK}}', content);
      },
    },
    debug: {
      label: 'Debug',
      title: 'Debug an issue',
      submitLabel: 'Debug',
      hint: 'Provide details. A new Claude tab will open on this worktree and run <code>/debug</code>.',
      buildSubmission: function (content) {
        return '/debug ' + content;
      },
    },
  };

  // Review runs this prompt as-is in a new Claude tab. It contains
  // {{BASE_BRANCH}} and {{REPO_SPECIFIC_CHECKS}} placeholders; the prompt
  // itself instructs Claude how to resolve them ("default to dev if
  // available, otherwise main" / fallback to CLAUDE.md), so we do not
  // substitute them here.
  var REVIEW_PROMPT = [
    'You are conducting a thorough PR review. Follow these phases in order.',
    '',
    '---',
    '',
    '## Phase 1: Context Gathering',
    '',
    'if no BASE_BRANCH is provided, then default to dev if its avialable, otherwise main',
    '',
    '1. Run `git diff --stat {{BASE_BRANCH}}...HEAD` and count the total lines changed (additions + deletions).',
    '2. Run `git diff {{BASE_BRANCH}}...HEAD` to get the full diff.',
    '3. Run `git log {{BASE_BRANCH}}..HEAD --oneline` to understand commit history and intent.',
    '4. For each changed file, read the full file (not just the diff hunks) to understand surrounding context.',
    '5. If the branch name contains a ticket reference (e.g. FEAT-1234), note it for context.',
    '',
    'Store the diff output, file contents, and commit log — you will need them in the next phase.',
    '',
    '---',
    '',
    '## Phase 2: Triage',
    '',
    'Count the total lines changed from the `--stat` output.',
    '',
    '- **If < 150 lines changed:** proceed to [Small PR Review](#small-pr-review) below.',
    '- **If >= 150 lines changed:** proceed to [Parallel Review](#parallel-review) below.',
    '',
    '---',
    '',
    '## Small PR Review',
    '',
    'You are a senior/principal-level engineer reviewing a pull request. Treat this as a real production PR. Output ONLY PR-style review comments, as if leaving inline comments on GitHub/GitLab.',
    '',
    '### Comment format (required for every comment):',
    '',
    '**[Severity: Blocker | High | Medium | Low | Warn | Nit]**',
    '**[Location: file_path:line_number and code_snippet]**',
    '**Comment:**',
    '',
    '- What is wrong or questionable, why this is a problem',
    '- What should be changed (specific suggestion or alternative)',
    '',
    '### Review rules:',
    '',
    '- Be skeptical and precise.',
    '- Assume the code will be read and modified by others.',
    '- Repeat the code to help pinpoint the issue. No more than 10 lines.',
    '- If something relies on an unstated assumption, call it out.',
    '- If behavior is unclear, treat that as a problem.',
    '- Prefer concrete fixes over vague advice.',
    '',
    '### What to look for (in order of priority):',
    '',
    '1. **Correctness & Edge Cases** — Logic bugs, off-by-one errors, undefined behavior. Error handling gaps, partial failures.',
    '2. **Concurrency & State** — Race conditions, shared mutable state. Thread safety, async misuse, ordering assumptions.',
    '3. **Design & API Boundaries** — Leaky abstractions, tight coupling. Public interfaces that are hard to evolve.',
    '4. **Performance & Scalability** — Inefficient loops, N+1 calls, blocking I/O. Work done in hot paths that doesn\'t need to be.',
    '5. **Reliability** — Missing retries, timeouts, idempotency. Resource cleanup (connections, files, tasks).',
    '6. **Security** — Input validation, trust boundaries. Logging sensitive data.',
    '7. **Readability & Maintainability** — Ambiguous naming, overly clever code. Comments that explain "what" instead of "why".',
    '8. **Test Coverage** — Were tests added or updated for the changes? Are edge cases covered?',
    '9. **Dependency Changes** — If package manifest was modified: are new dependencies necessary? Are versions pinned? Flag any new dependencies that duplicate existing functionality.',
    '10. **Scope** — Identify the primary intent of the PR. Flag changes unrelated to that intent with **Warn** severity.',
    '',
    '{{REPO_SPECIFIC_CHECKS}}',
    '',
    '### Tone & standards:',
    '',
    '- Assume a high bar (staff/principal quality).',
    '- If something is "technically correct but fragile," say so.',
    '- If something would fail under load or future change, flag it.',
    '- Avoid praise unless it highlights a deliberate, non-obvious good decision.',
    '',
    '### Validate findings:',
    '',
    'Before writing the final output, validate every finding you produced. For each one:',
    '',
    '1. **Read the full file** referenced in the finding (not just the diff hunk).',
    '2. **Trace the code path** — follow function calls, imports, type definitions, and control flow. Read caller and callee files as needed.',
    '3. **Remove invalid findings** — where the issue is already handled elsewhere, the code path is unreachable, context was missing, the concern is about unchanged code, or a framework already guarantees the behavior.',
    '4. **Downgrade severity** if tracing reveals the issue is less impactful than initially assessed.',
    '',
    'A shorter, accurate review is far more valuable than a long review with false positives.',
    '',
    '### End of review:',
    '',
    'After validation, add a final PR summary:',
    '',
    '**Overall verdict:** Approve / Request Changes / Block',
    '',
    '**Highest-risk issues:**',
    '1. ...',
    '2. ...',
    '3. ...',
    '',
    '**Test coverage assessment:**',
    '- [ ] Adequate test coverage for changes',
    '- [ ] Edge cases tested',
    '',
    'Write this output to a REVIEW_OUTPUT.md',
    '',
    '---',
    '',
    '## Parallel Review',
    '',
    'This PR is large enough to benefit from focused, parallel review. Use the **Agent tool** to launch all four of the following review agents **simultaneously in a single response**. Pass each agent the full diff, changed file contents, and commit log you gathered in Phase 1.',
    '',
    '**Important:** Each agent returns its findings as text. Agents must NOT write any files.',
    '',
    '---',
    '',
    '### Agent 1: Correctness & Logic',
    '',
    'Use the Agent tool with this prompt (include the diff and file contents you gathered):',
    '',
    '```',
    'You are a senior engineer reviewing a pull request. Your ONLY focus is correctness and concurrency. Ignore all other concerns (design, style, security, etc.) — other reviewers are handling those.',
    '',
    'Here is the diff:',
    '[PASTE THE FULL DIFF HERE]',
    '',
    'Here is the commit log:',
    '[PASTE THE COMMIT LOG HERE]',
    '',
    'Read every changed file in full for surrounding context.',
    '',
    '## What to look for:',
    '',
    '### Correctness & Edge Cases',
    '- Logic bugs, off-by-one errors, undefined behavior.',
    '- Error handling gaps, partial failures.',
    '- Incorrect return values or wrong types.',
    '- Boundary conditions: empty inputs, nil/null, max values, overflow.',
    '- State mutations that violate invariants.',
    '',
    '### Concurrency & State',
    '- Race conditions, shared mutable state.',
    '- Thread safety, async misuse, ordering assumptions.',
    '- Deadlocks, livelocks, starvation.',
    '- Missing synchronization or incorrect lock scope.',
    '- Assumptions about execution order in async code.',
    '',
    '## Output format (required for every finding):',
    '',
    '**[Severity: Blocker | High | Medium | Low | Warn | Nit]**',
    '**[Location: file_path:line_number and code_snippet]**',
    '**Comment:**',
    '',
    '- What is wrong, why this is a problem (be specific about the failure mode)',
    '- What should be changed (concrete fix or alternative)',
    '',
    'Rules:',
    '- Be skeptical and precise.',
    '- Repeat the relevant code (up to 10 lines) to pinpoint the issue.',
    '- If something relies on an unstated assumption, call it out.',
    '- Prefer concrete fixes over vague advice.',
    '- Return ONLY your findings. Do not write any files.',
    '```',
    '',
    '---',
    '',
    '### Agent 2: Architecture & Design',
    '',
    'Use the Agent tool with this prompt (include the diff and file contents you gathered):',
    '',
    '```',
    'You are a senior engineer reviewing a pull request. Your ONLY focus is architecture, design, performance, reliability, and dependency changes. Ignore correctness bugs, style, and security — other reviewers are handling those.',
    '',
    'Here is the diff:',
    '[PASTE THE FULL DIFF HERE]',
    '',
    'Here is the commit log:',
    '[PASTE THE COMMIT LOG HERE]',
    '',
    'Read every changed file in full for surrounding context.',
    '',
    '## What to look for:',
    '',
    '### Design & API Boundaries',
    '- Leaky abstractions, tight coupling.',
    '- Public interfaces that are hard to evolve.',
    '- Violation of existing architectural patterns in the codebase.',
    '- Responsibilities placed in the wrong layer or module.',
    '',
    '### Performance & Scalability',
    '- Inefficient loops, N+1 calls, blocking I/O.',
    '- Work done in hot paths that doesn\'t need to be.',
    '- Missing pagination, unbounded queries, or unbounded memory growth.',
    '- Allocations or copies that could be avoided.',
    '',
    '### Reliability',
    '- Missing retries, timeouts, idempotency.',
    '- Resource cleanup (connections, files, tasks).',
    '- Failure modes that leave the system in an inconsistent state.',
    '- Missing circuit breakers or backpressure for external calls.',
    '',
    '### Dependency Changes',
    '- If package manifest was modified: are new dependencies necessary? Are versions pinned?',
    '- Flag any new dependencies that duplicate existing functionality.',
    '- Evaluate transitive dependency impact.',
    '',
    '## Output format (required for every finding):',
    '',
    '**[Severity: Blocker | High | Medium | Low | Warn | Nit]**',
    '**[Location: file_path:line_number and code_snippet]**',
    '**Comment:**',
    '',
    '- What is wrong or questionable, why this is a problem',
    '- What should be changed (concrete fix or alternative)',
    '',
    'Rules:',
    '- Be skeptical and precise.',
    '- Repeat the relevant code (up to 10 lines) to pinpoint the issue.',
    '- Think about how changes behave at scale and over time.',
    '- Prefer concrete fixes over vague advice.',
    '- Return ONLY your findings. Do not write any files.',
    '```',
    '',
    '---',
    '',
    '### Agent 3: Security & Quality',
    '',
    'Use the Agent tool with this prompt (include the diff and file contents you gathered):',
    '',
    '```',
    'You are a senior engineer reviewing a pull request. Your ONLY focus is security, readability, maintainability, and test coverage. Ignore correctness bugs, architecture, and performance — other reviewers are handling those.',
    '',
    'Here is the diff:',
    '[PASTE THE FULL DIFF HERE]',
    '',
    'Here is the commit log:',
    '[PASTE THE COMMIT LOG HERE]',
    '',
    'Read every changed file in full for surrounding context.',
    '',
    '## What to look for:',
    '',
    '### Security',
    '- Input validation gaps, trust boundary violations.',
    '- Injection vectors: SQL, command, XSS, path traversal.',
    '- Authentication/authorization bypasses.',
    '- Logging or exposing sensitive data (tokens, passwords, PII).',
    '- Insecure defaults or missing security headers.',
    '- Cryptographic misuse (weak algorithms, hardcoded keys).',
    '',
    '### Readability & Maintainability',
    '- Ambiguous naming, overly clever code.',
    '- Comments that explain "what" instead of "why".',
    '- Functions that are too long or do too many things.',
    '- Magic numbers or strings without explanation.',
    '- Dead code or unreachable branches.',
    '',
    '### Test Coverage',
    '- Were tests added or updated for the changes?',
    '- Are edge cases covered?',
    '- Are failure paths tested?',
    '- Do tests actually assert meaningful behavior (not just "doesn\'t crash")?',
    '- Are mocks/stubs appropriate, or do they hide real behavior?',
    '',
    '## Output format (required for every finding):',
    '',
    '**[Severity: Blocker | High | Medium | Low | Warn | Nit]**',
    '**[Location: file_path:line_number and code_snippet]**',
    '**Comment:**',
    '',
    '- What is wrong or questionable, why this is a problem',
    '- What should be changed (concrete fix or alternative)',
    '',
    'Rules:',
    '- Be skeptical and precise.',
    '- Repeat the relevant code (up to 10 lines) to pinpoint the issue.',
    '- For security issues, describe the attack vector concretely.',
    '- Prefer concrete fixes over vague advice.',
    '- Return ONLY your findings. Do not write any files.',
    '```',
    '',
    '---',
    '',
    '### Agent 4: Scope & Conventions',
    '',
    'Use the Agent tool with this prompt (include the diff and file contents you gathered):',
    '',
    '```',
    'You are a senior engineer reviewing a pull request. Your ONLY focus is scope analysis and adherence to project conventions. Ignore bugs, architecture, security, and style — other reviewers are handling those.',
    '',
    'Here is the diff:',
    '[PASTE THE FULL DIFF HERE]',
    '',
    'Here is the commit log:',
    '[PASTE THE COMMIT LOG HERE]',
    '',
    'Read every changed file in full for surrounding context.',
    '',
    '## What to look for:',
    '',
    '### Scope',
    '- Identify the primary intent of the PR from the branch name, commit messages, and the bulk of the changes.',
    '- Flag any changes that do not appear related to that primary intent (e.g. drive-by refactors, unrelated formatting, feature creep).',
    '- Use **Warn** severity for unrelated changes — they may be intentional, but should be called out for the author to confirm.',
    '- Check that the PR does one thing well rather than bundling unrelated work.',
    '',
    '### Project Conventions',
    '{{REPO_SPECIFIC_CHECKS}}',
    '',
    'If no repo-specific checks are listed above, check the CLAUDE.md file in the repository for project conventions, commands, and known pitfalls, and verify the PR adheres to them.',
    '',
    '## Output format (required for every finding):',
    '',
    '**[Severity: Blocker | High | Medium | Low | Warn | Nit]**',
    '**[Location: file_path:line_number and code_snippet]**',
    '**Comment:**',
    '',
    '- What is wrong or questionable, why this is a problem',
    '- What should be changed (concrete fix or alternative)',
    '',
    'Rules:',
    '- Be precise about what is out of scope vs. in scope.',
    '- For convention violations, reference the specific convention.',
    '- Prefer concrete fixes over vague advice.',
    '- Return ONLY your findings. Do not write any files.',
    '```',
    '',
    '---',
    '',
    '## Phase 3: Validation',
    '',
    'Before synthesizing, validate every finding from the sub-agents. For each finding:',
    '',
    '1. **Read the full file** referenced in the finding\'s location (not just the diff hunk).',
    '2. **Trace the code path** — follow function calls, imports, type definitions, and control flow to understand the full context. Read caller and callee files as needed.',
    '3. **Determine if the finding is still valid** given the full context. Common reasons a finding is invalid:',
    '   - The issue is already handled elsewhere (e.g., validation happens in a caller, error is caught upstream).',
    '   - The code path cannot actually be reached in the way the finding assumes.',
    '   - The finding misreads the logic due to missing surrounding context.',
    '   - The concern is about code that was not changed in this PR and is out of scope.',
    '   - A dependency or framework already guarantees the behavior the finding questions.',
    '4. **Remove invalid findings.** Do not include them in the final output. Do not note that they were removed.',
    '5. **Downgrade severity** if tracing reveals the issue is less impactful than initially assessed (e.g., a "High" race condition that only affects a debug-only path should be "Low" or "Nit").',
    '',
    'Be thorough — read as many files as needed to verify each finding. A shorter, accurate review is far more valuable than a long review with false positives.',
    '',
    '---',
    '',
    '## Phase 4: Synthesis',
    '',
    'After validation, synthesize the remaining findings:',
    '',
    '1. **Deduplicate**: If multiple agents flagged the same issue, keep the most detailed comment and use the highest severity assigned.',
    '2. **Sort by severity**: Blocker > High > Medium > Low > Warn > Nit.',
    '3. **Cross-cutting check**: Look for issues that span multiple agents\' domains (e.g., a correctness bug that is also a security vulnerability). Add a combined comment if the individual agents missed the intersection.',
    '4. **Assess overall quality**: Consider the findings holistically.',
    '',
    'Write the final output to **REVIEW_OUTPUT.md** in this format:',
    '',
    '### Comment format (for each finding):',
    '',
    '**[Severity: Blocker | High | Medium | Low | Warn | Nit]**',
    '**[Location: file_path:line_number and code_snippet]**',
    '**[Category: Correctness | Concurrency | Design | Performance | Reliability | Security | Readability | Tests | Dependencies | Scope | Conventions]**',
    '**Comment:**',
    '',
    '- What is wrong or questionable, why this is a problem',
    '- What should be changed (specific suggestion or alternative)',
    '',
    '### Final PR summary:',
    '',
    '**Overall verdict:** Approve / Request Changes / Block',
    '',
    '**Highest-risk issues:**',
    '1. ...',
    '2. ...',
    '3. ...',
    '',
    '**Test coverage assessment:**',
    '- [ ] Adequate test coverage for changes',
    '- [ ] Edge cases tested',
    '',
    '**Review method:** Parallel (4 focused sub-agents)',
  ].join('\n');

  var currentTaskId = null;
  var currentAction = 'plan';
  var uploadedText = '';

  function setTab(name) {
    tabs.forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    contents.forEach(function (c) {
      c.classList.toggle('active', c.id === 'plan-tab-' + name);
    });
  }

  function reset(action) {
    var cfg = ACTIONS[action] || ACTIONS.plan;
    textarea.value = '';
    fileInput.value = '';
    fileDisplay.textContent = 'No files selected';
    fileDisplay.classList.remove('has-file');
    if (fileList) fileList.innerHTML = '';
    uploadedText = '';
    errorEl.textContent = '';
    submitBtn.disabled = false;
    submitBtn.textContent = cfg.submitLabel;
    setTab('paste');
  }

  function open(taskId, action) {
    action = ACTIONS[action] ? action : 'plan';
    currentTaskId = taskId;
    currentAction = action;
    var cfg = ACTIONS[action];
    reset(action);
    var task = AppState.tasks.get(taskId);
    titleEl.textContent = task && task.name ? (cfg.title + ' — ' + task.name) : cfg.title;
    if (subHint) {
      subHint.innerHTML = cfg.hint;
    }
    overlay.style.display = 'flex';
    setTimeout(function () { textarea.focus(); }, 0);
  }

  function close() {
    overlay.style.display = 'none';
    currentTaskId = null;
  }

  function activeContent() {
    var activeTab = overlay.querySelector('.plan-modal-tab.active');
    var name = activeTab ? activeTab.dataset.tab : 'paste';
    if (name === 'upload') {
      return (uploadedText || '').trim() || textarea.value.trim();
    }
    return textarea.value.trim();
  }

  async function submit() {
    if (currentTaskId == null) return;
    var cfg = ACTIONS[currentAction] || ACTIONS.plan;
    var content = activeContent();
    if (!content) {
      errorEl.textContent = 'Add some details first (paste text or upload a file).';
      return;
    }
    errorEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Starting…';
    try {
      var command = cfg.buildSubmission(content);
      var result = await TerminalManager.openClaudeSubTerminal(currentTaskId, cfg.label, command);
      if (result && result.error) {
        errorEl.textContent = result.error;
        submitBtn.disabled = false;
        submitBtn.textContent = cfg.submitLabel;
        return;
      }
      close();
    } catch (err) {
      errorEl.textContent = (err && err.message) || String(err);
      submitBtn.disabled = false;
      submitBtn.textContent = cfg.submitLabel;
    }
  }

  // Review has no modal — it just spawns a Claude sub-tab and fires the
  // full review prompt. Returns the same shape as openClaudeSubTerminal so
  // the caller can surface errors.
  async function runReview(taskId) {
    return TerminalManager.openClaudeSubTerminal(taskId, 'Review', REVIEW_PROMPT);
  }

  // Dropdown entry point.
  async function run(taskId, action) {
    if (action === 'review') {
      var r = await runReview(taskId);
      if (r && r.error) {
        if (window.toast && window.toast.error) window.toast.error(r.error);
        else console.error('Review failed:', r.error);
      }
      return;
    }
    open(taskId, action);
  }

  if (overlay) {
    tabs.forEach(function (t) {
      t.addEventListener('click', function () { setTab(t.dataset.tab); });
    });

    fileBtn.addEventListener('click', function () { fileInput.click(); });

    fileInput.addEventListener('change', async function () {
      var files = fileInput.files ? Array.from(fileInput.files) : [];
      if (files.length === 0) return;
      fileDisplay.textContent = files.length === 1
        ? files[0].name
        : files.length + ' files selected';
      fileDisplay.classList.add('has-file');
      fileList.innerHTML = '';
      files.forEach(function (f) {
        var row = document.createElement('div');
        row.className = 'plan-file-row';
        row.textContent = f.name;
        fileList.appendChild(row);
      });
      try {
        var parts = await Promise.all(files.map(function (f) { return f.text(); }));
        // Prefix each file's contents with a header so the prompt can tell
        // where one file ends and the next begins. Without this, concatenated
        // task specs would run into each other ambiguously.
        uploadedText = parts.map(function (text, i) {
          return '=== ' + files[i].name + ' ===\n' + text;
        }).join('\n\n');
      } catch (err) {
        errorEl.textContent = 'Failed to read file: ' + ((err && err.message) || String(err));
        uploadedText = '';
      }
    });

    cancelBtn.addEventListener('click', close);
    submitBtn.addEventListener('click', submit);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    document.addEventListener('keydown', function (e) {
      if (overlay.style.display === 'none') return;
      if (e.key === 'Escape') { close(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
  }

  return { open: open, close: close, run: run };
})();
