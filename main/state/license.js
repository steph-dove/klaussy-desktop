// License activation — one-time-purchase verification against Lemon Squeezy,
// with a 30-day trial that auto-starts on first launch.
//
// Flow:
//   1. First packaged launch with no license: trialStartedAt is stamped now.
//      isActivated() returns true while trialDaysLeft() > 0.
//   2. User buys via the website; LS emails them a license key.
//   3. User enters the key in our Activation dialog. We POST to
//      /v1/licenses/activate with the key + a human-readable instance_name.
//      LS returns an instance_id, which we persist alongside the key.
//   4. On every launch, isActivated() returns true if the license is on file.
//      If lastVerified is > 7 days old, maybeReVerify() pings LS in the
//      background using /v1/licenses/validate (with instance_id). Offline
//      launches keep working; revocation kicks in on the next successful
//      validate that comes back not-valid.
//
// LS license endpoints are authenticated by the license key itself — no
// store API key needs to be embedded in the app.
//
// Dev bypass: when app.isPackaged is false, isActivated() returns true so
// we don't gate the dev workflow. Set KLAUSSY_FORCE_LICENSE_GATE=1 to
// exercise the gate locally without packaging.
//
// Tampering: a determined user can edit userData/config.json to extend the
// trial. We don't try to defend against that — most users won't bother and
// honest customers shouldn't pay the cost of obfuscation.

const { app } = require('electron');
const os = require('os');
const { loadConfig, saveConfig } = require('../util/config');
const buildConfig = require('../util/build-config');
const log = require('electron-log');

const LS_ACTIVATE   = 'https://api.lemonsqueezy.com/v1/licenses/activate';
const LS_VALIDATE   = 'https://api.lemonsqueezy.com/v1/licenses/validate';
const LS_DEACTIVATE = 'https://api.lemonsqueezy.com/v1/licenses/deactivate';

const TRIAL_DAYS     = 30;
const RE_VERIFY_DAYS = 7;
const DAY_MS         = 24 * 60 * 60 * 1000;

const DEV_FORCE_GATE = process.env.KLAUSSY_FORCE_LICENSE_GATE === '1';

// Human-readable per-machine label shown to the customer in their LS account
// alongside the activation. Helps them identify "which laptop is that?" if
// they ever hit the activation limit and need to deactivate one.
function instanceName() {
  const user = (() => { try { return os.userInfo().username; } catch { return 'user'; } })();
  return `${os.hostname()} (${user}, ${os.platform()}-${os.arch()})`;
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

function gateBypassed() {
  if (!buildConfig.licenseRequired) return true;
  if (!app.isPackaged && !DEV_FORCE_GATE) return true;
  return false;
}

// Auto-start the trial the first time the gate is checked on a fresh install.
// Stored on the same `license` blob so existing config-merge plumbing handles
// it, and re-runs are no-ops once trialStartedAt is set.
function ensureTrialStarted() {
  const lic = loadLicense() || {};
  if (lic.trialStartedAt || lic.key) return lic;
  const next = Object.assign({}, lic, { trialStartedAt: Date.now() });
  storeLicense(next);
  log.info('[license] trial started');
  return next;
}

function trialDaysLeft(lic) {
  if (!lic || !lic.trialStartedAt) return 0;
  const elapsed = Date.now() - lic.trialStartedAt;
  return Math.max(0, Math.ceil((TRIAL_DAYS * DAY_MS - elapsed) / DAY_MS));
}

function inTrial(lic) {
  return trialDaysLeft(lic) > 0;
}

function isLicensed(lic) {
  return !!(lic && lic.key && lic.activatedAt);
}

// The gate every caller cares about.
function isActivated() {
  if (gateBypassed()) return true;
  const lic = ensureTrialStarted();
  return isLicensed(lic) || inTrial(lic);
}

async function lsPost(url, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Accept': 'application/json' },
    body,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = (data && data.error) || `LS HTTP ${res.status}`;
    return { ok: false, error: msg };
  }
  return { ok: true, data };
}

