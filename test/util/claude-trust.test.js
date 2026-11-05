require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { claudeConfigPath, trustClaudeFolder, trustIfRepoAllowed, sawTrustPrompt } = require('../../main/util/claude-trust');

function fixture(config) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-trust-')));
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt);
  const configPath = path.join(root, '.claude.json');
  if (config !== undefined) {
    fs.writeFileSync(configPath, typeof config === 'string' ? config : JSON.stringify(config), { mode: 0o600 });
  }
  return { root, wt, configPath, read: () => JSON.parse(fs.readFileSync(configPath, 'utf-8')) };
}

test('marks the folder trusted and keeps every other key', () => {
  const f = fixture({ numStartups: 7, projects: { '/other': { hasTrustDialogAccepted: false, x: 1 } } });
  const r = trustClaudeFolder(f.wt, { configPath: f.configPath });
  assert.deepEqual(r, { trusted: true, already: false });
  const c = f.read();
  assert.equal(c.numStartups, 7);
  assert.deepEqual(c.projects['/other'], { hasTrustDialogAccepted: false, x: 1 });
  assert.equal(c.projects[f.wt].hasTrustDialogAccepted, true);
});

test('keeps existing fields on the folder entry', () => {
  const f = fixture({ projects: {} });
  const seed = f.read();
  seed.projects[f.wt] = { allowedTools: ['Bash'], hasTrustDialogAccepted: false };
  fs.writeFileSync(f.configPath, JSON.stringify(seed));
  trustClaudeFolder(f.wt, { configPath: f.configPath });
  assert.deepEqual(f.read().projects[f.wt], { allowedTools: ['Bash'], hasTrustDialogAccepted: true });
});

test('does not rewrite a config that already trusts the folder', () => {
  const f = fixture({ projects: {} });
  trustClaudeFolder(f.wt, { configPath: f.configPath });
  const before = fs.readFileSync(f.configPath, 'utf-8');
  fs.writeFileSync(f.configPath, before.replace(/\n/g, ''));
  const r = trustClaudeFolder(f.wt, { configPath: f.configPath });
  assert.deepEqual(r, { trusted: true, already: true });
  assert.equal(fs.readFileSync(f.configPath, 'utf-8'), before.replace(/\n/g, ''));
});

test('never creates a missing config', () => {
  const f = fixture();
  const r = trustClaudeFolder(f.wt, { configPath: f.configPath });
  assert.equal(r.trusted, false);
  assert.equal(fs.existsSync(f.configPath), false);
});

test('leaves an unparseable config untouched', () => {
  const f = fixture('{ not json');
  const r = trustClaudeFolder(f.wt, { configPath: f.configPath });
  assert.equal(r.trusted, false);
  assert.equal(fs.readFileSync(f.configPath, 'utf-8'), '{ not json');
});

test('keeps the file mode and leaves no temp file behind', () => {
  const f = fixture({ projects: {} });
  trustClaudeFolder(f.wt, { configPath: f.configPath });
  // Windows has no POSIX modes to keep.
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.configPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['.claude.json', 'wt']);
});

test('trusts both the symlink and the path it resolves to', () => {
  const f = fixture({ projects: {} });
  const link = path.join(f.root, 'link');
  fs.symlinkSync(f.wt, link);
  trustClaudeFolder(link, { configPath: f.configPath });
  const p = f.read().projects;
  assert.equal(p[f.wt].hasTrustDialogAccepted, true);
  assert.equal(p[link].hasTrustDialogAccepted, true);
});

test('refuses a config whose root is not an object', () => {
  const f = fixture('[1,2]');
  assert.equal(trustClaudeFolder(f.wt, { configPath: f.configPath }).trusted, false);
  assert.equal(fs.readFileSync(f.configPath, 'utf-8'), '[1,2]');
});

test('replaces a malformed projects map or entry', () => {
  const f = fixture({ keep: true, projects: [] });
  trustClaudeFolder(f.wt, { configPath: f.configPath });
  assert.equal(f.read().keep, true);
  assert.equal(f.read().projects[f.wt].hasTrustDialogAccepted, true);
  const g = fixture({ projects: {} });
  const seed = g.read();
  seed.projects[g.wt] = 'junk';
  fs.writeFileSync(g.configPath, JSON.stringify(seed));
  trustClaudeFolder(g.wt, { configPath: g.configPath });
  assert.deepEqual(g.read().projects[g.wt], { hasTrustDialogAccepted: true });
});

test('also trusts the forward-slash form of a Windows path', () => {
  const f = fixture({ projects: {} });
  trustClaudeFolder('C:\\Users\\me\\wt', { configPath: f.configPath });
  const p = f.read().projects;
  assert.equal(p['C:\\Users\\me\\wt'].hasTrustDialogAccepted, true);
  assert.equal(p['C:/Users/me/wt'].hasTrustDialogAccepted, true);
});

test('writes through a symlinked config instead of replacing the link', () => {
  const f = fixture({ projects: {} });
  const link = path.join(f.root, 'linked.json');
  fs.symlinkSync(f.configPath, link);
  trustClaudeFolder(f.wt, { configPath: link });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(f.read().projects[f.wt].hasTrustDialogAccepted, true);
});

test('claudeConfigPath honors CLAUDE_CONFIG_DIR', () => {
  assert.equal(claudeConfigPath({ CLAUDE_CONFIG_DIR: '/x/cfg' }), path.join('/x/cfg', '.claude.json'));
  assert.equal(claudeConfigPath({}), path.join(os.homedir(), '.claude.json'));
});

test('trustIfRepoAllowed writes only with stored Allow', () => {
  const calls = [];
  const trust = (wt) => { calls.push(wt); return { trusted: true }; };
  for (const consent of ['skip', null]) {
    assert.equal(trustIfRepoAllowed('/wt', { getStoredConsent: () => consent, trust }).trusted, false);
  }
  assert.deepEqual(calls, []);
  assert.equal(trustIfRepoAllowed('/wt', { getStoredConsent: () => 'allow', trust }).trusted, true);
  assert.deepEqual(calls, ['/wt']);
});

test('sawTrustPrompt spots the dialog through ANSI and missing spaces', () => {
  const drawn = '\x1b[2K\x1b[1G\x1b[36m❯\x1b[39m No,\x1b[1Cexit\r\n  Yes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder';
  assert.equal(sawTrustPrompt(drawn), true);
  assert.equal(sawTrustPrompt('Yes,Itrustthisfolder'), true);
  assert.equal(sawTrustPrompt('\x1b[1m✻ Cooked for 12s\x1b[0m Run claude --continue'), false);
  assert.equal(sawTrustPrompt(undefined), false);
});

test('sawTrustPrompt ignores the phrase once later output follows it', () => {
  const quoted = 'finding: pick "Yes, I trust this folder"\r\n' + 'x'.repeat(5000);
  assert.equal(sawTrustPrompt(quoted), false);
  const answered = 'Yes, I trust this folder' + '\x1b[2K working '.repeat(500);
  assert.equal(sawTrustPrompt(answered), false);
});
