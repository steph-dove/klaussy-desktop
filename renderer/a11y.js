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
  // The `a11y-` prefix lets focus keys skip generated ids, which change on every re-render.
  function ensureId(el, prefix) {
    if (!el.id) el.id = 'a11y-' + (prefix || 'id').replace(/^a11y-/, '') + '-' + (++idSeq);
    return el.id;
  }

  function stableId(node) {
    return node.id && !node.id.startsWith('a11y-') ? node.id : '';
  }

  // `refresh` re-points a generated label whose heading was replaced by a content swap.
  function labelDialog(dialog, refresh) {
    const by = dialog.getAttribute('aria-labelledby');
    if (refresh && by && by.startsWith('a11y-') && !document.getElementById(by)) dialog.removeAttribute('aria-labelledby');
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
    update();
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

  const lastLine = new WeakMap();
  const rangeAnchor = new WeakMap();

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
      target.focus();
      target.scrollIntoView({ block: 'nearest' });
    }
    // Shift+Up/Down builds a real text selection so the diff's selection actions (comment, explain) work from the keyboard.
    function extendSelection(from, dir) {
      const kept = rangeAnchor.get(container);
      const anchor = kept && kept.isConnected ? kept : from;
      rangeAnchor.set(container, anchor);
      go(from, opts.lineSelector, dir);
      const target = document.activeElement;
      if (!target || target === from) return;
      const forward = anchor === target || !!(anchor.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING);
      const start = forward ? anchor : target;
      const end = forward ? target : anchor;
      window.getSelection().setBaseAndExtent(start, 0, end, end.childNodes.length);
      const lines = Array.from(container.querySelectorAll(opts.lineSelector)).filter(isShown);
      const count = Math.abs(lines.indexOf(target) - lines.indexOf(anchor)) + 1;
      announce(count + (count === 1 ? ' line selected' : ' lines selected'));
    }
    // Labelled on focus so a line refocused after a re-render is still announced.
    container.addEventListener('focusin', function (e) {
      if (e.target === container || !e.target.matches(opts.lineSelector)) return;
      lastLine.set(container, e.target);
      if (opts.describe) e.target.setAttribute('aria-label', opts.describe(e.target));
    });
    container.addEventListener('keydown', function (e) {
      const from = e.target;
      if (from !== container && !(from.matches && from.matches(opts.lineSelector))) return;
      if (e.ctrlKey || e.metaKey) return;
      const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (dir) {
        e.preventDefault();
        if (e.shiftKey && !e.altKey && from !== container) { extendSelection(from, dir); return; }
        if (rangeAnchor.has(container)) {
          rangeAnchor.delete(container);
          window.getSelection().removeAllRanges();
        }
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
    // Picking an item hides the menu under focus; registered on the menu so it runs before the generic rescue.
    menu.addEventListener('focusout', function (e) {
      if (e.relatedTarget) return;
      setTimeout(function () {
        if (document.activeElement === document.body && !isShown(menu) && canTakeFocus(trigger)) trigger.focus();
      }, 0);
    });
    // Close via the trigger's own toggle so the caller's open/closed bookkeeping stays consistent.
    menu.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.key !== 'Tab') return;
      e.preventDefault();
      e.stopPropagation();
      if (isShown(menu)) trigger.click();
      trigger.focus();
    });
  }

  const VOLATILE_CLASS = /^(active|selected|open|visible|expanded|collapsed|loading|disabled|hidden|focused|dirty|on|is-.+|has-.+)$/;

  function keyOf(node, isTarget) {
    if (stableId(node)) return '#' + CSS.escape(node.id);
    let sel = '';
    for (const a of node.attributes) {
      if (a.name.startsWith('data-')) sel += '[' + a.name + '="' + CSS.escape(a.value) + '"]';
    }
    if (isTarget) {
      const cls = Array.from(node.classList).find(function (c) { return !VOLATILE_CLASS.test(c); });
      if (cls) sel = '.' + CSS.escape(cls) + sel;
      sel = node.tagName.toLowerCase() + sel;
    }
    return sel;
  }

  function captureFocusKey(host, focused) {
    const el = focused || document.activeElement;
    if (!el || el === host || !host.contains(el)) return null;
    const parts = [];
    for (let node = el; node && node !== host; node = node.parentElement) {
      const sel = keyOf(node, node === el);
      if (sel) parts.unshift(sel);
      if (stableId(node)) break;
    }
    const selector = parts.join(' ');
    return {
      selector: selector,
      index: Array.prototype.indexOf.call(host.querySelectorAll(selector), el),
      caret: typeof el.selectionStart === 'number' ? [el.selectionStart, el.selectionEnd] : null,
    };
  }

  // Skipped when the render already moved focus on purpose (e.g. opened a composer).
  function restoreFocusKey(host, key) {
    if (!key) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const matches = host.querySelectorAll(key.selector);
    const target = matches[key.index] || matches[0];
    if (!target) return;
    if (!target.hasAttribute('tabindex') && target.tabIndex < 0) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    if (key.caret && typeof target.setSelectionRange === 'function') {
      try { target.setSelectionRange(key.caret[0], key.caret[1]); } catch {}
    }
  }

  function preserveFocus(host, fn) {
    const key = captureFocusKey(host);
    const result = fn();
    restoreFocusKey(host, key);
    return result;
  }

  function describeDiffLine(line) {
    const code = (line.querySelector('.diff-code, .diff-hunk-text') || line).textContent;
    if (line.classList.contains('diff-hunk')) {
      const hunks = Array.from((line.closest('pre') || line.parentElement).querySelectorAll('.diff-line.diff-hunk'));
      return 'Hunk ' + (hunks.indexOf(line) + 1) + ' of ' + hunks.length + ': ' + code;
    }
    if (line.classList.contains('diff-add')) return 'Added line ' + line.dataset.newLn + ': ' + code;
    if (line.classList.contains('diff-del')) return 'Removed line ' + line.dataset.oldLn + ': ' + code;
    if (line.dataset.newLn) return 'Line ' + line.dataset.newLn + ': ' + code;
    return code;
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
    :where(:focus-visible) { outline: 2px solid var(--focus-ring, var(--accent, #4a9eff)) !important; outline-offset: 2px; }
    :where(input, textarea, select, [contenteditable]):focus-visible { outline-offset: 0; }
    :where([role="tab"], .file-viewer-tab, .diff-tab):focus-visible { outline-offset: -2px; }
    :where(.xterm :focus-visible, .monaco-editor :focus-visible, [role="dialog"]:focus-visible) { outline: none !important; }
    @media (forced-colors: active) {
      :where(.status-dot, .grid-dot, .ci-status-icon, .agent-item-status, .minihud-dot, .unread-badge) { forced-color-adjust: none; }
      :where([aria-selected="true"], [aria-current="true"], [aria-pressed="true"], [aria-checked="true"][role="radio"]) { outline: 2px solid Highlight; outline-offset: -2px; }
    }
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

  let lastFocused = null;
  let rescueQueued = false;
  let lastInputAt = 0;

  function canTakeFocus(el) {
    return !!el && isShown(el) && !el.disabled && !el.closest('[inert]') && el.getAttribute('aria-hidden') !== 'true';
  }

  // A re-render that removes, disables or hides the focused control drops focus to <body>; put it back nearby.
  function focusLost() {
    return !document.activeElement || document.activeElement === document.body;
  }

  // A control disabled while busy usually comes back; wait for it rather than moving focus somewhere unrelated.
  function awaitReenable(lost) {
    const startedAt = Date.now();
    const deadline = startedAt + 120000;
    (function poll() {
      if (lastFocused !== lost || !focusLost() || lastInputAt > startedAt || Date.now() > deadline) return;
      if (lost.el.isConnected && isShown(lost.el) && lost.el.disabled) { setTimeout(poll, 200); return; }
      if (canTakeFocus(lost.el)) lost.el.focus({ preventScroll: true });
      else rescueFocus(true);
    })();
  }

  function rescueFocus(afterWait) {
    rescueQueued = false;
    const lost = lastFocused;
    if (!lost || !focusLost()) return;
    if (canTakeFocus(lost.el)) return;
    if (!afterWait && lost.el.isConnected && isShown(lost.el) && lost.el.disabled) { awaitReenable(lost); return; }
    for (const anc of lost.ancestors) {
      const line = anc.isConnected && lastLine.get(anc);
      if (line && line !== lost.el && line.isConnected && isShown(line)) { line.focus({ preventScroll: true }); return; }
    }
    // An unkeyed index match is just the next row, e.g. the following row's Remove after a delete.
    const twin = lost.keyed && lost.key.index >= 0 && document.querySelectorAll(lost.key.selector)[lost.key.index];
    if (twin && twin !== lost.el && canTakeFocus(twin)) { twin.focus({ preventScroll: true }); return; }
    for (let i = 0; i < lost.ancestors.length; i++) {
      const anc = lost.ancestors[i];
      if (!anc.isConnected || !isShown(anc) || anc.closest('[inert]')) continue;
      if (anc === document.body) return;
      if (anc.matches('[role="dialog"]')) { labelDialog(anc, true); focusFirst(anc, anc); return; }
      const next = nearSlot(anc, lost.slots[i]);
      if (next) { next.focus({ preventScroll: true }); return; }
      if (anc.matches('[tabindex], [role="region"], [role="dialog"], [role="main"], [role="navigation"], [role="complementary"], main, nav, aside')) {
        if (!anc.hasAttribute('tabindex')) anc.setAttribute('tabindex', '-1');
        anc.focus({ preventScroll: true });
        return;
      }
    }
  }

  // Prefer the control that now occupies the lost one's position, e.g. the Cancel that replaced Run.
  function nearSlot(anc, slot) {
    const all = Array.from(anc.querySelectorAll(FOCUSABLE));
    if (!all.length) return null;
    const start = Math.min(slot == null ? 0 : slot, all.length - 1);
    for (let d = 0; d < all.length; d++) {
      const after = all[start + d];
      if (after && canTakeFocus(after)) return after;
      const before = all[start - d - 1];
      if (before && canTakeFocus(before)) return before;
    }
    return null;
  }

  function hasOwnKey(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (stableId(n)) return n === el;
      if (keyOf(n, false)) return true;
    }
    return false;
  }

  function queueRescue() {
    if (rescueQueued || !lastFocused) return;
    rescueQueued = true;
    setTimeout(function () { rescueFocus(false); }, 0);
  }

  document.addEventListener('focusin', function (e) {
    if (e.target && e.target.closest && !e.target.closest(DIALOG_SELECTOR)) lastFocusOutside = e.target;
    const el = e.target;
    if (!el || el === document.body || !el.closest) return;
    if (el.closest('.xterm, .monaco-editor')) { lastFocused = null; return; }
    const ancestors = [];
    const slots = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      ancestors.push(n);
      slots.push(slots.length < 4 && el.tabIndex >= 0 ? Array.prototype.indexOf.call(n.querySelectorAll(FOCUSABLE), el) : null);
    }
    lastFocused = { el: el, key: captureFocusKey(document.body, el) || { selector: el.tagName.toLowerCase(), index: -1 }, keyed: hasOwnKey(el), ancestors: ancestors, slots: slots };
  });
  function noteInput() { lastInputAt = Date.now(); }
  window.addEventListener('pointerdown', noteInput, true);
  window.addEventListener('keydown', noteInput, true);
  document.addEventListener('focusout', function (e) { if (!e.relatedTarget) queueRescue(); });
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
    describeDiffLine: describeDiffLine,
    dropdownMenu: dropdownMenu,
    preserveFocus: preserveFocus,
    tabs: tabs,
    radios: radios,
    tabbables: tabbables,
  };
})();
