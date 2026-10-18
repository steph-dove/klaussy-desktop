// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Cmd+P quick-open palette — fuzzy filename search across the active
// worktree. Reuses the existing .palette-overlay styling from
// command-palette.js; renders basename-first so typing a filename jumps
// straight to it.

window.QuickOpen = (function () {
  var overlay = null;
  var cachedFiles = null;
  var cachedWorktree = null;
  // Bumped by invalidate() so a load that started before it isn't cached.
  var cacheGeneration = 0;

  // Simple fuzzy ranker. Lower score = better (sorted ascending).
  // Basename match > path match. Keeps the ranking predictable without the
  // overhead of a full subsequence scorer; most quick-open queries are
  // basename substrings anyway.
  function rankPath(path, lowerPath, basename, lowerBasename, q) {
    if (!q) return path.length; // no query → natural order, short paths first
    var bIdx = lowerBasename.indexOf(q);
    if (bIdx === 0) return 0 + path.length * 0.001; // basename prefix match (best)
    if (bIdx > 0) return 100 + bIdx + path.length * 0.001; // basename contains
    var pIdx = lowerPath.indexOf(q);
    if (pIdx >= 0) return 500 + pIdx + path.length * 0.001; // path contains
    return Infinity; // no match
  }

  async function show() {
    if (overlay) { hide(); return; }

    var task = window.AppState && window.AppState.activeTaskId
      ? window.AppState.tasks.get(window.AppState.activeTaskId) : null;
    var wt = task ? task.worktreePath : null;
    if (!wt) return;

    var ownOverlay = overlay = document.createElement('div');
    // `.palette-overlay` is the shared backdrop styling used by every
    // dialog in the app (Setup-check, About, license, etc.). Add a
    // `.quick-open-overlay` discriminator so e2e tests can target THIS
    // overlay specifically — without it, an unrelated dialog opening
    // mid-test (Setup-check on first launch in CI) makes selectors that
    // match `.palette-overlay` non-unique and the count assertions race.
    overlay.className = 'palette-overlay quick-open-overlay';

    var palette = document.createElement('div');
    palette.className = 'palette';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'palette-input';
    input.placeholder = 'Go to file…';
    input.autocomplete = 'off';
    input.spellcheck = false;

    var list = document.createElement('div');
    list.className = 'palette-list';

    var results = [];
    var selectedIndex = 0;
    // Cache per-worktree so reopening the palette is instant. Invalidated
    // on worktree switch.
    var files = cachedWorktree === wt ? cachedFiles : null;

    function render() {
      list.innerHTML = '';
      results.forEach(function (entry, i) {
        var item = document.createElement('div');
        item.className = 'palette-item quick-open-item' + (i === selectedIndex ? ' selected' : '');
        item.dataset.index = i;
        var dir = entry.path.slice(0, entry.path.length - entry.basename.length).replace(/\/$/, '');
        item.innerHTML = '<span class="quick-open-basename">' + escapeHtml(entry.basename) + '</span>' +
          (dir ? ' <span class="quick-open-dir">' + escapeHtml(dir) + '</span>' : '');
        item.addEventListener('click', function () {
          openEntry(entry);
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
      var item = e.target.closest('.quick-open-item');
      if (!item || Number(item.dataset.index) === selectedIndex) return;
      selectedIndex = Number(item.dataset.index);
      updateSelection(false);
    });

    // textContent, so a query like "<b>" shows as typed.
    function showEmpty(text) {
      var line = document.createElement('div');
      line.className = 'palette-empty';
      line.setAttribute('aria-hidden', 'true');
      line.textContent = text;
      list.innerHTML = '';
      list.appendChild(line);
    }

    var saidEmpty = false;
    function refilter() {
      var typed = input.value.trim();
      var q = typed.toLowerCase();
      results = (files || [])
        .map(function (f) { return { entry: f, score: rankPath(f.path, f.lowerPath, f.basename, f.lowerBasename, q) }; })
        .filter(function (r) { return r.score !== Infinity; })
        .sort(function (a, b) { return a.score - b.score; })
        .slice(0, 50)
        .map(function (r) { return r.entry; });
      selectedIndex = 0;
      render();
      if (!files) { showEmpty('Loading files…'); return; }
      if (results.length) { saidEmpty = false; return; }
      var text = files.length ? 'No files match "' + typed + '"' : 'No files in this worktree';
      showEmpty(text);
      // Once per run of empty results, not on every keystroke.
      if (!saidEmpty) A11y.announce(text);
      saidEmpty = true;
    }

    function openEntry(entry) {
      hide();
      window.openFileViewer(wt + '/' + entry.path, entry.basename);
    }

    input.addEventListener('input', refilter);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
        updateSelection(true);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        updateSelection(true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (results[selectedIndex]) openEntry(results[selectedIndex]);
      } else if (e.key === 'Escape') {
        hide();
      }
    });

    overlay.addEventListener('click', function (e) { if (e.target === overlay) hide(); });

    palette.appendChild(input);
    palette.appendChild(list);
    palette.setAttribute('aria-label', 'Go to file');
    A11y.combobox(input, list, { optionSelector: '.palette-item', label: 'Files' });
    overlay.appendChild(palette);
    document.body.appendChild(overlay);

    refilter();
    setTimeout(function () { input.focus(); }, 50);
    if (files) return;

    var generation = cacheGeneration;
    var result;
    try {
      result = await window.klaus.fs.listFiles(wt);
    } catch (err) {
      console.warn('quick-open: list-files failed', err);
      result = null;
    }
    files = ((result && result.files) || []).map(function (p) {
      var base = p.split('/').pop();
      return { path: p, basename: base, lowerPath: p.toLowerCase(), lowerBasename: base.toLowerCase() };
    });
    // A failed load isn't cached, so the next open tries again.
    if (result && !result.error && generation === cacheGeneration) {
      cachedWorktree = wt;
      cachedFiles = files;
    }
    // Closed or reopened while loading.
    if (overlay !== ownOverlay) return;
    refilter();
  }

  function hide() {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  return {
    show: show,
    hide: hide,
    // Call when the active worktree changes so the next open re-scans.
    invalidate: function () { cachedFiles = null; cachedWorktree = null; cacheGeneration++; },
  };
})();
