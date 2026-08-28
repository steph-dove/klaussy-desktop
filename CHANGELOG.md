# Changelog

All notable changes to Klaussy Desktop are documented here.

## 0.21.1

### 🦉 Dev Loop Plan Resolution, Universal QA Media & UI Polish

- **Session Plan & Spec Discovery**: Automatically resolves implementation plans, architecture specs, and OKF inter-agent session notes from workspace roots, child repositories, and the session notes bus.
- **Universal QA Media Support**: Expanded discovery and gallery rendering to support `.gif`, `.jpg`, `.jpeg`, `.webp`, `.avif`, `.bmp`, `.mp4`, `.webm`, `.mov`, `.m4v`, and `.mkv`. Pre-commit baseline captures are preserved with an expanded timestamp window.
- **PTY Media Protocol URLs**: Real-time terminal media detection mints servable `klaussy-qa://` URLs on the fly so live artifacts render without broken tiles.
- **Streamlined Diff Tabs**: Removed the legacy Stash tab to clean up the side panel layout.
- **Default Branch Protection**: Refuses to check out the repo's default branch into a session worktree to prevent uncommitted collision.

## 0.21.0

### 🦉 9-Phase Autonomous Dev Loop ("Rest of the Owl")

- **Autonomous Dev Loop Stepper**: 9-phase lifecycle tracking: Plan ➔ Code with TDD ➔ Local Self-Review ➔ QA Proof Capture ➔ Humanized PR Creation ➔ CI Monitoring ➔ PR Review Comment Resolution.
- **Live Mini-HUD & Gallery**: Real-time status indicators in diff tabs, subtab switching for progress, designs/plans, and QA screenshots/videos.
- **Automated Permissions Management**: Grant permissions flow allowing routine dev tool commands without interrupting prompts.

## 0.20.0

### 🔍 PR Review Finding Cards & Multi-Agent Token Usage

- **AI PR Review Card & Comment Alignment**: Finding cards now display the exact concise why + suggestion that gets posted to GitHub on "Add to PR" / "Copy".
- **Expandable Explanation**: Longer multi-sentence analyses, edge cases, and reasoning from the AI are preserved in an expandable `<details>` section within the finding card.
- **Agents Panel Review Routing & Auth Fix**: Directly opening PR review tasks from the Agents panel reliably loads the PR with full URL and account credentials across GitHub organizations.
- **Token Usage Aggregation**: Unified token usage and cost metrics across Antigravity, Copilot, and OpenCode sessions.

## 0.19.0

### 🪣 Bitbucket Cloud & Data Center Pull Request Review

- **Bitbucket PR Reviewing**: Complete pull request review support for Bitbucket Cloud and self-hosted Bitbucket Data Center / Server repositories. Includes diff viewing, line commenting, discussion thread trees, thread resolution, approval, and merging.
- **Git Accounts & Multi-Tier Auth**: Manage Bitbucket App Passwords, Personal Access Tokens, and Atlassian API tokens directly in the Git Accounts modal with multi-account switching and setup dependency checks.
- **CI / Commit Status Integration**: Integrated Bitbucket commit status checks (`/statuses`) into the Checks tab mapped to Pass/Fail/Pending/Cancel buckets.
- **Worktree Lifecycle**: Branch-isolated review worktrees with automatic cross-clone discovery and non-interactive Git credential resolution.

## 0.18.1

### 🔁 Resuming a session brings back what you left

- **Every agent comes back, not just the first.** Resuming a worktree spawned all of its saved agents but handed the renderer only the first one, so the rest ran with no terminal on screen. The extras now get a terminal, and the layout switches out of single so they are visible.
- **A closed session keeps the agent it ran.** The session saver replaced the whole stored list with whatever was open at that moment, so closing one session dropped its entry while another stayed open. The worktree was then rediscovered from disk with no record of its agent and labelled Claude — a closed Copilot session resumed as Claude. Sessions now last until you delete them.
- **A second agent resumes its conversation.** Reopened agent tabs carried no session id and always started fresh. They now come back where they left off, including Antigravity, whose conversation is identified by the workspace it ran in.
- **Resume-all-inactive no longer replaces saved agents.** It attached every inactive worktree with the default agent, wiping a saved session's agents in favour of one fresh terminal.

## 0.18.0

### 🦊 GitLab Merge Request Review & CLI Integration

- **GitLab MR Reviewing**: Review Merge Requests directly in Klaussy Desktop using `glab`. Full parity with GitHub pull request reviews, including diff inspection, comments, draft reviews, and status checks.
- **PR Picker Source & Metadata Badges**: Added color-coded forge badges (GitHub, GitLab, Bitbucket), repository labels, and author IDs to the PR/MR picker list.
- **Forge CLI Error Handling & Auth**: Improved error diagnostics for missing `glab` CLI authentication and OAuth tokens.

