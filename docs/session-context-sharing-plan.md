# Implementation Plan: Session-Level Inter-Agent Context Sharing (OKF)

> **Status:** Proposed Architecture & Plan  
> **Scope:** `klaussy-desktop` (Electron Main Process, Multi-Terminal Worktrees, Mixed Agent Providers)  
> **Objective:** Enable real-time, uncommitted, session-scoped context sharing between mixed AI agent providers (Claude Code, Gemini/Antigravity, Ollama, OpenAI/Codex, Kimi, etc.) without creating Git commits or dirtying `git status`.

---

## 1. Problem Statement & Goals

### Current Limitations
1. **Agent Context Isolation:** Concurrent agent runs across multiple worktree terminals cannot communicate runtime discoveries, breaking schema changes, or active server ports in real time.
2. **Provider Lock-in:** `klaussy-desktop`'s sequential session handoff (`main/state/session-handoff.js`) relies on Claude `.jsonl` transcript files. Non-Claude agents (Gemini/Antigravity, Ollama, OpenCode, Kimi) cannot read or contribute to native chat transcripts of other providers.
3. **Git Cleanliness:** Project context sharing must **not** generate transient Git commits or require dirtying the working tree with temporary scratchpad files.

### Key Goals
- **Session-Scoped & Uncommitted:** Context lives in local app storage outside of Git tracking (`~/.klaussy/sessions/<channel>/notes/`).
- **Vendor-Neutral Format:** Use the Open Knowledge Format (OKF) standard—YAML frontmatter + Markdown body—as the inter-agent data exchange contract.
- **Provider-Agnostic:** Any CLI agent provider spawned by `klaussy-desktop` can easily read and write OKF notes via simple file operations or environment variables.

---

## 2. System Architecture

```
        ┌─────────────────────────────────────────────────────────────┐
        │             Electron Main Process State                      │
        │        ~/.klaussy/sessions/<channel>/notes/                  │
        │          (Uncommitted Local OKF Storage)                   │
        └───────┬─────────────────────────────┬─────────────────┬─────┘
                │                             │                 │
           (OKF File)                    (OKF File)        (OKF File)
                ▼                             ▼                 ▼
   ┌──────────────────────────┐  ┌──────────────────┐  ┌──────────────────┐
   │    Claude Code (WT-1)    │  │ Gemini (WT-2)    │  │ Ollama (WT-3)    │
   │  Reads/Writes OKF Notes  │  │ Reads/Writes OKF │  │ Reads/Writes OKF │
   └──────────────────────────┘  └──────────────────┘  └──────────────────┘
```

---

## 3. Storage & Schema Specification

### 3.1 Storage Location
`~/.klaussy/sessions/<channel>/notes/` — outside every repository, so notes can
never be committed and never dirty `git status`.

One channel per klaussy **session**, which is the unit agents actually
collaborate in:

- A session worktree (`~/klaussy/sessions/<name>/<repo>`) uses `session-<name>`,
  so every repo and terminal in that session shares one channel.
- Anything else uses the folder itself (basename + a hash of its path), so two
  unrelated tasks in one repo stay separate and two folders that merely share a
  basename do not collide.

Keying by repository instead would be wrong in both directions: a session spans
several repos with different git dirs, and two unrelated tasks in one repo would
read each other's notes for as long as the TTL allows. Keying by terminal or by
worktree is worse still — every agent gets a private directory and no two ever
meet, which is the one thing this feature exists to prevent.
`KLAUSSY_SESSION_ID` identifies the writing terminal in note metadata only.

### 3.2 OKF Note Schema (`<agent-name>_<timestamp>.md`)
Every session note created by an agent or system service adheres to the following specification:

```markdown
---
id: note-1785128240
session_id: sess_abc123
agent: claude-code
provider: anthropic
worktree: feature/auth-refactor
timestamp: 2026-07-27T10:00:00Z
affected_files:
  - main/ipc/auth.js
  - renderer/components/login.jsx
tags:
  - auth
  - breaking_change
  - port_change
---
# Title: Auth IPC Refactored & Local Port Shift

### Summary of State Change
Refactored token verification in `main/ipc/auth.js`. 

### Key Runtime Notes for Other Agents
- Dev mock auth server moved from port `3000` to `3005`.
- Updated environment variable `AUTH_JWT_SECRET` key requirement.
```

---

## 4. Implementation Components in `klaussy-desktop`

### 4.1 Main State Module: `main/state/session-context.js`
Create a new state manager to handle directory creation, reading, and context assembly:

