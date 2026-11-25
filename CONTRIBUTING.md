# Contributing to Maussian Desktop

Thanks for your interest in improving Maussian Desktop! This guide covers how to
get set up, the quality bar, and how contributions are licensed.

## Getting started

```bash
git clone https://github.com/steph-dove/klaussy-desktop.git
cd klaussy-desktop
npm install      # rebuilds node-pty for Electron; patches the menu-bar name
npm start        # launches the app
```

You'll want **Node.js 24+**, the **GitHub CLI** (`gh`), and at least one
supported agent CLI (Claude Code by default). See the README for per-OS setup.

## Before you open a PR

Nothing runs in GitHub Actions, so run the checks yourself:

```bash
npm run lint     # eslint over main/, renderer/, preload.js, main.js
npm test         # unit tests (node --require ./test/setup.js --test test/util/*.test.js)
npm run secrets  # gitleaks over the full history (brew install gitleaks)
npm run test:e2e # Playwright e2e (optional; launches the app)
npm run test:e2e:affected  # only the e2e specs your branch can affect
```

The full e2e suite takes about 40 minutes. `test:e2e:affected` looks at what
changed since your branch left `origin/main` (uncommitted and untracked work
included) and runs only the specs that change can reach: from a changed IPC
handler to the `window.klaus` API that calls it, the renderer code using that
API, and the specs touching that UI. It prints why it picked each spec.

```bash
npm run test:e2e:affected -- --list              # show the choice, run nothing
npm run test:e2e:affected -- --base my-branch    # compare with another ref
npm run test:e2e:affected -- --all               # run the whole suite anyway
npm run test:e2e:affected -- -- --reporter=line  # after a second --, args go to Playwright
```

It runs everything for a change to `main.js`, startup code, CSS, the e2e
fixtures or config, a deleted app file, a file it has no rule for, or a
`preload.js` change it can't map to channels. Docs, unit tests, `web/` (browser
mode, covered by `npm run test:web`) and packaging run nothing. A changed file no
spec reaches is listed: unit tests are the check for those.

To screenshot the app as it is (for a plan or a PR), `npm run screenshot` boots it
the way the e2e tests do, skips the first-run Setup check, opens a repo in the
Files tab and saves a PNG. Without `--repo` it uses a small sample repo, and
`--right-click PATH` opens the menu of a top-level tree row (`src`, `README.md`)
first. With no display, run it under `xvfb-run -a`. For other screens,
`require('./scripts/screenshot').launch()` gives you the app with that setup done.
Run on your own machine, the sidebar still lists your real sessions and usage, so
crop the shot before you share it.

```bash
npm run screenshot -- --out shots/tree.png
npm run screenshot -- --out shots/menu.png --repo ~/code/app --right-click src
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
- **No secrets, ever.** `npm run secrets` scans the full history with `gitleaks`; keep
  credentials out of the tree (use env vars / `.env`, which is gitignored).
- **Update docs** when you change behavior a user would notice.
- For bugs and feature requests, use the
  [feedback tracker](https://github.com/steph-dove/klaussy-desktop-feedback/issues).

## License of contributions

Maussian Desktop is source-available under the **Sustainable Use License
(SUL 1.0)** — see [`LICENSE`](LICENSE). By submitting a contribution, you agree
that:

1. Your contribution is licensed to the project under SUL 1.0 (inbound = outbound), and
2. You grant **Dovatech LLC** a perpetual, irrevocable, worldwide license to use
   and **relicense** your contribution, including under the commercial /
   enterprise terms that fund the project.

You also confirm you have the right to make the contribution (it's your own
work, or you have permission to submit it). If you're contributing on behalf of
an employer, make sure you're authorized to do so.

Thanks for helping make Maussian better. 🐙
