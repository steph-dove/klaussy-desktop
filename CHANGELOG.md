# Changelog

All notable changes to Klaussy Desktop are documented here.

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
