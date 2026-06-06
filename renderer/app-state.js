window.AppState = {
  tasks: new Map(),          // id -> { name, terminal, fitAddon, container, cleanup[], alive, ... }
  activeTaskId: null,
  focusedTaskId: null,
  repoPath: null,
  layoutIndex: 0,
  currentFontSize: 13,
  savedPrefs: {},
  selectedRepoFilter: null,   // base-repo path the sidebar is filtered to (null = all)
  ciStatusMap: new Map(),    // taskId -> runs[]
  sidebarCollapsed: false,
};
