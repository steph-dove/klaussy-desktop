// Progressive-enhancement searchable dropdown.
//
// Wraps a native <select> — which stays the source of truth — with a custom
// trigger button + popover that has a search box at the top and a filterable,
// optgroup-aware list. The native select keeps doing everything it did before:
// callers still populate it via innerHTML/appendChild, read `.value`, and
// listen for 'change'. Picking an item just sets the select's value and
// dispatches a native 'change' event, so existing wiring is untouched.
//
// Re-population (an innerHTML rewrite) is picked up via a MutationObserver, so
// dropdowns that fill in asynchronously (sessions discovery, sidebar repo
// filters) light up automatically.
window.SearchableSelect = (function () {
  var openInstance = null; // only one popover open at a time

  function enhance(select, opts) {
    if (!select || select.__ssEnhanced) return select && select.__ss;
    opts = opts || {};
    select.__ssEnhanced = true;

    // Wrap the select so the custom UI lives right where the select did,
    // inheriting its flex sizing from the parent row.
    var wrap = document.createElement('div');
    wrap.className = 'searchable-select';
    if (opts.className) wrap.classList.add(opts.className);
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.classList.add('ss-native');

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'ss-trigger';
    trigger.innerHTML = '<span class="ss-label"></span><span class="ss-caret">▾</span>';
    wrap.appendChild(trigger);
    var labelEl = trigger.querySelector('.ss-label');

    var popover = document.createElement('div');
    popover.className = 'ss-popover';
    popover.hidden = true;
    popover.innerHTML =
      '<div class="ss-search-row">'
        + '<input type="text" class="ss-search" autocomplete="off" spellcheck="false" '
        + 'placeholder="' + (opts.searchPlaceholder || 'Search…') + '" />'
      + '</div>'
      + '<div class="ss-list" role="listbox"></div>';
    wrap.appendChild(popover);
    var searchInput = popover.querySelector('.ss-search');
    var listEl = popover.querySelector('.ss-list');

    var activeEl = null; // keyboard-highlighted item

    function selectedOption() {
      return select.options[select.selectedIndex] || null;
    }

    function syncLabel() {
      var opt = selectedOption();
      var text = opt ? opt.textContent : '';
      labelEl.textContent = text || (opts.placeholder || 'Select…');
      // Dim when the empty/"all"/placeholder option is selected.
      trigger.classList.toggle('ss-placeholder', !opt || opt.value === '');
      trigger.title = (opt && opt.title) || text || '';
    }

    function buildList() {
      listEl.innerHTML = '';
      var sel = select.value;

      function addOption(opt) {
        var item = document.createElement('div');
        item.className = 'ss-item';
        item.setAttribute('role', 'option');
        item.dataset.value = opt.value;
        item.textContent = opt.textContent;
        if (opt.title) item.title = opt.title;
        if (opt.disabled) item.classList.add('ss-disabled');
        if (opt.value === sel) item.classList.add('ss-selected');
        // mousedown (not click) so the search input doesn't blur-close first.
        item.addEventListener('mousedown', function (e) {
          e.preventDefault();
          if (!opt.disabled) choose(opt.value);
        });
        item.addEventListener('mousemove', function () { setActive(item); });
        listEl.appendChild(item);
      }

      Array.prototype.forEach.call(select.children, function (node) {
        if (node.tagName === 'OPTGROUP') {
          var head = document.createElement('div');
          head.className = 'ss-group';
          head.textContent = node.label;
          listEl.appendChild(head);
          Array.prototype.forEach.call(node.children, function (o) {
            if (o.tagName === 'OPTION') addOption(o);
          });
        } else if (node.tagName === 'OPTION') {
          addOption(node);
        }
      });

      var empty = document.createElement('div');
      empty.className = 'ss-empty';
      empty.textContent = 'No matches';
      empty.hidden = true;
      listEl.appendChild(empty);

      filter(searchInput.value);
    }

    function filter(q) {
      q = (q || '').trim().toLowerCase();
      var any = false;
      listEl.querySelectorAll('.ss-item').forEach(function (item) {
        var match = !q || item.textContent.toLowerCase().indexOf(q) !== -1;
        item.hidden = !match;
        if (match) any = true;
      });
      // Hide a group header when nothing under it survives the filter.
      listEl.querySelectorAll('.ss-group').forEach(function (head) {
        var n = head.nextElementSibling;
        var visible = false;
        while (n && !n.classList.contains('ss-group')) {
          if (n.classList.contains('ss-item') && !n.hidden) { visible = true; break; }
          n = n.nextElementSibling;
        }
        head.hidden = !visible;
      });
      var emptyEl = listEl.querySelector('.ss-empty');
      if (emptyEl) emptyEl.hidden = any;
      setActive(listEl.querySelector('.ss-item:not([hidden]):not(.ss-disabled)'));
    }

    function setActive(item) {
      if (activeEl) activeEl.classList.remove('ss-active');
      activeEl = item || null;
      if (activeEl) {
        activeEl.classList.add('ss-active');
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }

    function choose(value) {
      if (select.value !== value) {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      syncLabel();
      close();
      trigger.focus();
    }

    function open() {
      if (openInstance && openInstance !== api) openInstance.close();
      openInstance = api;
      buildList();
      popover.hidden = false;
      wrap.classList.add('ss-open');
      searchInput.value = '';
      filter('');
      var selItem = listEl.querySelector('.ss-item.ss-selected:not([hidden])');
      if (selItem) setActive(selItem);
      setTimeout(function () { searchInput.focus(); }, 0);
    }

    function close() {
      if (popover.hidden) return;
      popover.hidden = true;
      wrap.classList.remove('ss-open');
      if (openInstance === api) openInstance = null;
    }

    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      popover.hidden ? open() : close();
    });

    searchInput.addEventListener('input', function () { filter(searchInput.value); });

    searchInput.addEventListener('keydown', function (e) {
      var visible = Array.prototype.slice.call(
        listEl.querySelectorAll('.ss-item:not([hidden]):not(.ss-disabled)'));
      var idx = visible.indexOf(activeEl);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(visible[Math.min(idx + 1, visible.length - 1)] || visible[0]);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(visible[Math.max(idx - 1, 0)] || visible[0]);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeEl) choose(activeEl.dataset.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
        trigger.focus();
      }
    });

    // Click outside closes.
    document.addEventListener('mousedown', function (e) {
      if (!popover.hidden && !wrap.contains(e.target)) close();
    });

    // External re-population (innerHTML rewrite) → refresh label, and rebuild
    // the list if the popover is currently open.
    var mo = new MutationObserver(function () {
      syncLabel();
      if (!popover.hidden) buildList();
    });
    mo.observe(select, { childList: true, subtree: true });

    // Other code may set the value and dispatch 'change' — keep our label honest.
    select.addEventListener('change', syncLabel);

    syncLabel();

    var api = {
      open: open,
      close: close,
      refresh: function () { syncLabel(); if (!popover.hidden) buildList(); },
    };
    select.__ss = api;
    return api;
  }

  return { enhance: enhance };
})();
