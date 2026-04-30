// License activation modal.
//
// Entry points:
//   - LicenseActivation.openIfNeeded() — called at startup. Shows the modal
//     in *blocking* mode (no close button, escape disabled) when the trial
//     has expired and the user is unlicensed. During an active trial the
//     gate is open and the modal stays hidden.
//   - LicenseActivation.open() — forced open in *dismissable* mode, used from
//     About → Manage License so a user can re-activate or deactivate after
//     first run, or read their trial status.

window.LicenseActivation = (function () {
  var overlay = document.getElementById('license-overlay');
  var input = document.getElementById('license-key-input');
  var errorEl = document.getElementById('license-error');
  var statusEl = document.getElementById('license-status');
  var trialBanner = document.getElementById('license-trial-banner');
  var activateBtn = document.getElementById('license-activate');
  var buyBtn = document.getElementById('license-buy');
  var closeBtn = document.getElementById('license-close');

  // True when the modal was opened by the startup gate and dismissal would
  // bypass the license check. Hides the Close button and disables Escape.
  var blocking = false;

  function renderStatus(st) {
    if (!st || !st.licensed) {
      statusEl.style.display = 'none';
      return;
    }
    var parts = ['<strong>Activated.</strong>'];
    if (st.variantName) parts.push(escHtml(st.variantName) + '.');
    if (st.email) parts.push('Registered to ' + escHtml(st.email) + '.');
    if (st.expiresAt) parts.push('Expires ' + escHtml(new Date(st.expiresAt).toLocaleDateString()) + '.');
    else parts.push('Lifetime license.');
    statusEl.innerHTML = parts.join(' ');
    statusEl.style.display = 'block';
  }

  function renderTrialBanner(st) {
    if (!st || st.licensed || st.devBypass || !st.licenseRequired) {
      trialBanner.style.display = 'none';
      trialBanner.classList.remove('expired');
      return;
    }
    if (st.inTrial) {
      var days = st.trialDaysLeft;
      var label = days === 1 ? '1 day' : days + ' days';
      trialBanner.textContent = 'Trial: ' + label + ' remaining of ' + st.trialDaysTotal + '.';
      trialBanner.classList.remove('expired');
      trialBanner.style.display = 'block';
    } else {
      trialBanner.textContent = 'Trial ended. Enter your license key to keep using Klaussy.';
      trialBanner.classList.add('expired');
      trialBanner.style.display = 'block';
    }
  }

  function escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function show(opts) {
    blocking = !!(opts && opts.blocking);
    closeBtn.style.display = blocking ? 'none' : '';
    overlay.style.display = 'flex';
    setTimeout(function () { input.focus(); }, 0);
  }

  function hide() {
    if (blocking) return;
    overlay.style.display = 'none';
  }

  async function refreshStatus() {
    try {
      var st = await window.klaus.license.status();
      renderStatus(st);
      renderTrialBanner(st);
      return st;
    } catch (err) {
      errorEl.textContent = (err && err.message) || String(err);
      return null;
    }
  }

  // Once-per-day toast during the last 7 days of the trial. Persisted in
  // localStorage (UI-only durability is fine — losing it just means the
  // user sees the warning twice on the same day, not a security concern).
  var TRIAL_WARNING_KEY = 'klaussy.trialWarningShownDate';
  var TRIAL_WARNING_THRESHOLD_DAYS = 7;

  function maybeShowTrialWarning(st) {
    if (!st || st.licensed || st.devBypass || !st.licenseRequired) return;
    if (!st.inTrial) return;
    if (st.trialDaysLeft > TRIAL_WARNING_THRESHOLD_DAYS) return;

    var today = new Date().toISOString().slice(0, 10);
    try {
      if (localStorage.getItem(TRIAL_WARNING_KEY) === today) return;
    } catch {}

    var days = st.trialDaysLeft;
    var label = days === 1 ? '1 day' : days + ' days';
    var msg = 'Trial ends in ' + label + '. Activate a license to keep using Klaussy.';
    if (window.toast && typeof window.toast.warn === 'function') {
      window.toast.warn(msg);
    }
    try { localStorage.setItem(TRIAL_WARNING_KEY, today); } catch {}
  }

  async function openIfNeeded() {
    var st = await refreshStatus();
    if (!st) return;
    if (st.activated || st.devBypass) {
      maybeShowTrialWarning(st);
      return;
    }
    show({ blocking: true });
  }

  async function open() {
    await refreshStatus();
    show({ blocking: false });
  }

  activateBtn.addEventListener('click', async function () {
    var key = input.value.trim();
    if (!key) { errorEl.textContent = 'Enter your license key.'; return; }
    errorEl.textContent = '';
    activateBtn.disabled = true;
    activateBtn.textContent = 'Activating…';
    try {
      var result = await window.klaus.license.activate(key);
      if (!result || !result.ok) {
        errorEl.textContent = (result && result.error) || 'Activation failed.';
        activateBtn.disabled = false;
        activateBtn.textContent = 'Activate';
        return;
      }
      await refreshStatus();
      // Brief success state, then auto-close (force close even when blocking
      // since activation legitimately removes the gate).
      activateBtn.textContent = 'Activated';
      blocking = false;
      setTimeout(hide, 800);
    } catch (err) {
      errorEl.textContent = (err && err.message) || String(err);
      activateBtn.disabled = false;
      activateBtn.textContent = 'Activate';
    }
  });

  buyBtn.addEventListener('click', function () {
    try { window.klaus.license.openCheckout(); } catch {}
  });

  closeBtn.addEventListener('click', hide);

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) hide();
  });

  document.addEventListener('keydown', function (e) {
    if (overlay.style.display === 'none') return;
    if (e.key === 'Escape') hide();
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); activateBtn.click(); }
  });

  return {
    openIfNeeded: openIfNeeded,
    open: open,
  };
})();
