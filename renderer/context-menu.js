window.ContextMenu = (function () {
  var contextMenu = null;
  var opener = null;

  function remove() {
    if (!contextMenu) return;
    // Cleared first: removing the focused menu can fire focusout, which calls back in here.
    var menu = contextMenu;
    var target = opener;
    contextMenu = null;
    opener = null;
    var hadFocus = menu.contains(document.activeElement);
    menu.remove();
    if (hadFocus && target && target.isConnected) target.focus();
  }

  document.addEventListener('click', remove);
  document.addEventListener('contextmenu', function (e) {
    if (contextMenu && contextMenu.contains(e.target)) { e.preventDefault(); return; }
    remove();
  });

  function items() {
    return Array.from(contextMenu.querySelectorAll('[role^="menuitem"]'));
  }

  function onKeydown(e) {
    var list = items();
    var i = list.indexOf(document.activeElement);
    var next = null;
    if (e.key === 'ArrowDown') next = list[(i + 1) % list.length];
    else if (e.key === 'ArrowUp') next = list[(i - 1 + list.length) % list.length];
    else if (e.key === 'Home') next = list[0];
    else if (e.key === 'End') next = list[list.length - 1];
    else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      remove();
      return;
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      var ch = e.key.toLowerCase();
      var rest = list.slice(i + 1).concat(list.slice(0, i + 1));
      next = rest.find(function (el) {
        return el.textContent.replace(/^\s*\u2713?\s*/, '').toLowerCase().startsWith(ch);
      }) || null;
    }
    if (next) {
      e.preventDefault();
      next.focus();
    }
  }

  function show(x, y, items) {
    var previous = document.activeElement;
    remove();
    opener = previous && previous !== document.body ? previous : null;

    var menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    items.forEach(function (entry) {
      if (entry.sep) {
        var sep = document.createElement('div');
        sep.className = 'context-menu-sep';
        sep.setAttribute('role', 'separator');
        menu.appendChild(sep);
        return;
      }
      var item = document.createElement('div');
      item.className = 'context-menu-item';
      item.tabIndex = -1;
      item.innerHTML = entry.label + '<span class="shortcut">' + (entry.shortcut || '') + '</span>';
      // `checked` (true/false) makes a toggle item; the tick is visual, aria-checked carries the state.
      if (typeof entry.checked === 'boolean') {
        item.setAttribute('role', 'menuitemcheckbox');
        item.setAttribute('aria-checked', String(entry.checked));
        item.insertAdjacentHTML('afterbegin', '<span class="context-menu-check" aria-hidden="true">' + (entry.checked ? '\u2713 ' : '\u2003') + '</span>');
      } else {
        item.setAttribute('role', 'menuitem');
      }
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        remove();
        entry.action();
      });
      // Not mouseenter: that fires when a keyboard-opened menu appears under a resting cursor.
      item.addEventListener('mousemove', function () {
        if (document.activeElement !== item) item.focus({ preventScroll: true });
      });
      menu.appendChild(item);
    });

    menu.addEventListener('keydown', onKeydown);
    menu.addEventListener('focusout', function (e) {
      if (contextMenu === menu && !menu.contains(e.relatedTarget)) remove();
    });
    document.body.appendChild(menu);
    contextMenu = menu;

    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';

    var first = menu.querySelector('[role^="menuitem"]');
    if (first) first.focus();
  }

  return { show: show, remove: remove };
})();
