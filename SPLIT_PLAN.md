# main.js Split Plan (H-ARCH-1)

> **For the assistant picking this up:** this doc is self-contained. Read it fully before touching any file. Do NOT skim. Do NOT skip the protocol in §5.

## 1. Goal

`main.js` is the Electron main process. At the time of writing it is **5508 lines with 163 `ipcMain.handle/on` registrations and ~70 top-level functions** in one file. The task: extract it into ~15 focused modules under `main/`, leaving `main.js` itself as a ~200-line bootstrap (menu, app events, module wiring).

Behavior must not change. This is pure structural refactor.

## 2. Why (from the audit)

- H-ARCH-1 finding: "`main.js` is mixing ~15 unrelated responsibilities; any two of these can touch shared state (`instances`, `activePrReview`, `logBuffer`, `ghTokenCache`) without noticing."
- Every new feature touches the one file. Merge conflicts are constant; code review is impossible at this size.
- Several subtle bugs in the audit (orphan PTYs on kill-task, races in `saveConfig`, LSP leaks on window destroy) trace back to shared state being implicit. Making it explicit via module boundaries makes the bugs harder to reintroduce.

## 3. Target layout

```
main.js                           (~200 lines: require wiring, menu, app events)
main/
  util/
    logging.js                    captureLog, log ring, rolling file, scrubLogMsg
    exec.js                       execFileP, ghExec, ghExecP, ghEnvForRepo, ghTokenCache,
                                  sanitizeExtraEnv, runWithConcurrency, appendStderr
    path-gate.js                  pathUnder, pathUnderAnyRoot, getRendererAllowedRoots
    config.js                     loadConfig, saveConfig + queue, getConfigPath,
                                  migratePrReviewCache, STDERR_CAP_BYTES etc.
  state/
    instances.js                  instances Map, nextId, terminalSubscribers,
                                  spawnInWorktree, convertInstanceToShell,
                                  {subscribe,unsubscribe,sendTo}TerminalChannel,
                                  listSessionFiles, detectClaudeSessionId,
                                  findLatestSessionId, snapshotSessionIds,
                                  initIdleDetectionFields, processIdleDetection,
                                  sendIdleNotification, clearIdleTimer,
                                  isAnyWindowFocused, stripAnsi
    pr-review.js                  activePrReview, _threadsFetchEpoch,
                                  broadcastPrReview, sanitizePrReview,
                                  fetchThreadsForActive, ensureWorktreeForActivePr,
                                  findProjectForRepo, findWorktreeForBranch,
                                  reloadActivePrReviewMeta, pushReviewHistory,
                                  parseBaseFromUrl, currentRepoPath
    windows.js                    allWindows, mainWindow, hardenWindow,
                                  createWindow, popout BrowserWindow creators
    claude-streaming.js           spawnClaudeStream, makeClaudeCancelHandler,
                                  all 8 proc maps (debugCheckProcs, inlineEditProcs,
                                  inlineCompleteProcs, reviewSurfaceAiProcs,
                                  implementProcs, explainStreamProcs, aiReviewProcs,
                                  commitMsgProcs)
    ci-poll.js                    ciPollingIntervals map, startCIPolling, stopCIPolling,
                                  autoFetchIntervalId, startAutoFetch
    watcher.js                    worktreeWatchers map, startWorktreeWatcher,
                                  stopWorktreeWatcher
  ipc/
    tasks.js                      list-saved-sessions, resume-session, save-ui-state,
                                  get-ui-state, get-latest-session,
                                  clear-saved-sessions, dismiss-saved-session,
                                  create-task, attach-worktree, checkout-branch,
                                  browse-directory, open-folder, list-tasks,
                                  write-terminal, resize-terminal, add-sub-terminal,
                                  kill-sub-terminal, kill-task, restart-task,
                                  rename-task, duplicate-task, get-task-note,
                                  set-task-note, pop-out-task, export-transcript,
                                  write-transcript, set-notify-enabled,
                                  get-notify-enabled, get-worktree-state,
                                  list-all-dirty-worktrees
    repo.js                       select-repo, get-repo, list-projects, add-project,
                                  remove-project, switch-project, new-window,
                                  list-worktrees, hide-worktree, list-branches
    git.js                        git-status, git-diff, git-file-hunks, git-branches,
                                  git-branch-files, git-branch-diff, git-stage,
                                  git-unstage, git-apply-patch, git-discard,
                                  git-commit, git-push, git-fetch, git-pull,
                                  git-ahead-behind, git-checkout, git-stash-push,
                                  git-stash-pop, git-stash-list, git-log, git-show,
                                  git-blame, git-conflicts, git-tags, git-tag-create,
                                  git-tag-delete, git-tag-push, create-pr,
                                  collectWorktreeState
    gh.js                         gh-list-accounts, gh-switch-account,
                                  gh-detect-account-for-repo, ci-status, ci-run-logs,
                                  check-dependencies, open-external
    pr-review.js                  pr-list, pr-lookup-url, pr-load, pr-recent,
                                  pr-refresh-threads, pr-review-checks, pr-review-merge,
                                  pr-checkout-locally, pr-review-cache-*-by-pr,
                                  pr-add-issue-comment, pr-edit-issue-comment,
                                  pr-edit-review-comment, pr-current-user,
                                  pr-reply-to-review-comment, pr-submit-review,
                                  pr-review-state, pr-review-close, pop-out-pr-review,
                                  pop-in-pr-review, pr-for-branch, pr-add-review-comment,
                                  pr-merge, pr-checks, pr-review-threads,
                                  pr-{,un}resolve-thread, pr-add-comment, pr-review,
                                  pr-reply-to-comment, pr-fix-in-terminal,
                                  reviewCachePathFor, normalizeCheckRun, normalizeStatus,
                                  bucketFromState, ghJson, ghText,
                                  resolveOrUnresolveThread
    claude-stream-ipc.js          pr-debug-check-{start,cancel}, inline-edit-{start,cancel},
                                  inline-complete-{start,cancel}, pr-review-ai-{start,cancel},
                                  pr-review-implement-{start,cancel},
                                  explain-diff-stream-{start,cancel},
                                  pr-ai-review-{start,cancel}, pr-ai-review-comment,
                                  claude-commit-message-{start,cancel}, explain-diff,
                                  explainPrompt, PR_REVIEW_TEMPLATE
    files.js                      read-file, write-file, read-files-bulk, list-files,
                                  search-files, replace-in-files, read-conflict-file,
                                  write-resolved-file, list-env-files, read-env-file,
                                  write-env-file, walkDirectory, parseGrepOutput,
                                  watch-worktree, unwatch-worktree
    skills.js                     list-skills, open-skill-file, read-skill-file,
                                  write-skill-file, list-memory-files, list-mcp-servers,
                                  list-plugins, create-memory-file, create-skill-file
    windows-ipc.js                open-preferences, get-preferences, set-preferences,
                                  get-theme, set-theme, get-system-theme,
                                  get-about-info, get-claude-info, get-logs
    lsp.js                        lsp-start, lsp-stop, lsp-request, lsp-notify,
                                  lsp-install (thin wrappers around lsp-manager)
  bootstrap/
    app-events.js                 app.whenReady, window-all-closed, before-quit,
                                  will-quit, shutdownAndSave, saveSessions,
                                  fixSpawnPath, checkExternalCLIs,
                                  checkKlausifyInstalled, promptKlausifyInstall,
                                  runKlausifyInit, PATH-fixing magic
    menu.js                       (extract the menu building block from whenReady)
```

