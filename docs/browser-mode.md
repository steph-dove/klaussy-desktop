# Browser mode

Maussian opens from a link on the landing page and runs in a browser tab, while
everything that touches code (terminals, git, agents, language servers, files)
runs on the user's own machine in a small local helper. Nothing new runs in the
cloud, and code never leaves the machine. The desktop app stays as an optional
upgrade built on the same helper.

## Status

The phase 1 proof of concept is on `feat/browser-mode` and works end to end on
macOS: the full renderer loads in Chrome from `npm run web`, the unchanged
handlers in `main/ipc` answer it, a shell runs in a real pty, the in-page folder
picker stands in for the native one, and a shell keeps running after its tab
closes and reattaches when a tab opens again.

```sh
npm run web                 # starts the helper and opens the browser, signed in
npm run web -- --no-open    # print the link instead
npm run web -- --unpair-all # forget every paired browser, open tabs included
npm run test:web            # integration test: a real helper, every way in refused
```

## How it works

```
browser tab                      renderer/ unchanged; preload.js unchanged
  web/bridge.js                  contextBridge + ipcRenderer over a WebSocket
      │  JSON over ws://127.0.0.1:<port>/__ws, token + Origin + Host checked
      ▼
web/helper.js                    HTTP + WebSocket server, window <-> tab binding
  web/electron-shim.js           require('electron') resolves here
  main.js, main/ipc/*, main/state/*   unchanged
      ▼
node-pty, git, agent CLIs, LSP, the file system
```

- **No changes to `main/` or `renderer/`.** `helper.js` hooks module resolution
  so `require('electron')` returns `electron-shim.js`, then requires `main.js`
  as is. `ipcMain.handle` registers into a table the socket dispatches from.
- **Each tab is a virtual `BrowserWindow`.** Its `webContents.send()` writes to
  the tab's socket. A reload rebinds to the same window, the first tab takes the
  main window, and further tabs get secondary windows (closed 15 s after their
  tab goes). The main window is never closed, and `window-all-closed` is never
  emitted, so closing every tab leaves agents running.
- **The real `preload.js` runs in the page.** The helper serves it wrapped in a
  function that gets `require` and `process` from `bridge.js`. The single
  `sendSync` (`get-providers-sync`) uses a synchronous POST.
- **Dialogs are in-page.** `dialog.showMessageBox`, `showOpenDialog`,
  `showSaveDialog` and `showErrorBox` are sent to the focused tab as a request
  and answered by modals in `bridge.js`. `showMessageBoxSync` can't wait for a
  tab and takes the default button.
- **It runs under Electron's Node** (`ELECTRON_RUN_AS_NODE=1`), so `node-pty`
  keeps the ABI `electron-rebuild` built. A shipped helper bundles its own Node
  and a `node-pty` prebuilt for it instead.
- **The desktop app's userData.** One Maussian, two ways to view it: see below.

## One Maussian, two views

The browser version and the desktop app share one settings folder, so projects,
saved sessions, preferences and tokens are the same in both. The helper resolves
it exactly as `main/bootstrap/single-instance.js` does: the Klaussy folder on an
upgraded install, `-dev` when run from source (matching `npm start`), or the
installed app's folder with `npm run web -- --installed`.

