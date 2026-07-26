# Changelog

All notable changes to Klaussy Desktop are documented here.

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
