# Contributing to Klaussy Desktop

Thanks for your interest in improving Klaussy Desktop! This guide covers how to
get set up, the quality bar, and how contributions are licensed.

## Getting started

```bash
git clone https://github.com/steph-dove/klaussy-desktop.git
cd klaussy-desktop
npm install      # rebuilds node-pty for Electron; patches the menu-bar name
npm start        # launches the app
```

You'll want **Node.js 18+**, the **GitHub CLI** (`gh`), and at least one
supported agent CLI (Claude Code by default). See the README for per-OS setup.

## Before you open a PR

Run the checks the CI runs:

```bash
npm run lint     # eslint over main/, renderer/, preload.js, main.js
npm test         # unit tests (node --test test/util/*.test.js)
npm run test:e2e # Playwright e2e (optional; launches the app)
```

The repo also installs a **commit-time review gate** (the same one the product
ships) that flags silent failures, secrets, debug leftovers, and verbose
comments before a commit lands. If it blocks you on something intentional, you
can bypass with `git commit --no-verify`, but prefer fixing the finding.

## Guidelines

- **Keep PRs small and focused.** One concern per PR; describe what changed and
  why.
- **Match the surrounding code** — comment density, naming, and idioms. Comments
  should explain *why*, not *what*.
- **No secrets, ever.** A `gitleaks` scan runs in CI over the full history; keep
  credentials out of the tree (use env vars / `.env`, which is gitignored).
- **Update docs** when you change behavior a user would notice.
- For bugs and feature requests, use the
  [feedback tracker](https://github.com/steph-dove/klaussy-desktop-feedback/issues).

## License of contributions

Klaussy Desktop is source-available under the **Sustainable Use License
(SUL 1.0)** — see [`LICENSE`](LICENSE). By submitting a contribution, you agree
that:

1. Your contribution is licensed to the project under SUL 1.0 (inbound = outbound), and
2. You grant **Dovatech LLC** a perpetual, irrevocable, worldwide license to use
   and **relicense** your contribution, including under the commercial /
   enterprise terms that fund the project.

You also confirm you have the right to make the contribution (it's your own
work, or you have permission to submit it). If you're contributing on behalf of
an employer, make sure you're authorized to do so.

Thanks for helping make Klaussy better. 🐙
