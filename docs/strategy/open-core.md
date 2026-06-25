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

## License: asymmetric — desktop SUL, CLI stays MIT
The two repos start in opposite places, so they get opposite treatment.

**klaussy-desktop → Sustainable Use License (SUL 1.0).** *(Decided. Applied: [`/LICENSE`](../LICENSE).)* It was proprietary (`UNLICENSED`, draft EULA), so going source-available is *loosening* — clean and additive. SUL permits internal-business, personal, and non-commercial use and self-hosting, but bars reselling/hosting it as a paid offering — which covers our real threat (a funded rival lifting the product) without the friction of OSI compliance. We chose SUL over FSL/BSL because it has **no time-bomb conversion** (FSL → OSS in 2y, BSL → OSS in ≤4y): we keep control of the product indefinitely, which fits a closed→source-available move where the goal is protection, not eventual hand-off. (FSL's faster OSS conversion is the better *community-goodwill* play; we traded that for durable control.)

**klaussy-agents → keep MIT.** It's already MIT and published on PyPI, and we are sole copyright holder (Dovatech LLC, no external contributors). Tightening it would be the wrong move — and the instinct to "protect the most important repo hardest" is exactly the trap:
- **SUL would protect almost nothing.** Every MIT version already on PyPI (skills, hooks, conventions engine, review lenses — all the work) stays MIT and forkable forever. Relicensing only touches *future* additions: full cost, marginal protection. You can't relicense the past.
- **"Most important" is the argument FOR MIT.** klaussy-agents is important *because it's the funnel*, not a vault — every `klaussy init` seeds a future customer. The more strategically central it is, the more reach matters, the more MIT matters. Protection and value point opposite ways here.
- **A CLI is consumed as a *dependency* — SUL punishes adopters, not the competitor.** It lands in CI, pre-commit hooks, other tools, corporate dev envs, where non-OSI licenses trip legal review and get policy-banned. A determined competitor just forks the MIT 0.5.x or reimplements a scaffolder in a weekend; the enterprise that *would* have adopted it can't. You deter your friends, not your enemy.
- **Relicensing a published, community CLI away from MIT spawns hostile forks** (HashiCorp → OpenTofu; Redis → Valkey, AWS/Google-backed). That can birth a competitor-funded fork that out-distributes the original — the opposite of protection.
- **The asymmetry IS the strategy.** Permissive funnel (MIT CLI) → restricted product (SUL desktop) → paid enterprise. SUL-ing both collapses the funnel into the moat and kills the adoption engine that makes the moat worth anything.

This is the standard open-core shape, not a compromise: **permissive CLI/SDK for adoption, restricted license on the product.** The way to honor the work in klaussy-agents is to make it the standard, not to fence it — reach is the payoff; the moat is downstream.

**Rule going forward:** author any genuinely proprietary / differentiated review logic in the **desktop** (SUL), not the MIT CLI. Keep the CLI's review bits at "good, replicable defaults." That satisfies the protection instinct without poisoning the funnel.

## The split
| Tier | What's in it | License | Why |
|---|---|---|---|
| **CLI / engine** | `klaussy-agents` — skills, hooks, conventions scaffolding, default review lenses | **MIT** | Top-of-funnel; maximize reach + standard status |
| **Product** | Desktop client + the integrated review gate | **SUL 1.0** | The monetizable surface; protect from wholesale lift |
| **Paid** | Team review dashboards; policy & compliance enforcement; SSO/RBAC; audit logs; central conventions management; multi-repo orchestration at scale; support/SLA | Closed/commercial | What enterprises actually buy |

The single-developer experience is fully open and great. The moment it's a *team* enforcing standards across repos with audit/compliance needs, that's the paid line.

## Recommendation
1. **Desktop → SUL 1.0** *(applied — [`/LICENSE`](../LICENSE))*. **`klaussy-agents` → stays MIT.**
2. **Gate the governance/enterprise tier closed from day one** so the business exists before the OSS takes off.
3. Only pull the trigger alongside a real distribution motion (ship cadence + multi-agent hub + owned channels).
4. Author proprietary review logic in the desktop, not the MIT CLI.
5. Decide it as strategy on its own merits — not because a competitor annoyed us this week.

## Open questions to resolve before committing
- What's the minimum enterprise feature set worth charging for at launch (likely: SSO + audit log + central review policy)?
- Bootstrapped vs raise — runway needed to reach first enterprise revenue.
- Legal sanity-check of the applied SUL (trademark handling, interaction with the retained EULA draft for the commercial tier).

**Resolved:**
- `klaussy-agents` stays **MIT** (already MIT-published; CLI reach > marginal protection; moat is the product, not the scaffolder).
- Desktop license is **SUL 1.0** — chosen over FSL/BSL for durable control (no time-bomb OSS conversion). Applied at [`/LICENSE`](../LICENSE); the proprietary EULA draft is retired as the operative license and retained only for future commercial terms.
