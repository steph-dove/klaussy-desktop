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

  const ACTIVATABLE = ['button', 'link', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'tab']
    .map(function (r) { return '[role="' + r + '"]:not(button):not(input):not(a[href])'; }).join(',');
  function onActivateKey(e) {
    if (e.defaultPrevented || (e.key !== 'Enter' && e.key !== ' ')) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const el = e.target;
    if (!el || !el.matches || !el.matches(ACTIVATABLE)) return;
    if (el.getAttribute('aria-disabled') === 'true') return;
    e.preventDefault();
    el.click();
  }

  // Chromium doesn't map Shift+F10 to contextmenu on every platform, so do it here.
  function onContextMenuKey(e) {
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
    const el = document.activeElement;
    if (!el || el === document.body) return;
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(r.left + Math.min(r.width, 24)),
      clientY: Math.round(r.top + Math.min(r.height, 24)),
    }));
  }

  // Windows fires the native contextmenu on keyup; it would land on the just-opened menu and close it.
  function onContextMenuKeyUp(e) {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) e.preventDefault();
  }

  const NEXT_KEYS = { vertical: ['ArrowDown'], horizontal: ['ArrowRight'], both: ['ArrowDown', 'ArrowRight'] };
  const PREV_KEYS = { vertical: ['ArrowUp'], horizontal: ['ArrowLeft'], both: ['ArrowUp', 'ArrowLeft'] };

  function stepTarget(e, items, current, orientation) {
    const i = items.indexOf(current);
    if (NEXT_KEYS[orientation].includes(e.key)) return items[(i + 1) % items.length];
    if (PREV_KEYS[orientation].includes(e.key)) return items[(i - 1 + items.length) % items.length];
    if (e.key === 'Home') return items[0];
    if (e.key === 'End') return items[items.length - 1];
    return null;
  }

  // Items keep their own tab stops; arrows are a shortcut on top of Tab.
  function arrowNav(container, selector, opts) {
    const orientation = (opts && opts.orientation) || 'vertical';
    container.addEventListener('keydown', function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const current = e.target.closest && e.target.closest(selector);
      if (!current || !container.contains(current)) return;
      const items = Array.from(container.querySelectorAll(selector)).filter(isShown);
      const next = stepTarget(e, items, current, orientation);
      if (!next) return;
      e.preventDefault();
      next.focus();
    });
  }

  function selectedIn(items) {
    return items.find(function (el) { return el.classList.contains('active') || el.classList.contains('selected'); });
  }

  // State follows the `.active` class the existing click handlers already toggle.
  function selectionGroup(container, opts, cfg) {
    const selector = opts.itemSelector;
    const orientation = opts.orientation || 'horizontal';
    let syncing = false;

    function sync() {
      if (syncing) return;
      syncing = true;
      const items = Array.from(container.querySelectorAll(selector));
      const selected = selectedIn(items);
      const shown = items.filter(isShown);
      const holder = shown.includes(document.activeElement) ? document.activeElement
        : (selected && isShown(selected) ? selected : shown[0]);
      if (!container.getAttribute('role')) container.setAttribute('role', cfg.groupRole);
      if (opts.label && !container.hasAttribute('aria-label')) container.setAttribute('aria-label', opts.label);
      items.forEach(function (el) {
        el.setAttribute('role', cfg.itemRole);
        el.setAttribute(cfg.stateAttr, el === selected ? 'true' : 'false');
        el.tabIndex = el === holder ? 0 : -1;
        const panel = opts.panelFor && opts.panelFor(el);
        if (panel) {
          el.setAttribute('aria-controls', ensureId(panel, 'a11y-tabpanel'));
          panel.setAttribute('role', 'tabpanel');
          panel.setAttribute('aria-labelledby', ensureId(el, 'a11y-tab'));
        }
      });
      syncing = false;
    }

    container.addEventListener('keydown', function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const current = e.target.closest && e.target.closest(selector);
      if (!current || !container.contains(current)) return;
      const items = Array.from(container.querySelectorAll(selector)).filter(isShown);
      const next = stepTarget(e, items, current, orientation);
      if (!next) return;
      e.preventDefault();
      items.forEach(function (el) { el.tabIndex = el === next ? 0 : -1; });
      next.focus();
      if (cfg.selectOnMove) (opts.onMove ? opts.onMove(next) : next.click());
    });
    container.addEventListener('focusin', sync);
    new MutationObserver(sync).observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    sync();
  }

  // Manual activation: several tab panels load content when selected.
  function tabs(container, opts) {
    selectionGroup(container, opts, { groupRole: 'tablist', itemRole: 'tab', stateAttr: 'aria-selected', selectOnMove: false });
  }

  function radios(container, opts) {
    selectionGroup(container, opts, { groupRole: 'radiogroup', itemRole: 'radio', stateAttr: 'aria-checked', selectOnMove: true });
  }

  // Mirrors a list's highlighted item into ARIA for an input that already handles the arrow keys.
  function combobox(input, list, opts) {
    const selector = opts.optionSelector;
    const activeClasses = opts.activeClass ? [opts.activeClass] : ['selected', 'active'];
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', ensureId(list, 'listbox'));
    if (opts.label) input.setAttribute('aria-label', opts.label);
    list.setAttribute('role', 'listbox');
    if (opts.label) list.setAttribute('aria-label', opts.label);
    function mark(el) {
      const selected = activeClasses.some(function (c) { return el.classList.contains(c); });
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', selected ? 'true' : 'false');
      ensureId(el, 'option');
      return selected;
    }
    function setActiveDescendant(active) {
      if (active) input.setAttribute('aria-activedescendant', active.id);
      else input.removeAttribute('aria-activedescendant');
    }
    function sync() {
      let active = null;
      list.querySelectorAll(selector).forEach(function (el) { if (mark(el)) active = el; });
      setActiveDescendant(active);
    }
    function onMutations(records) {
      if (records.some(function (r) { return r.type === 'childList'; })) { sync(); return; }
      let active;
      records.forEach(function (r) {
        const el = r.target;
        if (!el.matches || !el.matches(selector)) return;
        if (mark(el)) active = el;
        else if (active === undefined && input.getAttribute('aria-activedescendant') === el.id) active = null;
      });
      if (active !== undefined) setActiveDescendant(active);
    }
    new MutationObserver(onMutations).observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    sync();
  }

  function popupList(button, list, itemSelector, close) {
    arrowNav(list, itemSelector);
    list.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
      button.focus();
    });
    return function focusFirst() {
      const first = list.querySelector(itemSelector);
      if (first) first.focus();
    };
  }

  // `grow` is ArrowLeft for a pane anchored to the right edge.
  function splitter(handle, opts) {
    const grow = opts.grow || 'ArrowRight';
    const shrink = grow === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', opts.label);
    handle.tabIndex = 0;
    function update() {
      handle.setAttribute('aria-valuemin', String(Math.round(opts.min())));
      handle.setAttribute('aria-valuemax', String(Math.round(opts.max())));
      handle.setAttribute('aria-valuenow', String(Math.round(opts.get())));
    }
    handle.addEventListener('focus', update);
    if (opts.commit) {
      handle.addEventListener('keyup', function (e) {
        if (e.key === grow || e.key === shrink || e.key === 'Home' || e.key === 'End') opts.commit();
      });
    }
    handle.addEventListener('keydown', function (e) {
      const step = e.shiftKey ? 50 : 10;
      let width = opts.get();
      if (e.key === grow) width += step;
      else if (e.key === shrink) width -= step;
      else if (e.key === 'Home') width = opts.min();
      else if (e.key === 'End') width = opts.max();
      else if (e.key === 'Enter' && opts.onEnter) { e.preventDefault(); opts.onEnter(); update(); return; }
      else return;
      e.preventDefault();
      opts.set(Math.max(opts.min(), Math.min(width, opts.max())));
      update();
    });
  }

  // Lines get tabindex only when reached, so a large diff costs one tab stop and no per-line setup.
  function lineNav(container, opts) {
    if (!container.hasAttribute('tabindex')) container.tabIndex = 0;
    if (opts.label) container.setAttribute('aria-label', opts.label);
    function go(from, selector, dir) {
      const all = Array.from(container.querySelectorAll(selector)).filter(isShown);
      if (!all.length) return;
      let target;
      if (from === container) {
        target = dir > 0 ? all[0] : all[all.length - 1];
      } else {
        const pos = from.compareDocumentPosition.bind(from);
        target = dir > 0
          ? all.find(function (el) { return pos(el) & Node.DOCUMENT_POSITION_FOLLOWING; })
          : all.slice().reverse().find(function (el) { return pos(el) & Node.DOCUMENT_POSITION_PRECEDING; });
      }
      if (!target) return;
      target.tabIndex = -1;
      if (opts.describe) target.setAttribute('aria-label', opts.describe(target));
      target.focus();
      target.scrollIntoView({ block: 'nearest' });
    }
    container.addEventListener('keydown', function (e) {
      const from = e.target;
      if (from !== container && !(from.matches && from.matches(opts.lineSelector))) return;
      if (e.ctrlKey || e.metaKey) return;
      const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (dir) {
        e.preventDefault();
        go(from, e.altKey ? opts.hunkSelector : opts.lineSelector, dir);
      } else if ((e.key === 'Enter' || e.key === 'c') && from !== container && opts.onActivate) {
        if (opts.onActivate(from) !== false) e.preventDefault();
      }
    });
  }

  // Opening is detected from the menu's own visibility, so callers keep their toggle code.
  function dropdownMenu(trigger, menu, itemSelector) {
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    menu.setAttribute('role', 'menu');
    let open = false;
    function sync() {
      const nowOpen = isShown(menu);
      if (nowOpen === open) return;
      open = nowOpen;
      trigger.setAttribute('aria-expanded', String(open));
      if (!open) return;
      const items = Array.from(menu.querySelectorAll(itemSelector));
      items.forEach(function (el) { el.setAttribute('role', 'menuitem'); });
      if (items[0]) items[0].focus();
    }
    new MutationObserver(sync).observe(menu, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
    arrowNav(menu, itemSelector);
    menu.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.key !== 'Tab') return;
      e.preventDefault();
      e.stopPropagation();
      menu.style.display = 'none';
      trigger.focus();
    });
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
    :where(.xterm :focus-visible, .monaco-editor :focus-visible, [role="dialog"]:focus-visible) { outline: none; }
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
  window.addEventListener('keydown', onContextMenuKey, true);
  window.addEventListener('keyup', onContextMenuKeyUp, true);
  document.addEventListener('keydown', onActivateKey);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();

  return {
    announce: announce,
    makeButton: makeButton,
    arrowNav: arrowNav,
    combobox: combobox,
    popupList: popupList,
    splitter: splitter,
    lineNav: lineNav,
    dropdownMenu: dropdownMenu,
    tabs: tabs,
    radios: radios,
    tabbables: tabbables,
  };
})();
