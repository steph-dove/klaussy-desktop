#!/usr/bin/env node
// Exercises the Lemon Squeezy license API end-to-end without launching
// Electron. Uses a key passed as argv (or KLAUSSY_LICENSE_KEY env var) to:
//   1. validate (no instance) — proves the key exists
//   2. activate — burns one activation, returns instance_id
//   3. validate (with instance_id) — confirms the activation slot is live
//   4. deactivate — frees the activation back up so we don't strand it
//
// Exit non-zero on any step failure. Useful as a smoke test before flipping
// licenseRequired on in build-config.js.
//
// Usage:
//   node scripts/test-license.js <license-key>
//   KLAUSSY_LICENSE_KEY=<key> node scripts/test-license.js

const os = require('os');

const KEY = (process.argv[2] || process.env.KLAUSSY_LICENSE_KEY || '').trim();
if (!KEY) {
  console.error('Usage: node scripts/test-license.js <license-key>');
  process.exit(2);
}

const ENDPOINTS = {
  validate:   'https://api.lemonsqueezy.com/v1/licenses/validate',
  activate:   'https://api.lemonsqueezy.com/v1/licenses/activate',
  deactivate: 'https://api.lemonsqueezy.com/v1/licenses/deactivate',
};

async function call(url, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Accept': 'application/json' },
    body,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, data };
}

function instanceName() {
  return `${os.hostname()} (test-license.js, ${os.platform()}-${os.arch()})`;
}

(async () => {
  console.log('--- 1. validate (no instance) ---');
  const v1 = await call(ENDPOINTS.validate, { license_key: KEY });
  console.log(JSON.stringify({ status: v1.status, valid: v1.data && v1.data.valid, error: v1.data && v1.data.error }, null, 2));
  if (!v1.ok || !v1.data || !v1.data.valid) {
    console.error('FAIL: validate returned not-valid');
    process.exit(1);
  }
  const meta = v1.data.meta || {};
  console.log(`  variant=${meta.variant_name}  customer=${meta.customer_email}  test_mode=${v1.data.license_key && v1.data.license_key.test_mode}`);
  console.log(`  activations: ${v1.data.license_key.activation_usage}/${v1.data.license_key.activation_limit}`);

  console.log('\n--- 2. activate ---');
  const a = await call(ENDPOINTS.activate, { license_key: KEY, instance_name: instanceName() });
  console.log(JSON.stringify({ status: a.status, activated: a.data && a.data.activated, error: a.data && a.data.error, instance_id: a.data && a.data.instance && a.data.instance.id }, null, 2));
  if (!a.ok || !a.data || !a.data.activated) {
    console.error('FAIL: activate refused (key invalid or activation_limit reached)');
    process.exit(1);
  }
  const instanceId = a.data.instance.id;

  console.log('\n--- 3. validate (with instance_id) ---');
  const v2 = await call(ENDPOINTS.validate, { license_key: KEY, instance_id: instanceId });
  console.log(JSON.stringify({ status: v2.status, valid: v2.data && v2.data.valid, error: v2.data && v2.data.error }, null, 2));
  if (!v2.ok || !v2.data || !v2.data.valid) {
    console.error('FAIL: post-activation validate not-valid');
    process.exit(1);
  }

  console.log('\n--- 4. deactivate ---');
  const d = await call(ENDPOINTS.deactivate, { license_key: KEY, instance_id: instanceId });
  console.log(JSON.stringify({ status: d.status, deactivated: d.data && d.data.deactivated, error: d.data && d.data.error }, null, 2));
  if (!d.ok) {
    console.error('FAIL: deactivate errored — your test key now has a stranded activation');
    process.exit(1);
  }

  console.log('\nOK — all four steps passed. The LS license API integration works end-to-end.');
})().catch((err) => {
  console.error('UNCAUGHT:', err);
  process.exit(1);
});