* `ensureSessionNotesDir(worktreePath)`: Resolves and creates the session-wide notes dir.
* `listSessionNotes(worktreePath)`: Scans and parses YAML frontmatter of all active session notes.
* `buildSessionContextSummary(worktreePath)`: Condenses active session notes into a compact text block for prompt injection.
* `writeSessionNote(worktreePath, noteData)`: Helper for programmatically creating OKF notes from IPC or system events.

### 4.2 IPC Layer: `main/ipc/session-context.js`
Register IPC handlers for the renderer UI and agent runners:
- `session-context:get-notes`: Retrieves active notes for the Electron frontend.
- `session-context:add-note`: Allows UI or agents to post notes via IPC.
- `session-context:clear-session`: Cleans up expired session directories.

### 4.3 Environment Variable & Spawn Injection
When `klaussy-desktop` spawns any PTY terminal or CLI agent (in `main/state/instances.js`, `main/ipc/claude-stream-ipc.js`, or `main/state/ai-providers.js`):
1. **Inject Environment Variables:**
   - `KLAUSSY_SESSION_ID=<active-session-id>`
   - `KLAUSSY_SESSION_NOTES_DIR=<absolute-path-to-notes-dir>`
2. **Initial Prompt Seeding:**
   Prepend active session note summaries to the initial prompt when an agent process starts.

---

## 5. Agent Instructions & Conventions

To ensure all agent providers (Claude Code, Gemini/Antigravity, Ollama, OpenCode, Kimi) recognize and participate in the session bus, update top-level convention files:

### Added Block for `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `.antigravityrules`:

```markdown
## Active Session Context Sharing (Uncommitted / Mixed Agent Bus)

This workspace uses klaussy-desktop multi-agent session context sharing.

- **Session Notes Location:** `$KLAUSSY_SESSION_NOTES_DIR` (absolute; skip session notes if unset)
- **Reading Session Context:** Before starting a complex task or when working in multi-terminal worktrees, check `$KLAUSSY_SESSION_NOTES_DIR` for Markdown notes left by other active agents.
- **Writing Session Context:** When completing a subtask, changing ports/schemas, or encountering a breaking discovery, create a Markdown file in `$KLAUSSY_SESSION_NOTES_DIR/<agent-name>-<timestamp>.md`:
  ```yaml
  ---
  agent: <your-agent-name>
  provider: <provider-id>
  affected_files: ["path/to/file.js"]
  tags: [topic]
  ---
  Summary of finding or runtime state update...
  ```
- **Git Safety:** notes live outside the repository. Never copy one into the working tree or commit it.
```

---

## 6. Execution Roadmap

- [x] **Phase 1: Backend Foundation**
  - Implement `main/state/session-context.js` and the per-session notes directory initializer.
  - Add `main/ipc/session-context.js` IPC routes.
- [x] **Phase 2: Agent Runner Integration**
  - Update agent spawn wrappers in `main/state/instances.js` to set `KLAUSSY_SESSION_NOTES_DIR` and `KLAUSSY_SESSION_ID`.
  - Prepend the notes summary to every spawn that carries a prompt: the
    cross-agent handoff, sub-terminal Plan/Debug/Review, PR implement, and PR
    chat (`withSessionContext`).
  - Bare terminals are deliberately excluded. No provider exposes a way to seed
    context without also starting a turn, so injecting there would have every
    new terminal in the repo open by talking to itself for as long as a note
    lives. Those agents still find notes through `CLAUDE.md` and the skill.
- [x] **Phase 3: Agent Rules & Documentation**
  - Session protocol reaches `CLAUDE.md` via `klaussy-repo-conventions`, and
    `AGENTS.md` / `GEMINI.md` via the `klaussy-agents` backends that re-emit the
    same conventions doc. These files are git-ignored here and regenerated, so
    they are not edited by hand in this repo.
  - Skill template ships from `klaussy-agents` (`templates/skills/session-context`)
    and scaffolds to `<prefix>-session-context`.
  - [ ] *Deferred:* `.antigravityrules` — Antigravity reads the cross-tool
    `AGENTS.md`, so it is already covered; a dedicated file is redundant.
- [ ] **Phase 4: Verification & UI Integration**
  - Add a "Session Context Notes" indicator/drawer in `klaussy-desktop` Electron
    renderer. Until this lands the IPC + preload surface has no caller and exists
    for agents and future UI only.
  - Test multi-terminal execution with Claude Code + Gemini side-by-side to verify live context exchange without Git commits.
