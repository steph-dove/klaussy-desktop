// Publish the locally-built macOS artifacts to BOTH release repos.
//
// CI (build-platforms.yml) builds Linux + Windows and dual-publishes them to
// klaussy-desktop and klaussy-desktop-feedback. The macOS build is produced
// locally (where the signing/notarization creds live), so its artifacts have
// to be uploaded separately — this script does that to both repos in one shot,
// mirroring the workflow's create-if-missing behavior.
//
// Usage:
//   npm run dist          # signs + notarizes, writes dist/Klaussy-<v>-macOS-*
//   npm run release:mac   # uploads those to both repos for tag v<version>
//
// Auth: uses the gh CLI. Two accounts are logged in on the release machine and
// the active one drifts to a pull-only account between commands, so this
// best-effort switches to the publish owner first (see the gh-account-drift
// note). Override with RELEASE_GH_USER if the owner account is named otherwise.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const pkg = require('../package.json');
const version = pkg.version;
const tag = `v${version}`;

const owner = (pkg.build && pkg.build.publish && pkg.build.publish.owner) || 'steph-dove';
const canonicalRepo = (pkg.build && pkg.build.publish && pkg.build.publish.repo) || 'klaussy-desktop';
// Canonical home first, then the migration-bridge mirror for v0.6.0-and-earlier
// auto-updaters. Deduped in case they're ever configured to be the same repo.
const repos = [...new Set([`${owner}/${canonicalRepo}`, `${owner}/klaussy-desktop-feedback`])];

function gh(args, opts = {}) {
  return execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
}

// Collect the mac artifacts electron-builder wrote for THIS version: the dmg +
// zip (and their blockmaps) for each arch, plus the shared update feed.
const distDir = path.join(__dirname, '..', 'dist');
let files;
try {
  files = fs.readdirSync(distDir)
    .filter((f) => f === 'latest-mac.yml' || f.startsWith(`Klaussy-${version}-macOS-`))
    .map((f) => path.join(distDir, f));
} catch {
  files = [];
}

const hasFeed = files.some((f) => path.basename(f) === 'latest-mac.yml');
if (files.length === 0 || !hasFeed) {
  console.error(
    `[release:mac] No macOS artifacts for ${tag} in dist/ ` +
    `(need Klaussy-${version}-macOS-*.{dmg,zip} + latest-mac.yml).\n` +
    `Run \`npm run dist\` first.`
  );
  process.exit(1);
}

console.log(`[release:mac] ${tag} — ${files.length} files -> ${repos.join(', ')}`);

// Best-effort account-drift guard: switch gh's active account to the publish
// owner so privileged ops don't fail with "must be a collaborator". Ignored if
// that account isn't logged in (e.g. CI or a different machine).
const ghUser = process.env.RELEASE_GH_USER || owner;
try {
  gh(['auth', 'switch', '--user', ghUser]);
  const active = gh(['api', 'user', '--jq', '.login']).trim();
  console.log(`[release:mac] gh account: ${active}`);
} catch {
  console.log(`[release:mac] could not switch gh account to ${ghUser}; using current active account.`);
}

for (const repo of repos) {
  // Create-if-missing: a freshly-tagged release may have no GitHub release
  // object yet, and `gh release upload` fails with "release not found"
  // otherwise. Same guard the workflow uses.
  try {
    gh(['release', 'view', tag, '--repo', repo]);
    console.log(`[release:mac] ${repo}: release ${tag} exists`);
  } catch {
    console.log(`[release:mac] ${repo}: creating release ${tag}`);
    const notes = repo.endsWith('/klaussy-desktop-feedback')
      ? `Mirror of ${owner}/${canonicalRepo} ${tag} for auto-updaters on v0.6.0 and earlier.`
      : `Release ${tag}.`;
    gh(['release', 'create', tag, '--repo', repo, '--title', tag, '--notes', notes], { stdio: 'inherit' });
  }

  console.log(`[release:mac] ${repo}: uploading macOS artifacts…`);
  gh(['release', 'upload', tag, ...files, '--repo', repo, '--clobber'], { stdio: 'inherit' });
  console.log(`[release:mac] ${repo}: done`);
}

console.log(`[release:mac] ${tag} macOS artifacts published to all ${repos.length} repos.`);
