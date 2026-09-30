// Overlays matching DIALOG_SELECTOR become modal dialogs automatically; Escape clicks [data-dialog-close], else the backdrop, else a Cancel/Close button.

window.A11y = (function () {
  const DIALOG_SELECTOR = [
    '.palette-overlay',
    '.klaus-modal-overlay',
    '#modal-overlay',
    '#theme-overlay',
    '#conflict-overlay',
    '.pr-picker-overlay',
    '.pr-submit-overlay',
    '.pr-workflow-dispatch-modal-backdrop',
    '[data-a11y-dialog]',
  ].join(',');

  const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'iframe',
    'summary',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const KEEP_LIVE = '#klaussy-toast-stack, .a11y-live';
  const CLOSE_LABEL = /^(cancel|close|dismiss|hide|not now|done|×|✕)$/i;

  const stack = [];
  let lastFocusOutside = null;
  let syncQueued = false;

  function isShown(el) {
    return !!el && el.isConnected && !el.hidden && el.getClientRects().length > 0;
  }

  function tabbables(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter(function (el) {
      return isShown(el) && !el.closest('[inert]');
    });
  }

  function focusFirst(root, fallback) {
    const auto = root.querySelector('[autofocus]');
    if (auto && isShown(auto)) { auto.focus(); return; }
    const all = tabbables(root);
    const field = all.find(function (el) { return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName); });
    const target = field || all[0];
    if (target) { target.focus(); return; }
    if (!fallback.hasAttribute('tabindex')) fallback.setAttribute('tabindex', '-1');
    fallback.focus();
  }

  let idSeq = 0;
  function ensureId(el, prefix) {
    if (!el.id) el.id = (prefix || 'a11y') + '-' + (++idSeq);
    return el.id;
  }

  function labelDialog(dialog) {
    if (dialog.hasAttribute('aria-label') || dialog.hasAttribute('aria-labelledby')) return;
    const heading = Array.from(dialog.querySelectorAll('h1, h2, h3, h4')).find(isShown);
    if (heading) dialog.setAttribute('aria-labelledby', ensureId(heading, 'dialog-title'));
  }

  // Ref-counted so dialogs closing out of order can't release an element another dialog still holds.
  const inertCount = new Map();
  function holdInert(el) {
    inertCount.set(el, (inertCount.get(el) || 0) + 1);
    el.inert = true;
  }
  function releaseInert(el) {
    const n = (inertCount.get(el) || 1) - 1;
    if (n > 0) inertCount.set(el, n);
    else { inertCount.delete(el); el.inert = false; }
  }

  function inertOthers(overlay) {
    const changed = [];
    let node = overlay;
    while (node && node.parentElement && node !== document.body) {
      for (const sib of node.parentElement.children) {
        if (sib === node || /^(SCRIPT|STYLE|LINK)$/.test(sib.tagName)) continue;
        if (sib.matches(KEEP_LIVE) || sib.matches(DIALOG_SELECTOR)) continue;
        if (sib.inert && !inertCount.has(sib)) continue;
        holdInert(sib);
        changed.push(sib);
      }
      node = node.parentElement;
    }
    return changed;
  }

  function openDialog(overlay) {
    const dialog = overlay.querySelector('[role="dialog"], [role="alertdialog"]') || overlay.firstElementChild || overlay;
    if (!dialog.getAttribute('role')) dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    labelDialog(dialog);
    for (let n = overlay; n && n !== document.body; n = n.parentElement) n.inert = false;
    const active = document.activeElement;
    const opener = active && active !== document.body && !overlay.contains(active) ? active : lastFocusOutside;
    const entry = { overlay: overlay, dialog: dialog, opener: opener, inerted: inertOthers(overlay) };
    stack.push(entry);
    if (!overlay.contains(document.activeElement)) focusFirst(dialog, dialog);
  }

  function restoreFocus(entry) {
    const active = document.activeElement;
    const lost = !active || active === document.body || entry.overlay.contains(active) || !active.isConnected;
    if (!lost) return;
    const opener = entry.opener;
    if (opener && opener.isConnected && isShown(opener) && !opener.closest('[inert]')) opener.focus();
  }

  function closeEntry(entry) {
    stack.splice(stack.indexOf(entry), 1);
    entry.inerted.forEach(releaseInert);
    restoreFocus(entry);
  }

  function sync() {
    syncQueued = false;
    stack.slice().reverse().forEach(function (entry) {
      if (!isShown(entry.overlay)) closeEntry(entry);
    });
    document.querySelectorAll(DIALOG_SELECTOR).forEach(function (overlay) {
      if (isShown(overlay) && !stack.some(function (e) { return e.overlay === overlay; })) openDialog(overlay);
    });
  }

  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    queueMicrotask(sync);
  }

  // Overlays are direct children of body; observing the subtree would fire on every terminal repaint.
  const attrObserver = new MutationObserver(queueSync);
  function watchOverlay(overlay) {
    attrObserver.observe(overlay, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  }

  function onBodyMutations(records) {
    let changed = false;
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches(DIALOG_SELECTOR)) { watchOverlay(n); changed = true; }
        n.querySelectorAll(DIALOG_SELECTOR).forEach(function (o) { watchOverlay(o); changed = true; });
      }
      for (const n of r.removedNodes) {
        if (n.nodeType === 1 && stack.some(function (e) { return n === e.overlay || n.contains(e.overlay); })) changed = true;
      }
    }
    if (changed) queueSync();
  }

  function top() { return stack[stack.length - 1]; }

  function closeTop(entry) {
    if (entry.dialog.getAttribute('aria-busy') === 'true') return;
    const explicit = entry.dialog.querySelector('[data-dialog-close]');
    if (explicit) { explicit.click(); return; }
    entry.overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    entry.overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    if (!isShown(entry.overlay)) return;
    const btn = tabbables(entry.dialog).find(function (b) {
      if (b.tagName !== 'BUTTON') return false;
      const name = (b.getAttribute('aria-label') || b.textContent || b.title || '').trim();
      return CLOSE_LABEL.test(name);
    });
    if (btn) btn.click();
  }

  // Re-sync on input so a dialog hidden in a way the observer missed can't leave the page inert.
  function recheck() {
    const entry = top();
    if (entry && !isShown(entry.overlay)) queueSync();
  }

  // Snapshot before any handler runs: one closing its own overlay pops the stack, and this Escape must not then close the dialog below.
  let escTarget = null;
  function onEscapeCapture(e) {
    if (e.key === 'Escape') escTarget = top();
  }

  function onKeydown(e) {
    const entry = top();
    if (!entry || !isShown(entry.overlay)) { recheck(); return; }
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (entry !== escTarget) return;
      e.preventDefault();
      closeTop(entry);
      return;
    }
    if (e.key !== 'Tab') return;
    const items = tabbables(entry.dialog);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!entry.dialog.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const ACTIVATABLE = '[role="button"]:not(button):not(input), [role="link"]:not(a), [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
  function onActivateKey(e) {
    if (e.defaultPrevented || (e.key !== 'Enter' && e.key !== ' ')) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const el = e.target;
    if (!el || !el.matches || !el.matches(ACTIVATABLE)) return;
    if (el.getAttribute('aria-disabled') === 'true') return;
    e.preventDefault();
    el.click();
  }

  function makeButton(el, label) {
    if (!el.getAttribute('role')) el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (label) el.setAttribute('aria-label', label);
    return el;
  }

  let politeEl = null;
  let assertiveEl = null;
  function liveRegion(level) {
    const existing = level === 'assertive' ? assertiveEl : politeEl;
    if (existing && existing.isConnected) return existing;
    const el = document.createElement('div');
    el.className = 'a11y-live sr-only';
    el.setAttribute('aria-live', level);
    el.setAttribute('aria-atomic', 'false');
    el.setAttribute('role', level === 'assertive' ? 'alert' : 'status');
    document.body.appendChild(el);
    if (level === 'assertive') assertiveEl = el; else politeEl = el;
    return el;
  }

  // One node per message so messages fired together are each read, and a repeat is a fresh addition.
  function announce(message, level) {
    if (!document.body || !message) return;
    const region = liveRegion(level === 'assertive' ? 'assertive' : 'polite');
    const item = document.createElement('div');
    item.textContent = String(message);
    region.appendChild(item);
    setTimeout(function () { item.remove(); }, 5000);
  }

  const STYLE = `
    .sr-only {
      position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
    :where(:focus-visible) { outline: 2px solid var(--focus-ring, var(--accent, #4a9eff)); outline-offset: 2px; }
    :where(input, textarea, select):focus-visible { outline: none; }
    :where([contenteditable]):focus-visible { outline-offset: 0; }
    :where(.xterm :focus-visible, .monaco-editor :focus-visible, [role="dialog"]:focus-visible, [tabindex="-1"]:focus-visible) { outline: none; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
      }
    }
  `;

  function install() {
    const style = document.createElement('style');
    style.id = 'a11y-base-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
    liveRegion('polite');
    liveRegion('assertive');
    document.querySelectorAll(DIALOG_SELECTOR).forEach(watchOverlay);
    new MutationObserver(onBodyMutations).observe(document.body, { childList: true });
    sync();
  }

  document.addEventListener('focusin', function (e) {
    if (e.target && e.target.closest && !e.target.closest(DIALOG_SELECTOR)) lastFocusOutside = e.target;
  });
  // Window-level so any document or element Escape handler runs first.
  window.addEventListener('keydown', onEscapeCapture, true);
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('pointerdown', recheck, true);
  document.addEventListener('keydown', onActivateKey);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();

  return {
    announce: announce,
    makeButton: makeButton,
  };
})();
