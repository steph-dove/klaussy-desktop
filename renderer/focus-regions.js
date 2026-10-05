// F6 / Shift+F6 cycle focus between regions; it's the way out of a terminal, which keeps Tab and Escape.
(function () {
  function byId(id) { return function () { return document.getElementById(id); }; }

  function diffPanelShown() {
    return document.getElementById('diff-panel').classList.contains('visible');
  }

  function prReviewShown() {
    const root = document.getElementById('pr-review-root');
    return !!root && root.style.display !== 'none';
  }

  function focusFirstIn(el) {
    const items = A11y.tabbables(el);
    const preferred = items.find(function (n) {
      return n.getAttribute('aria-selected') === 'true' || n.hasAttribute('aria-current') || n.classList.contains('active');
    });
    const target = preferred || items[0];
    if (!target) return false;
    target.focus();
    return true;
  }

  function inReview(selector) {
    return function () { return document.querySelector('#pr-review-root ' + selector); };
  }

  // The PR review pop-out has no sidebar or panels; F6 is still the only way out of its terminal.
  const POPOUT_REGIONS = [
    { label: 'Pull request header', el: inReview('.pr-review-header') },
    { label: 'Review sections', el: inReview('.pr-review-tabs') },
    { label: 'Section content', el: inReview('.pr-review-body') },
    {
      label: 'Terminal',
      el: inReview('.pr-implement-terminal-body'),
      focus: function (el) {
        const input = el.querySelector('.xterm-helper-textarea');
        if (!input) return focusFirstIn(el);
        input.focus();
        return true;
      },
    },
  ];

  // The editor is nested in the changes panel, so it must come after it.
  const MAIN_REGIONS = [
    { label: 'Sidebar', el: byId('sidebar') },
    {
      label: 'Terminals',
      el: byId('terminal-area'),
      shown: function () { return !prReviewShown(); },
      focus: function (el) { return window.TerminalManager.focusActive() || focusFirstIn(el); },
    },
    { label: 'Pull request review', el: byId('pr-review-root'), shown: prReviewShown },
    {
      label: 'Changes panel',
      el: byId('diff-panel'),
      shown: diffPanelShown,
    },
    {
      label: 'Agents',
      el: byId('agents-panel'),
      shown: function () { return document.getElementById('agents-panel').style.display !== 'none'; },
    },
    // Error toasts stay until dismissed, so keyboard users need a way to reach them.
    {
      label: 'Notifications',
      el: byId('klaussy-toast-stack'),
      shown: function () { return !!document.querySelector('#klaussy-toast-stack .klaussy-toast'); },
    },
    {
      label: 'Editor',
      el: byId('file-viewer-content'),
      shown: diffPanelShown,
      focus: function () {
        const ed = window.FileBrowser && window.FileBrowser.getActiveEditor && window.FileBrowser.getActiveEditor();
        if (!ed) return false;
        ed.focus();
        return true;
      },
    },
  ];

  const REGIONS = document.getElementById('sidebar') ? MAIN_REGIONS : POPOUT_REGIONS;

  const lastFocus = new Map();

  function available(region) {
    const el = region.el();
    if (!el || el.closest('[inert]') || !el.getClientRects().length) return false;
    return region.shown ? region.shown() : true;
  }

  function regionOf(node) {
    let found = -1;
    REGIONS.forEach(function (r, i) {
      const el = r.el();
      if (el && el.contains(node)) found = i;
    });
    return found;
  }

  function enter(region) {
    const el = region.el();
    const remembered = lastFocus.get(region);
    if (remembered && remembered.isConnected && el.contains(remembered) && remembered.getClientRects().length) {
      remembered.focus();
    } else if (region.focus) {
      region.focus(el);
    } else {
      focusFirstIn(el);
    }
    // focus() is a silent no-op on hidden nodes, so trust where focus landed, not what was called.
    if (!el.contains(document.activeElement)) return false;
    A11y.announce(region.label);
    return true;
  }

  function cycle(step) {
    const n = REGIONS.length;
    const current = regionOf(document.activeElement);
    const base = current >= 0 ? current : (step > 0 ? -1 : n);
    for (let k = 1; k <= n; k++) {
      const region = REGIONS[((base + step * k) % n + n) % n];
      if (available(region) && enter(region)) return;
    }
  }

  document.addEventListener('focusin', function (e) {
    const i = regionOf(e.target);
    if (i >= 0) lastFocus.set(REGIONS[i], e.target);
  });

  window.addEventListener('keydown', function (e) {
    if (e.key !== 'F6' || e.altKey || e.ctrlKey || e.metaKey) return;
    if (document.activeElement.closest('[aria-modal="true"]')) return;
    e.preventDefault();
    e.stopPropagation();
    cycle(e.shiftKey ? -1 : 1);
  }, true);

})();
