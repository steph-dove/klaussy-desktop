window.CommandPalette = (function () {
  var paletteOverlay = null;

  function show(commands) {
    if (paletteOverlay) { hide(); return; }

    paletteOverlay = document.createElement('div');
    paletteOverlay.className = 'palette-overlay';

    var palette = document.createElement('div');
    palette.className = 'palette';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'palette-input';
    input.placeholder = 'Type a command...';
    input.autocomplete = 'off';
    input.spellcheck = false;

    var list = document.createElement('div');
    list.className = 'palette-list';

    var filtered = commands;
    var selectedIndex = 0;

    function render() {
      list.innerHTML = '';
      filtered.forEach(function (cmd, i) {
        var item = document.createElement('div');
        item.className = 'palette-item' + (i === selectedIndex ? ' selected' : '');
        item.textContent = cmd.label;
        item.addEventListener('click', function () {
          hide();
          cmd.action();
        });
        item.addEventListener('mouseenter', function () {
          selectedIndex = i;
          render();
        });
        list.appendChild(item);
      });
    }

    input.addEventListener('input', function () {
      var q = input.value.toLowerCase();
      filtered = commands.filter(function (c) { return c.label.toLowerCase().includes(q); });
      selectedIndex = 0;
      render();
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          hide();
          filtered[selectedIndex].action();
        }
      } else if (e.key === 'Escape') {
        hide();
      }
    });

    paletteOverlay.addEventListener('click', function (e) {
      if (e.target === paletteOverlay) hide();
    });

    palette.appendChild(input);
    palette.appendChild(list);
    paletteOverlay.appendChild(palette);
    document.body.appendChild(paletteOverlay);
    render();
    setTimeout(function () { input.focus(); }, 50);
  }

  function hide() {
    if (paletteOverlay) {
      paletteOverlay.remove();
      paletteOverlay = null;
    }
  }

  return { show: show, hide: hide };
})();
