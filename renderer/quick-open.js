// Cmd+P quick-open palette — fuzzy filename search across the active
// worktree. Reuses the existing .palette-overlay styling from
// command-palette.js; renders basename-first so typing a filename jumps
// straight to it.

window.QuickOpen = (function () {
  var overlay = null;
  var cachedFiles = null;
  var cachedWorktree = null;

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

    // Cache per-worktree so reopening the palette is instant. Invalidated
    // on worktree switch.
    if (cachedWorktree !== wt || !cachedFiles) {
      cachedWorktree = wt;
      var result = await window.klaus.fs.listFiles(wt);
      cachedFiles = (result.files || []).map(function (p) {
        var base = p.split('/').pop();
        return { path: p, basename: base, lowerPath: p.toLowerCase(), lowerBasename: base.toLowerCase() };
      });
    }

    overlay = document.createElement('div');
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

    function render() {
      list.innerHTML = '';
      results.forEach(function (entry, i) {
        var item = document.createElement('div');
        item.className = 'palette-item quick-open-item' + (i === selectedIndex ? ' selected' : '');
        var dir = entry.path.slice(0, entry.path.length - entry.basename.length).replace(/\/$/, '');
        item.innerHTML = '<span class="quick-open-basename">' + escapeHtml(entry.basename) + '</span>' +
          (dir ? ' <span class="quick-open-dir">' + escapeHtml(dir) + '</span>' : '');
        item.addEventListener('click', function () {
          openEntry(entry);
        });
        item.addEventListener('mouseenter', function () {
          selectedIndex = i;
          updateSelection();
        });
        list.appendChild(item);
      });
    }

    function updateSelection() {
      var items = list.querySelectorAll('.palette-item');
      items.forEach(function (el, i) { el.classList.toggle('selected', i === selectedIndex); });
      var el = items[selectedIndex];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }

    function refilter() {
      var q = input.value.trim().toLowerCase();
      results = cachedFiles
        .map(function (f) { return { entry: f, score: rankPath(f.path, f.lowerPath, f.basename, f.lowerBasename, q) }; })
        .filter(function (r) { return r.score !== Infinity; })
        .sort(function (a, b) { return a.score - b.score; })
        .slice(0, 50)
        .map(function (r) { return r.entry; });
      selectedIndex = 0;
      render();
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
        updateSelection();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        updateSelection();
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
    overlay.appendChild(palette);
    document.body.appendChild(overlay);

    refilter();
    setTimeout(function () { input.focus(); }, 50);
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
    invalidate: function () { cachedFiles = null; cachedWorktree = null; },
  };
})();
