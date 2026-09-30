window.SearchBar = (function () {
  var searchBar = document.getElementById('search-bar');
  var searchInput = document.getElementById('search-input');
  var searchCount = document.getElementById('search-count');
  var searchPrev = document.getElementById('search-prev');
  var searchNext = document.getElementById('search-next');
  var searchCloseBtn = document.getElementById('search-close');
  var searchTaskId = null;
  var resultsSub = null;
  searchCount.setAttribute('role', 'status');

  // The addon only reports match counts when decorations are on.
  var SEARCH_OPTS = {
    decorations: {
      matchOverviewRuler: '#888888',
      activeMatchColorOverviewRuler: '#ffaa00',
      matchBackground: '#665500',
      activeMatchBackground: '#aa7700',
    },
  };

  function showCount(e) {
    if (!searchInput.value) { searchCount.textContent = ''; return; }
    if (e.resultCount === 0) searchCount.textContent = 'No matches';
    else if (e.resultIndex < 0) searchCount.textContent = e.resultCount + '+ matches';
    else searchCount.textContent = (e.resultIndex + 1) + ' of ' + e.resultCount;
  }

  function open(id) {
    searchTaskId = id;
    if (resultsSub) resultsSub.dispose();
    var task = AppState.tasks.get(id);
    resultsSub = task && task.searchAddon.onDidChangeResults(showCount);
    searchBar.style.display = 'flex';
    searchInput.value = '';
    searchCount.textContent = '';
    setTimeout(function () { searchInput.focus(); }, 50);
  }

  function close() {
    searchBar.style.display = 'none';
    searchInput.value = '';
    searchCount.textContent = '';
    if (resultsSub) { resultsSub.dispose(); resultsSub = null; }
    if (searchTaskId != null) {
      var task = AppState.tasks.get(searchTaskId);
      if (task) {
        task.searchAddon.clearDecorations();
        task.terminal.focus();
      }
    }
    searchTaskId = null;
  }

  function doSearch(direction) {
    if (searchTaskId == null) return;
    var task = AppState.tasks.get(searchTaskId);
    if (!task) return;
    var term = searchInput.value;
    if (!term) {
      task.searchAddon.clearDecorations();
      searchCount.textContent = '';
      return;
    }
    if (direction === 'prev') {
      task.searchAddon.findPrevious(term, SEARCH_OPTS);
    } else {
      task.searchAddon.findNext(term, SEARCH_OPTS);
    }
  }

  searchInput.addEventListener('input', function () { doSearch('next'); });
  searchNext.addEventListener('click', function () { doSearch('next'); });
  searchPrev.addEventListener('click', function () { doSearch('prev'); });
  searchCloseBtn.addEventListener('click', close);
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && e.shiftKey) { doSearch('prev'); e.preventDefault(); }
    else if (e.key === 'Enter') { doSearch('next'); e.preventDefault(); }
  });

  return { open: open, close: close };
})();
