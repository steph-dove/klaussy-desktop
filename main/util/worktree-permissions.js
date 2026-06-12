// Per-worktree Claude permission setup for the PR-implement flow.
//
// When the user clicks Implement, we want Claude to be able to edit files
// in the PR's worktree *without* prompting Y/N for every single tool call,
// while still refusing to touch obvious secrets (.env, credentials, *.pem).
// The compromise lives in each worktree's .claude/settings.local.json:
//
//   permissions:
//     allow: [ Edit(<wt>/**), Write(<wt>/**), MultiEdit(<wt>/**), Read(<wt>/**) ]
//     deny:  [ Read(<wt>/**/.env), Edit(<wt>/**/.env), ...
//              for each secret glob × file-touching tool ]
//
// All rules are scoped to the worktree path — never to `**`. A repo
// permission set never grants access to anything outside that repo.
//
// Consent: the first time Klaussy would write settings.local.json into a
// worktree, the user sees a native dialog with three buttons:
//   * Allow for this repo  — write the file, remember 'allow' for this path
//   * Skip                 — don't write, remember 'skip' for this path
//                            (Claude will prompt per-edit in the embedded
//                            terminal — slower, but no settings file added)
//   * Allow for all repos  — write the file AND set a global flag so future
//                            repos auto-allow without re-prompting
//
// Per-repo decisions persist in user config under
//   klaussyPermissions: { allowAllRepos: bool, repoConsent: { [path]: 'allow'|'skip' } }
// Paths are normalized to forward slashes so Windows + POSIX agree.

const fs = require('fs');
const path = require('path');
const { dialog, BrowserWindow } = require('electron');
const { loadConfig, saveConfig } = require('./config');
const { baseRepoForWorktree } = require('./git-repo');

const SECRET_GLOBS = [
  // dotenv + direnv (top-level and nested)
  '.env',
  '.env.*',
  '.envrc',
  '**/.env',
  '**/.env.*',
  '**/.envrc',
  // app credentials
  '**/credentials.json',
  '**/.aws/credentials',
  '**/.npmrc',
  // PEM + private keys
  '**/*.pem',
  '**/*.key',
  '**/id_rsa',
  '**/id_ed25519',
];

const TOUCH_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit'];

// Bash command families an implement run is expected to use — pre-approved so
// the agent doesn't stop to ask for routine review/test/build/install/commit
// work. Each becomes a `Bash(<prefix>:*)` allow rule (prefix-matches the
// command line; a compound command like `x && rm -rf y` won't match a single
// prefix and still prompts). DELIBERATELY EXCLUDED so they still prompt:
// git push / reset / clean / rebase, rm, mv, chmod, sudo, npx (arbitrary
// package exec), `env`/`printenv` (bulk secret dump), and — critically — ALL
// network egress (curl, wget, nc, ssh, scp, http clients). That last exclusion
// is the secret-exfiltration backstop: even though content readers (cat/grep)
// are allowed for review, nothing can send a file off the machine without a
// prompt. The file-tool deny-list still blocks Read/Edit of .env & friends.
const BASH_ALLOW = [
  // read-only git (inspection)
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git rev-parse',
  'git ls-files', 'git remote', 'git stash list', 'git blame', 'git config --get',
  // staging + committing (NOT push/reset/clean)
  'git add', 'git commit', 'git restore --staged',
  // file inspection / listing
  'ls', 'cat', 'head', 'tail', 'find', 'grep', 'rg', 'wc', 'pwd', 'tree', 'which',
  'echo', 'sed -n', 'awk', 'sort', 'uniq', 'diff', 'stat', 'file',
  // node / js — test, lint, build, install
  'npm test', 'npm run', 'npm install', 'npm ci', 'npm exec',
  'pnpm test', 'pnpm run', 'pnpm install', 'pnpm lint', 'pnpm build', 'pnpm exec',
  'yarn test', 'yarn run', 'yarn install', 'yarn lint', 'yarn build',
  'tsc', 'eslint', 'prettier', 'vitest', 'jest',
  // python
  'pytest', 'python -m pytest', 'python3 -m pytest', 'python -m', 'python3 -m',
  'pip install', 'pip3 install', 'poetry install', 'poetry run', 'uv ',
  'ruff', 'mypy', 'black', 'flake8', 'pyright',
  // rust
  'cargo test', 'cargo check', 'cargo clippy', 'cargo build', 'cargo fmt', 'cargo add', 'cargo run',
  // go
  'go test', 'go vet', 'go build', 'go run', 'gofmt', 'golangci-lint',
  // generic build runners
  'make', 'bundle install', 'bundle exec', 'rake', 'gradle', './gradlew', 'mvn',
];

