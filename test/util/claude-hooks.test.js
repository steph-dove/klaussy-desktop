require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hooks = require('../../main/util/claude-hooks');

function tmpWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-worktree-'));
}

test('a permission notification is recognised as one', () => {
  const h = hooks.interpret({
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission to use Bash',
    cwd: '/w',
    session_id: 's1',
    transcript_path: '/t/s1.jsonl',
  });
  assert.equal(h.kind, 'notification');
  assert.equal(h.isPermission, true);
  assert.match(h.message, /permission to use Bash/);
  assert.equal(h.transcriptPath, '/t/s1.jsonl', 'the hook names its own transcript');
});

test('an informational notification is not a permission ask', () => {
  const h = hooks.interpret({
    hook_event_name: 'Notification', notification_type: 'idle', message: 'still working',
  });
  assert.equal(h.isPermission, false);
});

// A Stop raised by a hook's own continuation is not the agent finishing; acting
// on it is how these turn into loops.
test('a hook-driven Stop is ignored', () => {
  assert.equal(hooks.interpret({ hook_event_name: 'Stop', stop_hook_active: true }), null);
  assert.equal(hooks.interpret({ hook_event_name: 'Stop' }).kind, 'turn-end');
});

test('events we do not act on yield nothing', () => {
  assert.equal(hooks.interpret({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), null);
  assert.equal(hooks.interpret(null), null);
  assert.equal(hooks.interpret({}), null);
});

test('hooks install into the worktree, not the user profile', () => {
  const wt = tmpWorktree();
  const r = hooks.installForWorktree(wt);
  assert.equal(r.ok, true);
  // settings.local.json is per-checkout and git-ignored by convention.
  assert.equal(r.file, path.join(wt, '.claude', 'settings.local.json'));
  const written = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.deepEqual(Object.keys(written.hooks).sort(), ['Notification', 'Stop']);
});

test('installing twice does not stack duplicate hooks', () => {
  const wt = tmpWorktree();
  hooks.installForWorktree(wt);
  hooks.installForWorktree(wt);
  const written = JSON.parse(fs.readFileSync(path.join(wt, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(written.hooks.Stop.length, 1);
});

test("a user's own hooks on the same event survive", () => {
  const wt = tmpWorktree();
  const dir = path.join(wt, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.local.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-thing.sh' }] }] },
    permissions: { allow: ['Bash'] },
  }));

  hooks.installForWorktree(wt);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'settings.local.json'), 'utf8'));
  assert.equal(written.hooks.Stop.length, 2, 'theirs plus ours');
  assert.match(JSON.stringify(written.hooks.Stop), /my-own-thing\.sh/);
  assert.deepEqual(written.permissions, { allow: ['Bash'] }, 'unrelated settings untouched');
});

test('the client script exits quietly rather than wedging the agent', () => {
  const file = hooks.writeClient();
  const src = fs.readFileSync(file, 'utf8');
  assert.match(src, /uncaughtException/, 'never throws out');
  assert.match(src, /process\.exit\(0\)/, 'never signals failure to Claude');
  assert.match(src, /setTimeout/, 'never blocks indefinitely');
});

// Treating an unreadable file as empty would rewrite it as hooks alone, losing
// permissions and anything else the user keeps there.
test('a malformed settings file is left alone rather than replaced', () => {
  const wt = tmpWorktree();
  const dir = path.join(wt, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.local.json');
  fs.writeFileSync(file, '{ "permissions": { "allow": ["Bash"] }, oops');

  const r = hooks.installForWorktree(wt);
  assert.equal(r.ok, false, 'reports rather than clobbering');
  assert.match(r.error, /refusing to overwrite/);
  assert.match(fs.readFileSync(file, 'utf8'), /oops/, 'the file is untouched');
});