**Why this grouping and not fewer files:** each listed module is a coherent seam. Smaller = easier to reason about one concern. But don't over-fragment: `git.js` is intentionally one large file (~30 handlers) because they all share the same `execFileP(git, ...)` pattern and splitting by git subcommand would be silly.

## 4. Shared-state contract (CRITICAL)

State must live in exactly one module. Everything else imports. Table of truth:

| State                          | Lives in                     |
|--------------------------------|------------------------------|
| `instances` Map + `nextId`     | `main/state/instances.js`    |
| `terminalSubscribers`          | `main/state/instances.js`    |
| `allWindows`, `mainWindow`     | `main/state/windows.js`      |
| `activePrReview`, `_threadsFetchEpoch` | `main/state/pr-review.js` |
| All 8 claude proc maps         | `main/state/claude-streaming.js` |
| `logBuffer`, `LOG_*`           | `main/util/logging.js`       |
| `ghTokenCache`                 | `main/util/exec.js`          |
| `_saveConfigQueue`             | `main/util/config.js`        |
| `ciPollingIntervals`, `autoFetchIntervalId` | `main/state/ci-poll.js` |
| `worktreeWatchers`             | `main/state/watcher.js`      |
| `pendingTranscripts`           | `main/ipc/tasks.js`          |
| `isQuitting`, `_beforeQuitFlushed` | `main/bootstrap/app-events.js` |

