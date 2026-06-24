# Klaussy positioning

## The one-liner

> **Klaussy — the agent-first IDE, built on an engine that makes agents follow your repo's rules and reviews their work before it ships.**

The desktop is the **face**. `klaussy-agents` is the **spine**. Competing tools have a beautiful face with no spine.

## Origin: same day, opposite ends

Klaussy and Orca (stablyai/orca, YC, ~6.7k★) **started the same day** — `klausify` (now `klaussy-agents`) and Orca's repo were both created **2026-03-17**. We attacked the same problem from opposite ends:

- **Orca started from the runtime** — *where do the agents run?* → terminal orchestrator, worktree grid, "fleet."
- **Klaussy started from governance** — *how do agents follow my repo's rules?* → conventions, namespaced skills, cross-agent hooks, a commit-time review gate. The desktop came *after*, as a surface on top of that engine.

This isn't a copy story and it isn't a follower story. It's convergent timing on a hot category — once Claude Code / Codex / etc. existed, "parallel agents in worktrees" became the obvious shape, and a dozen teams (Orca, Conductor, Crystal, Vibe Kanban, Sculptor, …) landed on it at once. The worktree grid is now table stakes; who-had-it-first is a fight nobody remembers.

## Thesis: spine, not face

Orchestration is the part that's **commoditizing** — a dozen interchangeable worktree grids. The conventions-and-correctness layer is the part that's **hard, sticky, and unglamorous**, which is exactly why no well-funded competitor is building it. Klaussy has been building that moat from day one; the desktop is just where it became visible.

What none of the orchestrators have (see `docs/competitive/orca.md` for source-verified detail):

- **Commit-time review gate** — a 5-lens agent review + linter + comment-strip, run as git hooks, that blocks the agent's *own* bad commits.
- **Per-repo conventions scaffolding** — generates CLAUDE.md/AGENTS.md/GEMINI.md, namespaced skills, settings, and cross-agent hooks into the user's repos.
- **Multi-repo coordinated sessions** — one change across N repos on a shared branch, each its own worktree.
- **AI-tell scrubbing** — strips AI tells and AI attribution; enforces house commit conventions.

Orca, with YC fuel and ~35 agents, can say none of these.

## Where to spend (and not spend) energy

**Lean in:** push the `klaussy-agents` engine deeper (review gate, conventions, multi-repo, scrubbing), and make the desktop *showcase* it — e.g. "watch it block its own bad commit." These are the things only this architecture can do.

**Don't chase:** Orca's agent breadth (35+), mobile app, embedded browser / Design Mode / computer-use, or fleet orchestration theater. Matching those is a treadmill on their terms, on the axes where funding wins.

## Tagline options

- *The agent-first IDE that reviews its own code before you commit.*
- *The agent-first IDE that knows your repo's conventions.*
- *One change, every repo — reviewed before it ships.*

Pick whichever moat the moment calls for; keep **"agent-first IDE"** as the durable category claim (familiar noun, no acronym to teach, sidesteps Orca's coined "ADE" frame).
