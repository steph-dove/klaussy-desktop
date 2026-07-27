require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const perms = require('../../main/state/kimi-permissions');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-perm-'));
}
function read(home) {
  return fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
}

test('grant writes a rule matching kimi 0.29.1 PermissionRuleSchema', () => {
  const home = tmpHome();
  assert.equal(perms.isGranted(home), false);
  assert.deepEqual(perms.grant(home), { ok: true, changed: true });

  const text = read(home);
  assert.match(text, /\[\[permission\.rules\]\]/);
  // Every field the schema requires, with the tool-name-only pattern grammar.
  assert.match(text, /decision = "allow"/);
  assert.match(text, /scope = "user"/);
  assert.match(text, /pattern = "Bash"/);
  // No `tool =` key — that field does not exist in the schema.
  assert.ok(!/^\s*tool\s*=/m.test(text), 'must not emit a bogus tool key');
  assert.equal(perms.isGranted(home), true);

  fs.rmSync(home, { recursive: true, force: true });
});

test('grant is idempotent — never stacks duplicate rules', () => {
  const home = tmpHome();
  perms.grant(home);
  assert.deepEqual(perms.grant(home), { ok: true, changed: false });
  assert.equal(read(home).match(/\[\[permission\.rules\]\]/g).length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('revoke restores the file byte-for-byte, preserving the user own rules', () => {
  const home = tmpHome();
  const original = [
    'default_model = "k2"',
    '',
    '[[permission.rules]]',
    'decision = "deny"',
    'scope = "user"',
    'pattern = "Bash(rm *)"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(home, 'config.toml'), original);

  perms.grant(home);
  const granted = read(home);
  assert.match(granted, /pattern = "Bash"/);      // ours added
  assert.match(granted, /pattern = "Bash\(rm \*\)"/); // theirs intact

  assert.deepEqual(perms.revoke(home), { ok: true, changed: true });
  assert.equal(read(home), original, 'revoke must restore the original bytes');
  assert.equal(perms.isGranted(home), false);

  fs.rmSync(home, { recursive: true, force: true });
});

test('revoke on a config we never touched is a no-op', () => {
  const home = tmpHome();
  const original = 'default_model = "k2"\n';
  fs.writeFileSync(path.join(home, 'config.toml'), original);
  assert.deepEqual(perms.revoke(home), { ok: true, changed: false });
  assert.equal(read(home), original);
  fs.rmSync(home, { recursive: true, force: true });
});

test('grant creates config.toml when kimi has never run', () => {
  const home = path.join(tmpHome(), 'nested-home');
  assert.equal(perms.isGranted(home), false);
  assert.deepEqual(perms.grant(home), { ok: true, changed: true });
  assert.match(read(home), /pattern = "Bash"/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('setGranted toggles both directions', () => {
  const home = tmpHome();
  perms.setGranted(true, home);
  assert.equal(perms.isGranted(home), true);
  perms.setGranted(false, home);
  assert.equal(perms.isGranted(home), false);
  fs.rmSync(home, { recursive: true, force: true });
});
