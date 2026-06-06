// Repo filter for the sidebar. The dropdown lists the distinct base repos of
// whatever worktrees are currently in the sidebar (running tasks, resumable
// worktrees, and saved sessions) and filters the list to one repo. Picking a
// repo also makes it the active source repo for the New Worktree modal.
//
// There is no longer a user-managed "projects" list — repos appear here purely
// because you have a worktree from them open. Each sidebar `.task-item` is
// stamped with `data-repo` (its base repo path); this module reads that.

window.ProjectSwitcher = (function () {
  var repoSelect = document.getElementById('project-select');
  var taskList = document.getElementById('task-list');

  function basename(p) {
    if (!p) return '';
    var parts = p.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || p;
  }

  // Distinct base repos present among the sidebar items, sorted by name.
  function sidebarRepos() {
    var seen = new Set();
    var repos = [];
    taskList.querySelectorAll('.task-item').forEach(function (item) {
      var repo = item.dataset.repo;
      if (!repo || seen.has(repo)) return;
      seen.add(repo);
      repos.push({ path: repo, name: basename(repo) });
    });
    repos.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return repos;
  }

  // Rebuild the dropdown from the current sidebar, preserving the selection if
  // that repo still has items (otherwise fall back to "All repos").
  function refresh() {
    var repos = sidebarRepos();
    var current = AppState.selectedRepoFilter;
    var stillPresent = current && repos.some(function (r) { return r.path === current; });
    if (!stillPresent && current) {
      AppState.selectedRepoFilter = null;
      current = null;
    }

    repoSelect.innerHTML = '';
    var allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All repos';
    if (!current) allOpt.selected = true;
    repoSelect.appendChild(allOpt);

    repos.forEach(function (r) {
      var opt = document.createElement('option');
      opt.value = r.path;
      opt.textContent = r.name;
      opt.title = r.path;
      if (r.path === current) opt.selected = true;
      repoSelect.appendChild(opt);
    });

    filterTaskList();
  }

  function filterTaskList() {
    var filter = AppState.selectedRepoFilter;
    taskList.querySelectorAll('.task-item').forEach(function (item) {
      if (!filter) { item.style.display = ''; return; }
      item.style.display = (item.dataset.repo === filter) ? '' : 'none';
    });
  }

  repoSelect.addEventListener('change', function () {
    var repo = repoSelect.value || null;
    AppState.selectedRepoFilter = repo;
    filterTaskList();
    // Picking a specific repo also makes it the active source repo for the
    // New Worktree modal (default source, base-branch list, suggestions).
    if (repo) {
      AppState.repoPath = repo;
      window.klaus.repo.switchProject(repo).then(function () {
        window.dispatchEvent(new CustomEvent('klaussy:project-changed'));
      });
    }
  });

  // Keep the dropdown in sync with the sidebar without hooking every add/remove
  // site: rebuild whenever the task list's children change (debounced to a
  // microtask so a burst of appends during load coalesces into one rebuild).
  var pending = false;
  var observer = new MutationObserver(function () {
    if (pending) return;
    pending = true;
    Promise.resolve().then(function () { pending = false; refresh(); });
  });
  observer.observe(taskList, { childList: true });

  return {
    // `loadProjects` name retained so app.js's existing call sites keep working.
    loadProjects: refresh,
    refresh: refresh,
    filterTaskList: filterTaskList,
    sidebarRepos: sidebarRepos,
  };
})();
