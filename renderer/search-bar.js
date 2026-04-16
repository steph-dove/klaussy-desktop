window.SearchBar = (function () {
  var searchBar = document.getElementById('search-bar');
  var searchInput = document.getElementById('search-input');
  var searchCount = document.getElementById('search-count');
  var searchPrev = document.getElementById('search-prev');
  var searchNext = document.getElementById('search-next');
  var searchCloseBtn = document.getElementById('search-close');
  var searchTaskId = null;

  function open(id) {
    searchTaskId = id;
    searchBar.style.display = 'flex';
    searchInput.value = '';
    searchCount.textContent = '';
    setTimeout(function () { searchInput.focus(); }, 50);
  }

  function close() {
    searchBar.style.display = 'none';
    searchInput.value = '';
    searchCount.textContent = '';
    if (searchTaskId != null) {
      var task = AppState.tasks.get(searchTaskId);
      if (task) task.terminal.focus();
    }
    searchTaskId = null;
  }

  function doSearch(direction) {
    if (searchTaskId == null) return;
    var task = AppState.tasks.get(searchTaskId);
    if (!task) return;
    var term = searchInput.value;
    if (!term) return;
    if (direction === 'prev') {
      task.searchAddon.findPrevious(term);
    } else {
      task.searchAddon.findNext(term);
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
