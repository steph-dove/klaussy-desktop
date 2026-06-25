# Strategy: open-core for Klaussy

**Date:** 2026-06-24 · **Status:** proposal / thinking doc, not a commitment. Decide deliberately, not as a reaction to a competitor.

Related: [`docs/positioning.md`](../positioning.md) · [`docs/competitive/orca.md`](../competitive/orca.md)

## The question
Should the Klaussy desktop app (and `klaussy-agents`) go open-source, funded by enterprise rather than VC?

## The short answer
**Lean open, asymmetrically: the desktop goes fair-source, `klaussy-agents` stays MIT, and the governance layer is paid from day one.** Open-core fits Klaussy unusually well because our moat is the part enterprises pay for, not the desktop UI.

## Why open-core fits *us* specifically
- **The moat isn't the UI.** The worktree grid / multi-pane terminal is converging — a dozen tools have it. Our defensible layer is **governance**: the commit-time review gate, conventions enforcement, multi-repo coordination, AI-tell scrubbing. That layer is *literally enterprise-shaped* (policy, compliance, audit, "prove the agent followed our rules"). It monetizes far better than Orca's moat (breadth, mobile, polish).
- **Inspectability is a feature for our category.** A tool that runs agents on your code and installs git hooks faces a real objection: "what does this do to my repo?" Open source removes it. For us, openness drives adoption rather than giving away the crown jewels.
- **It levels distribution.** We can't out-spend a funded competitor closed-source. OSS is how we compete on adoption without their funding (the GitHub-stars / community flywheel is largely OSS-gated).

## Three things that must be true (or this fails)
1. **It's a one-way door.** Can't un-open-source; forks persist. Decide once.
2. **OSS ≠ distribution.** Stars come from a *motion* (daily ships, multi-agent-hub strategy, owned X/Discord), not the license. Without that motion you get exposed code and ~50 stars — downside without upside. Commit to the motion or don't open.
3. **Enterprise revenue is slow.** Open-core money takes years + a sales motion (SSO, RBAC, audit, support). Plan runway to bridge it; "open-source and the money appears" is not real.

## License: asymmetric — desktop fair-source, CLI stays MIT
The two repos start in opposite places, so they get opposite treatment.

**klaussy-desktop → fair-source.** It's currently proprietary (`UNLICENSED`, draft EULA), so going fair-source is *loosening* — clean and additive, no downside. Pure MIT/Apache (Orca's choice) would let a funded rival lift the product wholesale; a **source-available / fair-source** license is open to read, use, and self-host but restricted from being resold as a competing hosted service (often auto-converting to OSS after ~2–4 years). Candidates: **FSL** (Functional Source License, Sentry), **Sustainable Use License** (n8n), **BSL** (MariaDB/HashiCorp). ~90% of the trust/adoption benefit, minus the one risk we care about.

**klaussy-agents → keep MIT.** It's already MIT and published on PyPI through 0.5.1, and we are sole copyright holder (Dovatech LLC, no external contributors). Tightening it now is the wrong move:
- **The horse is out.** Every MIT version already on PyPI (skills, hooks, conventions engine, review lenses) stays MIT and forkable forever. Relicensing only protects *future* additions — full friction cost for partial protection.
- **A CLI's job is reach.** It's the top-of-funnel scaffolder; we want it embedded and treated as a standard. Non-OSI licenses get flagged by enterprise compliance and chill adoption — the opposite of what a funnel needs.
- **Relicensing published MIT reads as a rug-pull** (cf. HashiCorp → OpenTofu, Redis). Opening a *closed* app carries none of that; tightening an *open* one does.
- **The scaffolder isn't the moat.** The moat is integrated commit-time enforcement + the desktop + enterprise governance + brand. Lens prompt text isn't defensible (Orca already ships similar comment-hygiene lenses).

This is the standard open-core shape, not a compromise: **permissive CLI/SDK for adoption, restricted license on the product.**

**Rule going forward:** author any genuinely proprietary / differentiated review logic in the **desktop** (fair-source), not the MIT CLI. Keep the CLI's review bits at "good, replicable defaults."

## The split
| Tier | What's in it | License | Why |
|---|---|---|---|
| **CLI / engine** | `klaussy-agents` — skills, hooks, conventions scaffolding, default review lenses | **MIT** | Top-of-funnel; maximize reach + standard status |
| **Product** | Desktop client + the integrated review gate | **Fair-source** | The monetizable surface; protect from wholesale lift |
| **Paid** | Team review dashboards; policy & compliance enforcement; SSO/RBAC; audit logs; central conventions management; multi-repo orchestration at scale; support/SLA | Closed/commercial | What enterprises actually buy |

The single-developer experience is fully open and great. The moment it's a *team* enforcing standards across repos with audit/compliance needs, that's the paid line.

## Recommendation
1. **Desktop → fair-source** (pick FSL or similar after a quick license review). **`klaussy-agents` → stays MIT.**
2. **Gate the governance/enterprise tier closed from day one** so the business exists before the OSS takes off.
3. Only pull the trigger alongside a real distribution motion (ship cadence + multi-agent hub + owned channels).
4. Author proprietary review logic in the desktop, not the MIT CLI.
5. Decide it as strategy on its own merits — not because a competitor annoyed us this week.

## Open questions to resolve before committing
- Which fair-source license for the desktop, exactly (FSL vs SUL vs BSL — terms, OSS-conversion window)?
- What's the minimum enterprise feature set worth charging for at launch (likely: SSO + audit log + central review policy)?
- Bootstrapped vs raise — runway needed to reach first enterprise revenue.

**Resolved:** `klaussy-agents` stays MIT (already MIT-published; CLI reach > marginal protection; moat is the product, not the scaffolder). Only the desktop goes fair-source.
