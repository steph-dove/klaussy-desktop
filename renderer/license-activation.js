// License activation modal.
//
// Entry points:
//   - LicenseActivation.openIfNeeded() — called at startup. Shows the modal
//     only when the app is packaged AND not yet activated. Non-blocking: the
//     user can Close and use the app; we surface "Unlicensed" via the status
//     hook for later tightening.
//   - LicenseActivation.open() — forced open, used from About → Manage
//     License so a user can re-activate or deactivate after first run.

window.LicenseActivation = (function () {
  var overlay = document.getElementById('license-overlay');
  var input = document.getElementById('license-key-input');
  var errorEl = document.getElementById('license-error');
  var statusEl = document.getElementById('license-status');
  var activateBtn = document.getElementById('license-activate');
  var buyBtn = document.getElementById('license-buy');
  var closeBtn = document.getElementById('license-close');

  function renderStatus(st) {
    if (!st || !st.activated) {
      statusEl.style.display = 'none';
      return;
    }
    var parts = ['<strong>Activated.</strong>'];
    if (st.email) parts.push('Registered to ' + escHtml(st.email) + '.');
    if (st.expiresAt) parts.push('Expires ' + escHtml(new Date(st.expiresAt).toLocaleDateString()) + '.');
    else parts.push('Lifetime license.');
    statusEl.innerHTML = parts.join(' ');
    statusEl.style.display = 'block';
  }

  function escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function show() { overlay.style.display = 'flex'; setTimeout(function () { input.focus(); }, 0); }
  function hide() { overlay.style.display = 'none'; }

  async function refreshStatus() {
    try {
      var st = await window.klaus.license.status();
      renderStatus(st);
      return st;
    } catch (err) {
      errorEl.textContent = (err && err.message) || String(err);
      return null;
    }
  }

  async function openIfNeeded() {
    var st = await refreshStatus();
    if (!st) return;
    if (st.activated || st.devBypass) return;
    show();
  }

  async function open() {
    await refreshStatus();
    show();
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
      // Brief success state, then auto-close.
      activateBtn.textContent = 'Activated';
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