async function activateWithLS(licenseKey) {
  try {
    const r = await lsPost(LS_ACTIVATE, {
      license_key: licenseKey,
      instance_name: instanceName(),
    });
    if (!r.ok) return r;
    const d = r.data;
    if (!d.activated) {
      return { ok: false, error: d.error || 'Activation refused (limit reached or key invalid)' };
    }
    return {
      ok: true,
      instanceId: d.instance && d.instance.id,
      email:      d.meta    && d.meta.customer_email,
      customerName: d.meta  && d.meta.customer_name,
      variantName:  d.meta  && d.meta.variant_name,
      expiresAt:  d.license_key && d.license_key.expires_at,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

async function validateWithLS(licenseKey, instanceId) {
  try {
    const params = { license_key: licenseKey };
    if (instanceId) params.instance_id = instanceId;
    const r = await lsPost(LS_VALIDATE, params);
    if (!r.ok) return r;
    return { ok: true, valid: !!r.data.valid, raw: r.data };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

async function deactivateWithLS(licenseKey, instanceId) {
  if (!licenseKey || !instanceId) return { ok: true };
  try {
    const r = await lsPost(LS_DEACTIVATE, {
      license_key: licenseKey,
      instance_id: instanceId,
    });
    return r.ok ? { ok: true } : r;
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

async function activate(licenseKey) {
  const key = (licenseKey || '').trim();
  if (!key) return { ok: false, error: 'Enter a license key' };
  const result = await activateWithLS(key);
  if (!result.ok) return result;
  const existing = loadLicense() || {};
  storeLicense({
    key,
    instanceId:   result.instanceId,
    email:        result.email,
    customerName: result.customerName,
    variantName:  result.variantName,
    expiresAt:    result.expiresAt || null,
    activatedAt:  Date.now(),
    lastVerified: Date.now(),
    // Preserve trialStartedAt so customers who buy mid-trial don't lose history.
    trialStartedAt: existing.trialStartedAt || null,
  });
  log.info('[license] activated', result.variantName || '', 'for', result.email || '(unknown)');
  return { ok: true, email: result.email, variantName: result.variantName };
}

async function deactivate() {
  const lic = loadLicense();
  if (lic && lic.key && lic.instanceId) {
    await deactivateWithLS(lic.key, lic.instanceId);
  }
  clearLicense();
  log.info('[license] deactivated');
  return { ok: true };
}

// Background re-verify on startup. Silent: network errors keep the existing
// activation. A successful validate that returns valid=false revokes locally.
async function maybeReVerify() {
  if (gateBypassed()) return;
  const lic = loadLicense();
  if (!isLicensed(lic)) return;
  const ageMs = Date.now() - (lic.lastVerified || 0);
  if (ageMs < RE_VERIFY_DAYS * DAY_MS) return;

  const result = await validateWithLS(lic.key, lic.instanceId);
  if (!result.ok) {
    log.info('[license] re-verify network failure, keeping activation');
    return;
  }
  if (!result.valid) {
    log.warn('[license] re-verify says invalid — clearing activation');
    clearLicense();
    return;
  }
  storeLicense(Object.assign({}, lic, { lastVerified: Date.now() }));
}

function status() {
  const bypass = gateBypassed();
  // Don't auto-start the trial in dev or with the gate off — keeps a clean
  // dev config and avoids stamping trialStartedAt on every dev run.
  const lic = bypass ? (loadLicense() || {}) : ensureTrialStarted();
  return {
    activated:      isActivated(),
    licensed:       isLicensed(lic),
    inTrial:        !isLicensed(lic) && inTrial(lic),
    trialDaysLeft:  trialDaysLeft(lic),
    trialDaysTotal: TRIAL_DAYS,
    devBypass:      bypass,
    licenseRequired: buildConfig.licenseRequired,
    email:          lic.email || null,
    variantName:    lic.variantName || null,
    expiresAt:      lic.expiresAt || null,
    activatedAt:    lic.activatedAt || null,
  };
}

module.exports = {
  isActivated,
  activate,
  deactivate,
  maybeReVerify,
  status,
};
