// License activation — one-time-purchase verification against Paddle.
//
// Flow:
//   1. User buys via the website; Paddle emails them a license key.
//   2. User enters the key in our Activation dialog.
//   3. We POST to Paddle's /licenses/activate with the key + this device's
//      fingerprint. Paddle returns activation status + expiry (or lifetime).
//   4. We persist { key, email, activatedAt, lastVerified } locally.
//   5. On every launch, we load the local activation. If the last-verified
//      timestamp is > 7 days old, we re-verify in the background. Offline
//      launches still work — revocation kicks in on the next successful
//      re-verify.
//
// Paddle-specific plumbing lives in `verifyWithPaddle()`. Everything else
// is generic and doesn't care which license provider is used.
//
// Dev bypass: when app.isPackaged is false, isActivated() returns true so
// we don't gate the dev workflow behind a fake key.

const { app } = require('electron');
const os = require('os');
const crypto = require('crypto');
const { loadConfig, saveConfig } = require('../util/config');
const buildConfig = require('../util/build-config');
const log = require('electron-log');

// Set at build time. For now a placeholder — flip this to your Paddle
// product ID before shipping. The client-side API token is ALSO required
// but exposing it in the client is fine for Paddle License Keys (it's
// scoped to activations only, can't read private data).
const PADDLE_PRODUCT_ID = process.env.PADDLE_PRODUCT_ID || null;
const PADDLE_API_KEY    = process.env.PADDLE_API_KEY || null;
const PADDLE_ENDPOINT   = 'https://api.paddle.com/licenses/activate';
const RE_VERIFY_DAYS    = 7;

// Stable per-device identifier — Paddle binds activations to this so one
// license can't be spread across an unbounded number of machines. Pulled
// from the OS machine UUID (falls back to hostname+user) and hashed so we
// don't leak anything personal.
function deviceFingerprint() {
  const parts = [os.hostname(), os.userInfo().username, os.platform(), os.arch()];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

function loadLicense() {
  const cfg = loadConfig();
  return cfg.license || null;
}

function storeLicense(lic) {
  saveConfig({ license: lic });
}

function clearLicense() {
  saveConfig({ license: null });
}

// The gate every caller cares about. Cached per process; re-verify happens
// out-of-band in maybeReVerify().
function isActivated() {
  if (!buildConfig.licenseRequired) return true; // flag off in this build
  if (!app.isPackaged) return true;               // dev bypass
  const lic = loadLicense();
  return !!(lic && lic.key && lic.activatedAt);
}

// Replace the body of this with your actual Paddle API call once you have
// the product set up. The function must return:
//   { ok: true, email, expiresAt }       on success
//   { ok: false, error: 'reason' }        on failure
//
// For Paddle Billing with License Keys, the shape is roughly:
//   POST https://api.paddle.com/licenses/activate
//   Authorization: Bearer <API_KEY>
//   { "license_key": "...", "device_id": "<fingerprint>" }
// → { "data": { "email": "...", "expires_at": "..." } }
//
// Paddle Classic has a different endpoint (vendors.paddle.com/api/2.0/...)
// and a different response shape. Swap once you know which you're on.
async function verifyWithPaddle(licenseKey) {
  if (!PADDLE_PRODUCT_ID || !PADDLE_API_KEY) {
    return { ok: false, error: 'Paddle credentials not configured' };
  }
  try {
    const res = await fetch(PADDLE_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${PADDLE_API_KEY}`,
      },
      body: JSON.stringify({
        product_id: PADDLE_PRODUCT_ID,
        license_key: licenseKey,
        device_id: deviceFingerprint(),
      }),
    });
    if (!res.ok) return { ok: false, error: 'Paddle returned HTTP ' + res.status };
    const body = await res.json();
    // Shape depends on which Paddle product you're using; adjust.
    const data = body && (body.data || body);
    return {
      ok: true,
      email: data.email || null,
      expiresAt: data.expires_at || null,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

async function activate(licenseKey) {
  if (!licenseKey || !licenseKey.trim()) return { ok: false, error: 'Enter a license key' };
  const result = await verifyWithPaddle(licenseKey.trim());
  if (!result.ok) return result;
  storeLicense({
    key: licenseKey.trim(),
    email: result.email || null,
    expiresAt: result.expiresAt || null,
    activatedAt: Date.now(),
    lastVerified: Date.now(),
  });
  log.info('[license] activated for', result.email || '(unknown email)');
  return { ok: true, email: result.email };
}

async function deactivate() {
  clearLicense();
  log.info('[license] deactivated');
  return { ok: true };
}

// Fires on startup if the last verify is > RE_VERIFY_DAYS old. Silent: if
// the network's down we just keep the existing activation until next try.
// A successful re-verify that comes back "invalid" clears the license.
async function maybeReVerify() {
  if (!app.isPackaged) return;
  const lic = loadLicense();
  if (!lic || !lic.key) return;
  const ageMs = Date.now() - (lic.lastVerified || 0);
  if (ageMs < RE_VERIFY_DAYS * 24 * 60 * 60 * 1000) return;

  const result = await verifyWithPaddle(lic.key);
  if (!result.ok) {
    log.info('[license] re-verify failed (network?), keeping existing activation');
    return;
  }
  // Explicit server-side revocation is rare; handle if/when Paddle signals it.
  storeLicense(Object.assign({}, lic, { lastVerified: Date.now() }));
}

function status() {
  const lic = loadLicense();
  return {
    activated: isActivated(),
    // devBypass drives the renderer's decision to skip the activation modal
    // on launch — true when the gate is off for any reason (dev or flag off).
    devBypass: !app.isPackaged || !buildConfig.licenseRequired,
    licenseRequired: buildConfig.licenseRequired,
    email: lic && lic.email || null,
    expiresAt: lic && lic.expiresAt || null,
    activatedAt: lic && lic.activatedAt || null,
  };
}

module.exports = {
  isActivated,
  activate,
  deactivate,
  maybeReVerify,
  status,
};
