window.ContextMenu = (function () {
  var contextMenu = null;

  function remove() {
    if (contextMenu) {
      contextMenu.remove();
      contextMenu = null;
    }
  }

  document.addEventListener('click', remove);
  document.addEventListener('contextmenu', remove);

  function show(x, y, items) {
    remove();

    var menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    items.forEach(function (entry) {
      if (entry.sep) {
        var sep = document.createElement('div');
        sep.className = 'context-menu-sep';
        menu.appendChild(sep);
        return;
      }
      var item = document.createElement('div');
      item.className = 'context-menu-item';
      item.innerHTML = entry.label + '<span class="shortcut">' + (entry.shortcut || '') + '</span>';
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        remove();
        entry.action();
      });
      menu.appendChild(item);
    });

    document.body.appendChild(menu);
    contextMenu = menu;

    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';
  }

  return { show: show, remove: remove };
})();
