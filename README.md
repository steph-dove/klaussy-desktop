# <img src="brand-mark.png" width="32" height="32" align="absmiddle" alt="Klaussy Logo"> Klaussy Workspace

**The agent-first IDE that reviews its own code before you commit.**

[![GitHub stars](https://img.shields.io/github/stars/steph-dove/klaussy-desktop?style=social)](https://github.com/steph-dove/klaussy-desktop/stargazers)

> **The desktop is the face. The [`klaussy-agents`](https://github.com/steph-dove/klaussy-agents) engine is the spine.** While other orchestrators give you a worktree grid, Klaussy brings the conventions, custom skills, and active git-level guardrails that actually keep agents aligned with your codebase.

Designed by an ex-GitHub, ex-Twitch, and ex-Microsoft engineer, Klaussy Desktop runs multi-agent, multi-repository AI coding sessions in a unified, tabbed light-themed workspace. It spawns isolated Git worktrees per task, enabling you to run multiple agents in parallel without juggling branches, staging mess, or local workspace clutter.

---

## 🚀 Key Highlights

*   **⚡ Parallel Agents, Isolated Worktrees**
    One task = one git worktree + one independent agent. Run Claude Code, Codex, Gemini, Copilot, Cursor, and Cline side by side. The visual sidebar tracks staged/unstaged counts, status, and branch alignment per task.
*   **📂 Multi-Repo Git Sessions**
    Coordinate changes across multiple microservices or repositories on a shared task branch. Each repository spins up its own isolated worktree so agents can safely collaborate.
*   **🛡️ Commit-Time Review Gate**
    A built-in pre-commit and pre-push hook runs an agent-powered audit looking for silent failures, leaked credentials, debug leftovers, correctness bugs, and overly verbose comments. Auto-tidies code before committing.
*   **🔍 PR Reviews Without Local Checkout**
    Paste a GitHub Pull Request URL to view files, commit history, checks, and AI review tabs. Instantly materializes any review into a local worktree for editing with one click.
*   **🔄 Cross-Agent Session Resuming**
    Start a session with Claude Code, pause it, and resume it under Gemini, Cursor, or Cline. Klaussy Desktop automatically compiles a structured handoff brief to catch the new agent up.
*   **🛠️ Workflow-Oriented Tools**
    Fuzzy command palette (`Cmd+K`), pop-out task windows, and built-in flows for planning, debugging, and humanizing prose.

---

## 📦 Download & Install

Prebuilt, signed, and notarized binaries are available for macOS, Windows, and Linux. Free for individual use — no account or access key required.

➡️ **[Download the Latest Release](https://github.com/steph-dove/klaussy-desktop/releases/latest)** &nbsp;|&nbsp; **[★ Star this Repo](https://github.com/steph-dove/klaussy-desktop)** &nbsp;|&nbsp; 💬 **[Join the Discord](https://discord.gg/ZxNhsuMyYu)**

*   **macOS:** signed + notarized using Apple Developer ID. Drag `Klaussy.app` to `/Applications`.
*   **Windows:** signed with an EV Code Signing certificate. Run the installer.
*   **Linux:** AppImage, `.deb`, and `.tar.gz` packages are provided.

---

## 📸 In Action

**Multi-agent, multi-repo workspace** — run agents side by side, each in its own worktree, with a live file tree and editor.

![Multi-agent, multi-repo workspace](./docs/klaussy_multi_agent_workspace.png)

**Conventions-aware PR review** — paste a pull request and get a structured AI review: findings ranked by severity, suggested changes, and one-click Implement / Add to PR.

![AI-powered PR review with structured findings](./docs/klaussy_pr_ai_review.png)

**CI debugging built in** — when a check fails, Klaussy pulls the logs and an agent explains the root cause and proposes a concrete fix without leaving the app.

![Agent-assisted CI failure debugging](./docs/klaussy_ci_debug.png)

**Inline CI annotations** — failures and warnings are surfaced with their stack frames right in the CI View tab.

![Inline CI annotations and failure stack frames](./docs/klaussy_ci_annotations.png)

---

## 📋 Prerequisites

Klaussy Desktop automatically detects and configures your local environment. It requires:
1.  **Node.js 18+**
2.  **GitHub CLI (`gh`)** (with active authentication)
3.  **An Agent CLI or IDE extension** (Claude Code is the default, supports Codex, Gemini, Copilot, Cursor, and Cline)

### Setup Commands

#### macOS
```bash
brew install node gh
gh auth login
npm install -g @anthropic-ai/claude-code && claude
```

#### Windows
```powershell
winget install OpenJS.NodeJS GitHub.cli
gh auth login
npm install -g @anthropic-ai/claude-code
claude
```

#### Linux
```bash
sudo apt install nodejs npm gh
gh auth login
npm install -g @anthropic-ai/claude-code && claude
```

---

## 🛠️ Developer Setup (Run from Source)

If you'd like to build or modify the desktop client locally:

```bash
git clone https://github.com/steph-dove/klaussy-desktop.git
cd klaussy-desktop
npm install
npm start
```

### Packaging Binaries

```bash
npm run dist:arm64    # macOS Apple Silicon DMG
npm run dist:intel    # macOS Intel DMG
npm run dist:win      # Windows executable (requires Windows host)
npm run dist:linux    # Linux AppImage + DEB (requires Linux host)
```

---

## 📂 Repository Architecture

*   [`main/`](file:///Users/stephaniedover/projects/klaussy-desktop/main): Electron main process. Manages PTY terminals, file watching, git worktrees, and the pre-commit review server.
*   [`preload.js`](file:///Users/stephaniedover/projects/klaussy-desktop/preload.js): Context-isolated IPC bridge.
*   [`renderer/`](file:///Users/stephaniedover/projects/klaussy-desktop/renderer): Tailwind-free vanilla CSS/JS UI components (`diff-panel.js`, `pr-review.js`).
*   [`docs/`](file:///Users/stephaniedover/projects/klaussy-desktop/docs): Engineering design docs, competitive analysis, and positioning strategies.

---

## ⚖️ License & Attribution

Klaussy Desktop is source-available under the **Sustainable Use License (SUL 1.0)**. You can run, modify, and self-host the software for personal, non-commercial, and internal business use. Reselling or offering Klaussy Desktop as a paid hosted service requires a commercial license.

The underlying generator engine, [`klaussy-agents`](https://github.com/steph-dove/klaussy-agents), is open-source under the MIT license.

© 2026 Dovatech LLC
