# main/

Electron main-process code. `main.js` at the repo root is the bootstrap
entry point — it requires everything here and hands off to
`bootstrap/app-events.install()`.

## Layout

- **util/** — pure helpers, no module-level state that matters.
  - `logging.js` — console hooks + ring buffer + rolling file (required early).
  - `path-gate.js` — `pathUnder` / `pathUnderAnyRoot`: symlink-safe path containment.
  - `exec.js` — `execFileP`, `ghExec`/`ghExecP`, gh token cache, stderr tail cap, env sanitizer.
  - `config.js` — `loadConfig` / `saveConfig` (atomic + queued) + pr-review-cache migration.

- **state/** — owns long-lived mutable state. Import `util/` only; never each other (except `pr-review → instances`).
  - `windows.js` — `allWindows`, `mainWindow`, `hardenWindow`, `createWindow`.
  - `instances.js` — `instances` Map, PTY lifecycle, terminal subscribers, idle detection, session files.
  - `claude-streaming.js` — `spawnClaudeStream` + 8 proc maps.
  - `watcher.js` — worktree file watchers.
  - `ci-poll.js` — per-task CI polling + repo-wide auto-fetch.
  - `pr-review.js` — active PR review state + fetch/broadcast helpers.

- **ipc/** — the handler layer. Each file registers its IPC handlers on load.
  - `windows-ipc.js`, `lsp.js`, `skills.js`, `files.js`, `gh.js`, `git.js`, `tasks.js`, `repo.js`, `claude-stream-ipc.js`, `pr-review.js`.

- **bootstrap/** — app lifecycle.
  - `menu.js` — macOS menu template (`installAppMenu()`).
  - `app-events.js` — PATH fix, whenReady, before-quit, saveSessions, klausify init. `install()` attaches everything.

## Injection

A few dependencies cross layers without a direct require (to avoid cycles):
path-gate gets `loadConfig + instances` from `main.js`;
`instances.js` gets `isQuitting + startCIPolling` from `bootstrap/app-events.js`;
`state/pr-review.js` gets `ghJson` from `ipc/pr-review.js` on that module's load;
`state/pr-review.js` + `ipc/tasks.js` get `runKlausifyInit` from `bootstrap/app-events.js`.
