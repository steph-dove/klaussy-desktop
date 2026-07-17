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
      .klaussy-toast-action {
        display: inline-block;
        margin-top: 8px;
        padding: 4px 12px;
        font: inherit;
        font-weight: 600;
        color: #e8e8f0;
        background: rgba(255,255,255,0.12);
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 4px;
        cursor: pointer;
      }
      .klaussy-toast-action:hover { background: rgba(255,255,255,0.2); }
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

  // opts (optional): { actionLabel, onAction, sticky }. An action toast renders
  // a button that runs onAction then dismisses; `sticky` disables auto-dismiss.
  function show(level, message, opts) {
    if (!_installed) install();
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'klaussy-toast ' + level;
    const span = document.createElement('span');
    span.className = 'msg';
    // Plain text: no innerHTML, so message content can't smuggle markup.
    span.textContent = String(message == null ? '' : message);
    el.appendChild(span);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(timer);
      el.classList.remove('visible');
      el.classList.add('leaving');
      // Wait for the fade-out transition before removing from the DOM.
      setTimeout(() => { try { el.remove(); } catch {} }, 200);
    };

    if (opts.actionLabel && typeof opts.onAction === 'function') {
      const btn = document.createElement('button');
      btn.className = 'klaussy-toast-action';
      btn.textContent = String(opts.actionLabel);
      btn.addEventListener('click', (e) => {
        // Don't let the click bubble to the toast body's dismiss handler before
        // the action runs.
        e.stopPropagation();
        try { opts.onAction(); } finally { dismiss(); }
      });
      el.appendChild(document.createElement('br'));
      el.appendChild(btn);
    }

    _container.appendChild(el);

    // Next frame so the transition runs from the initial off-screen state.
    requestAnimationFrame(() => el.classList.add('visible'));

    // Sticky toasts stay until clicked — used for actionable prompts the user
    // shouldn't miss (a timed-out upgrade nag reads as "nothing to do").
    const timeout = DISMISS_MS[level] || DISMISS_MS.info;
    const timer = opts.sticky ? null : setTimeout(dismiss, timeout);
    el.addEventListener('click', dismiss);
  }

  window.toast = {
    error:   (msg) => show('error', msg),
    warn:    (msg) => show('warn', msg),
    info:    (msg) => show('info', msg),
    success: (msg) => show('success', msg),
    // Actionable toast: level + message + a button. Sticky by default so the
    // action stays available; pass opts.sticky === false to auto-dismiss.
    action:  (level, msg, actionLabel, onAction, opts) =>
      show(level, msg, Object.assign({ sticky: true, actionLabel, onAction }, opts)),
  };
})();
