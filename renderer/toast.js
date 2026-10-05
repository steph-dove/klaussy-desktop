// Toast notifications — replacement for window.alert().
//
// Usage:
//   window.toast.error('Commit failed: ' + msg);
//   window.toast.warn('No file selected.');
//   window.toast.info('Pushed to origin/main');
//   window.toast.success('Merged.');
//
// Bottom-right stack; the newest three show, errors stay until dismissed, Escape dismisses the focused one.
// Self-contained: injects its own <style> and container on first use.
//
// Not a drop-in for alert() semantically: alert() is blocking, toasts are
// not. Every current caller was using alert() to report an async failure
// the user doesn't need to acknowledge synchronously, so the non-blocking
// swap is a net win — no more modal UI freeze when a background IPC fails.

(function () {
  let _container = null;
  let _more = null;
  let _expanded = false;
  let _installed = false;
  const MAX_VISIBLE = 3;
  const dismissers = new WeakMap();

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
        max-height: calc(100vh - 32px);
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        line-height: 1.4;
      }
      #klaussy-toast-stack.expanded { overflow-y: auto; }
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
      .klaussy-toast { position: relative; padding-right: 30px; }
      .klaussy-toast-close {
        position: absolute; top: 4px; right: 4px;
        width: 24px; height: 24px; padding: 0;
        font: inherit; font-size: 16px; line-height: 1;
        color: #e8e8f0; background: transparent; border: 0; border-radius: 4px;
        cursor: pointer; opacity: 0.7;
      }
      .klaussy-toast-close:hover, .klaussy-toast-close:focus-visible { opacity: 1; background: rgba(255,255,255,0.12); }
      .klaussy-toast-more {
        pointer-events: auto;
        align-self: flex-end;
        padding: 4px 12px;
        font: inherit;
        font-weight: 600;
        color: #e8e8f0;
        background: #1c1c2e;
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 12px;
        cursor: pointer;
      }
      .klaussy-toast-more:hover { background: #2a2a40; }
    `;
    document.head.appendChild(style);

    _container = document.createElement('div');
    _container.id = 'klaussy-toast-stack';
    _container.setAttribute('aria-label', 'Notifications');
    // A11y announces toasts itself; the stack is only a live region as a fallback.
    if (window.A11y) {
      _container.setAttribute('role', 'region');
    } else {
      _container.setAttribute('role', 'status');
      _container.setAttribute('aria-live', 'polite');
    }
    _more = document.createElement('button');
    _more.type = 'button';
    _more.className = 'klaussy-toast-more';
    _more.hidden = true;
    _more.addEventListener('click', () => { _expanded = !_expanded; layout(); });
    _container.appendChild(_more);
    _container.addEventListener('keydown', onStackKeydown);
    document.body.appendChild(_container);
  }

  function liveToasts() {
    return Array.from(_container.querySelectorAll('.klaussy-toast:not(.leaving)'));
  }

  // Shows the newest MAX_VISIBLE toasts (all of them when expanded) so a burst of sticky errors can't cover the window.
  function layout() {
    const toasts = liveToasts();
    const extra = toasts.length - MAX_VISIBLE;
    if (extra <= 0) _expanded = false;
    toasts.forEach((t, i) => { t.hidden = !_expanded && i < extra; });
    _more.hidden = extra <= 0;
    _more.textContent = _expanded ? 'Show fewer' : '+' + extra + ' more';
    _more.setAttribute('aria-expanded', String(_expanded));
    _container.classList.toggle('expanded', _expanded);
  }

  // Escape inside the stack dismisses the focused toast, or the newest one from the "+N more" button.
  function onStackKeydown(e) {
    if (e.key !== 'Escape') return;
    const toasts = liveToasts();
    const target = e.target.closest('.klaussy-toast') || toasts[toasts.length - 1];
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    dismissers.get(target)();
    const next = liveToasts().filter((t) => !t.hidden).pop();
    const focusTo = next ? next.querySelector('.klaussy-toast-close') : (!_more.hidden && _more);
    if (focusTo) focusTo.focus();
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
    let timer = null;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(timer);
      el.classList.remove('visible');
      el.classList.add('leaving');
      layout();
      // Wait for the fade-out transition before removing from the DOM.
      setTimeout(() => { try { el.remove(); } catch {} }, 200);
    };
    dismissers.set(el, dismiss);

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

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'klaussy-toast-close';
    closeBtn.setAttribute('aria-label', 'Dismiss notification');
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
    el.appendChild(closeBtn);

    _container.appendChild(el);
    layout();
    if (window.A11y) window.A11y.announce(span.textContent, level === 'error' ? 'assertive' : 'polite');

    // Next frame so the transition runs from the initial off-screen state.
    requestAnimationFrame(() => el.classList.add('visible'));

    // Sticky toasts stay until clicked — used for actionable prompts the user
    // shouldn't miss (a timed-out upgrade nag reads as "nothing to do").
    const timeout = DISMISS_MS[level] || DISMISS_MS.info;
    // Errors don't time out: there's no reliable way for keyboard users to reach them in time (WCAG 2.2.1).
    const sticky = opts.sticky || level === 'error';
    const arm = () => { if (!sticky && !dismissed) timer = setTimeout(dismiss, timeout); };
    const pause = () => { clearTimeout(timer); timer = null; };
    arm();
    el.addEventListener('mouseenter', pause);
    el.addEventListener('focusin', pause);
    el.addEventListener('mouseleave', () => { if (!el.contains(document.activeElement)) arm(); });
    el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget) && !el.matches(':hover')) arm(); });
    el.addEventListener('click', dismiss);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else if (document.body) install();

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
