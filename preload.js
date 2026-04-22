const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  hideWorktree: (worktreePath) => ipcRenderer.invoke('hide-worktree', { worktreePath }),

  // Task management
  createTask: (name, repoPath, mode, basePath, envVars, baseBranch) =>
    ipcRenderer.invoke('create-task', { name, repoPath, mode, basePath, envVars, baseBranch }),
  listBranches: (repoPath) => ipcRenderer.invoke('list-branches', { repoPath }),
  checkoutBranch: (repoPath, branch, mode, basePath, envVars) => ipcRenderer.invoke('checkout-branch', { repoPath, branch, mode, basePath, envVars }),
  attachWorktree: (worktreePath, mode) => ipcRenderer.invoke('attach-worktree', { worktreePath, mode }),
  browseDirectory: () => ipcRenderer.invoke('browse-directory'),
  openFolder: (folderPath, mode) => ipcRenderer.invoke('open-folder', { folderPath, mode }),
  listTasks: () => ipcRenderer.invoke('list-tasks'),
  killTask: (id) => ipcRenderer.invoke('kill-task', { id }),
  restartTask: (id, cols, rows) => ipcRenderer.invoke('restart-task', { id, cols, rows }),
  onTaskConverted: (callback) => {
    ipcRenderer.on('task-converted-to-shell', (_event, data) => callback(data));
  },
  convertToShell: (id) => ipcRenderer.invoke('convert-to-shell', { id }),
  openExternal: (url) => ipcRenderer.invoke('open-external', { url }),

  // Idle notification (A1)
  setNotifyEnabled: (id, enabled) => ipcRenderer.invoke('set-notify-enabled', { id, enabled }),
  getNotifyEnabled: (id) => ipcRenderer.invoke('get-notify-enabled', { id }),
  onNotificationClicked: (callback) => {
    ipcRenderer.on('notification-clicked', (_event, data) => callback(data));
  },

  // About, rename, duplicate (A4, A6, A7)
  getAboutInfo: () => ipcRenderer.invoke('get-about-info'),
  renameTask: (id, newName) => ipcRenderer.invoke('rename-task', { id, newName }),
  duplicateTask: (id) => ipcRenderer.invoke('duplicate-task', { id }),

  // Phase E: Reliability
  getLogs: () => ipcRenderer.invoke('get-logs'),
  exportTranscript: (id) => ipcRenderer.invoke('export-transcript', { id }),
  writeTranscript: (filePath, content) => ipcRenderer.invoke('write-transcript', { filePath, content }),

  // Preferences (B1-B4)
  openPreferences: () => ipcRenderer.invoke('open-preferences'),
  getPreferences: () => ipcRenderer.invoke('get-preferences'),
  setPreferences: (prefs) => ipcRenderer.invoke('set-preferences', prefs),
  getClaudeInfo: () => ipcRenderer.invoke('get-claude-info'),
  onPreferencesChanged: (callback) => {
    ipcRenderer.on('preferences-changed', (_event, prefs) => callback(prefs));
  },

  // File utilities
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Terminal I/O
  writeTerminal: (id, data, subId) => ipcRenderer.send('write-terminal', { id, data, subId }),
  resizeTerminal: (id, cols, rows, subId) => ipcRenderer.send('resize-terminal', { id, cols, rows, subId }),
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
  gitApplyPatch: (worktreePath, patch, reverse) => ipcRenderer.invoke('git-apply-patch', { worktreePath, patch, reverse }),
  gitDiscard: (worktreePath, files) => ipcRenderer.invoke('git-discard', { worktreePath, files }),
  gitCommit: (worktreePath, message) => ipcRenderer.invoke('git-commit', { worktreePath, message }),
  gitPush: (worktreePath) => ipcRenderer.invoke('git-push', { worktreePath }),
  createPR: (worktreePath, title, body) => ipcRenderer.invoke('create-pr', { worktreePath, title, body }),

  // Git gaps (Phase D)
  gitFetch: (worktreePath) => ipcRenderer.invoke('git-fetch', { worktreePath }),
  gitPull: (worktreePath) => ipcRenderer.invoke('git-pull', { worktreePath }),
  gitAheadBehind: (worktreePath) => ipcRenderer.invoke('git-ahead-behind', { worktreePath }),
  gitCheckout: (worktreePath, branch) => ipcRenderer.invoke('git-checkout', { worktreePath, branch }),
  gitStashPush: (worktreePath, message) => ipcRenderer.invoke('git-stash-push', { worktreePath, message }),
  gitStashPop: (worktreePath, index) => ipcRenderer.invoke('git-stash-pop', { worktreePath, index }),
  gitStashList: (worktreePath) => ipcRenderer.invoke('git-stash-list', { worktreePath }),
  gitLog: (worktreePath, count) => ipcRenderer.invoke('git-log', { worktreePath, count }),
  gitShow: (worktreePath, hash) => ipcRenderer.invoke('git-show', { worktreePath, hash }),
  gitBlame: (worktreePath, file) => ipcRenderer.invoke('git-blame', { worktreePath, file }),
  gitConflicts: (worktreePath) => ipcRenderer.invoke('git-conflicts', { worktreePath }),

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
  prReviewThreads: (worktreePath, prNumber) => ipcRenderer.invoke('pr-review-threads', { worktreePath, prNumber }),
  prResolveThread: (worktreePath, threadId) => ipcRenderer.invoke('pr-resolve-thread', { worktreePath, threadId }),
  prUnresolveThread: (worktreePath, threadId) => ipcRenderer.invoke('pr-unresolve-thread', { worktreePath, threadId }),
  prChecks: (worktreePath, prNumber) => ipcRenderer.invoke('pr-checks', { worktreePath, prNumber }),
  prMerge: (worktreePath, prNumber, strategy) => ipcRenderer.invoke('pr-merge', { worktreePath, prNumber, strategy }),
  prAddReviewComment: (opts) => ipcRenderer.invoke('pr-add-review-comment', opts),
  prAddComment: (worktreePath, prNumber, body) => ipcRenderer.invoke('pr-add-comment', { worktreePath, prNumber, body }),
  prReview: (worktreePath, prNumber, event, body) => ipcRenderer.invoke('pr-review', { worktreePath, prNumber, event, body }),
  prAiReviewComment: (opts) => ipcRenderer.invoke('pr-ai-review-comment', opts),
  prReviewCacheGet: (worktreePath, prNumber) => ipcRenderer.invoke('pr-review-cache-get', { worktreePath, prNumber }),
  prReviewCacheSave: (worktreePath, prNumber, review) => ipcRenderer.invoke('pr-review-cache-save', { worktreePath, prNumber, review }),
  prReviewCacheClear: (worktreePath, prNumber) => ipcRenderer.invoke('pr-review-cache-clear', { worktreePath, prNumber }),
  prFixInTerminal: (worktreePath, text) => ipcRenderer.invoke('pr-fix-in-terminal', { worktreePath, text }),
  prAiReviewStart: (opts) => ipcRenderer.invoke('pr-ai-review-start', opts),
  prAiReviewCancel: (requestId) => ipcRenderer.invoke('pr-ai-review-cancel', { requestId }),
  onPrAiReviewData: (requestId, cb) => {
    const ch = 'pr-ai-review-data-' + requestId;
    const handler = (_e, chunk) => cb(chunk);
    ipcRenderer.on(ch, handler);
    return () => ipcRenderer.removeListener(ch, handler);
  },
  onPrAiReviewDone: (requestId, cb) => {
    const ch = 'pr-ai-review-done-' + requestId;
    ipcRenderer.once(ch, (_e, result) => cb(result));
  },
  prReplyToComment: (worktreePath, prNumber, commentId, body) => ipcRenderer.invoke('pr-reply-to-comment', { worktreePath, prNumber, commentId, body }),

  // Explain diff
  explainDiff: (worktreePath, file, hunk) => ipcRenderer.invoke('explain-diff', { worktreePath, file, hunk }),
  explainDiffStreamStart: (requestId, worktreePath, file, hunk) =>
    ipcRenderer.invoke('explain-diff-stream-start', { requestId, worktreePath, file, hunk }),
  explainDiffStreamCancel: (requestId) => ipcRenderer.invoke('explain-diff-stream-cancel', { requestId }),
  onExplainDiffChunk: (requestId, callback) => {
    const channel = 'explain-diff-chunk-' + requestId;
    const handler = (_e, chunk) => callback(chunk);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  onExplainDiffDone: (requestId, callback) => {
    const channel = 'explain-diff-done-' + requestId;
    const handler = (_e, data) => callback(data);
    ipcRenderer.once(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  // File viewer (Phase 7) + File tree & search (C1-C3)
  readFile: (filePath) => ipcRenderer.invoke('read-file', { filePath }),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', { filePath, content }),
  listFiles: (worktreePath) => ipcRenderer.invoke('list-files', { worktreePath }),
  readFilesBulk: (worktreePath, relPaths, maxBytesPerFile) =>
    ipcRenderer.invoke('read-files-bulk', { worktreePath, relPaths, maxBytesPerFile }),

  // LSP (Phase I3)
  lspStart: (worktreePath, languageId) => ipcRenderer.invoke('lsp-start', { worktreePath, languageId }),
  lspStop: (serverId) => ipcRenderer.invoke('lsp-stop', { serverId }),
  lspRequest: (serverId, method, params) => ipcRenderer.invoke('lsp-request', { serverId, method, params }),
  lspNotify: (serverId, method, params) => ipcRenderer.invoke('lsp-notify', { serverId, method, params }),
  lspInstall: (languageId) => ipcRenderer.invoke('lsp-install', { languageId }),
  onLspMessage: (serverId, callback) => {
    const channel = `lsp-message-${serverId}`;
    const handler = (_e, msg) => callback(msg);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  onLspInstallProgress: (languageId, callback) => {
    const channel = `lsp-install-progress-${languageId}`;
    const handler = (_e, msg) => callback(msg);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  searchFiles: (worktreePath, query, maxPerFile) =>
    ipcRenderer.invoke('search-files', { worktreePath, query, maxPerFile }),
  replaceInFiles: (worktreePath, relPaths, query, replacement) =>
    ipcRenderer.invoke('replace-in-files', { worktreePath, relPaths, query, replacement }),

  // Sub-terminal multiplexing (Feature 5)
  addSubTerminal: (taskId, label) => ipcRenderer.invoke('add-sub-terminal', { taskId, label }),
  killSubTerminal: (taskId, subId) => ipcRenderer.invoke('kill-sub-terminal', { taskId, subId }),
  onSubTerminalData: (taskId, subId, callback) => {
    const channel = `terminal-data-${taskId}-${subId}`;
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onSubTerminalExit: (taskId, subId, callback) => {
    const channel = `terminal-exit-${taskId}-${subId}`;
    const listener = () => callback();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // Merge conflict resolution (Feature 1)
  readConflictFile: (worktreePath, file) => ipcRenderer.invoke('read-conflict-file', { worktreePath, file }),
  writeResolvedFile: (worktreePath, file, content) => ipcRenderer.invoke('write-resolved-file', { worktreePath, file, content }),

  // .env file editor (Feature 12)
  listEnvFiles: (worktreePath) => ipcRenderer.invoke('list-env-files', { worktreePath }),
  readEnvFile: (worktreePath, filename) => ipcRenderer.invoke('read-env-file', { worktreePath, filename }),
  writeEnvFile: (worktreePath, filename, content) => ipcRenderer.invoke('write-env-file', { worktreePath, filename, content }),

  // CI/CD status (Feature 3)
  ciStatus: (worktreePath, branch) => ipcRenderer.invoke('ci-status', { worktreePath, branch }),
  ciRunLogs: (worktreePath, runId) => ipcRenderer.invoke('ci-run-logs', { worktreePath, runId }),
  onCIStatusUpdate: (callback) => {
    ipcRenderer.on('ci-status-update', (_event, data) => callback(data));
  },

  // Git tags (Feature 11)
  gitTags: (worktreePath) => ipcRenderer.invoke('git-tags', { worktreePath }),
  gitTagCreate: (worktreePath, name, message, commit) => ipcRenderer.invoke('git-tag-create', { worktreePath, name, message, commit }),
  gitTagDelete: (worktreePath, name) => ipcRenderer.invoke('git-tag-delete', { worktreePath, name }),
  gitTagPush: (worktreePath, name) => ipcRenderer.invoke('git-tag-push', { worktreePath, name }),

  // Task notes (Feature 14)
  getTaskNote: (taskName) => ipcRenderer.invoke('get-task-note', { taskName }),
  setTaskNote: (taskName, note) => ipcRenderer.invoke('set-task-note', { taskName, note }),

  // Auto-fetch updates (Feature 15)
  onAutoFetchUpdate: (callback) => {
    ipcRenderer.on('auto-fetch-update', (_event, data) => callback(data));
  },

  // Triggered by the View → How to use Klaussy menu item.
  onShowHowToUse: (callback) => {
    ipcRenderer.on('show-how-to-use', () => callback());
  },
  // Triggered by the View → Send feedback menu item.
  onShowFeedback: (callback) => {
    ipcRenderer.on('show-feedback', () => callback());
  },
  // Triggered by the View → Logs menu item.
  onShowLogs: (callback) => {
    ipcRenderer.on('show-logs', () => callback());
  },
  // Triggered by the View → Skills & commands menu item.
  onShowSkills: (callback) => {
    ipcRenderer.on('show-skills', () => callback());
  },
  onShowMemory: (callback) => {
    ipcRenderer.on('show-memory', () => callback());
  },
  onShowMcp: (callback) => {
    ipcRenderer.on('show-mcp', () => callback());
  },
  onShowPlugins: (callback) => {
    ipcRenderer.on('show-plugins', () => callback());
  },
  onShowShortcuts: (callback) => {
    ipcRenderer.on('show-shortcuts', () => callback());
  },
  onShowGhAccounts: (callback) => {
    ipcRenderer.on('show-gh-accounts', () => callback());
  },

  // First-run dependency probe (gh + claude installed/authed?).
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),

  // gh account switching (handles users with multiple authed accounts).
  ghListAccounts: () => ipcRenderer.invoke('gh-list-accounts'),
  ghSwitchAccount: (username) => ipcRenderer.invoke('gh-switch-account', { username }),

  // Skills + slash commands inventory for the Skills dialog.
  listSkills: () => ipcRenderer.invoke('list-skills'),
  openSkillFile: (filePath) => ipcRenderer.invoke('open-skill-file', { filePath }),
  readSkillFile: (filePath) => ipcRenderer.invoke('read-skill-file', { filePath }),
  writeSkillFile: (filePath, content) => ipcRenderer.invoke('write-skill-file', { filePath, content }),
  createSkillFile: ({ type, scope, name }) => ipcRenderer.invoke('create-skill-file', { type, scope, name }),

  // Memory (CLAUDE.md) inventory + create.
  listMemoryFiles: () => ipcRenderer.invoke('list-memory-files'),
  createMemoryFile: (filePath) => ipcRenderer.invoke('create-memory-file', { filePath }),

  // MCP servers + plugins (read-only browsers).
  listMcpServers: () => ipcRenderer.invoke('list-mcp-servers'),
  listPlugins: () => ipcRenderer.invoke('list-plugins'),

  // H3: Worktree file watcher for instant diff refresh
  watchWorktree: (worktreePath) => ipcRenderer.invoke('watch-worktree', { worktreePath }),
  unwatchWorktree: (worktreePath) => ipcRenderer.invoke('unwatch-worktree', { worktreePath }),
  onWorktreeChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('worktree-changed', handler);
    return () => ipcRenderer.removeListener('worktree-changed', handler);
  },

  // H2: Cross-task review inbox
  listAllDirtyWorktrees: () => ipcRenderer.invoke('list-all-dirty-worktrees'),
  getWorktreeState: (taskId) => ipcRenderer.invoke('get-worktree-state', { taskId }),

  // Phase G: Review others' PRs
  prList: () => ipcRenderer.invoke('pr-list'),
  prLookupUrl: (url) => ipcRenderer.invoke('pr-lookup-url', { url }),
  prLoad: ({ number, url }) => ipcRenderer.invoke('pr-load', { number, url }),
  prRecent: () => ipcRenderer.invoke('pr-recent'),
  prReviewState: () => ipcRenderer.invoke('pr-review-state'),
  prReviewClose: () => ipcRenderer.invoke('pr-review-close'),
  prRefreshThreads: () => ipcRenderer.invoke('pr-refresh-threads'),
  prSubmitReview: ({ event, body, comments }) =>
    ipcRenderer.invoke('pr-submit-review', { event, body, comments }),
  prAddIssueComment: (body) => ipcRenderer.invoke('pr-add-issue-comment', { body }),
  prReplyToReviewComment: (inReplyTo, body) =>
    ipcRenderer.invoke('pr-reply-to-review-comment', { inReplyTo, body }),
  prEditIssueComment: (commentId, body) =>
    ipcRenderer.invoke('pr-edit-issue-comment', { commentId, body }),
  prEditReviewComment: (commentId, body) =>
    ipcRenderer.invoke('pr-edit-review-comment', { commentId, body }),
  prCurrentUser: () => ipcRenderer.invoke('pr-current-user'),
  prReviewChecks: () => ipcRenderer.invoke('pr-review-checks'),
  prReviewMerge: (strategy) => ipcRenderer.invoke('pr-review-merge', { strategy }),
  prDebugCheckStart: (requestId, checkLink, checkName) =>
    ipcRenderer.invoke('pr-debug-check-start', { requestId, checkLink, checkName }),
  prDebugCheckCancel: (requestId) => ipcRenderer.invoke('pr-debug-check-cancel', { requestId }),
  onPrDebugCheckChunk: (requestId, callback) => {
    const channel = 'pr-debug-check-chunk-' + requestId;
    const handler = (_e, chunk) => callback(chunk);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  onPrDebugCheckDone: (requestId, callback) => {
    const channel = 'pr-debug-check-done-' + requestId;
    const handler = (_e, data) => callback(data);
    ipcRenderer.once(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  prCheckoutLocally: () => ipcRenderer.invoke('pr-checkout-locally'),
  prReviewAiStart: (requestId) => ipcRenderer.invoke('pr-review-ai-start', { requestId }),
  prReviewAiCancel: (requestId) => ipcRenderer.invoke('pr-review-ai-cancel', { requestId }),
  onPrReviewAiData: (requestId, callback) => {
    const channel = 'pr-review-ai-data-' + requestId;
    const handler = (_e, chunk) => callback(chunk);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  onPrReviewAiDone: (requestId, callback) => {
    const channel = 'pr-review-ai-done-' + requestId;
    const handler = (_e, data) => callback(data);
    ipcRenderer.once(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  prReviewImplementStart: (requestId, mode, body) =>
    ipcRenderer.invoke('pr-review-implement-start', { requestId, mode, body }),
  prReviewImplementCancel: (requestId) =>
    ipcRenderer.invoke('pr-review-implement-cancel', { requestId }),
  prReviewCacheGetByPr: (owner, repo, number) =>
    ipcRenderer.invoke('pr-review-cache-get-by-pr', { owner, repo, number }),
  prReviewCacheSaveByPr: (owner, repo, number, data) =>
    ipcRenderer.invoke('pr-review-cache-save-by-pr', { owner, repo, number, data }),
  prReviewCacheClearByPr: (owner, repo, number) =>
    ipcRenderer.invoke('pr-review-cache-clear-by-pr', { owner, repo, number }),
  onPrReviewImplementData: (requestId, callback) => {
    const channel = 'pr-review-implement-data-' + requestId;
    const handler = (_e, chunk) => callback(chunk);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  onPrReviewImplementDone: (requestId, callback) => {
    const channel = 'pr-review-implement-done-' + requestId;
    const handler = (_e, data) => callback(data);
    ipcRenderer.once(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  onPrCheckoutReady: (callback) => {
    const handler = (_event, task) => callback(task);
    ipcRenderer.on('pr-checkout-ready', handler);
    return () => ipcRenderer.removeListener('pr-checkout-ready', handler);
  },
  popOutPrReview: () => ipcRenderer.invoke('pop-out-pr-review'),
  popInPrReview: () => ipcRenderer.invoke('pop-in-pr-review'),
  onPrReviewState: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('pr-review-state', handler);
    return () => ipcRenderer.removeListener('pr-review-state', handler);
  },
});
