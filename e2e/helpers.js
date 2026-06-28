// Shared e2e helpers: temp git repos, fake external binaries (agent CLI, gh,
// ollama), and a tiny ollama HTTP mock. Specs that need a mocked external
// service install a fake binary into a temp bin dir and pass it on PATH via
// the `extraEnv` fixture option (and/or seed config.json via `configSeed`).

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

// ---- temp dirs / repos ----

function tmpDir(label = 'tmp') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `klaussy-e2e-${label}-`));
}

function rm(p) {
  if (!p) return;
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

// Build a real git repo in a temp dir. `files` maps relative path -> contents.
// Returns the repo path. Always makes one initial commit on `main`.
function buildRepo(files = { 'README.md': '# r\n' }, label = 'repo') {
  const dir = tmpDir(label);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@klaussy.test');
  git('config', 'user.name', 'e2e');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

// ---- fake external binaries ----

// Create an isolated bin dir to prepend to PATH. Pass `binDir` into the launch
// env as `PATH=${binDir}:${process.env.PATH}` via the extraEnv fixture option,
// or use envWithBin().
function makeBinDir() {
  return tmpDir('bin');
}

function envWithBin(binDir, extra = {}) {
  return { PATH: `${binDir}${path.delimiter}${process.env.PATH}`, ...extra };
}

function writeExecutable(binDir, name, body) {
  const p = path.join(binDir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return p;
}

// Fake agent CLI — a POSIX sh script, NOT node. Interactive tasks spawn the
// agent via `zsh -l -c '<bin> <flags>'`; that login shell re-resolves PATH from
// profile files and on CI runners drops the node injected by setup-node, so a
// `#!/usr/bin/env node` shebang fails and the instance falls back to a plain
// shell. /bin/sh + printf/sleep have no such dependency. It ignores all flags
// and re-emits a recognizable banner (plus $FAKE_AGENT_OUTPUT) for ~3s, then
// exits — long enough that a terminal test's data subscription (attached just
// after spawn) catches the marker, short enough that passthrough AI-stream
// tests (which don't kill the process) see the stream complete, not leak.
function writeFakeAgent(binDir, name = 'claude') {
  return writeExecutable(binDir, name, `#!/bin/sh
i=0
while [ "$i" -lt 11 ]; do
  printf 'FAKE-AGENT-READY ${name}\\n'
  if [ -n "$FAKE_AGENT_OUTPUT" ]; then printf '%s\\n' "$FAKE_AGENT_OUTPUT"; fi
  i=$((i + 1))
  sleep 0.3
done
`);
}

// Fake ollama binary: just enough for which()/version/serve probes. Real
// completion traffic goes over HTTP to config.ollamaUrl (use startOllamaMock).
function writeFakeOllama(binDir) {
  return writeExecutable(binDir, 'ollama', `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('ollama version 0.0.0-fake'); process.exit(0); }
process.exit(0);
`);
}

// Fake gh CLI. Reads response fixtures from JSON at $FAKE_GH_FIXTURES and
// dispatches on the subcommand. Built-in sane defaults for auth/version/repo
// so PR flows work with a minimal fixtures file. Unknown calls exit non-zero
// with a diagnostic so a missing case is obvious in test output.
function writeFakeGh(binDir) {
  return writeExecutable(binDir, 'gh', `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let fx = {};
try { if (process.env.FAKE_GH_FIXTURES) fx = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURES, 'utf-8')); } catch {}
const out = (s) => { process.stdout.write(typeof s === 'string' ? s : JSON.stringify(s)); process.exit(0); };
const has = (...xs) => xs.every((x) => args.includes(x));
const sub = args[0];

if (sub === '--version') out('gh version 2.0.0-fake (e2e)\\n');
if (sub === 'auth' && args[1] === 'status') out('github.com\\n  Active account: true\\n  account ' + (fx.username || 'e2e-user') + '\\n');
if (sub === 'auth' && args[1] === 'token') out((fx.token || 'gho_faketoken') + '\\n');
if (sub === 'auth' && args[1] === 'switch') process.exit(0);

if (sub === 'repo' && args[1] === 'view') out(fx.repo || { nameWithOwner: 'e2e-owner/e2e-repo' });

if (sub === 'pr' && args[1] === 'list') out(fx.prList || []);
if (sub === 'pr' && args[1] === 'view') out(fx.pr || {});
if (sub === 'pr' && args[1] === 'diff') out(fx.diff || '');
if (sub === 'pr' && (args[1] === 'review' || args[1] === 'comment' || args[1] === 'merge')) process.exit(0);

if (sub === 'search' && args[1] === 'prs') out(fx.searchPrs || []);
if (sub === 'run' && args[1] === 'list') out(fx.runList || []);

if (sub === 'api') {
  // GraphQL (review threads / resolve) and REST endpoints.
  if (args.includes('graphql')) out(fx.graphql || { data: {} });
  if (args.some((a) => /check-runs/.test(a))) out(fx.checkRuns || '');
  if (args.some((a) => /\\/status$/.test(a))) out(fx.commitStatus || { statuses: [] });
  if (args.some((a) => /required_status_checks/.test(a))) out(fx.requiredChecks || { contexts: [] });
  if (args.some((a) => a === 'user' || /\\/user$/.test(a))) out(fx.user || (fx.username || 'e2e-user') + '\\n');
  out(fx.api || '{}');
}

process.stderr.write('[fake-gh] unhandled: ' + args.join(' ') + '\\n');
process.exit(1);
`);
}

// Minimal ollama HTTP mock. Implements /api/tags (probe) and /api/generate
// (fill-in-middle streaming). Returns { server, url, close } — point
// config.ollamaUrl at `url`.
function startOllamaMock({ model = 'qwen2.5-coder:1.5b', completion = ' world' } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/tags') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: model }] }));
        return;
      }
      if (req.url === '/api/generate') {
        res.setHeader('content-type', 'application/x-ndjson');
        res.write(JSON.stringify({ response: completion, done: false }) + '\n');
        res.end(JSON.stringify({ response: '', done: true }) + '\n');
        return;
      }
      if (req.url === '/api/pull') {
        res.setHeader('content-type', 'application/x-ndjson');
        res.end(JSON.stringify({ status: 'success' }) + '\n');
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// Write a gh fixtures JSON file; returns its path (set FAKE_GH_FIXTURES to it).
function writeGhFixtures(dir, fixtures) {
  const p = path.join(dir, 'gh-fixtures.json');
  fs.writeFileSync(p, JSON.stringify(fixtures, null, 2));
  return p;
}

module.exports = {
  tmpDir, rm, buildRepo, git,
  makeBinDir, envWithBin, writeExecutable,
  writeFakeAgent, writeFakeOllama, writeFakeGh, writeGhFixtures,
  startOllamaMock,
};
