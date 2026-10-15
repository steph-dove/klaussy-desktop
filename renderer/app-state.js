// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
window.AppState = {
  tasks: new Map(),          // id -> { name, terminal, fitAddon, container, cleanup[], alive, ... }
  inactiveWorktrees: [],     // list of inactive worktrees/sessions
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