## 0.17.1

### 🗣 Review comments say less, and errors say something true

Three fixes to what the app posts and what it tells you when GitHub says no.

- **Add-to-PR posted the whole finding.** A two-sentence reason, a
  `Suggested change:` label, and the block. It now posts one line saying what
  breaks, then the change. The label is kept only where GitHub doesn't print
  its own header — a plain fence or a prose fix — since without it those read
  as a quote of the existing code rather than the proposal.
- **An empty review took your comments down with it.** When every draft fell
  through to an issue comment (their lines weren't in the diff) and the summary
  was blank, the app posted an empty review, GitHub answered 422 with an errors
  array holding one empty string, and the early return then skipped the
  comments entirely. They were dropped, not delayed. There is no review to
  create in that case, so the comments now post on their own. Approve and
  Request changes are untouched.
- **A 404 blamed the wrong thing.** A fine-grained PAT in `GH_TOKEN` only
  reaches repositories it was granted, and GitHub answers for anything else
  with a plain 404 — so the app said the wrong account was active and pointed
  at `gh auth switch`. The account was right, and gh ignores that command while
  an env token is set. The message now names the token and offers `unset` or
  granting the repo.

## 0.17.0

### 🔏 Notes say who wrote them and whether anyone checked

Session notes carried `type` from 0.16.1 but kept hand-rolled versions of three
things OKF already defines, so a tool that wasn't ours could read the envelope
and still miss who wrote a note or whether anyone had confirmed it.

- `agent` and `provider` are now one `generated: { by, at }` key, using OKF's
  actor convention. Klaussy writes `klaussy/gemini`, the harness and the agent
  it was driving.
- Trust comes from `verified` alone. A note with no `verified` key is
  unverified, which is the right state for one an agent just wrote, and a
  `human:<id>` actor means a person checked it. Only the exception is labelled
  in the injected block, since stamping "unverified" on every note is noise an
  agent learns to skip.
- `status: deprecated` behaves like an expired note, kept in the drawer and
  withheld from prompts, so a superseded note can say so instead of waiting out
  `stale_after`.
- The frontmatter parser reads flow mappings, since OKF writes provenance as
  `{ by: x, at: y }` and an agent quotes that into valid JSON roughly never.
  Splitting each pair on its first colon leaves actors like `human:sdover`
  intact.
- The older `agent` and `provider` keys are still read, so notes already on
  disk stay valid.

Needs `klaussy-agents` 0.29.0 and `klaussy-repo-conventions` 1.9.0, which teach
the same keys to the agents writing notes by hand.

## 0.16.1

### 📎 Session notes are real OKF documents now

The notes agents leave for each other were described as [Open Knowledge
Format](https://okf.md/) documents in every repo's `CLAUDE.md` and in the
session-context skill. They were not. OKF names `type` as the only key it
actually requires, and ours carried eight fields of their own and not that one,
so nothing we wrote would have been readable as OKF by anything else.

- Notes now carry `type`, and an explicit `stale_after` expiry date alongside
  it. Klaussy fills the date in when it writes the note, since an agent has no
  idea when its own claim stops being true.
- A note that carries its own expiry is honoured on read, so a note written by
  some other tool in the same folder ages out on its own terms rather than on
  ours.
- Nothing changes for notes already sitting on disk, and nothing is deleted.

Needs `klaussy-agents` 0.28.1 and `klaussy-repo-conventions` 1.8.1, which teach
the same field to the agents writing notes by hand.

## 0.16.0

### 🔀 Agents in one session can tell each other what they did

Two agents working the same session were blind to each other. One would move a
port, change a payload shape or settle on a layout, and the other would carry on
against the old assumption — or redo the same work — because nothing carried
between them. Klaussy now gives every session a shared notes channel that any
agent can read and write.

- **Notes tab.** A new tab in the right-hand panel lists what agents in this
  session have reported: who wrote it, how long ago, the files it touches. The
  channel is shared by every repo in a session, so a note written in `api` is
  read in `web`. Notes live outside the repository, so they never dirty
  `git status` and cannot be committed by accident.
- **Klaussy writes them too.** Agents volunteer notes for changes they recognise
  — a port, a schema, a new required env var — but produce nothing for design
  and spec work, which is often the work most worth handing over. So Klaussy
  summarizes each active agent for the others every few minutes, and records a
  note whenever a session is handed to a different agent. **Capture now** in the
  drawer runs a pass immediately.
- **Summarized on your machine by default.** That summarizing runs against your
  local Ollama server, using the model already in play, so it costs nothing and
  the text never leaves your machine. An installed agent covers when Ollama is
  stopped or has only autocomplete models. Both behaviours have a switch in
  Preferences.
- **Notes are kept.** Nothing is deleted behind your back — the drawer shows
  every note with its age. Only recent ones are passed to agents as current,
  since an agent mid-task can't tell a three-week-old claim from a live one.

Agents learn the protocol from their own conventions file, so this needs
`klaussy-agents` 0.28.0 and `klaussy-repo-conventions` 1.8.0 — Klaussy will
prompt to upgrade if you are behind.

## 0.14.1

### 🪟 Local models get a context window they can actually work in

opencode running on a local Ollama model behaved as though it had no tools and
no memory — it couldn't read your repo, and it forgot the previous turn. The
cause wasn't opencode: Ollama hands local models a 4096-token window by default,
and an agent's system prompt and tool definitions alone come to roughly 11,000
tokens. The tools and the conversation were pushed out before you typed a word.

Klaussy now raises that window on the model itself, since the window can't be
set per request over the interface opencode uses. It happens when you pick a
model, when opencode starts, and once at launch — so it also covers a provider
you configured yourself in `opencode.json` without ever opening Klaussy's picker.

- **Preferences → Local Model Context Window.** `Auto` sizes the window to your
  machine's memory, so a 16GB laptop isn't handed one it can't load. Pick a
  size explicitly to pin it, including a smaller one to reclaim memory.
- **Windows and Linux fixes.** opencode's settings and sign-in files were being
  written to macOS/Linux locations that Windows never reads, so this never took
  effect there.
- **Your config is no longer overwritten.** A settings file Klaussy couldn't
  parse — a stray comma is enough — was being replaced with a blank one, which
  could discard a hand-written `opencode.json` or your other providers' saved
  sign-ins. Files that can't be read are now left alone.

## 0.14.0

### 🌙 Kimi Code — Moonshot's terminal agent, as a first-class provider

Kimi Code joins the agent roster. Pick **Kimi** for any tab, or set it as your
default under **Preferences → Default Agent**. It gets the same treatment as the
rest: worktree tabs, the New Task picker, MCP server management, skills, and the
Setup Check's install/sign-in guidance.

- **Session resume that actually resumes.** Kimi records every session against
  its working directory, so Klaussy reopens the right one for a worktree rather
  than falling back to "most recent".
- **Cross-agent handoff.** Start under Claude and resume under Kimi (or the other
  way): its TUI accepts no prompt at launch, so Klaussy pastes the handoff brief
  in once the interface is up, arriving as one block instead of line-by-line.
- **Optional unattended shell access.** Kimi edits files in a worktree on its own
  but always asks before running commands, which stops unattended jobs like CI
  fix-check from running your tests. **Preferences → "Let Kimi run shell commands
  unattended"** adds an allow rule to Kimi's own config; it's off by default, and
  unticking removes it cleanly.

Kimi tabs don't report token usage, and the Implement panel shows raw terminal
output rather than tool-by-tool progress — Kimi doesn't publish either of those
in a form Klaussy can read yet.

## 0.13.0

### 🧪 Nemesis8 Sandbox — run agents in an isolated Docker sandbox

The headline of this release: you can now run an agent inside an isolated
[Nemesis8](https://github.com/DeepBlueDynamics/nemesis8) Docker sandbox instead
of directly on your machine. Pick **Nemesis8 Sandbox** as the agent for any tab
and Klaussy runs the agent (Claude, Codex, and the others Nemesis8 supports) in a
sealed container, keeping its blast radius off your host.

- **Named gateways.** Add one or more gateways under **Preferences → Nemesis8
  Sandboxes**. Each appears in the agent picker as `Nemesis8 Sandbox: <name>`, so
  you can run, say, a Claude sandbox and a Codex sandbox side by side.
- **One-click local setup.** Klaussy opens a terminal tab that installs Nemesis8,
  signs the agent in, and starts the gateway — you just complete the sign-in.
- **Local or remote.** A localhost gateway runs against local Docker; a remote
  host is driven over the wire. The token you set is bound to the gateway command
  so the two can't drift apart.

### Features

- **Inline diff comments** — leave comments on diff lines and batch them to the
  agent in one go (#40).
- **One-click "Enable Commit Review Gate"** from the repo view (#36).
- **Live artifact preview** — a preview pane for HTML/SVG/Markdown files (#39).

### Fixes

- Keep the agent's name on a tab after its CLI exits (#41).
- Stop a restart from racing an agent PTY into a shell (#42).
- Report a failed commit-hook install honestly instead of a false success (#43).
