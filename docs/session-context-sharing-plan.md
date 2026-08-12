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
- **Session-Scoped & Uncommitted:** Context lives in local app storage outside of Git tracking (`.git/klaussy-session/notes/` or `~/.klaussy/sessions/<session_id>/notes/`).
- **Vendor-Neutral Format:** Use the Open Knowledge Format (OKF) standard—YAML frontmatter + Markdown body—as the inter-agent data exchange contract.
- **Provider-Agnostic:** Any CLI agent provider spawned by `klaussy-desktop` can easily read and write OKF notes via simple file operations or environment variables.

---

## 2. System Architecture

```
        ┌─────────────────────────────────────────────────────────────┐
        │             Electron Main Process State                      │
        │       .git/klaussy-session/notes/<session_id>/               │
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
- **Primary:** `.git/klaussy-session/notes/` under the repo's **common** git dir — `git rev-parse --git-common-dir`, not the worktree's own git dir (automatically ignored by Git, zero `.gitignore` edits needed).
- **Fallback / Global:** `~/.klaussy/sessions/<workspace-slug>/notes/` for folders that aren't git repos.

The channel is deliberately keyed by repository, not by session or terminal. A
linked worktree's own git dir is `<repo>/.git/worktrees/<name>`, so keying on it
— or on a per-terminal id — gives every agent a private directory and no two
ever meet, which is the one thing this feature exists to prevent.
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

- **Session Notes Location:** `$KLAUSSY_SESSION_NOTES_DIR` (or `.git/klaussy-session/notes/`)
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
- **Git Safety:** NEVER commit `$KLAUSSY_SESSION_NOTES_DIR` or `.git/klaussy-session/` to Git. Context is strictly runtime session data.
```

---

## 6. Execution Roadmap

- [x] **Phase 1: Backend Foundation**
  - Implement `main/state/session-context.js` and `.git/klaussy-session/notes/` directory initializer.
  - Add `main/ipc/session-context.js` IPC routes.
- [x] **Phase 2: Agent Runner Integration**
  - Update agent spawn wrappers in `main/state/instances.js` to set `KLAUSSY_SESSION_NOTES_DIR` and `KLAUSSY_SESSION_ID`.
  - Inject the notes summary into the cross-agent handoff seed (`session-handoff.js`).
  - [ ] *Deferred:* prompt-header injection on every spawn. The handoff path
    covers agent-to-agent carryover; doing it for all spawns means reworking the
    staged-prompt path each TUI already uses, and is a change worth its own PR.
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
