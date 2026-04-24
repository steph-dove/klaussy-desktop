window.ProjectSwitcher = (function () {
  var projectSelect = document.getElementById('project-select');
  var btnAddProject = document.getElementById('btn-add-project');
  var taskList = document.getElementById('task-list');

  async function loadProjects() {
    var projects = await window.klaus.repo.listProjects();
    var current = await window.klaus.repo.get();
    projectSelect.innerHTML = '';

    if (projects.length === 0 && current) {
      await window.klaus.repo.switchProject(current);
      projects = [{ name: current.split('/').pop(), path: current }];
    }

    var allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All Projects';
    if (!AppState.selectedProjectFilter) allOpt.selected = true;
    projectSelect.appendChild(allOpt);

    projects.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.path;
      opt.textContent = p.name;
      if (p.path === AppState.selectedProjectFilter) opt.selected = true;
      projectSelect.appendChild(opt);
    });

    if (!AppState.repoPath && projects.length > 0) {
      AppState.repoPath = projects[0].path;
    }
  }

  function filterTaskList() {
    taskList.querySelectorAll('.task-item').forEach(function (item) {
      var id = Number(item.dataset.id);
      var task = AppState.tasks.get(id);
      if (!task || !AppState.selectedProjectFilter) {
        item.style.display = '';
        return;
      }
      var matches = task.worktreePath && task.worktreePath.startsWith(AppState.selectedProjectFilter);
      if (!matches && task.worktreePath) {
        var parentDir = task.worktreePath.substring(0, task.worktreePath.lastIndexOf('/'));
        var projectParent = AppState.selectedProjectFilter.substring(0, AppState.selectedProjectFilter.lastIndexOf('/'));
        matches = parentDir === projectParent;
      }
      item.style.display = matches ? '' : 'none';
    });
  }

  projectSelect.addEventListener('change', function () {
    var newPath = projectSelect.value;
    AppState.selectedProjectFilter = newPath || null;
    filterTaskList();
  });

  btnAddProject.addEventListener('click', async function () {
    var result = await window.klaus.repo.addProject();
    if (result) {
      AppState.repoPath = result.path;
      await loadProjects();
      // Notify other modules (e.g. the empty-state guidance in app.js) that
      // the active project changed so they can re-render without polling.
      window.dispatchEvent(new CustomEvent('klaussy:project-changed'));
    }
  });

  return {
    loadProjects: loadProjects,
    filterTaskList: filterTaskList,
  };
})();
