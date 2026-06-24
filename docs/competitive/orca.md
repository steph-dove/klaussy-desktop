# Competitive analysis: Orca (stablyai/orca) vs. Klaussy

**Date:** 2026-06-24 · **Source:** scanned [`stablyai/orca`](https://github.com/stablyai/orca) at commit `3f775c3` (MIT, TypeScript, ~6.7k★) — this is a source-verified read of the actual repo, not its marketing README. Findings cite Orca file paths; re-verify against newer commits since Orca ships daily.

## TL;DR
- **Orca** is the broader, more polished **orchestration platform**: ~35 agents, remote/mobile/browser/computer-use, MCP + issue-tracker integrations, premium terminals, an automation CLI. Optimizes for **running a big fleet anywhere**.
- **Klaussy** is narrower but goes deep on **repo-native correctness**: a commit-time review/lint/comment gate, per-repo agent scaffolding & conventions, cross-agent handoff, AI-tell scrubbing, and true multi-repo coordinated sessions. Optimizes for **shipping clean, conventions-correct code**.

## Orca has — Klaussy doesn't

| Capability | Evidence in Orca |
|---|---|
| **~35 well-known agents + any custom CLI** | `AgentType = WellKnownAgentType \| (string & {})`; registry in `src/shared/types.ts` (claude, codex, opencode, pi, gemini, antigravity, aider, goose, amp, cline, continue, cursor, droid, kimi, mistral-vibe, qwen, grok, devin, copilot…). Klaussy = 5. |
| **Remote/SSH worktrees** | Real SSH (`src/relay/pty-handler.ts`, `settings/SshTargetForm.tsx`) with auto-reconnect + port forwarding. Klaussy = local only. |
| **Native mobile app** | `mobile/` (Expo/React-Native), WebSocket pairing to the desktop — monitor/steer agents from a phone. Klaussy = none. |
| **Embedded Chromium + Design Mode + Computer Use** | `browser-screencast-protocol.ts`, `browser-annotation-viewport-bridge.ts` (click a UI element → inject HTML/CSS/screenshot into the prompt), native macOS computer-use (`src/cli/specs/computer.ts`). Klaussy = none. |
| **MCP management UI** | `settings/McpConfigSection.tsx`, `mcp-config-inspection.ts` — detect/configure MCP servers across Claude/Cursor/Cline/LSP. Klaussy desktop = none. |
| **Linear / Jira / GitHub boards in-app** | `TaskPage.tsx`, `PullRequestPage.tsx`, `jira-connect-dialog.tsx` — browse issues/PRs/boards, open a worktree from any task. Klaussy = GitHub PR review only. |
| **Multi-target PR creation** | `src/main/source-control/hosted-review-creation.ts` — GitHub, GitLab, Azure DevOps, Gitea. |
| **Ghostty-class terminals** | WebGL rendering, infinite splits, scrollback that survives restarts (`workspace-session-terminal-buffers.ts`, Ghostty config import). Klaussy = xterm.js. |
| **`orca` automation CLI** | `src/cli/specs/*` — `worktree create`, browser `snapshot/click/fill`, computer-use scripting. |
| **Broad agent-hook management** | Installs agent hooks into 14 agents' *own* configs (`src/main/agent-hooks/`, e.g. `~/.claude/settings.json`). |

## Klaussy has — Orca doesn't

| Capability | Why it's real |
|---|---|
| **Commit-time agent review/lint gate** | Confirmed absent in Orca: it only *reacts* to commit/lint failures (`commit-failure-summary.ts`) and can spawn an agent to fix them — no pre-commit code-review/secrets/silent-failure/comment gate. Klaussy's 5-lens agent review + real linter + comment-strip, run as **git hooks** on every commit/push, has no Orca equivalent. |
| **Git hooks written into the repo** | Orca installs hooks into each *agent's home config*, **never** `.git/hooks`. Klaussy installs pre-commit/pre-push/commit-msg/post-commit git hooks that gate human *and* agent commits. |
| **Per-repo agent-config scaffolding** | Orca does **not** generate CLAUDE.md/AGENTS.md/GEMINI.md, namespaced skills, settings, or conventions into user repos. Klaussy-agents' bootstrapping (5 ecosystems, version-gated) has no Orca equivalent. |
| **Cross-agent session handoff** | Orca resume is **same-agent only** (`src/shared/agent-session-resume.ts`, 9 agents, by provider session id) — no state handoff. Klaussy distills a session and seeds a *different* agent to continue. |
| **AI-tell scrubbing / humanize + attribution stripping** | Opposite philosophy: Orca *adds* attribution (`Co-authored-by: Orca`, "Made with Orca 🐋" in `src/shared/orca-attribution.ts`). Klaussy strips AI tells and AI attribution and enforces Conventional Commits. |
| **Multi-repo coordinated *sessions*** | Orca worktree = exactly one repo (`Worktree.repoId`); cross-repo only via an optional parent→child "orchestration" feature. Klaussy's session spans several repos on a shared branch, each its own worktree, edited as one coordinated unit. |
| **Prompt-injection read guard** | Klaussy's read-injection hook scans file/URL content before the agent consumes it; no content-level injection guard found in Orca. |

## Roughly at parity
Worktree-per-agent isolation · PR review with inline diff comments fed back to the agent (Orca `DiffNotesSendMenu.tsx`; Klaussy PR-review inline comments) · commit-message generation · quick-open · same-agent session resume · themes.

## Opportunities to consider
- **Agent breadth:** Orca's "any CLI agent" string-typed registry is a cheap way to support long-tail agents; Klaussy's 5-provider registry could adopt a similar escape hatch.
- **MCP management:** Klaussy has no MCP settings UI; Orca's `McpConfigSection` is a reference.
- **Orchestration/fan-out:** Orca's parent→child agent dispatch is worth studying if "race N agents, pick the winner" becomes a goal.
- **Defensible moat:** the commit-time review gate, per-repo conventions scaffolding, multi-repo sessions, and humanize/scrubbing are Klaussy-only — lean into these rather than chasing breadth.
