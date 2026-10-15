// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
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

    var wasEmpty = false;
    function render() {
      list.innerHTML = '';
      var empty = filtered.length === 0;
      if (empty !== wasEmpty) {
        wasEmpty = empty;
        if (empty) A11y.announce('No matching commands');
      }
      if (empty) {
        var none = document.createElement('div');
        none.className = 'palette-empty';
        none.setAttribute('aria-hidden', 'true');
        none.textContent = 'No matching commands';
        list.appendChild(none);
      }
      filtered.forEach(function (cmd, i) {
        var item = document.createElement('div');
        item.className = 'palette-item' + (i === selectedIndex ? ' selected' : '');
        item.dataset.index = i;
        item.textContent = cmd.label;
        item.addEventListener('click', function () {
          hide();
          cmd.action();
        });
        list.appendChild(item);
      });
    }

    // Hover passes scroll=false so the list doesn't jump under the pointer.
    function updateSelection(scroll) {
      var items = list.querySelectorAll('.palette-item');
      items.forEach(function (el, i) { el.classList.toggle('selected', i === selectedIndex); });
      var el = items[selectedIndex];
      if (scroll && el) el.scrollIntoView({ block: 'nearest' });
    }

    // Scrolling a list under a still pointer fires hover events too; only a
    // pointer that actually moved may take the selection from the arrow keys.
    var lastPointer = null;
    list.addEventListener('mousemove', function (e) {
      if (lastPointer && lastPointer.x === e.clientX && lastPointer.y === e.clientY) return;
      lastPointer = { x: e.clientX, y: e.clientY };
      var item = e.target.closest('.palette-item');
      if (!item || Number(item.dataset.index) === selectedIndex) return;
      selectedIndex = Number(item.dataset.index);
      updateSelection(false);
    });

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
        updateSelection(true);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        updateSelection(true);
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
    palette.setAttribute('aria-label', 'Command palette');
    A11y.combobox(input, list, { optionSelector: '.palette-item', label: 'Commands' });
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