function normalizePath(p) {
  // Claude's permission glob format expects forward slashes regardless of
  // host OS. On Windows path.join produces backslashes; normalize so the
  // rule and the path stored in config stay consistent across runs.
  return String(p || '').replace(/\\/g, '/');
}

function buildRulesForWorktree(worktreePath) {
  const root = normalizePath(worktreePath);
  // File tools scoped to the worktree; Bash families pre-approved by command
  // prefix (Bash rules aren't path-scoped — the agent runs with cwd = worktree).
  const allow = [
    ...TOUCH_TOOLS.map((t) => `${t}(${root}/**)`),
    ...BASH_ALLOW.map((c) => `Bash(${c}:*)`),
  ];
  const deny = [];
  for (const tool of TOUCH_TOOLS) {
    for (const glob of SECRET_GLOBS) {
      deny.push(`${tool}(${root}/${glob})`);
    }
  }
  return { allow, deny };
}

// Consent is a per-REPO decision, not per-worktree: PR-implement worktrees are
// ephemeral (a new one per PR), so keying consent by worktree path made the
// native dialog re-appear for every PR of the same repo. Resolve the worktree
// to its base repo so one "Allow for this repo" covers all its worktrees.
function consentKeyFor(worktreePath) {
  let base;
  try { base = baseRepoForWorktree(worktreePath); } catch { base = null; }
  return normalizePath(base || worktreePath);
}

// Read the saved decision for this worktree, if any. Returns one of:
//   'allow' | 'skip' | null  (null means we haven't asked yet)
function getStoredConsent(worktreePath) {
  const config = loadConfig();
  const perms = config.klaussyPermissions || {};
  if (perms.allowAllRepos) return 'allow';
  const map = perms.repoConsent || {};
  // Keyed by repo now; fall back to a legacy worktree-path key so existing
  // decisions made before this change still count.
  const v = map[consentKeyFor(worktreePath)] ?? map[normalizePath(worktreePath)];
  return v === 'allow' || v === 'skip' ? v : null;
}

function persistConsent(worktreePath, decision, opts) {
  const norm = consentKeyFor(worktreePath);
  const config = loadConfig();
  const prev = config.klaussyPermissions || {};
  const repoConsent = { ...(prev.repoConsent || {}) };
  repoConsent[norm] = decision;
  const next = {
    ...prev,
    repoConsent,
  };
  if (opts && opts.allowAllRepos) next.allowAllRepos = true;
  saveConfig({ klaussyPermissions: next });
}

// Ask the user (native dialog) and persist the answer.
// Returns 'allow' or 'skip'. Dialog cancel maps to 'skip' but is NOT
// persisted — we want to re-ask if the user dismissed without picking.
async function askRepoConsent(worktreePath) {
  // Parent the dialog to the focused BrowserWindow when one exists so the
  // sheet attaches properly on macOS; fall back to app-modal otherwise.
  const focused = BrowserWindow.getFocusedWindow();
  const opts = {
    type: 'question',
    title: 'Set up Claude file permissions for this repo',
    message: 'Allow Klaussy to manage Claude permissions for this repo?',
    detail:
      `Klaussy will write ${path.join(worktreePath, '.claude', 'settings.local.json')} with rules that:\n\n` +
      `  • Allow Read / Edit / Write / MultiEdit inside this repo\n` +
      `  • Deny .env, .envrc, credentials, .npmrc, *.pem, *.key, etc.\n` +
      `  • Add .claude/settings.local.json to .gitignore\n\n` +
      `Without this, Claude will prompt Y/N for every file change in the embedded terminal.\n\n` +
      `Rules are scoped to this repo only — never to your full filesystem.`,
    buttons: ['Allow for this repo', 'Skip', 'Allow for all repos'],
    defaultId: 0,
    cancelId: 1,
    normalizeAccessKeys: true,
  };
  const result = focused
    ? await dialog.showMessageBox(focused, opts)
    : await dialog.showMessageBox(opts);

  // 0 = Allow, 1 = Skip (also fires on Esc), 2 = Allow for all
  if (result.response === 0) {
    persistConsent(worktreePath, 'allow');
    return 'allow';
  }
  if (result.response === 2) {
    persistConsent(worktreePath, 'allow', { allowAllRepos: true });
    return 'allow';
  }
  persistConsent(worktreePath, 'skip');
  return 'skip';
}

// Composed: stored answer if any, else prompt. Always resolves to
// 'allow' or 'skip'.
async function getOrAskRepoConsent(worktreePath) {
  const stored = getStoredConsent(worktreePath);
  if (stored) return stored;
  return askRepoConsent(worktreePath);
}

