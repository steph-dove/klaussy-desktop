window.ContextMenu = (function () {
  var contextMenu = null;
  var opener = null;

  function remove() {
    if (!contextMenu) return;
    var hadFocus = contextMenu.contains(document.activeElement);
    contextMenu.remove();
    contextMenu = null;
    if (hadFocus && opener && opener.isConnected) opener.focus();
    opener = null;
  }

  document.addEventListener('click', remove);
  document.addEventListener('contextmenu', remove);

  function items() {
    return Array.from(contextMenu.querySelectorAll('[role="menuitem"]'));
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
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      var ch = e.key.toLowerCase();
      var rest = list.slice(i + 1).concat(list.slice(0, i + 1));
      next = rest.find(function (el) { return el.textContent.trim().toLowerCase().startsWith(ch); }) || null;
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
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;
      item.innerHTML = entry.label + '<span class="shortcut">' + (entry.shortcut || '') + '</span>';
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        remove();
        entry.action();
      });
      item.addEventListener('mouseenter', function () { item.focus({ preventScroll: true }); });
      menu.appendChild(item);
    });

    menu.addEventListener('keydown', onKeydown);
    document.body.appendChild(menu);
    contextMenu = menu;

    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';

    var first = menu.querySelector('[role="menuitem"]');
    if (first) first.focus();
  }

  return { show: show, remove: remove };
})();
