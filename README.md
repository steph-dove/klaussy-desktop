# Klaussy

Multi-terminal Claude Code worktree manager + PR reviewer for macOS, Windows, and Linux.

Klaussy spawns one git worktree + Claude Code instance per task so you can run
several agents in parallel without juggling branches in your main clone, and
turns reviewing someone else's PR into a tabbed surface (files / conversation /
checks / AI review) without needing the PR checked out locally.

> Status: pre-release. Sharing with a small group of devs to gather feedback
> before broader distribution.

## Prerequisites

Klaussy runs on **macOS 12+** (Apple Silicon or Intel), **Windows 10/11**, or
**Ubuntu 22.04+**. You'll also need **Node.js 18+**, the **GitHub CLI**, and
the **Claude Code CLI**, all authenticated. Klaussy auto-checks the CLIs on
startup and surfaces a setup dialog with copy-pasteable install commands if
anything's missing.

### macOS

```bash
brew install node gh
gh auth login
npm install -g @anthropic-ai/claude-code && claude
```

### Windows

```powershell
winget install OpenJS.NodeJS GitHub.cli
gh auth login
npm install -g @anthropic-ai/claude-code
claude
```

### Linux (Ubuntu/Debian)

```bash
sudo apt install nodejs npm gh
gh auth login
npm install -g @anthropic-ai/claude-code && claude
```

## Install (dev mode)

```bash
git clone https://github.com/steph-dove/klausify-desktop.git
cd klausify-desktop
npm install
npm start
```

The first `npm install` rebuilds `node-pty` for your Electron version and
patches the bundled Electron's `Info.plist` so the macOS menu bar shows
"Klaussy" instead of "Electron".

## Build a packaged binary

```bash
npm run dist:arm64    # macOS arm64 .dmg + .zip
npm run dist:intel    # macOS x64 .dmg + .zip
npm run dist:win      # Windows .exe (run on a Windows host)
npm run dist:linux    # Linux .AppImage + .deb (run on a Linux host)
```

Output lands in `dist/`. Cross-compiling Win/Linux from macOS is blocked by
node-gyp's no-cross-compile rule for `node-pty`, so the
`.github/workflows/build-platforms.yml` workflow runs those on native runners
— `gh workflow run build-platforms.yml -f release_tag=v<x.y.z>` to publish
straight to the feedback repo's release.

### Installing

Builds are signed and notarized — macOS uses an Apple Developer ID
certificate + `@electron/notarize` (via the `afterSign` hook in
`package.json`), and Windows is signed with an SSL.com EV certificate via
SSL.com eSigner / CodeSignTool in CI. Drag `Klaussy.app` into `/Applications`
and double-click; no quarantine workaround needed.

## Quick tour

- **Spawn a task**: click `+` in the sidebar header. Pick a name (creates a
  new branch off `dev`/`main`/`master`) or pick an existing branch from the
  dropdown to continue working on it in a fresh worktree.
- **Sidebar dirty indicators**: each task row shows staged / unstaged /
  untracked counts plus ahead/behind arrows. The `!` button filters to only
  tasks with local changes.
- **Diff panel** (`Δ`): per-task git overview with stage/unstage/discard,
  partial-line staging, commit + push, create-PR, and a selection-based
  Explain. Toggle unified ↔ split.
- **Review someone else's PR** (`PR` in the sidebar header, or Cmd+K →
  "Review Pull Request…"): paste a GitHub PR URL or pick from your active
  project's open PRs. Tabs:
  - **Files** — full diff with inline review threads + draft comment
    composer; Finish review submits everything in one round trip.
  - **Conversation** — GitHub-style feed; reply to threads or leave general
    comments inline.
  - **Checks** — CI runs grouped failures-first; Debug button on failures
    runs Claude on the failing job's logs to explain + suggest a fix.
  - **Review** — full AI review broken into per-finding cards with
    Ignore / Implement / Add to PR. Implement-all bundles open findings.
    Reviews + per-finding state persist across sessions.
- **Check out locally**: any PR review can be materialized into a worktree
  + task with one click. Auto-clones the base repo into Klaussy's user-data
  dir if you don't already have it as a project.
- **Command palette**: Cmd+K. Fuzzy search every action.
- **Pop out**: any task or PR review can be moved into its own window.

The full feature walkthrough lives in **View → How to use Klaussy** (or
Cmd+K → "How to use Klaussy") inside the app.

## Reporting bugs

File issues on the public feedback tracker:
[steph-dove/klausify-desktop-feedback](https://github.com/steph-dove/klausify-desktop-feedback/issues).
The source repo is private; this is where bug reports + feature requests land.

In-app: **View → Send feedback…** opens a pre-filled issue with version info.

When reporting:

- Klaussy version (Cmd+K → About Klaussy)
- OS and version (macOS / Windows / Linux distro)
- What you did + what you expected vs. what happened
- Logs from **Cmd+K → View Logs** if relevant

## Repo layout

- `main.js` — Electron main process (PTY spawning, git ops, IPC handlers,
  worktree watcher, gh / claude integrations).
- `preload.js` — context-isolated bridge exposing `window.klaus.*` to the
  renderer.
- `renderer/` — UI. Module-per-feature pattern (`diff-panel.js`,
  `pr-review.js`, `pr-panel.js`, `sidebar-manager.js`, etc.).
- `package.json` — `npm start` runs `electron .`.

## License

Proprietary — internal tool, not for redistribution.