// Append .claude/settings.local.json to .gitignore if it isn't already
// excluded. We check for the exact line, the parent `.claude/`, and the
// bare `.claude` form — git treats all three as covering the file. If
// no .gitignore exists, create one.
function ensureGitignoreExcludesSettings(worktreePath) {
  const gitignorePath = path.join(worktreePath, '.gitignore');
  const wanted = '.claude/settings.local.json';
  const covers = (line) => {
    const t = line.trim();
    return t === wanted || t === '.claude/' || t === '.claude';
  };

  let existing = '';
  let hasFile = false;
  try {
    if (fs.existsSync(gitignorePath)) {
      hasFile = true;
      existing = fs.readFileSync(gitignorePath, 'utf-8');
      if (existing.split(/\r?\n/).some(covers)) return; // already covered
    }
  } catch (err) {
    console.warn('[worktree-permissions] gitignore read failed:', err.message);
    return;
  }

  // Append with a single trailing newline. Avoid double-blank lines by
  // checking what the existing file ends with.
  const needsSep = hasFile && !/\n$/.test(existing);
  const block = (hasFile ? '' : '')
    + (needsSep ? '\n' : '')
    + (hasFile ? '\n# Added by Klaussy — Claude per-repo permission overrides\n' : '# Added by Klaussy — Claude per-repo permission overrides\n')
    + wanted + '\n';
  try {
    fs.writeFileSync(gitignorePath, existing + block);
  } catch (err) {
    console.warn('[worktree-permissions] gitignore write failed:', err.message);
  }
}

// Before modifying an existing settings.local.json, drop a .bak copy
// next to it (only if no Klaussy backup is already there — we want the
// pristine pre-Klaussy state, not the most recent intermediate state).
// Best-effort; a backup failure does not block the main write.
function backupSettingsOnce(settingsPath) {
  const bakPath = settingsPath + '.klaussy-bak';
  if (fs.existsSync(bakPath)) return; // pristine backup already preserved
  try {
    fs.copyFileSync(settingsPath, bakPath);
  } catch (err) {
    console.warn('[worktree-permissions] backup failed for', settingsPath, err.message);
  }
}

// Merge our scoped allow + deny rules into the worktree's
// .claude/settings.local.json. Refuses to write if the existing file is
// malformed — overwriting could nuke hand-edited rules. Dedupes by exact
// string match. Saves a .klaussy-bak copy on first modification.
function applyWorktreePermissionsToSettings(worktreePath) {
  const claudeDir = path.join(worktreePath, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.local.json');
  const { allow, deny } = buildRulesForWorktree(worktreePath);

  let existing = {};
  const fileExisted = fs.existsSync(settingsPath);
  if (fileExisted) {
    let raw;
    try {
      raw = fs.readFileSync(settingsPath, 'utf-8');
    } catch (err) {
      throw new Error(`Failed to read ${settingsPath}: ${err.message}`);
    }
    try {
      existing = JSON.parse(raw);
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        throw new Error('not a JSON object');
      }
    } catch (err) {
      throw new Error(
        `${settingsPath} is malformed (${err.message}). Fix or remove it, then retry.`
      );
    }
  }
  if (!existing.permissions || typeof existing.permissions !== 'object' || Array.isArray(existing.permissions)) {
    existing.permissions = {};
  }
  if (!Array.isArray(existing.permissions.allow)) existing.permissions.allow = [];
  if (!Array.isArray(existing.permissions.deny)) existing.permissions.deny = [];

  let changed = false;
  for (const r of allow) {
    if (!existing.permissions.allow.includes(r)) {
      existing.permissions.allow.push(r);
      changed = true;
    }
  }
  for (const r of deny) {
    if (!existing.permissions.deny.includes(r)) {
      existing.permissions.deny.push(r);
      changed = true;
    }
  }
  if (!changed) return { changed: false };

  try { fs.mkdirSync(claudeDir, { recursive: true }); } catch (err) {
    console.warn('[worktree-permissions] mkdir failed for', claudeDir, err.message);
  }
  if (fileExisted) backupSettingsOnce(settingsPath);
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n');
  return { changed: true };
}

// Caller-facing: given consent and a worktree, write the settings file
// and update .gitignore. Returns { applied: true } or { applied: false,
// reason }. Never throws into the IPC handler.
function applyWorktreePermissions(worktreePath) {
  try {
    applyWorktreePermissionsToSettings(worktreePath);
  } catch (err) {
    return { applied: false, reason: err.message };
  }
  try {
    ensureGitignoreExcludesSettings(worktreePath);
  } catch (err) {
    // gitignore failure isn't fatal — the settings file still works
    console.warn('[worktree-permissions] gitignore step failed:', err.message);
  }
  return { applied: true };
}

module.exports = {
  getOrAskRepoConsent,
  getStoredConsent,
  applyWorktreePermissions,
  buildRulesForWorktree,
  normalizePath,
  SECRET_GLOBS,
  TOUCH_TOOLS,
};
