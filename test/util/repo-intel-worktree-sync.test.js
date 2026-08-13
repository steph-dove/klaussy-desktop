require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { syncIntelIntoWorktree } = require('../../main/state/repo-intel');

// The conventions docs are generated and git-excluded, so the worktree starts
// without any of them.
function makeBaseAndWorktree() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'intel-base-')));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(base, 'init', '-q');
  git(base, 'config', 'user.email', 'test@example.com');
  git(base, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(base, 'README.md'), 'hi\n');
  git(base, 'add', '-A');
  git(base, 'commit', '-qm', 'init');

  const worktree = path.join(path.dirname(base), `${path.basename(base)}-wt`);
  git(base, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  return { base, worktree };
}

const DOCS = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];

// Syncing only CLAUDE.md left every non-Claude agent in a worktree with no
// conventions at all.
test('every agent\'s conventions doc reaches the worktree', () => {
  const { base, worktree } = makeBaseAndWorktree();
  for (const doc of DOCS) fs.writeFileSync(path.join(base, doc), `# ${doc}\n\nprotocol here\n`);

  syncIntelIntoWorktree(worktree);

  for (const doc of DOCS) {
    assert.ok(fs.existsSync(path.join(worktree, doc)), `${doc} missing from worktree`);
    assert.match(fs.readFileSync(path.join(worktree, doc), 'utf-8'), /protocol here/);
  }
});

test('a stale generated doc is refreshed from the base', () => {
  const { base, worktree } = makeBaseAndWorktree();
  for (const doc of DOCS) {
    fs.writeFileSync(path.join(base, doc), 'old\n');
    fs.writeFileSync(path.join(worktree, doc), 'old\n');
  }
  // The base regenerates — e.g. a klaussy-repo-conventions upgrade.
  for (const doc of DOCS) fs.writeFileSync(path.join(base, doc), 'new protocol\n');

  syncIntelIntoWorktree(worktree);

  for (const doc of DOCS) {
    assert.equal(fs.readFileSync(path.join(worktree, doc), 'utf-8'), 'new protocol\n', doc);
  }
});

test('a committed conventions doc is left alone', () => {
  const { base, worktree } = makeBaseAndWorktree();
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  fs.writeFileSync(path.join(worktree, 'CLAUDE.md'), 'hand written\n');
  git(worktree, 'add', 'CLAUDE.md');
  git(worktree, 'commit', '-qm', 'docs: own conventions');
  fs.writeFileSync(path.join(base, 'CLAUDE.md'), 'generated\n');

  syncIntelIntoWorktree(worktree);

  assert.equal(fs.readFileSync(path.join(worktree, 'CLAUDE.md'), 'utf-8'), 'hand written\n');
});
