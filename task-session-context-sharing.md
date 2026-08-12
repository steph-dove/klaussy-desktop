# Task: Session-Level Inter-Agent Context Sharing (OKF)

> See full architectural details in [docs/session-context-sharing-plan.md](file:///Users/stephaniedover/projects/klaussy-desktop/docs/session-context-sharing-plan.md).

## Overview
Implement uncommitted, real-time session context sharing between mixed AI agent providers (Claude Code, Gemini/Antigravity, Ollama, Codex, Kimi, etc.) running across worktree terminals in `klaussy-desktop`.

## Key Requirements
1. **Uncommitted & Git-Clean:** Store OKF session notes in `.git/klaussy-session/notes/` or `~/.klaussy/sessions/<session_id>/notes/` so Git is never dirtied and zero commits are generated.
2. **OKF Standard Schema:** Markdown files with YAML frontmatter (`id`, `session_id`, `agent`, `provider`, `affected_files`, `tags`) + concise summary body.
3. **Provider Agnostic:** Inject `KLAUSSY_SESSION_NOTES_DIR` and `KLAUSSY_SESSION_ID` into process env when launching agents in `klaussy-desktop`.
4. **Agent Protocol Instructions:** Instruct all agent providers via [AGENTS.md](file:///Users/stephaniedover/projects/klaussy-desktop/AGENTS.md), [CLAUDE.md](file:///Users/stephaniedover/projects/klaussy-desktop/CLAUDE.md), and [GEMINI.md](file:///Users/stephaniedover/projects/klaussy-desktop/GEMINI.md) on how to read and write session notes.

## Execution Checklist
- [ ] Create `main/state/session-context.js` for managing session note files.
- [ ] Create `main/ipc/session-context.js` for IPC IPC routes.
- [ ] Inject `KLAUSSY_SESSION_NOTES_DIR` into agent spawn wrappers in `main/state/instances.js` and `ai-providers.js`.
- [ ] Update `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `.antigravityrules` with protocol guidelines.
- [ ] Add `.agents/skills/klaussy-desktop-session-context/SKILL.md` skill definition.
