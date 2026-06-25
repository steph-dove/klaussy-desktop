# Klaussy Desktop

**The agent-first IDE — run a fleet of coding agents across git worktrees, and review their work before it ships.**

Klaussy Desktop spawns one git worktree + coding-agent session per task, so you can run several agents in parallel without juggling branches in your main clone. It works with **Claude Code, Codex, Gemini, GitHub Copilot, and Antigravity**, turns reviewing a GitHub PR into a tabbed surface (files / conversation / checks / AI review) without checking the PR out locally, and — uniquely — installs a **commit-time review gate** that catches silent failures, secrets, debug leftovers, and verbose comments before they land.

Under the hood it's powered by [`klaussy-agents`](https://github.com/steph-dove/klaussy-agents) (MIT), which scaffolds your repo's conventions, skills, and hooks for every supported agent. Klaussy Desktop is the surface; that engine is the spine.

## Highlights

- **Parallel agents, isolated worktrees** — one task = one worktree + one agent. Run Claude, Codex, and Gemini side by side; the sidebar shows per-task staged/unstaged/untracked counts and ahead/behind arrows.
- **Multi-repo sessions** — a session can span several repos on a shared branch, each in its own worktree, so an agent can make one coordinated change across all of them.
- **Commit-time review gate** — a pre-commit/pre-push git hook runs an agent review (silent failures · secrets · debug leftovers · correctness · excessive comments) plus your real linter, and auto-tidies verbose comments. Gates human *and* agent commits.
- **PR review without checkout** — paste a GitHub PR URL and get Files / Conversation / Checks / AI-review tabs; inline threads, one-round-trip submit, and per-finding cards with Ignore / Implement / Add to PR.
- **Conventions-aware** — `klaussy-agents` generates CLAUDE.md / AGENTS.md / GEMINI.md, namespaced skills, and cross-agent hooks (incl. pre-plan guidance) into your repos, and Klaussy injects that context into prompts.
- **Cross-agent resume** — resume a session under a different agent; Klaussy distills the prior session into a handoff brief.
- **Plan / Debug / Humanize** flows, a fuzzy command palette (Cmd+K), and pop-out windows for any task or PR review.

## Download

Prebuilt, signed + notarized builds for macOS (arm64 + x64), Windows, and Linux are published on the releases page:

➡️ **[Download the latest release](https://github.com/steph-dove/klaussy-desktop-feedback/releases/latest)**

macOS builds use an Apple Developer ID certificate + notarization; Windows is signed with an SSL.com EV certificate. Drag `Klaussy.app` into `/Applications` (macOS), or run the installer (Windows) / AppImage / `.deb` (Linux). No quarantine workaround needed.

## Prerequisites

Klaussy runs on **macOS 12+** (Apple Silicon or Intel), **Windows 10/11**, or **Ubuntu 22.04+**. You'll also need **Node.js 18+**, the **GitHub CLI**, and at least one supported agent CLI (Claude Code is the default). Klaussy auto-checks the CLIs on startup and shows a setup dialog with copy-pasteable install commands if anything's missing.

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

## Run from source

```bash
git clone https://github.com/steph-dove/klaussy-desktop.git
cd klaussy-desktop
npm install
npm start
```

The first `npm install` rebuilds `node-pty` for your Electron version and patches the bundled Electron's `Info.plist` so the macOS menu bar shows "Klaussy" instead of "Electron".

### Build a packaged binary

```bash
npm run dist:arm64    # macOS arm64 .dmg + .zip
npm run dist:intel    # macOS x64 .dmg + .zip
npm run dist:win      # Windows .exe (run on a Windows host)
npm run dist:linux    # Linux .AppImage + .deb (run on a Linux host)
```

Output lands in `dist/`. Cross-compiling Win/Linux from macOS is blocked by node-gyp's no-cross-compile rule for `node-pty`, so `.github/workflows/build-platforms.yml` runs those on native runners.

## Quick tour

- **Spawn a task**: click `+` in the sidebar header. Pick a name (creates a new branch off `dev`/`main`/`master`) or pick an existing branch to continue in a fresh worktree.
- **Diff panel** (`Δ`): per-task git overview with stage/unstage/discard, partial-line staging, commit + push, create-PR, and selection-based Explain. Toggle unified ↔ split.
- **Review someone else's PR** (`PR` in the sidebar header, or Cmd+K → "Review Pull Request…"): paste a GitHub PR URL or pick from your project's open PRs.
- **Check out locally**: any PR review can be materialized into a worktree + task with one click.
- **Command palette**: Cmd+K — fuzzy search every action.

The full walkthrough lives in **View → How to use Klaussy** (or Cmd+K → "How to use Klaussy") inside the app.

## Feedback & bugs

File issues on the feedback tracker: [steph-dove/klaussy-desktop-feedback](https://github.com/steph-dove/klaussy-desktop-feedback/issues). In-app: **View → Send feedback…** opens a pre-filled issue with version info.

When reporting, include:

- Klaussy version (Cmd+K → About Klaussy)
- OS and version (macOS / Windows / Linux distro)
- What you did + what you expected vs. what happened
- Logs from **Cmd+K → View Logs** if relevant

## Repo layout

- `main/` — Electron main process: PTY spawning, git ops, IPC handlers, worktree watcher, agent/`gh` integrations, the pre-commit review server.
- `preload.js` — context-isolated bridge exposing `window.klaus.*` to the renderer.
- `renderer/` — UI, module-per-feature (`diff-panel.js`, `pr-review.js`, `sidebar-manager.js`, …).
- `docs/` — positioning, strategy, and competitive notes.

## License

Klaussy Desktop is **source-available** under the **Sustainable Use License (SUL 1.0)** — see [`LICENSE`](LICENSE). You're free to use, modify, and self-host it for internal business, personal, and non-commercial purposes; reselling it or offering it as a paid hosted service requires a commercial license. The [`klaussy-agents`](https://github.com/steph-dove/klaussy-agents) engine is separately licensed under MIT.

© 2026 Dovatech LLC
