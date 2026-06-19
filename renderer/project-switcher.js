// Repo + session filters for the sidebar. The repo dropdown lists the
// distinct base repos of whatever worktrees are currently in the sidebar
// (running tasks, resumable worktrees, and saved sessions); the session
// dropdown lists the distinct branch names — a "session" is the branch name
// shared by the repos created together in one multi-repo create. Both
// filters combine. Picking a repo also makes it the active source repo for
// the New Session modal.
//
// There is no longer a user-managed "projects" list — repos appear here purely
// because you have a worktree from them open. Each sidebar `.task-item` is
// stamped with `data-repo` (base repo path) and `data-branch` (session);
// this module reads those.

window.ProjectSwitcher = (function () {
  var repoSelect = document.getElementById('project-select');
  var sessionSelect = document.getElementById('session-select');
  var taskList = document.getElementById('task-list');

  // Searchable dropdowns over the native selects (the selects stay the source
  // of truth; refresh() keeps rebuilding their <option>s and the enhancer
  // mirrors them). No-op if the enhancer failed to load.
  if (window.SearchableSelect) {
    window.SearchableSelect.enhance(repoSelect, { searchPlaceholder: 'Search repos…' });
    window.SearchableSelect.enhance(sessionSelect, { searchPlaceholder: 'Search sessions…' });
  }

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

  // Distinct sessions (branch names) present among the sidebar items.
  function sidebarSessions() {
    var seen = new Set();
    var sessions = [];
    taskList.querySelectorAll('.task-item').forEach(function (item) {
      var branch = item.dataset.branch;
      if (!branch || seen.has(branch)) return;
      seen.add(branch);
      sessions.push(branch);
    });
    sessions.sort(function (a, b) { return a.localeCompare(b); });
    return sessions;
  }

  // Rebuild both dropdowns from the current sidebar, preserving selections
  // that still have items (otherwise fall back to "All ...").
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

    var sessions = sidebarSessions();
    var curSession = AppState.selectedSessionFilter;
    if (curSession && sessions.indexOf(curSession) === -1) {
      AppState.selectedSessionFilter = null;
      curSession = null;
    }

    sessionSelect.innerHTML = '';
    var allSess = document.createElement('option');
    allSess.value = '';
    allSess.textContent = 'All sessions';
    if (!curSession) allSess.selected = true;
    sessionSelect.appendChild(allSess);

    sessions.forEach(function (branch) {
      var opt = document.createElement('option');
      opt.value = branch;
      opt.textContent = branch;
      opt.title = 'Session: ' + branch;
      if (branch === curSession) opt.selected = true;
      sessionSelect.appendChild(opt);
    });

    filterTaskList();
  }

  function filterTaskList() {
    var repoFilter = AppState.selectedRepoFilter;
    var sessionFilter = AppState.selectedSessionFilter;
    taskList.querySelectorAll('.task-item').forEach(function (item) {
      var show = (!repoFilter || item.dataset.repo === repoFilter)
        && (!sessionFilter || item.dataset.branch === sessionFilter);
      item.style.display = show ? '' : 'none';
    });
  }

  repoSelect.addEventListener('change', function () {
    var repo = repoSelect.value || null;
    AppState.selectedRepoFilter = repo;
    filterTaskList();
    // Picking a specific repo also makes it the active source repo for the
    // New Session modal (default source, base-branch list, suggestions).
    if (repo) {
      AppState.repoPath = repo;
      window.klaus.repo.switchProject(repo).then(function () {
        window.dispatchEvent(new CustomEvent('klaussy:project-changed'));
      });
    }
  });

  sessionSelect.addEventListener('change', function () {
    AppState.selectedSessionFilter = sessionSelect.value || null;
    filterTaskList();
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
