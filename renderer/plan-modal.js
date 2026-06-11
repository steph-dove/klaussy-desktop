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
  // would be wrong advice in the spawned tab.
  //
  // Self-contained — no Claude Code plugin install required. Shape borrowed
  // from the official `feature-dev` skill (parallel exploration, multi-
  // architect compare, post-implementation review) but the specialized agent
  // bodies (the analysis approach, architect process, reviewer process) are
  // inlined here so every spawned tab has them whether or not the user has
  // any plugins installed. All sub-Agent calls use `subagent_type: general-
  // purpose`, which ships with Claude Code by default. Anti-patterns kept as
  // universal craft rules; the prompt instructs Claude to read the target
  // repo's CLAUDE.md / README / CONTRIBUTING for project-specific rules and
  // append them to its working list.
  var PLAN_PROMPT = [
    'You are helping plan and implement a task. Follow these phases in order — do NOT skip Phase 3 (clarifying questions).',
    '',
    'Use TodoWrite throughout: create one task per phase up front, mark each in_progress when starting and completed when done. The flow is long-running, and the todo list keeps the user oriented.',
    '',
    '## Phase 1 — Discovery',
    '',
    'Restate the user\'s request in your own words: what is being built, what problem it solves, what success looks like. Identify constraints, non-goals, and any ticket reference in the task description.',
    '',
    '**Surface-level ambiguity check** — before launching parallel exploration in Phase 2 (which costs 2-3 agent invocations), make sure you can answer all of these:',
    '- Can you name the *thing being built* in one sentence (a feature, a fix, a refactor)?',
    '- Do you know the *user-visible surface* it touches (an endpoint, a screen, a command)?',
    '- Is success *observable* (a behavior change you could write a test for)?',
    '',
    'If any answer is "no", ask the user before exploring. Phase 3 covers the deeper "what should error handling do" / "what about edge case X" questions; Phase 1 catches the "do I even know what they want" case so the parallel agents don\'t waste effort on the wrong target.',
    '',
    'Confirm with the user before continuing.',
    '',
    '## Phase 2 — Understand (parallel exploration)',
    '',
    'Launch 2–3 explore subagents IN PARALLEL via the Agent tool with `subagent_type: general-purpose`. Pass each agent BOTH the analysis approach AND the angle below in its prompt — they need that context inline because they don\'t see this master prompt. Mark this phase\'s todo in_progress when the agents are dispatched.',
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
    '- Agent B — *Architecture & conventions*: "Map the architecture for the area this task touches using the analysis approach above. Identify existing patterns, naming conventions, and any project-doc guidelines (CLAUDE.md, any matching `.claude/rules/*.md` whose `paths:` glob covers the area, README, CONTRIBUTING, AGENTS.md, etc.) that constrain or shape the solution."',
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
    '## Phase 4 — Design (parallel architectures, in plan mode)',
    '',
    '**Enter plan mode now** — design and approval must happen before any edits. Stay in plan mode through Phase 5.',
    '',
    'Launch 2–3 architect subagents IN PARALLEL via the Agent tool with `subagent_type: general-purpose`. Pass each agent the architect process below + their priority + the user\'s task + the answers from Phase 3 + the file list and findings from Phase 2 — they need all of that inline.',
    '',
    '### Architect process (every architect uses this)',
    '',
    '- **Pattern analysis**: Re-confirm the existing patterns and conventions you will integrate with. Cite file:line refs. Read any `.claude/rules/*.md` whose `paths:` glob matches the area you\'ll touch.',
    '- **Architecture decision**: Pick ONE approach (do not hedge with "or maybe X"). State it clearly and own the trade-offs.',
    '- **YAGNI rule**: Design the minimum surface that satisfies the task and Phase 3 answers. Do NOT add config knobs, extension hooks, abstractions for hypothetical future features, or "while we\'re here" cleanups. If the task doesn\'t ask for it, don\'t design it. Architect B (Clean architecture) may refactor more aggressively, but only when the existing structure actively blocks the task — never speculatively.',
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
    'Still in plan mode. Write the chosen plan to the plan file, and call ExitPlanMode to request approval. Do NOT edit any files until the user approves. Once approved, plan mode exits automatically and Phase 6 begins.',
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
    'After implementation, launch 3 reviewer subagents IN PARALLEL via the Agent tool with `subagent_type: general-purpose`. Pass each agent the reviewer process below + their focus + the diff (`git diff main...HEAD` or equivalent) + any context files they\'ll need.',
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
    '- Reviewer A — *Simplicity / DRY / readability*: Is the code as simple as it can be? Are there abstractions that should be inlined or duplications that should be extracted? Is naming clear? Are comments explaining "why" not "what"? Flag dead code and unreachable branches.',
    '- Reviewer B — *Bugs, silent failures, inadequate error handling*. Apply these rules:',
    '    - Empty `catch` blocks (e.g. `catch (_) {}`) are forbidden on user-initiated actions — the user clicked a button, they need feedback if it failed. They are also suspect on background work; even a 30s background poll should at least `console.error` the first failure of each tick.',
    '    - Broad catches (`catch (Exception)`, `catch (e: any)`) hide unrelated errors. List every error type that could be silently swallowed.',
    '    - Fallbacks must be explicit and justified. A fallback that returns `[]`, `null`, or "no data" on a parse error is indistinguishable from "no data was there" — surface a real error instead.',
    '    - Error messages must be actionable. Generic strings ("Something went wrong") are defects.',
    '    - Optional chaining (`?.`) and null coalescing (`??`) on critical operations can mask failures the same way an empty catch can — flag where they hide errors.',
    '    - For each finding give: file:line, severity (CRITICAL silent failure / HIGH poor error message / MEDIUM could be more specific), what could be hidden, user impact, and a concrete fix.',
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
    'These apply regardless of the project. ALSO read this codebase\'s CLAUDE.md / `.claude/rules/*.md` / README / CONTRIBUTING (or equivalent) early in Phase 2 to pick up project-specific rules and add them to your working list — local conventions usually beat generic advice when they conflict.',
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
      hint: 'Provide details. A new agent tab opens on this worktree and runs a multi-agent flow: discovery → parallel exploration → clarify → parallel architectures → approve → implement → parallel review → summary. All local, no cloud round-trip.',
      buildSubmission: function (content) {
        return PLAN_PROMPT.replace('{{TASK}}', content);
      },
    },
    debug: {
      label: 'Debug',
      title: 'Debug an issue',
      submitLabel: 'Debug',
      hint: 'Provide details. A new agent tab will open on this worktree and run <code>/debug</code>.',
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
    'Resolve the base branch: use `{{BASE_BRANCH}}` if set, otherwise `dev` if it exists, otherwise `main`.',
    '',
    'Fetch the base fresh before diffing — a stale local base ref makes `base...HEAD` include commits that landed on the base after your branch point but are not part of this branch, so the review flags files that are not actually in the change. Run `git fetch origin <base>` (skip if there is no `origin` remote). Use `origin/<base>` as the base ref in the commands below if the fetch succeeded, otherwise fall back to the local `<base>`.',
    '',
    '1. Run `git diff --stat <base-ref>...HEAD` and count the total lines changed (additions + deletions). The three-dot `...` form scopes the diff to your branch only (changes since it diverged from the base).',
    '2. Run `git diff <base-ref>...HEAD` to get the full diff.',
    '3. Run `git log <base-ref>..HEAD --oneline` to understand commit history and intent.',
    '4. **Read the full file (not just the diff hunks) for every changed file** listed in the stat output. These are independent reads — issue them all in a single batch of parallel tool calls (one assistant message containing multiple Read tool_use blocks), not sequentially.',
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
    '- Quote the **original code being reviewed** in a fenced code block — verbatim from the file, no edits or ellipses, no more than 10 lines. This is what the comment IS ABOUT, not what to do about it.',
    '- Do NOT include a "fix" or "suggested change" in that same code block. If you have a concrete fix to propose, put it in a separate fenced block prefixed with `Suggested change:` on its own line above the block. Mixing the two confuses readers about which is which.',
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
    '10. **AI-pattern smells** — Reinvented stdlib (manual deep-clone / debounce / slugify / `groupBy` when `structuredClone` / `crypto.randomUUID` / `Object.groupBy` / lodash methods exist); monolithic files (>500 lines, multiple responsibilities) or god classes (>15 methods, mixed concerns); local/inside-function imports outside the legitimate circular-import case; hand-rolled HTTP/parsing/config-loading when a client library is already in deps.',
    '11. **Scope** — Identify the primary intent of the PR. Flag changes unrelated to that intent with **Warn** severity.',
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
    'This PR is large enough to benefit from focused, parallel review. Use the **Agent tool** with `subagent_type: general-purpose` to launch the selected review sub-agents **simultaneously in a single assistant message** (parallel tool calls).',
    '',
    'For each sub-agent, compose the prompt body as: the **Common scaffold** below (with `[PASTE THE FULL DIFF HERE]` and `[PASTE THE COMMIT LOG HERE]` replaced by the actual diff and commit log from Phase 1), then the sub-agent\'s `## Lens` section, then its `## Additional rules` if any.',
    '',
    'Sub-agents 1–4 always run. **Sub-agent 5 (Agentic & Evals) is conditional** — only spawn it if the diff touches AI / agent / eval code (skills, agents, prompts, MCP servers, eval suites, or imports of `anthropic` / `openai` / `langchain` / `langgraph` / `mcp` / `inspect_ai` / `langsmith` / `promptfoo`). Detection signals are listed in full at the top of Sub-agent 5 below.',
    '',
    '**Important:** Each sub-agent returns its findings as text. Sub-agents must NOT write any files.',
    '',
    '---',
    '',
    '### Common scaffold (apply to every sub-agent)',
    '',
    '```',
    'You are a senior engineer reviewing a pull request. Your ONLY focus is the lens described below. Other concerns (correctness, architecture, security, scope, etc.) are handled by parallel reviewers — ignore them.',
    '',
    'Here is the diff:',
    '[PASTE THE FULL DIFF HERE]',
    '',
    'Here is the commit log:',
    '[PASTE THE COMMIT LOG HERE]',
    '',
    'Read every changed file in full for surrounding context.',
    '',
    '## Output format (required for every finding)',
    '',
    '**[Severity: Blocker | High | Medium | Low | Warn | Nit]**',
    '**[Location: file_path:line_number and code_snippet]**',
    '**Comment:**',
    '',
    '- What is wrong or questionable, why this is a problem',
    '- What should be changed (concrete fix or alternative)',
    '',
    '## Ground rules (always)',
    '',
    '- Be skeptical and precise.',
    '- Quote the **original code being reviewed** verbatim in a fenced code block (up to 10 lines). This is what the comment IS ABOUT — not your fix. Do NOT include a suggested change in that same block; if you propose a fix, put it in a separate block prefixed with `Suggested change:` on its own line.',
    '- If something relies on an unstated assumption, call it out.',
    '- Prefer concrete fixes over vague advice.',
    '- Return ONLY your findings. Do not write any files.',
    '```',
    '',
    '---',
    '',
    '### Sub-agent 1: Correctness & Logic',
    '',
    '#### Lens',
    '',
    '```',
    '## Look for: Correctness & Concurrency',
    '',
    '### Correctness & Edge Cases',
    '- Logic bugs, off-by-one errors, undefined behavior.',
    '- Error handling gaps, partial failures.',
    '- Incorrect return values or wrong types.',
    '- Boundary conditions: empty inputs, nil/null, max values, overflow.',
    '- State mutations that violate invariants.',
    '',
    '### Cross-file coupling (do not skip)',
    '- For any exported symbol or shared contract changed in this diff (function signatures, return shapes, IPC channels, event names, config keys, enum variants): grep for usages in the repo and verify every call site still composes correctly. Read the consumer file in full, not just the diff.',
    '- Producer/consumer shape mismatches: when a value is set in one file and read in another, verify the consumer handles every shape/case the producer can now emit (added enum variants, optional fields, null/empty results, error states).',
    '- IPC/preload boundaries: if a handler return shape changed, grep the matching channel name on the other side and confirm every renderer call site still destructures correctly.',
    '',
    '### Concurrency & State',
    '- Race conditions, shared mutable state.',
    '- Thread safety, async misuse, ordering assumptions.',
    '- Deadlocks, livelocks, starvation.',
    '- Missing synchronization or incorrect lock scope.',
    '- Assumptions about execution order in async code.',
    '',
    'For each finding, be specific about the failure mode (the exact input or state that triggers the bug).',
    '```',
    '',
    '(No additional rules — common scaffold covers it.)',
    '',
    '---',
    '',
    '### Sub-agent 2: Architecture & Design',
    '',
    '#### Lens',
    '',
    '```',
    '## Look for: Architecture, Design, Performance, Reliability, Dependencies',
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
    '### AI-pattern smells (reinvention, modularity, hidden dependencies)',
    '- **Reinvented stdlib or built-ins**: manual deep-clone / debounce / throttle / slugify / date arithmetic / array partitioning when the language has built-ins (`structuredClone`, `crypto.randomUUID`, `Array.prototype.flat`/`flatMap`, `Intl.*`, `Object.groupBy`, Python\'s `itertools.*` / `functools.*` / `collections.Counter`, Go\'s `slices`/`maps` packages, etc.).',
    '- **Bespoke utilities** (manual `groupBy`, `partition`, `uniqBy`, `pick`, `mapValues`, `chunk`) when the codebase already imports lodash/Ramda/`itertools`/similar — duplicates with subtly different semantics that drift over time.',
    '- **Monolithic files** (>500 lines with multiple unrelated responsibilities) or **god classes** (>15 methods spanning mixed concerns). Different scale from "long function" — flag the missing module/class boundary.',
    '- **Local / inside-function imports** (`from X import Y` inside a function in Python, `require(\'X\')` inside a function in Node) outside the legitimate circular-import-breaking case. Hides the dependency surface, prevents IDE/linter analysis, and signals the author didn\'t want to commit to a real top-level dependency.',
    '- **Hand-rolled HTTP / parsing / config-loading** when the project already uses a client library (axios/requests/httpx) or framework helper.',
    '```',
    '',
    '#### Additional rules',
    '',
    '```',
    '- Think about how changes behave at scale and over time, not just on the current request.',
    '```',
    '',
    '---',
    '',
    '### Sub-agent 3: Security & Quality',
    '',
    '#### Lens',
    '',
    '```',
    '## Look for: Security, Readability/Maintainability, Test Coverage',
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
    '```',
    '',
    '#### Additional rules',
    '',
    '```',
    '- For security issues, describe the attack vector concretely (the exact input or sequence that triggers it).',
    '```',
    '',
    '---',
    '',
    '### Sub-agent 4: Scope & Conventions',
    '',
    '#### Lens',
    '',
    '```',
    '## Look for: Scope, Project Conventions',
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
    'If no repo-specific checks are listed above, read CLAUDE.md and any matching `.claude/rules/*.md` for the area being changed, and verify the PR adheres to the conventions and known pitfalls listed there.',
    '```',
    '',
    '#### Additional rules',
    '',
    '```',
    '- Be precise about what is out of scope vs. in scope.',
    '- For convention violations, reference the specific convention (file path or section in CLAUDE.md / `.claude/rules/`).',
    '```',
    '',
    '---',
    '',
    '### Sub-agent 5: Agentic & Evals (conditional)',
    '',
    '**Spawn this sub-agent ONLY if the Phase 1 diff touches AI / agent / eval code.** Detection signals:',
    '',
    '- Files under `**/skills/**`, `**/agents/**`, `**/.claude/**`',
    '- MCP server files: `**/mcp_*.{py,ts,js}`, `**/mcp-server*.*`, `**/.mcp.json`',
    '- Eval suites: `**/evals/**`, `**/eval_*.{py,ts,js}`, `*.eval.{py,ts,js}`',
    '- Imports of `anthropic`, `openai`, `langchain`, `langgraph`, `llama_index`, `mcp`, `@anthropic-ai/sdk`, `@openai/openai`, `inspect_ai`, `langsmith`, `promptfoo`, `ragas`',
    '- System-prompt or skill-body string changes (e.g. `SKILL.md`, `*.prompt.md`, `system_prompt = "..."` literals)',
    '',
    'If none of these signals are present in the diff, skip this sub-agent entirely — it has nothing to review.',
    '',
    '#### Lens',
    '',
    '```',
    '## Look for: Agentic & Eval correctness',
    '',
    'If, after reading the diff, you find no AI / agent / eval changes, return one line: "No agentic or eval changes — nothing to review." Do NOT invent findings.',
    '',
    '### Agentic code (prompts, tools, model calls, agents, skills, MCP servers)',
    '',
    '- **Hardcoded model IDs** — any literal model identifier (e.g. `<vendor>-<family>-<rev>` shapes like the current Claude / GPT / Gemini families) inline in code instead of routed through config. Models change; literals rot. Flag every literal that should be a config value.',
    '- **Missing prompt caching** on stable prefixes (system prompts, tool/function definitions, skill bodies, long retrieved context). Anthropic SDK exposes this via `cache_control` breakpoints; OpenAI surfaces it automatically on the Responses API. Long stable prefixes that aren\'t cached are wasted tokens.',
    '- **Unbounded agent loops** — recursion or `while True:` driving model calls with no max-iteration / max-cost guard. Cite the exit condition (or absence).',
    '- **Token / context-window math** — system prompt + tools + history sized close to the model\'s window with no truncation strategy. Long static prefixes added to a chat history accumulator are a slow-burn defect.',
    '- **Sensitive data sent to LLM** without redaction: PII, secrets, internal API URLs, customer-specific identifiers. Especially in tool descriptions, dynamic context injection (`` !`<command>` ``), and retrieved-document chunks.',
    '- **Tool / function-call schema issues**: missing or wrong `required` fields; tool-name collisions across multiple registered tools; ambiguous parameter names. For Anthropic SDK tool definitions, descriptions exceeding 1,024 characters get truncated. For Claude Code skills, the combined `description` + `when_to_use` text is capped at 1,536 characters per skill (per `code.claude.com/docs/en/skills.md` frontmatter table).',
    '- **LLM error paths quietly swallowed**: rate-limit (429) without retry/backoff, malformed-JSON parse, refusal, timeout, context-length-exceeded — bare `except:` / `catch (e)` blocks around an LLM call are almost always defects.',
    '- **System prompt or skill body changed without a version bump** — silent behavior shifts. Look for prompt edits in the diff that don\'t bump a version constant, invalidate a cache, or note the change in CHANGELOG.',
    '- **Streaming vs non-streaming**: long calls (>10s expected) made non-streaming where users see no progress; OR streaming used for short structured calls where the parsing overhead isn\'t justified.',
    '- **Claude Code skill / MCP specifics**:',
    '  - SKILL.md `description` doesn\'t start with "Use when…" (auto-trigger heuristic regression).',
    '  - `allowed-tools: Bash` (unscoped) on a skill that only invokes git or one specific tool — flag e.g. a `commit` skill or `pr` skill with bare `Bash`. **Do NOT flag** unscoped `Bash` on skills that legitimately need to run user-defined test / lint / build / type-check commands (typically `debug`, `implement`, `refactor`, `test`, `fix`, `plan`); those genuinely cannot be enumerated up-front.',
    '  - Pure-side-effect skills (`commit`, `deploy`, `send-message`, `new-worktree` / branch creation, anything that publishes externally) missing `disable-model-invocation: true`. **Do NOT flag** auto-invocable code-modification skills (`implement`, `refactor`, `fix`, `debug`, `test`) — users explicitly want Claude to trigger those when relevant; mutating local source on request is the design, not a side effect to gate.',
    '  - Tool descriptions that hardcode a count or list ("review, plan, debug, and 8 others") that will rot as the surface evolves.',
    '  - `allowed-tools` written as comma-separated when the canonical syntax is space-separated. Concretely: `allowed-tools: Read Grep Glob Bash` ✓ — `allowed-tools: Read, Grep, Glob, Bash` ✗.',
    '',
    '### Don\'t flag these (documented features, NOT smells)',
    '',
    'The following are documented Claude Code skill features. Do NOT flag their *presence* — only flag their *misuse* (e.g. dynamic injection running a command that leaks secrets).',
    '',
    '- **Dynamic context injection** — `` !`<command>` `` inline form or ` ```! ` fenced blocks inside SKILL.md bodies. Documented at `code.claude.com/docs/en/skills.md` under "Inject dynamic context". The shell command runs at skill-load time and its output replaces the placeholder. Flag only if the command leaks secrets, hits an external service unintentionally, or runs something destructive — never flag the syntax itself.',
    '- **`$ARGUMENTS` / `$N` / `${CLAUDE_SESSION_ID}` / `${CLAUDE_SKILL_DIR}` substitution** in SKILL.md bodies. Documented in the skills frontmatter spec under "Available string substitutions". When a skill is auto-triggered without args, `$ARGUMENTS` resolves to empty — that is by design, not a defect.',
    '- **`{{REPO}}` / `{{BASE_BRANCH}}` / `{{REPO_SPECIFIC_CHECKS}}` placeholders** in klausify-managed templates. These get substituted at scaffold time by `klausify init` / `klausify checklist`. Flag only if you see the literal `{{...}}` token in a *generated* SKILL.md or rules file under `.claude/` (substitution failed) — never in a template source under `templates/`.',
    '- **Frontmatter fields** `name`, `description`, `when_to_use`, `allowed-tools`, `disable-model-invocation`, `user-invocable`, `model`, `effort`, `context`, `agent`, `hooks`, `paths`, `shell`, `argument-hint`, `arguments` — all documented in the skills frontmatter table. Don\'t flag a field\'s existence; flag wrong values.',
    '- **Glob patterns inside `allowed-tools`** — `Bash(git diff *)` matches `git diff` with any args (`git diff`, `git diff --cached`, `git diff main...HEAD`, `git diff <file>`, multi-flag invocations, etc.). The `*` is a glob, not a literal. Do NOT flag a body command as "missing from allowed-tools" just because the literal flags don\'t appear inside the parentheses; the glob covers them. Only flag when the body invokes a *different command* (e.g. `git status` when allowed-tools has only `Bash(git diff *)`).',
    '- **`.claude/rules/<name>.md` with YAML `paths:` frontmatter** — documented at `code.claude.com/docs/en/memory.md` under "Organize rules with .claude/rules/" → "Path-specific rules". Each rule file with `paths:` frontmatter loads only when Claude reads files matching the glob. Do NOT confuse this with Cursor\'s `.cursor/rules/*.mdc` (different tool, different format). Rule files without `paths:` load unconditionally alongside CLAUDE.md. Flag misuse (e.g. invalid YAML in the frontmatter, paths that don\'t match anything in the repo) but not the *presence* of this feature.',
    '',
    '### Evals (test suites for LLM behavior)',
    '',
    '- **Non-determinism** where avoidable: `temperature` not 0, no `seed` / `random_state`, no fixed eval harness seed. Flag any LLM call inside an eval that doesn\'t pin temperature.',
    '- **Pass thresholds**: too high (>95%) → flaky and CI-noise generator; too low (<60%) → meaningless. Flag thresholds without a documented rationale.',
    '- **No committed baseline / golden output** to diff against. Snapshot evals should have a checked-in expected output, not free-form "looks reasonable" assertions or LLM-as-judge calls without a calibrated rubric.',
    '- **Coverage gaps**: happy-path evals only, no failure-mode / refusal / boundary-input / adversarial evals. The hard cases are where eval suites earn their keep.',
    '- **Eval datasets not versioned** in source control — checked in as opaque blobs without provenance, or pulled from external URLs without a lockfile. A drifted dataset silently invalidates trend lines.',
    '- **Cost guard missing**: an eval that spends real API credit per run with no max-call / max-token cap and no CI throttle. A flaky eval can cost real money.',
    '- **Snapshot rot**: snapshot evals with stale `// updated: 2024-...` comments and no recent rebaseline. Stale snapshots silently mask regressions.',
    '- **Eval not wired to CI** — only manual invocation. Means regressions ship.',
    '- **LLM-as-judge without calibration**: using one LLM to grade another\'s output without a calibration set showing the judge\'s accuracy on known-good and known-bad outputs.',
    '```',
    '',
    '#### Additional rules',
    '',
    '```',
    '- Cite the exact file:line and the SDK/library/model being used (e.g. "src/agent.py:42 — `anthropic.messages.create(model=<literal>, ...)` with no cache_control on the system prompt").',
    '- Distinguish "smell" (e.g. hardcoded model ID, missing cache_control) from "bug" (e.g. unbounded loop, swallowed 429) in your severity. Smells are typically Medium/Low; bugs are High/Blocker.',
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
    '   - The issue is already handled elsewhere (e.g., validation happens in a caller, error is caught upstream). Verify by reading the caller — do not assume.',
    '   - The code path cannot actually be reached in the way the finding assumes. Verify by tracing — do not assume.',
    '   - The finding misreads the logic due to missing surrounding context.',
    '4. **Do NOT prune a finding just because:**',
    '   - The concern technically lives in unchanged code, if this PR\'s change exposes it (a new caller now hits an existing latent bug, a new return shape is fed to an old consumer, a new code path now reaches stale logic). The diff made it relevant — keep it.',
    '   - A framework, library, or dependency "probably" handles it. Verify by reading the framework\'s code or type definitions. Speculation is not validation.',
    '   - The fix would be small or "the author probably knows". Reviewers flag, authors decide.',
    '5. **Remove invalid findings.** Do not include them in the final output. Do not note that they were removed.',
    '6. **Downgrade severity** if tracing reveals the issue is less impactful than initially assessed (e.g., a "High" race condition that only affects a debug-only path should be "Low" or "Nit").',
    '',
    'Be thorough — read as many files as needed to verify each finding. A shorter, accurate review is far more valuable than a long review with false positives, but pruning real findings as "out of scope" creates the worse problem: the next review round flags them once the author\'s own changes expose the underlying issue.',
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
    '**[Category: Correctness | Concurrency | Design | Performance | Reliability | Security | Readability | Tests | Dependencies | Scope | Conventions | Agentic | Evals]**',
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
    '**Review method:** Parallel (4–5 focused sub-agents — sub-agent 5 conditional on AI/agent/eval signals)',
  ].join('\n');

  var currentTaskId = null;
  var currentAction = 'plan';
  // Absolute paths of dropped/picked uploads. We pass the paths to Claude (not
  // the file contents) and let the CLI read them itself — works for any file
  // type and for folders, with no size cap or binary handling on our side.
  var uploadedPaths = [];

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
    uploadedPaths = [];
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

  // Quote a path for the shell only when it contains whitespace, matching the
  // terminal drag-drop behavior.
  function quotePath(p) {
    return /\s/.test(p) ? '"' + p + '"' : p;
  }

  function activeContent() {
    var activeTab = overlay.querySelector('.plan-modal-tab.active');
    var name = activeTab ? activeTab.dataset.tab : 'paste';
    if (name === 'upload' && uploadedPaths.length) {
      // Hand Claude the paths and let it read them. A short lead-in tells it
      // these are the inputs for the task; the plan flow's clarifying phase
      // takes over from there.
      return 'Use these files/folders for the task (read them):\n'
        + uploadedPaths.map(quotePath).join('\n');
    }
    return textarea.value.trim();
  }

  // Shared by the file-picker change handler and drag-and-drop. Resolves each
  // dropped/picked item to its absolute path (getPathForFile works for files
  // and folders alike) and lists them; the paths are handed to Claude at
  // submit time. Multiple items in one drop/pick are all kept.
  function processFiles(files) {
    if (!files || files.length === 0) return;
    errorEl.textContent = '';
    // getPathForFile returns '' (or can throw) for files with no backing OS
    // path; skip those rather than letting an exception kill the handler.
    var paths = files.map(function (f) {
      try { return window.klaus.fs.getPathForFile(f) || ''; } catch (_err) { return ''; }
    }).filter(Boolean);
    if (paths.length === 0) {
      errorEl.textContent = 'Could not resolve a path for the selected item(s).';
      return;
    }
    // Accumulate across repeated drops/picks; dedupe so the same path added
    // twice doesn't appear twice. Use the × buttons to drop individual items.
    paths.forEach(function (p) {
      if (uploadedPaths.indexOf(p) === -1) uploadedPaths.push(p);
    });
    renderUploadList();
    var skipped = files.length - paths.length;
    if (skipped > 0) errorEl.textContent = skipped + ' item(s) had no readable path and were skipped.';
  }

  function renderUploadList() {
    if (uploadedPaths.length === 0) {
      fileDisplay.textContent = 'No files selected';
      fileDisplay.classList.remove('has-file');
      fileList.innerHTML = '';
      return;
    }
    fileDisplay.textContent = uploadedPaths.length === 1
      ? basename(uploadedPaths[0])
      : uploadedPaths.length + ' items selected';
    fileDisplay.classList.add('has-file');
    fileList.innerHTML = '';
    uploadedPaths.forEach(function (p, i) {
      var row = document.createElement('div');
      row.className = 'plan-file-row';
      var nameEl = document.createElement('span');
      nameEl.textContent = basename(p);
      nameEl.title = p;
      var rm = document.createElement('button');
      rm.className = 'plan-file-remove';
      rm.type = 'button';
      rm.textContent = '×';
      rm.title = 'Remove';
      rm.addEventListener('click', function () {
        uploadedPaths.splice(i, 1);
        renderUploadList();
      });
      row.appendChild(nameEl);
      row.appendChild(rm);
      fileList.appendChild(row);
    });
  }

  function basename(p) {
    var parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  // Repository-intelligence block (conventions + import graph, generated on
  // session create and cached in main). '' until ready — callers append it
  // conditionally. Passes the task's agent so claude tabs in synced
  // worktrees get the slim graph-only block (their CLAUDE.md loads
  // natively; re-injecting it would double-pay those tokens). Never throws.
  async function repoIntelFor(taskId) {
    try {
      var task = AppState.tasks.get(taskId);
      if (!task || !task.worktreePath) return '';
      // Sub-tabs spawn with the parent task's agent (shell parents fall back
      // to the default agent) — mirror openClaudeSubTerminal's resolution.
      var defaultAgent = (AppState.savedPrefs && (AppState.savedPrefs.defaultProvider || AppState.savedPrefs.defaultMode)) || 'claude';
      var agent = (task.mode && task.mode !== 'shell') ? task.mode : defaultAgent;
      var res = await window.klaus.task.getRepoIntel(task.worktreePath, agent);
      return (res && res.block) || '';
    } catch (e) {
      console.warn('[plan-modal repo-intel]', e);
      return '';
    }
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
      // Append the repo's conventions/graph context so Plan and Debug runs
      // reason with house rules from the start instead of rediscovering them.
      var intel = await repoIntelFor(currentTaskId);
      if (intel) command += '\n\n' + intel;
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
  // the caller can surface errors. When repo intel is cached we substitute
  // the {{REPO_SPECIFIC_CHECKS}} placeholder with it; otherwise the
  // placeholder stays and the prompt's own fallback (read CLAUDE.md) applies.
  async function runReview(taskId) {
    var prompt = REVIEW_PROMPT;
    var intel = await repoIntelFor(taskId);
    if (intel) prompt = prompt.split('{{REPO_SPECIFIC_CHECKS}}').join('\n' + intel + '\n');
    return TerminalManager.openClaudeSubTerminal(taskId, 'Review', prompt);
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

    fileInput.addEventListener('change', function () {
      processFiles(fileInput.files ? Array.from(fileInput.files) : []);
    });

    // Drag-and-drop: drop a file anywhere on the modal to upload it. Only
    // engages when files are actually being dragged, so text drags into the
    // paste textarea keep their native behavior. A file drop flips to the
    // upload tab and runs the same processing as the file picker.
    var modalEl = document.getElementById('plan-modal');
    if (modalEl) {
      var draggingFiles = function (e) {
        var types = e.dataTransfer && e.dataTransfer.types;
        return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
      };
      modalEl.addEventListener('dragover', function (e) {
        if (!draggingFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        modalEl.classList.add('drag-over');
      });
      modalEl.addEventListener('dragleave', function (e) {
        // Only clear when the cursor actually leaves the modal, not when it
        // crosses between child elements (which also fire dragleave).
        if (!modalEl.contains(e.relatedTarget)) modalEl.classList.remove('drag-over');
      });
      modalEl.addEventListener('drop', function (e) {
        if (!draggingFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        modalEl.classList.remove('drag-over');
        var files = Array.from(e.dataTransfer.files);
        if (files.length === 0) return;
        setTab('upload');
        processFiles(files);
      });
    }

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