Electron objects (`app`, `BrowserWindow`, `ipcMain`, `dialog`, `shell`, `Menu`, `nativeTheme`, `Notification`): `require('electron')` in each file that needs them.

## 5. Extraction protocol (DO NOT SKIP STEPS)

For **each module** in the order below:

1. **Read the source section** in `main.js` using the line numbers in the mapping above. Understand every outward reference (functions called, globals read).
2. **Create the new file** under `main/...`. Add `const { ... } = require('electron')` (or other deps) at the top.
3. **Move the code verbatim** into the new file. Change `function foo(` to stay as-is; add `module.exports = { foo, ... }` at the bottom.
4. **In `main.js`**:
   - Delete the moved code.
   - Add `const { foo, ... } = require('./main/...');` at the top near the other requires.
   - Fix any internal references that now need to go through the import.
5. **Syntax check**: `node --check main.js && node --check main/<new>.js` — MUST pass.
6. **Launch the app**: `npm start` in the background.
7. **Smoke-test the affected feature.** Each module below has a "verify" line — follow it.
8. **If anything breaks, revert the single commit.** Do not try to fix forward unless the break is obvious (missing require).
9. **Commit** with message `Split main.js: extract <module>` (no Claude coauthor — user preference, see memory `feedback_no_coauthor.md`).
10. **Push to origin/main.** The user wants each module visible on GitHub.

**Between modules:** update §7's progress checklist in this file, commit that separately or with the module.

**DO NOT** try to extract multiple modules in one commit. One commit per module.

## 6. Extraction order

Earlier modules have NO dependencies on later modules. Later modules can freely import earlier ones. Extract in this order:

### Phase 1 — Pure utilities (no state, no cross-dependencies)

1. **`main/util/logging.js`** — captureLog, ring, rolling file. Verify: open app, View → Logs shows entries.
2. **`main/util/path-gate.js`** — pathUnder, pathUnderAnyRoot, getRendererAllowedRoots. NOTE: `getRendererAllowedRoots` reads `instances`; until instances.js exists, accept it as a function parameter OR leave it in main.js and move in Phase 2.
3. **`main/util/exec.js`** — execFileP, ghExec, ghExecP, ghEnvForRepo + cache, sanitizeExtraEnv, runWithConcurrency, appendStderr, STDERR_CAP_BYTES. Verify: any gh-backed action (PR picker open, CI status).
4. **`main/util/config.js`** — loadConfig, saveConfig + queue, getConfigPath, migratePrReviewCache. Verify: open prefs, change theme, restart — setting persists.

### Phase 2 — State modules

5. **`main/state/windows.js`** — allWindows, mainWindow, hardenWindow, createWindow, popout creators. Verify: launch opens window; popout a task; new-window still works.
6. **`main/state/instances.js`** — HUGE file. instances Map, PTY lifecycle, terminal subscribers, idle detection, session-file helpers. Verify: create a task, kill it, restart it — orphan-shell fix from H-COR-1 must still hold.
7. **`main/state/claude-streaming.js`** — spawnClaudeStream + 8 proc maps. Verify: Cmd+K inline edit runs. Run PR AI review. Both must stream.
8. **`main/state/watcher.js`** — worktree file watcher. Verify: edit a file outside the app, diff panel auto-refreshes.
9. **`main/state/ci-poll.js`** — auto-fetch + CI polling. Verify: create a task on a CI'd branch, wait 30s, badge updates.
10. **`main/state/pr-review.js`** — activePrReview + related helpers. Verify: load a PR, refresh threads, check the Review tab, close.

### Phase 3 — IPC bundles (each imports from state + util)

