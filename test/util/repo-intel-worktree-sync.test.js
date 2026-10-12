require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { syncIntelIntoWorktree, syncSkillsIntoWorktree } = require('../../main/state/repo-intel');

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

function writeSkill(root, version, body) {
  const dir = path.join(root, '.claude', 'skills');
  fs.mkdirSync(path.join(dir, 'acme-review'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'acme-review', 'SKILL.md'), body);
  if (version) fs.writeFileSync(path.join(dir, '.klaussy-version'), `${version}\n`);
}

const wtSkill = (worktree) => fs.readFileSync(path.join(worktree, '.claude', 'skills', 'acme-review', 'SKILL.md'), 'utf-8');

// copyMissing never overwrote, so a worktree kept its first skills forever and a
// PR review ran a skill several klaussy releases old.
test('skills from an older klaussy are replaced when the base has a newer version', () => {
  const { base, worktree } = makeBaseAndWorktree();
  writeSkill(worktree, '0.36.1', 'old single-pass review\n');
  writeSkill(base, '0.38.0', 'new parallel review\n');
  fs.writeFileSync(path.join(base, '.claude', 'skills', 'acme-review', 'parallel.md'), 'lenses\n');

  syncIntelIntoWorktree(worktree);

  assert.equal(wtSkill(worktree), 'new parallel review\n');
  assert.ok(fs.existsSync(path.join(worktree, '.claude', 'skills', 'acme-review', 'parallel.md')));
  assert.equal(fs.readFileSync(path.join(worktree, '.claude', 'skills', '.klaussy-version'), 'utf-8').trim(), '0.38.0');
});

test('skills with no version stamp count as older than the base', () => {
  const { base, worktree } = makeBaseAndWorktree();
  writeSkill(worktree, null, 'pre-stamp skill\n');
  writeSkill(base, '0.38.0', 'new parallel review\n');

  syncIntelIntoWorktree(worktree);

  assert.equal(wtSkill(worktree), 'new parallel review\n');
});

test('skills on the same klaussy version keep local edits', () => {
  const { base, worktree } = makeBaseAndWorktree();
  writeSkill(base, '0.38.0', 'generated\n');
  writeSkill(worktree, '0.38.0', 'hand-edited in this worktree\n');

  syncIntelIntoWorktree(worktree);

  assert.equal(wtSkill(worktree), 'hand-edited in this worktree\n');
});

test('a skill file the repo commits is never replaced', () => {
  const { base, worktree } = makeBaseAndWorktree();
  writeSkill(worktree, '0.36.1', 'committed skill\n');
  execFileSync('git', ['add', '-f', '.claude/skills/acme-review/SKILL.md'], { cwd: worktree, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'commit a skill'], { cwd: worktree, stdio: 'pipe' });
  writeSkill(base, '0.38.0', 'new parallel review\n');

  syncIntelIntoWorktree(worktree);

  assert.equal(wtSkill(worktree), 'committed skill\n');
});

test('a PR checkout gets newer skills without the base .env or settings', () => {
  const { base, worktree } = makeBaseAndWorktree();
  writeSkill(worktree, '0.36.1', 'old single-pass review\n');
  writeSkill(base, '0.38.0', 'new parallel review\n');
  fs.writeFileSync(path.join(base, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(base, '.claude', 'settings.json'), '{}\n');

  syncSkillsIntoWorktree(worktree);

  assert.equal(wtSkill(worktree), 'new parallel review\n');
  assert.ok(!fs.existsSync(path.join(worktree, '.env')), '.env must not be linked into a PR checkout');
  assert.ok(!fs.existsSync(path.join(worktree, '.claude', 'settings.json')));
});

test('a refresh that fails partway keeps the old stamp so the next sync retries', () => {
  const { base, worktree } = makeBaseAndWorktree();
  writeSkill(base, '0.38.0', 'new parallel review\n');
  const wtSkills = path.join(worktree, '.claude', 'skills');
  fs.mkdirSync(wtSkills, { recursive: true });
  fs.writeFileSync(path.join(wtSkills, '.klaussy-version'), '0.36.1\n');
  // A file where the base has a directory makes the copy throw mid-walk.
  fs.writeFileSync(path.join(wtSkills, 'acme-review'), 'not a directory\n');

  syncIntelIntoWorktree(worktree);

  assert.equal(fs.readFileSync(path.join(wtSkills, '.klaussy-version'), 'utf-8').trim(), '0.36.1');
});