Only one may run against that folder at a time. `main/util/instance-lock.js`
keeps a lock file there naming the holder (`desktop` or `web`, its pid, and the
helper's port); a holder whose process is gone is replaced.

| Starting | While running | Result |
| --- | --- | --- |
| Browser (`npm run web`) | Desktop app | Says the desktop app is running and exits; quit it first |
| Browser | Browser | Prints the running helper's link and opens it |
| Desktop app | Browser | Asks: Open in Browser · Use the Desktop App · Cancel. Using the desktop app stops the helper (it saves sessions on SIGTERM) and relaunches |
| Desktop app | Desktop app | Electron's own single-instance lock, unchanged |

`main.js` now boots inside a `boot()` function that runs only when
`browser-handoff.js` doesn't defer to the browser version. On Windows,
`process.kill(pid, 'SIGTERM')` ends the helper without its save, so the switch
there needs a real stop request (over the socket) before it ships.

The longer-term shape is still the desktop app hosting the helper itself, so a
desktop user can open the same running sessions in a browser at the same time.

## Security

A localhost process that can open shells is remote code execution for any page
that can reach it. Current checks (in `web/guards.js` and
`main/util/web-pairing.js`, unit-tested, and run against a real helper by
`npm run test:web`):

| Check | Result when it fails |
| --- | --- |
| Listens on 127.0.0.1 only | not reachable from the network |
| `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding) | HTTP 403, WebSocket refused at upgrade |
| `Origin` must be the helper's own origin | WebSocket refused at upgrade, POST 401 |
| A session ticket on `/__bind`, `/__sync` and the socket's first message, within 2 s | HTTP 401, close 4401 |
| Pairing code: one-time, 5 minutes, stored hashed | 401 |
| Sign-in: a fresh challenge (single use, 1 minute) signed by the paired key | 401 |
| An unpaired browser's open tabs | closed 4401 within 2 s |
| No request is handled before the hello; pre-hello messages capped at 4 KB, at most 8 sockets waiting | close 4401 / 1009 / 1013 |
| Malformed paths (bad %-escape, NUL, backslash) | 400, never a crash |
| Static files only from an allowlist of folders, checked after resolving symlinks | 404 |
| `/__sync` only answers `get-providers-sync` | 400 |
| The in-page folder browser lists folders inside the home folder only | error in the dialog |
| `frame-ancestors 'none'` and `X-Frame-Options: DENY` on the page | can't be framed |

**Pairing.** A browser pairs once. The helper's link carries a one-time
pairing code (32 random bytes, 5 minutes, single use, kept only as a SHA-256
hash in `<userData>/web-pair-codes.json`). The page makes an ECDSA P-256 key
with WebCrypto as non-extractable, keeps it in IndexedDB, and registers the
public half (`<userData>/web-browsers.json`). Anyone who can run `npm run web`
as this user can mint a code; nobody else can.

**Signing in.** The page asks for a challenge, signs it with that key, and gets
a session ticket. The ticket lives in the helper's memory (hashed) and the
tab's sessionStorage, so it ends with the tab or the helper, and a tab opened
with `window.open` gets a copy. After a helper restart the page signs in again
with its key, no new link needed. The app's scripts need `window.klaus` before
they run, so binding is synchronous; with no valid ticket, the page signs in
asynchronously and reloads.

What a script injected into the page could still do is use the key while the
page is open; it can't copy it out. Nothing long-lived that grants access sits
anywhere a script could read. `--unpair-all` revokes every browser, and a
running helper closes their tabs within 2 seconds. The helper prints its link
only with `--no-open`. Stop the helper with Ctrl-C or SIGTERM; it saves
sessions first.

Still to do before anyone else runs it:

- A `maussian status` command listing paired browsers, and unpairing one at a
  time.
- Review every IPC handler against "a hostile page that got paired" and confirm
  destructive actions outside a worktree in the helper.
- When the UI moves to app.maussian.ai: allow that origin, answer Chrome's local
  network access preflight for it only, deploy the UI from CI with a strict CSP
  and SRI and no third-party script.

## First-run flow (target)

1. The landing page's "Open Maussian" links to app.maussian.ai.
2. With no helper on 127.0.0.1, the page shows one card, "Connect your
   computer", with a copy button for `curl -fsSL https://maussian.ai/install | sh`
   (`brew` and `npx` behind "other ways") and a link to the trust page.
3. The install asks one question, "Start Maussian when you log in? (Y/n)", then
   opens `app.maussian.ai/#pair=<one-time token>`.
4. The open tab notices the helper and connects by itself.
5. Chrome asks once to allow local network access; the card said it would.
6. A setup checklist: git, gh sign-in, each agent CLI, with copy-to-install for
   anything missing. One agent is enough to continue.
7. Pick a repo in the helper's folder browser and start the first task.

After that, opening app.maussian.ai is the whole step. The desktop app bundles
the same helper and registers `maussian://`, so the landing page link opens it
when installed and falls back to the web otherwise.

## Trust page (target)

A public page at maussian.ai/trust, linked from the connect card, the install
script's output, the app's settings and the enterprise page. It states:

- **Files:** repos the user adds and their worktrees; `<userData>`; agent config
  files when the user adds an MCP server; git hooks when the commit gate is on.
- **Processes:** shells, git, the agent CLIs the user picks, language servers,
  Docker only for a Nemesis8 sandbox. All as the user, never root.
- **Network in:** one port on 127.0.0.1, refused to every origin but the app.
- **Network out:** forge APIs once signed in, Slack/Discord only if set up,
  update checks; a complete host list for firewall rules.
- **What Maussian receives:** an exact statement of telemetry and crash
  reporting, or "none" if that's true. Check this against the code first.
- **How to stop it:** today Ctrl-C or SIGTERM; the planned `maussian stop`,
  `unpair --all` and `uninstall` commands once the CLI exists.

Make it checkable: a Local activity panel listing processes the helper started
and paired browsers, the same events in a log file, signed builds with
checksums and an SBOM. An enterprise section covers MDM installs with a managed
config (no autostart, pinned version, allowed agents and hosts).

## Phases

1. **Proof of concept** (done): helper, shim, bridge, in-page dialogs, a shell
   in a browser tab, refusal checks.
2. **Gaps found in phase 1:**
   - Scrollback on reattach (done): each window keeps the last 256 KB of every
     terminal it shows (at most 64 terminals, least recently written dropped
     first), recorded even with no tab attached. A tab gets it once per
     terminal on its first subscribe; a page that survived a dropped connection
     gets each terminal reset and repainted on reconnect. A full-screen agent
     UI cut mid-stream relies on the redraw that follows the reattach resize.
   - Pop-outs as tabs (done): when main/ opens a window (task pop-out, PR
     review pop-out, Preferences, New Window), the helper asks the tab in use
     to open a tab for it, signed in and bound to that window by id. It follows
     the click, so popup blockers allow it; if one doesn't, the tab offers a
     button. main/ closing the window ("Pop in") closes the tab, and a closed
     pop-out tab reads as closed in the app after 4 s. A pop-out starts from
     the terminal history another window recorded. The PR review pop-out is
     untested end to end (it needs a live PR review).
   - `klaussy-voice:` and `klaussy-qa:` schemes have no browser equivalent yet;
     serve them as helper routes.
   - Browser-reserved shortcuts (Cmd+W/T/N) need remapping outside an installed
     web app.
   - Run the Playwright e2e suite against the web build.
3. **Pairing and security hardening** (pairing, sign-in and the integration
   test done; the rest of the list above still open).
4. **Install and returning users:** self-contained helper builds, curl/brew/npx,
   autostart, `maussian` CLI, version handshake, trust page, Safari fallback.
5. **Launch:** hosted UI at app.maussian.ai, `maussian://` handoff to desktop,
   PR review before install, first-run testers.

## Risks

| Risk | Mitigation |
| --- | --- |
| Safari blocks the hosted page from reaching localhost | the helper opens its own localhost URL in Safari |
| Chrome's local network prompt alarms people | warn first on the connect card; a recovery screen |
| app.maussian.ai compromised drives every paired helper | CI-only deploys, strict CSP + SRI, helper-side confirmation of destructive actions |
| Endpoint security flags a new localhost listener | signed binaries, documented port, the trust page, MDM config |
| Web and desktop drift | one handler set; web e2e in CI |
| A new Electron API in `main/` that the shim lacks | the helper fails loudly at startup; add it to the shim |
