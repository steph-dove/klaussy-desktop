// Toast notifications — replacement for window.alert().
//
// Usage:
//   window.toast.error('Commit failed: ' + msg);
//   window.toast.warn('No file selected.');
//   window.toast.info('Pushed to origin/main');
//   window.toast.success('Merged.');
//
// Toasts stack in the bottom-right, auto-dismiss after a type-dependent
// timeout (longer for errors so they can actually be read), and can be
// clicked to dismiss immediately. The module is fully self-contained —
// it injects its own <style> + container on first use, so any HTML
// entrypoint that includes this script gets the API for free.
//
// Not a drop-in for alert() semantically: alert() is blocking, toasts are
// not. Every current caller was using alert() to report an async failure
// the user doesn't need to acknowledge synchronously, so the non-blocking
// swap is a net win — no more modal UI freeze when a background IPC fails.

(function () {
  let _container = null;
  let _installed = false;

  function install() {
    if (_installed) return;
    _installed = true;

    const style = document.createElement('style');
    style.textContent = `
      #klaussy-toast-stack {
        position: fixed;
        right: 16px;
        bottom: 16px;
        display: flex;
        flex-direction: column-reverse;
        gap: 8px;
        z-index: 99999;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        line-height: 1.4;
      }
      .klaussy-toast {
        pointer-events: auto;
        min-width: 260px;
        max-width: 420px;
        padding: 10px 14px 10px 12px;
        background: #1c1c2e;
        color: #e8e8f0;
        border-radius: 6px;
        border-left: 3px solid #888;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.06);
        cursor: pointer;
        word-break: break-word;
        opacity: 0;
        transform: translateX(12px);
        transition: opacity 140ms ease, transform 140ms ease;
      }
      .klaussy-toast.visible {
        opacity: 1;
        transform: translateX(0);
      }
      .klaussy-toast.leaving {
        opacity: 0;
        transform: translateX(12px);
      }
      .klaussy-toast.error   { border-left-color: #ff5252; }
      .klaussy-toast.warn    { border-left-color: #ffb74d; }
      .klaussy-toast.info    { border-left-color: #64b5f6; }
      .klaussy-toast.success { border-left-color: #81c784; }
      .klaussy-toast .msg { white-space: pre-wrap; }
    `;
    document.head.appendChild(style);

    _container = document.createElement('div');
    _container.id = 'klaussy-toast-stack';
    // role=status so screen readers announce without stealing focus.
    _container.setAttribute('role', 'status');
    _container.setAttribute('aria-live', 'polite');
    document.body.appendChild(_container);
  }

  // Type-dependent auto-dismiss timeouts (ms). Errors stick around longer
  // so users can read + copy the failure message before it disappears.
  const DISMISS_MS = { error: 8000, warn: 6000, info: 4500, success: 4500 };

  function show(level, message) {
    if (!_installed) install();
    const el = document.createElement('div');
    el.className = 'klaussy-toast ' + level;
    const span = document.createElement('span');
    span.className = 'msg';
    // Plain text: no innerHTML, so message content can't smuggle markup.
    span.textContent = String(message == null ? '' : message);
    el.appendChild(span);
    _container.appendChild(el);

    // Next frame so the transition runs from the initial off-screen state.
    requestAnimationFrame(() => el.classList.add('visible'));

    const timeout = DISMISS_MS[level] || DISMISS_MS.info;
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      el.classList.remove('visible');
      el.classList.add('leaving');
      // Wait for the fade-out transition before removing from the DOM.
      setTimeout(() => { try { el.remove(); } catch {} }, 200);
    };
    const timer = setTimeout(dismiss, timeout);
    el.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
  }

  window.toast = {
    error:   (msg) => show('error', msg),
    warn:    (msg) => show('warn', msg),
    info:    (msg) => show('info', msg),
    success: (msg) => show('success', msg),
  };
})();
