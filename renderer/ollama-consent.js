// Consent + install flow for the local Ollama inline-completion backend.
//
// Entry point: OllamaConsent.openIfNeeded().
//   - Queries setup state; if 'ready' or 'declined', returns without showing
//     anything (idempotent, safe to call on every editor open).
//   - Otherwise shows the modal: consent → Enable → progress → done / error.
//   - On success, resolves so the caller can activate the passive trigger
//     immediately (no restart required).
//
// This file is UI-only — all the heavy lifting (brew install, server spawn,
// model pull with streaming progress) lives in main/state/ollama.js.

window.OllamaConsent = (function () {
  var overlay = document.getElementById('ollama-consent-overlay');
  var consentPane = document.getElementById('ollama-consent-pane');
  var progressPane = document.getElementById('ollama-progress-pane');
  var errorPane = document.getElementById('ollama-error-pane');
  var errorMessage = document.getElementById('ollama-error-message');
  var enableBtn = document.getElementById('ollama-consent-enable');
  var declineBtn = document.getElementById('ollama-consent-decline');
  var hideBtn = document.getElementById('ollama-progress-hide');
  var errorClose = document.getElementById('ollama-error-close');
  var errorRetry = document.getElementById('ollama-error-retry');
  var progressBar = document.getElementById('ollama-progress-bar');
  var progressMsg = document.getElementById('ollama-progress-message');
  var stepEls = overlay ? overlay.querySelectorAll('.ollama-progress-step') : [];

  // Callers awaiting setup completion. We resolve all of them once ready.
  var resolvers = [];
  // Whether the full pipeline has finished successfully this session.
  var readyInSession = false;

  function show(pane) {
    consentPane.style.display = pane === 'consent' ? 'block' : 'none';
    progressPane.style.display = pane === 'progress' ? 'block' : 'none';
    errorPane.style.display = pane === 'error' ? 'block' : 'none';
    overlay.style.display = 'flex';
  }

  function hide() {
    overlay.style.display = 'none';
  }

  function setStep(step, state) {
    stepEls.forEach(function (el) {
      if (el.dataset.step !== step) return;
      el.classList.remove('active', 'done');
      if (state === 'active') el.classList.add('active');
      if (state === 'done') el.classList.add('done');
      var icon = el.querySelector('.ollama-progress-icon');
      if (!icon) return;
      if (state === 'active') icon.textContent = '⧗';
      else if (state === 'done') icon.textContent = '✓';
      else icon.textContent = '○';
    });
  }

  // Mark everything up to and including `currentStep` as active/done.
  var STEP_ORDER = ['install', 'server', 'model', 'warmup'];
  function advanceToStep(currentStep) {
    var idx = STEP_ORDER.indexOf(currentStep);
    if (idx === -1) return;
    STEP_ORDER.forEach(function (s, i) {
      if (i < idx) setStep(s, 'done');
      else if (i === idx) setStep(s, 'active');
      else setStep(s, 'pending');
    });
  }

  function resetSteps() {
    STEP_ORDER.forEach(function (s) { setStep(s, 'pending'); });
    progressBar.style.width = '0%';
    progressMsg.textContent = 'Starting…';
  }

  function resolveAll(value) {
    var copy = resolvers;
    resolvers = [];
    copy.forEach(function (r) { try { r(value); } catch {} });
  }

  async function runSetup() {
    resetSteps();
    show('progress');

    // Subscribe to progress BEFORE starting so we don't drop the first event.
    var unsub = window.klaus.ai.ollama.onSetupProgress(function (p) {
      if (!p) return;
      if (p.step && p.step !== 'done') advanceToStep(p.step);
      if (p.message) progressMsg.textContent = p.message;
      if (typeof p.percent === 'number' && p.step === 'model') {
        progressBar.style.width = Math.max(0, Math.min(100, p.percent)) + '%';
      }
      if (p.step === 'done') {
        STEP_ORDER.forEach(function (s) { setStep(s, 'done'); });
        progressBar.style.width = '100%';
      }
    });

    var result = null;
    try {
      result = await window.klaus.ai.ollama.setupStart();
    } catch (err) {
      result = { error: (err && err.message) || String(err) };
    }
    try { unsub && unsub(); } catch {}

    if (result && result.ok) {
      readyInSession = true;
      resolveAll({ ok: true });
      // Short delay so the user sees the "Ready." state land before close.
      setTimeout(hide, 500);
      return;
    }

    errorMessage.textContent = (result && result.error) || 'Unknown error';
    show('error');
  }

  async function openIfNeeded() {
    if (!overlay) return { ok: false, error: 'consent modal missing' };
    if (readyInSession) return { ok: true };
    var status;
    try { status = await window.klaus.ai.ollama.setupStatus(); } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
    var state = status && status.state;
    if (state === 'ready') { readyInSession = true; return { ok: true }; }
    if (state === 'declined') return { ok: false, declined: true };

    // 'needs-install', 'needs-server', 'needs-model' all show the consent
    // pane first — even when only the model is missing, it's a material
    // download (~1GB) and we should ask before doing it.
    show('consent');

    return new Promise(function (resolve) { resolvers.push(resolve); });
  }

  if (overlay) {
    enableBtn.addEventListener('click', function () {
      runSetup();
    });
    declineBtn.addEventListener('click', async function () {
      try { await window.klaus.ai.ollama.setupDecline(); } catch {}
      hide();
      resolveAll({ ok: false, declined: true });
    });
    hideBtn.addEventListener('click', function () {
      // User hides the progress; setup continues in main. When it finishes,
      // the setupStart promise resolves and we call resolveAll. But the modal
      // is already hidden, so the user just gets inline AI activated silently.
      hide();
    });
    errorClose.addEventListener('click', function () {
      hide();
      resolveAll({ ok: false, error: errorMessage.textContent });
    });
    errorRetry.addEventListener('click', function () {
      runSetup();
    });
    overlay.addEventListener('click', function (e) {
      // Click outside only dismisses the initial consent pane — during
      // install / error we keep the modal up so the user explicitly resolves.
      if (e.target === overlay && consentPane.style.display !== 'none') {
        hide();
        resolveAll({ ok: false, dismissed: true });
      }
    });
  }

  return {
    openIfNeeded: openIfNeeded,
  };
})();
