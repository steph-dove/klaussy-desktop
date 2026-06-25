# Strategy: open-core for Klaussy

**Date:** 2026-06-24 · **Status:** proposal / thinking doc, not a commitment. Decide deliberately, not as a reaction to a competitor.

Related: [`docs/positioning.md`](../positioning.md) · [`docs/competitive/orca.md`](../competitive/orca.md)

## The question
Should the Klaussy desktop app (and `klaussy-agents`) go open-source, funded by enterprise rather than VC?

## The short answer
**Lean open — but fair-source, not MIT — and keep the governance layer paid from day one.** Open-core fits Klaussy unusually well because our moat is the part enterprises pay for, not the desktop UI.

## Why open-core fits *us* specifically
- **The moat isn't the UI.** The worktree grid / multi-pane terminal is converging — a dozen tools have it. Our defensible layer is **governance**: the commit-time review gate, conventions enforcement, multi-repo coordination, AI-tell scrubbing. That layer is *literally enterprise-shaped* (policy, compliance, audit, "prove the agent followed our rules"). It monetizes far better than Orca's moat (breadth, mobile, polish).
- **Inspectability is a feature for our category.** A tool that runs agents on your code and installs git hooks faces a real objection: "what does this do to my repo?" Open source removes it. For us, openness drives adoption rather than giving away the crown jewels.
- **It levels distribution.** We can't out-spend a funded competitor closed-source. OSS is how we compete on adoption without their funding (the GitHub-stars / community flywheel is largely OSS-gated).

## Three things that must be true (or this fails)
1. **It's a one-way door.** Can't un-open-source; forks persist. Decide once.
2. **OSS ≠ distribution.** Stars come from a *motion* (daily ships, multi-agent-hub strategy, owned X/Discord), not the license. Without that motion you get exposed code and ~50 stars — downside without upside. Commit to the motion or don't open.
3. **Enterprise revenue is slow.** Open-core money takes years + a sales motion (SSO, RBAC, audit, support). Plan runway to bridge it; "open-source and the money appears" is not real.

## License: fair-source, NOT MIT
Pure MIT/Apache (Orca's choice) lets a funded rival take the review-gate code and ship it. Given the copying concern, use a **source-available / fair-source** license: open to read, use, and self-host, but restricted from being resold as a competing hosted service — often auto-converting to full OSS after ~2–4 years.

Candidates to evaluate: **FSL** (Functional Source License, Sentry), **Sustainable Use License** (n8n), **BSL** (MariaDB/HashiCorp). Net: ~90% of the trust/adoption/inspectability benefit, minus the one risk we actually care about (wholesale lift by a funded competitor).

## The split
| Tier | What's in it | Why |
|---|---|---|
| **Open (fair-source)** | Desktop client; `klaussy-agents` engine (skills, hooks, conventions scaffolding); the review gate itself | Adoption, trust, stars, inspectability |
| **Paid (closed/licensed)** | Team review dashboards; policy & compliance enforcement; SSO/RBAC; audit logs; central conventions management; multi-repo orchestration at scale; support/SLA | This is what enterprises actually buy |

The single-developer experience is fully open and great. The moment it's a *team* enforcing standards across repos with audit/compliance needs, that's the paid line.

## Recommendation
1. Go open, **fair-source** (pick FSL or similar after a quick license review).
2. Open the desktop client + `klaussy-agents`; **gate the governance/enterprise tier closed from day one** so the business exists before the OSS takes off.
3. Only pull the trigger alongside a real distribution motion (ship cadence + multi-agent hub + owned channels).
4. Decide it as strategy on its own merits — not because a competitor annoyed us this week.

## Open questions to resolve before committing
- Which license, exactly (FSL vs SUL vs BSL — terms, OSS-conversion window)?
- Does `klaussy-agents` (already on PyPI) go fair-source too, or stay permissive for max CLI reach?
- What's the minimum enterprise feature set worth charging for at launch (likely: SSO + audit log + central review policy)?
- Bootstrapped vs raise — runway needed to reach first enterprise revenue.
