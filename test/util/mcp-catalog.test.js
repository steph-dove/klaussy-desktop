require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { CATALOG, CATEGORIES } = require('../../main/state/mcp-catalog');
const mcp = require('../../main/util/mcp-config');

test('catalog is non-empty and every entry is well-formed', () => {
  assert.ok(Array.isArray(CATALOG) && CATALOG.length, 'catalog should have entries');
  const seen = new Set();
  for (const e of CATALOG) {
    assert.ok(e.id && /^[\w.-]+$/.test(e.id), `bad id: ${e.id}`);
    assert.ok(!seen.has(e.id), `duplicate id: ${e.id}`);
    seen.add(e.id);

    assert.ok(e.name && typeof e.name === 'string', `${e.id}: missing name`);
    assert.ok(CATEGORIES.includes(e.category), `${e.id}: unknown category ${e.category}`);
    assert.ok(['stdio', 'http', 'sse'].includes(e.type), `${e.id}: bad type ${e.type}`);
    assert.ok(['oauth', 'env', 'app', 'none'].includes(e.auth), `${e.id}: bad auth ${e.auth}`);
    assert.ok(e.docsUrl && /^https?:\/\//.test(e.docsUrl), `${e.id}: missing docsUrl`);

    // OAuth entries are remote and never ask for env vars; env entries are
    // local stdio servers that declare what they need.
    if (e.auth === 'oauth') {
      assert.ok(e.type !== 'stdio', `${e.id}: oauth entry should be remote`);
      assert.ok(!e.requiredEnv, `${e.id}: oauth entry should not require env`);
    }
    if (e.auth === 'env') {
      assert.equal(e.type, 'stdio', `${e.id}: env entry should be stdio`);
      assert.ok(e.requiredEnv && e.requiredEnv.length, `${e.id}: env entry must declare requiredEnv`);
    }

    if (e.type === 'stdio') {
      assert.ok(e.command, `${e.id}: stdio entry needs a command`);
      assert.ok(Array.isArray(e.args || []), `${e.id}: args must be an array`);
    } else {
      assert.ok(e.url, `${e.id}: remote entry needs a url`);
    }

    for (const list of [e.requiredEnv, e.optionalEnv]) {
      if (!list) continue;
      assert.ok(Array.isArray(list), `${e.id}: env list must be an array`);
      for (const v of list) {
        assert.ok(v.key && /^[A-Za-z0-9_]+$/.test(v.key), `${e.id}: bad env key ${v.key}`);
        assert.ok(v.label, `${e.id}: env ${v.key} missing label`);
      }
    }
    if (e.requiredArgs) {
      for (const a of e.requiredArgs) assert.ok(a.label, `${e.id}: requiredArg missing label`);
    }
  }
});

test('the user-named servers are present', () => {
  const ids = new Set(CATALOG.map((e) => e.id));
  for (const id of ['github', 'notion', 'slack', 'linear', 'atlassian', 'datadog']) {
    assert.ok(ids.has(id), `catalog missing ${id}`);
  }
});

test('every catalog entry validates as a server template', () => {
  // A catalog entry, once its required secrets/args are supplied, must produce a
  // server that passes the writer's validation — guards against a template that
  // could never be added.
  for (const e of CATALOG) {
    const server = { name: e.id, type: e.type, command: e.command, url: e.url, args: (e.args || []).slice() };
    if (e.requiredArgs) server.args.push(...e.requiredArgs.map(() => 'x'));
    assert.equal(mcp.validateServer(server), null, `${e.id}: not a valid server template`);
  }
});
