# main/

Electron main-process code. `main.js` at the repo root is the bootstrap
entry point — it requires everything here and hands off to
`bootstrap/app-events.install()`.

## Layout

- **util/** — pure helpers, no module-level state that matters.
  - `logging.js` — console hooks + ring buffer + rolling file (required early).
  - `path-gate.js` — `pathUnder` / `pathUnderAnyRoot`: symlink-safe path containment.
  - `exec.js` — `execFileP`, `ghExec`/`ghExecP`, gh token and repo-owner caches, stderr tail cap, env sanitizer.
  - `output-coalescer.js` — batches PTY output per channel into one IPC send per tick.
  - `pr-for-branch.js` — async PR lookup for a worktree; never rejects.
  - `config.js` — `loadConfig` / `saveConfig` (atomic + queued) + pr-review-cache migration.
  - `voice-model.json` — pinned speech model and runtime files with their SHA-256s (read by `scripts/fetch-voice-model.js` and `bootstrap/voice-protocol.js`).

- **state/** — owns long-lived mutable state. Import `util/` only; never each other (except `pr-review → instances`).
  - `windows.js` — `allWindows`, `mainWindow`, `hardenWindow`, `createWindow`.
  - `instances.js` — `instances` Map, PTY lifecycle, terminal subscribers, idle detection, session files.
  - `claude-streaming.js` — `spawnClaudeStream` + 8 proc maps.
  - `watcher.js` — worktree file watchers.
  - `ci-poll.js` — per-task CI polling + repo-wide auto-fetch.
  - `pr-review.js` — active PR review state + fetch/broadcast helpers.

- **ipc/** — the handler layer. Each file registers its IPC handlers on load.
  - `windows-ipc.js`, `lsp.js`, `skills.js`, `files.js`, `gh.js`, `git.js`, `tasks.js`, `repo.js`, `claude-stream-ipc.js`, `pr-review.js`.
  - `voice.js` — `voice-prepare`: voice pref, bundled model present, macOS mic access.

- **bootstrap/** — app lifecycle.
  - `menu.js` — macOS menu template (`installAppMenu()`).
  - `app-events.js` — PATH fix + refresh, whenReady, before-quit, saveSessions. `install()` attaches everything.
  - `privileged-schemes.js` — the one `registerSchemesAsPrivileged` call (Electron honours only one; a second replaces the first). A new custom scheme exports its entry and is added here. Required before app ready.
  - `qa-media-protocol.js`, `voice-protocol.js` — the `klaussy-qa:` and `klaussy-voice:` handlers.
  - `permissions.js` — the session's one permission handler. Default grant for everything except the mic, which only the main window gets while voice input is on.

## Injection

A few dependencies cross layers without a direct require (to avoid cycles):
path-gate gets `loadConfig + instances` from `main.js`;
`instances.js` gets `isQuitting + startCIPolling` from `bootstrap/app-events.js`;
`state/pr-review.js` gets `ghJson` from `ipc/pr-review.js` on that module's load.