11. **`main/ipc/windows-ipc.js`** — preferences, theme, about, logs, claude-info. Smallest; good warm-up. Verify: open Preferences; change theme.
12. **`main/ipc/lsp.js`** — thin wrappers around lsp-manager.js. Verify: open a .py / .ts file, LSP diagnostics appear.
13. **`main/ipc/skills.js`** — skills / memory / MCP / plugins. Verify: Cmd+K → Skills dialog lists entries.
14. **`main/ipc/files.js`** — file IPCs + watcher subscriptions. Verify: open a file in editor, save it, close it; project search works.
15. **`main/ipc/gh.js`** — gh account + CI status + open-external. Verify: PR picker shows accounts; switching account still clears `ghTokenCache`.
16. **`main/ipc/git.js`** — 30-ish git handlers. Biggest IPC module. Verify: stage / commit / push / blame / log / branches all work.
17. **`main/ipc/tasks.js`** — task lifecycle + saved sessions + transcripts. Verify: create, kill, restart, rename, duplicate a task; resume a saved session.
18. **`main/ipc/repo.js`** — project + worktree management. Verify: add / switch / remove a project.
19. **`main/ipc/claude-stream-ipc.js`** — 8 claude-streaming IPCs + explain-diff + PR_REVIEW_TEMPLATE. Verify: all streaming features one by one (inline-edit, inline-complete, explain-diff, pr-debug-check, pr-review-ai, pr-review-implement, pr-ai-review, claude-commit-message).
20. **`main/ipc/pr-review.js`** — the ~30 pr-* handlers. Verify: full PR-review flow — load PR, reply, submit review, merge, etc.

### Phase 4 — Bootstrap

21. **`main/bootstrap/menu.js`** — extract the menu template from the big `whenReady` block. Verify: menu items work (Cmd+N, Cmd+W, Cmd+Q, View → ...).
22. **`main/bootstrap/app-events.js`** — app.whenReady body, shutdownAndSave, saveSessions, before-quit, window-all-closed, fixSpawnPath, checkExternalCLIs, klausify-install helpers. Verify: quit via Cmd+Q persists sessions; relaunch resumes them.
23. **Slim `main.js`** — should now be just `require` statements + final wiring. Target ~200 lines.

## 7. Progress tracker (update as you go)

Phase 1:
- [x] main/util/logging.js
- [x] main/util/path-gate.js
- [x] main/util/exec.js
- [x] main/util/config.js

Phase 2:
- [x] main/state/windows.js
- [x] main/state/instances.js
- [x] main/state/claude-streaming.js
- [x] main/state/watcher.js
- [ ] main/state/ci-poll.js
- [ ] main/state/pr-review.js

Phase 3:
- [ ] main/ipc/windows-ipc.js
- [ ] main/ipc/lsp.js
- [ ] main/ipc/skills.js
- [ ] main/ipc/files.js
- [ ] main/ipc/gh.js
- [ ] main/ipc/git.js
- [ ] main/ipc/tasks.js
- [ ] main/ipc/repo.js
- [ ] main/ipc/claude-stream-ipc.js
- [ ] main/ipc/pr-review.js

Phase 4:
- [ ] main/bootstrap/menu.js
- [ ] main/bootstrap/app-events.js
- [ ] Slim main.js to ~200 lines

## 8. Hazards + resolutions

**Circular imports.** `state/pr-review.js` calls `spawnInWorktree` (in `state/instances.js`) via `ensureWorktreeForActivePr`. `state/instances.js` does NOT need pr-review. So pr-review imports instances, not the other way. Rule: **state/ imports util/ only; state modules never import each other, EXCEPT pr-review → instances.** If you find another state → state need, it's likely a sign the thing belongs in util or a new primitive.

**`ipc/` modules freely import `state/` and `util/`, never other `ipc/`.** If one IPC handler wants to call another, promote the shared logic to `state/` or `util/`.

**`package.json` build block** lists top-level files to ship. `main.js`, `lsp-manager.js`, `preload.js` are there. Add `main/**/*` to the `files` array after Phase 1 Step 1 so the .dmg build still works — **easy to forget; do it with the first commit.**

**Preload doesn't change.** This whole refactor is main-only.

**`build/notarize.js` doesn't change.** Packaging config stays.

**During Phase 2/3, the number of `require` statements at the top of main.js will balloon** as you add modules. That's fine; Phase 4 does not "clean that up" — main.js at the end is: requires, menu, app lifecycle, exit. The requires are the point.

## 9. If a module extraction breaks something

1. `git revert HEAD` (or `git reset --hard HEAD^` if the break was obvious and you want to retry).
2. Launch the app — confirm things work again.
3. Diagnose: was it a missing require? A stale reference to `window.foo` that should be a module import? A missed state dep?
4. Commit the fix attempt separately so the history shows the retry explicitly.

**Never fight forward when something breaks.** The whole point of one-module-per-commit is so reverts are cheap.

## 10. When everything is done

- Add a `main/README.md` that's a short tour of the module layout (30 lines max).
- Update the project memory to note the split is complete.
- Delete SPLIT_PLAN.md.
