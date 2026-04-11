const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('klaus', {
  // Session persistence
  listSavedSessions: () => ipcRenderer.invoke('list-saved-sessions'),
  resumeSession: (session) => ipcRenderer.invoke('resume-session', session),
  clearSavedSessions: () => ipcRenderer.invoke('clear-saved-sessions'),
  getLatestSession: (worktreePath) => ipcRenderer.invoke('get-latest-session', { worktreePath }),
  saveUIState: (state) => ipcRenderer.invoke('save-ui-state', state),
  getUIState: () => ipcRenderer.invoke('get-ui-state'),
  onBeforeQuit: (callback) => {
    ipcRenderer.on('app-before-quit', () => callback());
  },

  // Repo management
  selectRepo: () => ipcRenderer.invoke('select-repo'),
  getRepo: () => ipcRenderer.invoke('get-repo'),

  // Multi-window
  newWindow: () => ipcRenderer.invoke('new-window'),
  listWorktrees: () => ipcRenderer.invoke('list-worktrees'),

  // Task management
  createTask: (name, repoPath, mode, basePath) => ipcRenderer.invoke('create-task', { name, repoPath, mode, basePath }),
  attachWorktree: (worktreePath, mode) => ipcRenderer.invoke('attach-worktree', { worktreePath, mode }),
  browseDirectory: () => ipcRenderer.invoke('browse-directory'),
  listTasks: () => ipcRenderer.invoke('list-tasks'),
  killTask: (id) => ipcRenderer.invoke('kill-task', { id }),
  restartTask: (id, cols, rows) => ipcRenderer.invoke('restart-task', { id, cols, rows }),
  onTaskConverted: (callback) => {
    ipcRenderer.on('task-converted-to-shell', (_event, data) => callback(data));
  },
  convertToShell: (id) => ipcRenderer.invoke('convert-to-shell', { id }),
  openExternal: (url) => ipcRenderer.invoke('open-external', { url }),

  // Terminal I/O
  writeTerminal: (id, data) => ipcRenderer.send('write-terminal', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('resize-terminal', { id, cols, rows }),
  onTerminalData: (id, callback) => {
    const channel = `terminal-data-${id}`;
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onTerminalExit: (id, callback) => {
    const channel = `terminal-exit-${id}`;
    const listener = (_event, code) => callback(code);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onMenuCopy: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('menu-copy', listener);
    return () => ipcRenderer.removeListener('menu-copy', listener);
  },
  onMenuPaste: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('menu-paste', listener);
    return () => ipcRenderer.removeListener('menu-paste', listener);
  },

  // Git status & diff (Phase 1)
  gitStatus: (worktreePath) => ipcRenderer.invoke('git-status', { worktreePath }),
  gitDiff: (worktreePath, file, staged) => ipcRenderer.invoke('git-diff', { worktreePath, file, staged }),

  // Branch diff mode
  gitBranches: (worktreePath) => ipcRenderer.invoke('git-branches', { worktreePath }),
  gitBranchFiles: (worktreePath, baseBranch) => ipcRenderer.invoke('git-branch-files', { worktreePath, baseBranch }),
  gitBranchDiff: (worktreePath, baseBranch, file) => ipcRenderer.invoke('git-branch-diff', { worktreePath, baseBranch, file }),

  // Git operations (Phase 2)
  gitStage: (worktreePath, files) => ipcRenderer.invoke('git-stage', { worktreePath, files }),
  gitUnstage: (worktreePath, files) => ipcRenderer.invoke('git-unstage', { worktreePath, files }),
  gitDiscard: (worktreePath, files) => ipcRenderer.invoke('git-discard', { worktreePath, files }),
  gitCommit: (worktreePath, message) => ipcRenderer.invoke('git-commit', { worktreePath, message }),
  gitPush: (worktreePath) => ipcRenderer.invoke('git-push', { worktreePath }),
  createPR: (worktreePath, title, body) => ipcRenderer.invoke('create-pr', { worktreePath, title, body }),

  // Multi-project (Phase 3)
  listProjects: () => ipcRenderer.invoke('list-projects'),
  addProject: () => ipcRenderer.invoke('add-project'),
  removeProject: (projectPath) => ipcRenderer.invoke('remove-project', { projectPath }),
  switchProject: (projectPath) => ipcRenderer.invoke('switch-project', { projectPath }),

  // Pop-out (Phase 4)
  popOutTask: (id) => ipcRenderer.invoke('pop-out-task', { id }),
  onPopoutInit: (callback) => {
    ipcRenderer.on('popout-init', (_event, data) => callback(data));
  },

  // Theme (Phase 5)
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', { theme }),
  getSystemTheme: () => ipcRenderer.invoke('get-system-theme'),
  onSystemThemeChanged: (callback) => {
    ipcRenderer.on('system-theme-changed', (_event, isDark) => callback(isDark));
  },

  // PR interaction
  prForBranch: (worktreePath) => ipcRenderer.invoke('pr-for-branch', { worktreePath }),
  prReviewComments: (worktreePath, prNumber) => ipcRenderer.invoke('pr-review-comments', { worktreePath, prNumber }),
  prAddComment: (worktreePath, prNumber, body) => ipcRenderer.invoke('pr-add-comment', { worktreePath, prNumber, body }),
  prReview: (worktreePath, prNumber, event, body) => ipcRenderer.invoke('pr-review', { worktreePath, prNumber, event, body }),

  // Explain diff
  explainDiff: (worktreePath, file, hunk) => ipcRenderer.invoke('explain-diff', { worktreePath, file, hunk }),

  // File viewer (Phase 7)
  readFile: (filePath) => ipcRenderer.invoke('read-file', { filePath }),
});
