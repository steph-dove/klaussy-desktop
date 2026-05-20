// Preload: the only bridge between the sandboxed renderer and main.
//
// API is namespaced: `window.klaus.git.status(...)` rather than the
// previous flat `window.klaus.gitStatus(...)`. Grouping makes it obvious
// which module owns each IPC target; a renderer that only needs git shouldn't
// see the whole PR surface. See M-ARCH-2 in REVIEW_OUTPUT.md for the rationale.
//
// Every entry is a thin `ipcRenderer.invoke` / `.send` / `.on` wrapper —
// the handlers live in main/ipc/<feature>.js and the state modules.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('klaus', {
  // ---- session: Session persistence + UI state ----
  session: {
    listSaved: () => ipcRenderer.invoke('list-saved-sessions'),
    resume: (session) => ipcRenderer.invoke('resume-session', session),
    clearSaved: () => ipcRenderer.invoke('clear-saved-sessions'),
    dismissSaved: (session) => ipcRenderer.invoke('dismiss-saved-session', {
      worktreePath: session && session.worktreePath,
      sessionId: session && session.sessionId,
    }),
    getLatest: (worktreePath) => ipcRenderer.invoke('get-latest-session', { worktreePath }),
    saveUIState: (state) => ipcRenderer.invoke('save-ui-state', state),
    getUIState: () => ipcRenderer.invoke('get-ui-state'),
    onBeforeQuit: (callback) => {
      ipcRenderer.on('app-before-quit', () => callback());
    },
  },

  // ---- repo: Projects, worktrees, repo selection ----
  repo: {
    select: () => ipcRenderer.invoke('select-repo'),
    get: () => ipcRenderer.invoke('get-repo'),
    listProjects: () => ipcRenderer.invoke('list-projects'),
    addProject: (folderPath) => ipcRenderer.invoke('add-project', { folderPath }),
    removeProject: (projectPath) => ipcRenderer.invoke('remove-project', { projectPath }),
    switchProject: (projectPath) => ipcRenderer.invoke('switch-project', { projectPath }),
    listWorktrees: () => ipcRenderer.invoke('list-worktrees'),
    hideWorktree: (worktreePath) => ipcRenderer.invoke('hide-worktree', { worktreePath }),
    browseDirectory: () => ipcRenderer.invoke('browse-directory'),
    recentPathsGet: () => ipcRenderer.invoke('recent-paths-get'),
    recentPathsAdd: (kind, path) => ipcRenderer.invoke('recent-paths-add', { kind, path }),
    recentPathsRemove: (kind, path) => ipcRenderer.invoke('recent-paths-remove', { kind, path }),
  },

  // ---- task: Task lifecycle, notify, notes, transcripts, dirty-worktree aggregator ----
  task: {
    create: (name, repoPath, mode, basePath, envVars, baseBranch) =>
      ipcRenderer.invoke('create-task', { name, repoPath, mode, basePath, envVars, baseBranch }),
    listBranches: (repoPath) => ipcRenderer.invoke('list-branches', { repoPath }),
    checkoutBranch: (repoPath, branch, mode, basePath, envVars) => ipcRenderer.invoke('checkout-branch', { repoPath, branch, mode, basePath, envVars }),
    attachWorktree: (worktreePath, mode) => ipcRenderer.invoke('attach-worktree', { worktreePath, mode }),
    openFolder: (folderPath, mode) => ipcRenderer.invoke('open-folder', { folderPath, mode }),
    list: () => ipcRenderer.invoke('list-tasks'),
    kill: (id) => ipcRenderer.invoke('kill-task', { id }),
    restart: (id, cols, rows) => ipcRenderer.invoke('restart-task', { id, cols, rows }),
    rename: (id, newName) => ipcRenderer.invoke('rename-task', { id, newName }),
    duplicate: (id) => ipcRenderer.invoke('duplicate-task', { id }),
    popOut: (id) => ipcRenderer.invoke('pop-out-task', { id }),
    onConverted: (callback) => {
      ipcRenderer.on('task-converted-to-shell', (_event, data) => callback(data));
    },
    onPopoutInit: (callback) => {
      ipcRenderer.on('popout-init', (_event, data) => callback(data));
    },
    setNotifyEnabled: (id, enabled, kind) => ipcRenderer.invoke('set-notify-enabled', { id, enabled, kind: kind || 'idle' }),
    getNotifyEnabled: (id) => ipcRenderer.invoke('get-notify-enabled', { id }),
    onNotificationClicked: (callback) => {
      ipcRenderer.on('notification-clicked', (_event, data) => callback(data));
    },
    getNote: (taskName) => ipcRenderer.invoke('get-task-note', { taskName }),
    setNote: (taskName, note) => ipcRenderer.invoke('set-task-note', { taskName, note }),
    exportTranscript: (id) => ipcRenderer.invoke('export-transcript', { id }),
    writeTranscript: (id, content) => ipcRenderer.invoke('write-transcript', { id, content }),
    listAllDirtyWorktrees: () => ipcRenderer.invoke('list-all-dirty-worktrees'),
    getWorktreeState: (taskId) => ipcRenderer.invoke('get-worktree-state', { taskId }),
    onCIStatusUpdate: (callback) => {
      ipcRenderer.on('ci-status-update', (_event, data) => callback(data));
    },
    onAutoFetchUpdate: (callback) => {
      ipcRenderer.on('auto-fetch-update', (_event, data) => callback(data));
    },
  },

  // ---- terminal: PTY I/O + sub-terminals ----
  terminal: {
    write: (id, data, subId) => ipcRenderer.send('write-terminal', { id, data, subId }),
    resize: (id, cols, rows, subId) => ipcRenderer.send('resize-terminal', { id, cols, rows, subId }),
    onData: (id, callback) => {
      const channel = `terminal-data-${id}`;
      const listener = (_event, data) => callback(data);
      ipcRenderer.on(channel, listener);
      // Main uses the subscription set as its authoritative "who should receive"
      // list. The subscribe message is send() not invoke() — fire-and-forget,
      // no round trip.
      ipcRenderer.send('subscribe-terminal', channel);
      return () => {
        ipcRenderer.removeListener(channel, listener);
        ipcRenderer.send('unsubscribe-terminal', channel);
      };
    },
    onExit: (id, callback) => {
      const channel = `terminal-exit-${id}`;
      const listener = (_event, code) => callback(code);
      ipcRenderer.on(channel, listener);
      ipcRenderer.send('subscribe-terminal', channel);
      return () => {
        ipcRenderer.removeListener(channel, listener);
        ipcRenderer.send('unsubscribe-terminal', channel);
      };
    },
    addSub: (taskId, label, mode) => ipcRenderer.invoke('add-sub-terminal', { taskId, label, mode }),
    killSub: (taskId, subId) => ipcRenderer.invoke('kill-sub-terminal', { taskId, subId }),
    onSubData: (taskId, subId, callback) => {
      const channel = `terminal-data-${taskId}-${subId}`;
      const listener = (_event, data) => callback(data);
      ipcRenderer.on(channel, listener);
      ipcRenderer.send('subscribe-terminal', channel);
      return () => {
        ipcRenderer.removeListener(channel, listener);
        ipcRenderer.send('unsubscribe-terminal', channel);
      };
    },
    onSubExit: (taskId, subId, callback) => {
      const channel = `terminal-exit-${taskId}-${subId}`;
      const listener = () => callback();
      ipcRenderer.on(channel, listener);
      ipcRenderer.send('subscribe-terminal', channel);
      return () => {
        ipcRenderer.removeListener(channel, listener);
        ipcRenderer.send('unsubscribe-terminal', channel);
      };
    },
  },

  // ---- git: Git status/diff, branches, ops, stash, tags, log, blame, conflicts, create-PR ----
  git: {
    status: (worktreePath) => ipcRenderer.invoke('git-status', { worktreePath }),
    diff: (worktreePath, file, staged) => ipcRenderer.invoke('git-diff', { worktreePath, file, staged }),
    fileHunks: (worktreePath, file) => ipcRenderer.invoke('git-file-hunks', { worktreePath, file }),
    branches: (worktreePath) => ipcRenderer.invoke('git-branches', { worktreePath }),
    branchFiles: (worktreePath, baseBranch) => ipcRenderer.invoke('git-branch-files', { worktreePath, baseBranch }),
    branchDiff: (worktreePath, baseBranch, file) => ipcRenderer.invoke('git-branch-diff', { worktreePath, baseBranch, file }),
    stage: (worktreePath, files) => ipcRenderer.invoke('git-stage', { worktreePath, files }),
    unstage: (worktreePath, files) => ipcRenderer.invoke('git-unstage', { worktreePath, files }),
    applyPatch: (worktreePath, patch, reverse) => ipcRenderer.invoke('git-apply-patch', { worktreePath, patch, reverse }),
    discard: (worktreePath, files) => ipcRenderer.invoke('git-discard', { worktreePath, files }),
    commit: (worktreePath, message) => ipcRenderer.invoke('git-commit', { worktreePath, message }),
    push: (worktreePath) => ipcRenderer.invoke('git-push', { worktreePath }),
    fetch: (worktreePath) => ipcRenderer.invoke('git-fetch', { worktreePath }),
    pull: (worktreePath) => ipcRenderer.invoke('git-pull', { worktreePath }),
    aheadBehind: (worktreePath) => ipcRenderer.invoke('git-ahead-behind', { worktreePath }),
    checkout: (worktreePath, branch) => ipcRenderer.invoke('git-checkout', { worktreePath, branch }),
    stashPush: (worktreePath, message) => ipcRenderer.invoke('git-stash-push', { worktreePath, message }),
    stashPop: (worktreePath, index) => ipcRenderer.invoke('git-stash-pop', { worktreePath, index }),
    stashList: (worktreePath) => ipcRenderer.invoke('git-stash-list', { worktreePath }),
    log: (worktreePath, count) => ipcRenderer.invoke('git-log', { worktreePath, count }),
    show: (worktreePath, hash) => ipcRenderer.invoke('git-show', { worktreePath, hash }),
    blame: (worktreePath, file) => ipcRenderer.invoke('git-blame', { worktreePath, file }),
    conflicts: (worktreePath) => ipcRenderer.invoke('git-conflicts', { worktreePath }),
    tags: (worktreePath) => ipcRenderer.invoke('git-tags', { worktreePath }),
    tagCreate: (worktreePath, name, message, commit) => ipcRenderer.invoke('git-tag-create', { worktreePath, name, message, commit }),
    tagDelete: (worktreePath, name) => ipcRenderer.invoke('git-tag-delete', { worktreePath, name }),
    tagPush: (worktreePath, name) => ipcRenderer.invoke('git-tag-push', { worktreePath, name }),
    createPR: (worktreePath, title, body) => ipcRenderer.invoke('create-pr', { worktreePath, title, body }),
  },

  // ---- pr: Phase G — review others' PRs (load, threads, checks, merge, comments, AI review) ----
  pr: {
    forBranch: (worktreePath) => ipcRenderer.invoke('pr-for-branch', { worktreePath }),
    reviewThreads: (worktreePath, prNumber) => ipcRenderer.invoke('pr-review-threads', { worktreePath, prNumber }),
    resolveThread: (worktreePath, threadId) => ipcRenderer.invoke('pr-resolve-thread', { worktreePath, threadId }),
    unresolveThread: (worktreePath, threadId) => ipcRenderer.invoke('pr-unresolve-thread', { worktreePath, threadId }),
    checks: (worktreePath, prNumber) => ipcRenderer.invoke('pr-checks', { worktreePath, prNumber }),
    requiredChecks: (worktreePath, prNumber) => ipcRenderer.invoke('pr-required-checks', { worktreePath, prNumber }),
    reviewRequiredChecks: () => ipcRenderer.invoke('pr-review-required-checks'),
    reviewCheckAnnotations: (checkRunId) => ipcRenderer.invoke('pr-review-check-annotations', { checkRunId }),
    reviewRunRerunFailed: (runId) => ipcRenderer.invoke('pr-review-run-rerun-failed', { runId }),
    reviewRunCancel: (runId) => ipcRenderer.invoke('pr-review-run-cancel', { runId }),
    reviewWorkflowsList: () => ipcRenderer.invoke('pr-review-workflows-list'),
    reviewWorkflowDispatch: (workflowId, ref, inputs) =>
      ipcRenderer.invoke('pr-review-workflow-dispatch', { workflowId, ref, inputs }),
    reviewRunLogWatchStart: (requestId, runId) =>
      ipcRenderer.invoke('pr-review-run-log-watch-start', { requestId, runId }),
    reviewRunLogWatchStop: (requestId) =>
      ipcRenderer.invoke('pr-review-run-log-watch-stop', { requestId }),
    onRunLogChunk: (requestId, callback) => {
      const channel = 'pr-review-run-log-chunk-' + requestId;
      const handler = (_e, chunk) => callback(chunk);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onRunLogDone: (requestId, callback) => {
      const channel = 'pr-review-run-log-done-' + requestId;
      const handler = (_e, data) => callback(data);
      ipcRenderer.once(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    merge: (worktreePath, prNumber, strategy) => ipcRenderer.invoke('pr-merge', { worktreePath, prNumber, strategy }),
    addReviewComment: (opts) => ipcRenderer.invoke('pr-add-review-comment', opts),
    addComment: (worktreePath, prNumber, body) => ipcRenderer.invoke('pr-add-comment', { worktreePath, prNumber, body }),
    review: (worktreePath, prNumber, event, body) => ipcRenderer.invoke('pr-review', { worktreePath, prNumber, event, body }),
    aiReviewComment: (opts) => ipcRenderer.invoke('pr-ai-review-comment', opts),
    fixInTerminal: (worktreePath, text) => ipcRenderer.invoke('pr-fix-in-terminal', { worktreePath, text }),
    aiReviewStart: (opts) => ipcRenderer.invoke('pr-ai-review-start', opts),
    aiReviewCancel: (requestId) => ipcRenderer.invoke('pr-ai-review-cancel', { requestId }),
    onAiReviewData: (requestId, cb) => {
      const ch = 'pr-ai-review-data-' + requestId;
      const handler = (_e, chunk) => cb(chunk);
      ipcRenderer.on(ch, handler);
      return () => ipcRenderer.removeListener(ch, handler);
    },
    onAiReviewDone: (requestId, cb) => {
      const ch = 'pr-ai-review-done-' + requestId;
      ipcRenderer.once(ch, (_e, result) => cb(result));
    },
    replyToComment: (worktreePath, prNumber, commentId, body) => ipcRenderer.invoke('pr-reply-to-comment', { worktreePath, prNumber, commentId, body }),
    list: () => ipcRenderer.invoke('pr-list'),
    lookupUrl: (url) => ipcRenderer.invoke('pr-lookup-url', { url }),
    load: ({ number, url }) => ipcRenderer.invoke('pr-load', { number, url }),
    recent: () => ipcRenderer.invoke('pr-recent'),
    reviewState: () => ipcRenderer.invoke('pr-review-state'),
    reviewClose: () => ipcRenderer.invoke('pr-review-close'),
    refreshThreads: () => ipcRenderer.invoke('pr-refresh-threads'),
    pullUpdates: () => ipcRenderer.invoke('pr-pull-updates'),
    submitReview: ({ event, body, comments }) =>
      ipcRenderer.invoke('pr-submit-review', { event, body, comments }),
    addIssueComment: (body) => ipcRenderer.invoke('pr-add-issue-comment', { body }),
    replyToReviewComment: (inReplyTo, body) =>
      ipcRenderer.invoke('pr-reply-to-review-comment', { inReplyTo, body }),
    editIssueComment: (commentId, body) =>
      ipcRenderer.invoke('pr-edit-issue-comment', { commentId, body }),
    editReviewComment: (commentId, body) =>
      ipcRenderer.invoke('pr-edit-review-comment', { commentId, body }),
    currentUser: () => ipcRenderer.invoke('pr-current-user'),
    reviewChecks: () => ipcRenderer.invoke('pr-review-checks'),
    reviewMerge: (strategy) => ipcRenderer.invoke('pr-review-merge', { strategy }),
    debugCheckStart: (requestId, checkLink, checkName, checkRunId) =>
      ipcRenderer.invoke('pr-debug-check-start', { requestId, checkLink, checkName, checkRunId }),
    debugCheckCancel: (requestId) => ipcRenderer.invoke('pr-debug-check-cancel', { requestId }),
    debugCheckOpenAsTask: (analysis, checkName, prNumber) =>
      ipcRenderer.invoke('pr-debug-check-open-task', { analysis, checkName, prNumber }),
    onDebugCheckChunk: (requestId, callback) => {
      const channel = 'pr-debug-check-chunk-' + requestId;
      const handler = (_e, chunk) => callback(chunk);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onDebugCheckDone: (requestId, callback) => {
      const channel = 'pr-debug-check-done-' + requestId;
      const handler = (_e, data) => callback(data);
      ipcRenderer.once(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    fixCheckStart: (requestId, checkLink, checkName, checkRunId) =>
      ipcRenderer.invoke('pr-fix-check-start', { requestId, checkLink, checkName, checkRunId }),
    fixCheckCancel: (requestId) => ipcRenderer.invoke('pr-fix-check-cancel', { requestId }),
    onFixCheckData: (requestId, callback) => {
      const channel = 'pr-fix-check-data-' + requestId;
      const handler = (_e, chunk) => callback(chunk);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onFixCheckDone: (requestId, callback) => {
      const channel = 'pr-fix-check-done-' + requestId;
      const handler = (_e, data) => callback(data);
      ipcRenderer.once(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    checkoutLocally: () => ipcRenderer.invoke('pr-checkout-locally'),
    reviewAiStart: (requestId) => ipcRenderer.invoke('pr-review-ai-start', { requestId }),
    reviewAiCancel: (requestId) => ipcRenderer.invoke('pr-review-ai-cancel', { requestId }),
    onReviewAiData: (requestId, callback) => {
      const channel = 'pr-review-ai-data-' + requestId;
      const handler = (_e, chunk) => callback(chunk);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onReviewAiDone: (requestId, callback) => {
      const channel = 'pr-review-ai-done-' + requestId;
      const handler = (_e, data) => callback(data);
      ipcRenderer.once(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    // Implement runs inside an interactive node-pty (see
    // main/state/pr-implement-pty.js). Renderer mounts xterm.js,
    // streams raw bytes via onReviewImplementPtyData, and parses
    // structured progress via onReviewImplementPtyEvent.
    reviewImplementStart: (requestId, mode, body) =>
      ipcRenderer.invoke('pr-review-implement-start', { requestId, mode, body }),
    reviewImplementInput: (requestId, data) =>
      ipcRenderer.invoke('pr-review-implement-input', { requestId, data }),
    reviewImplementResize: (requestId, cols, rows) =>
      ipcRenderer.invoke('pr-review-implement-resize', { requestId, cols, rows }),
    reviewImplementCancel: (requestId) =>
      ipcRenderer.invoke('pr-review-implement-cancel', { requestId }),
    reviewChatStart: (requestId, findingBody, messages, findingId) =>
      ipcRenderer.invoke('pr-review-chat-start', { requestId, findingBody, messages, findingId }),
    reviewChatCancel: (requestId) =>
      ipcRenderer.invoke('pr-review-chat-cancel', { requestId }),
    onReviewChatData: (requestId, callback) => {
      const channel = 'pr-review-chat-data-' + requestId;
      const handler = (_e, chunk) => callback(chunk);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onReviewChatDone: (requestId, callback) => {
      const channel = 'pr-review-chat-done-' + requestId;
      const handler = (_e, data) => callback(data);
      ipcRenderer.once(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    reviewInvestigateStart: (requestId, findingBody) =>
      ipcRenderer.invoke('pr-review-investigate-start', { requestId, findingBody }),
    reviewInvestigateCancel: (requestId) =>
      ipcRenderer.invoke('pr-review-investigate-cancel', { requestId }),
    onReviewInvestigateData: (requestId, callback) => {
      const channel = 'pr-review-investigate-data-' + requestId;
      const handler = (_e, chunk) => callback(chunk);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onReviewInvestigateDone: (requestId, callback) => {
      const channel = 'pr-review-investigate-done-' + requestId;
      const handler = (_e, data) => callback(data);
      ipcRenderer.once(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    readWorktreeFile: (worktreePath, relPath) =>
      ipcRenderer.invoke('pr-review-read-file', { worktreePath, relPath }),
    localState: (worktreeHint) => ipcRenderer.invoke('pr-review-local-state', { worktreeHint }),
    commitLocal: (message, worktreeHint) => ipcRenderer.invoke('pr-review-commit-local', { message, worktreeHint }),
    pushLocal: (worktreeHint) => ipcRenderer.invoke('pr-review-push-local', { worktreeHint }),
    cacheGetByPr: (owner, repo, number) =>
      ipcRenderer.invoke('pr-review-cache-get-by-pr', { owner, repo, number }),
    cacheSaveByPr: (owner, repo, number, data) =>
      ipcRenderer.invoke('pr-review-cache-save-by-pr', { owner, repo, number, data }),
    cacheClearByPr: (owner, repo, number) =>
      ipcRenderer.invoke('pr-review-cache-clear-by-pr', { owner, repo, number }),
    // Raw PTY bytes for the inline xterm. on (not once) — every chunk
    // streams while the run is in flight.
    onReviewImplementData: (requestId, callback) => {
      const channel = 'pr-review-implement-pty-data-' + requestId;
      const handler = (_e, chunk) => callback(chunk);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    // Structured JSONL events (tool/text/usage/end_turn) for progress
    // chips, draft-comment extraction, and the "done" transition.
    onReviewImplementEvent: (requestId, callback) => {
      const channel = 'pr-review-implement-pty-event-' + requestId;
      const handler = (_e, ev) => callback(ev);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onReviewImplementDone: (requestId, callback) => {
      const channel = 'pr-review-implement-pty-exit-' + requestId;
      const handler = (_e, data) => callback(data);
      ipcRenderer.once(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onCheckoutReady: (callback) => {
      const handler = (_event, task) => callback(task);
      ipcRenderer.on('pr-checkout-ready', handler);
      return () => ipcRenderer.removeListener('pr-checkout-ready', handler);
    },
    popOut: () => ipcRenderer.invoke('pop-out-pr-review'),
    popIn: () => ipcRenderer.invoke('pop-in-pr-review'),
    onReviewState: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('pr-review-state', handler);
      return () => ipcRenderer.removeListener('pr-review-state', handler);
    },
  },

  // ---- ai: Claude streaming IPC: inline edit, completion, explain-diff, commit-message ----
  ai: {
    inlineEditStart: (opts) => ipcRenderer.invoke('inline-edit-start', opts),
    inlineEditCancel: (requestId) => ipcRenderer.invoke('inline-edit-cancel', { requestId }),
    onInlineEditChunk: (requestId, callback) => {
      const channel = `inline-edit-chunk-${requestId}`;
      const handler = (_e, chunk) => callback(chunk);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onInlineEditDone: (requestId, callback) => {
      const channel = `inline-edit-done-${requestId}`;
      const handler = (_e, msg) => callback(msg);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    inlineCompleteStart: (opts) => ipcRenderer.invoke('inline-complete-start', opts),
    inlineCompleteCancel: (requestId) => ipcRenderer.invoke('inline-complete-cancel', { requestId }),
    onInlineCompleteChunk: (requestId, callback) => {
      const channel = `inline-complete-chunk-${requestId}`;
      const handler = (_e, chunk) => callback(chunk);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onInlineCompleteDone: (requestId, callback) => {
      const channel = `inline-complete-done-${requestId}`;
      const handler = (_e, msg) => callback(msg);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    explainDiff: (worktreePath, file, hunk) => ipcRenderer.invoke('explain-diff', { worktreePath, file, hunk }),
    explainDiffStreamStart: (requestId, worktreePath, file, hunk, prNumber) =>
      ipcRenderer.invoke('explain-diff-stream-start', { requestId, worktreePath, file, hunk, prNumber }),
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
    commitMessageStart: (requestId, worktreePath) =>
      ipcRenderer.invoke('claude-commit-message-start', { requestId, worktreePath }),
    commitMessageCancel: (requestId) =>
      ipcRenderer.invoke('claude-commit-message-cancel', { requestId }),
    onCommitMessageChunk: (requestId, callback) => {
      const channel = 'claude-commit-message-chunk-' + requestId;
      const handler = (_e, chunk) => callback(chunk);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onCommitMessageDone: (requestId, callback) => {
      const channel = 'claude-commit-message-done-' + requestId;
      const handler = (_e, data) => callback(data);
      ipcRenderer.once(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },

    // Ollama-backed fill-in-middle completion. Runs locally, ~50-200ms TTFT
    // on Apple Silicon; used for the passive/ghost-text autocomplete path
    // so every keystroke doesn't roundtrip to the Claude API.
    ollama: {
      probe: () => ipcRenderer.invoke('ollama-probe'),
      probeRefresh: () => ipcRenderer.invoke('ollama-probe-refresh'),
      warmup: () => ipcRenderer.invoke('ollama-warmup'),
      completeStart: (opts) => ipcRenderer.invoke('ollama-complete-start', opts),
      completeCancel: (requestId) => ipcRenderer.invoke('ollama-complete-cancel', { requestId }),
      onCompleteChunk: (requestId, callback) => {
        const channel = `ollama-complete-chunk-${requestId}`;
        const handler = (_e, chunk) => callback(chunk);
        ipcRenderer.on(channel, handler);
        return () => ipcRenderer.removeListener(channel, handler);
      },
      onCompleteDone: (requestId, callback) => {
        const channel = `ollama-complete-done-${requestId}`;
        const handler = (_e, msg) => callback(msg);
        ipcRenderer.once(channel, handler);
        return () => ipcRenderer.removeListener(channel, handler);
      },
      // Consent / install flow. The setup-start handler streams progress
      // events on the shared `ollama-setup-progress` channel; subscribe
      // once and you'll receive every step (install / server / model /
      // warmup / done).
      setupStatus: () => ipcRenderer.invoke('ollama-setup-status'),
      setupStart: () => ipcRenderer.invoke('ollama-setup-start'),
      setupDecline: () => ipcRenderer.invoke('ollama-setup-decline'),
      onSetupProgress: (callback) => {
        const handler = (_e, p) => callback(p);
        ipcRenderer.on('ollama-setup-progress', handler);
        return () => ipcRenderer.removeListener('ollama-setup-progress', handler);
      },
    },
  },

  // ---- agents: global background-agent registry (Agents panel) ----
  agents: {
    list: () => ipcRenderer.invoke('agents-list'),
    get: (id) => ipcRenderer.invoke('agents-get', { id }),
    findByDedupeKey: (key) => ipcRenderer.invoke('agents-find-by-dedupe-key', { key }),
    cancel: (id) => ipcRenderer.invoke('agents-cancel', { id }),
    markRead: (id) => ipcRenderer.invoke('agents-mark-read', { id }),
    markAllRead: () => ipcRenderer.invoke('agents-mark-all-read'),
    clearCompleted: () => ipcRenderer.invoke('agents-clear-completed'),
    // Fired on every registry mutation (register / done / error / cancel /
    // read). Subscribers re-render with the snapshot.
    onChanged: (callback) => {
      const handler = (_e, list) => callback(list);
      ipcRenderer.on('agents-changed', handler);
      return () => ipcRenderer.removeListener('agents-changed', handler);
    },
    // Generic chunk subscription for an in-flight backgrounded agent. The
    // channel matches whatever channelPrefix the agent was registered with
    // (`<prefix>-chunk-<id>` for plain text, `<prefix>-data-<id>` for
    // stream-json). Lets a re-mounting consumer attach to live output.
    onChunk: (channelPrefix, id, isStreamJson, callback) => {
      const channel = `${channelPrefix}-${isStreamJson ? 'data' : 'chunk'}-${id}`;
      const handler = (_e, chunk) => callback(chunk);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onDone: (channelPrefix, id, callback) => {
      const channel = `${channelPrefix}-done-${id}`;
      const handler = (_e, payload) => callback(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },

  // ---- license: one-time-purchase activation (Paddle-backed) ----
  license: {
    status: () => ipcRenderer.invoke('license-status'),
    activate: (key) => ipcRenderer.invoke('license-activate', { key }),
    deactivate: () => ipcRenderer.invoke('license-deactivate'),
    openCheckout: () => ipcRenderer.invoke('license-open-checkout'),
  },

  // ---- tokenUsage: sidebar leaderboard data ----
  tokenUsage: {
    // spec = { kind: 'preset', preset: '7d'|'14d'|'30d'|'6m'|'1y'|'all' }
    //      | { kind: 'custom', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
    range: (spec) => ipcRenderer.invoke('token-usage:range', spec),
    onUpdate: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('token-usage-updated', handler);
      return () => ipcRenderer.removeListener('token-usage-updated', handler);
    },
  },

  // ---- fs: File IO, bulk read, search, replace-in-files, worktree watcher, env files ----
  fs: {
    readFile: (filePath) => ipcRenderer.invoke('read-file', { filePath }),
    writeFile: (filePath, content) => ipcRenderer.invoke('write-file', { filePath, content }),
    statFile: (filePath) => ipcRenderer.invoke('stat-file', { filePath }),
    createFile: (worktreePath, relPath) => ipcRenderer.invoke('create-file', { worktreePath, relPath }),
    createDir: (worktreePath, relPath) => ipcRenderer.invoke('create-dir', { worktreePath, relPath }),
    renamePath: (worktreePath, fromRel, toRel) => ipcRenderer.invoke('rename-path', { worktreePath, fromRel, toRel }),
    deletePath: (worktreePath, relPath, permanent) => ipcRenderer.invoke('delete-path', { worktreePath, relPath, permanent }),
    revealInFolder: (filePath) => ipcRenderer.invoke('reveal-in-folder', { filePath }),
    copyToClipboard: (text) => ipcRenderer.invoke('clipboard-write-text', { text }),
    listFiles: (worktreePath) => ipcRenderer.invoke('list-files', { worktreePath }),
    readFilesBulk: (worktreePath, relPaths, maxBytesPerFile) =>
      ipcRenderer.invoke('read-files-bulk', { worktreePath, relPaths, maxBytesPerFile }),
    searchFiles: (worktreePath, query, maxPerFile) =>
      ipcRenderer.invoke('search-files', { worktreePath, query, maxPerFile }),
    replaceInFiles: (worktreePath, relPaths, query, replacement) =>
      ipcRenderer.invoke('replace-in-files', { worktreePath, relPaths, query, replacement }),
    readConflictFile: (worktreePath, file) => ipcRenderer.invoke('read-conflict-file', { worktreePath, file }),
    writeResolvedFile: (worktreePath, file, content) => ipcRenderer.invoke('write-resolved-file', { worktreePath, file, content }),
    listEnvFiles: (worktreePath) => ipcRenderer.invoke('list-env-files', { worktreePath }),
    readEnvFile: (worktreePath, filename) => ipcRenderer.invoke('read-env-file', { worktreePath, filename }),
    writeEnvFile: (worktreePath, filename, content) => ipcRenderer.invoke('write-env-file', { worktreePath, filename, content }),
    watchWorktree: (worktreePath) => ipcRenderer.invoke('watch-worktree', { worktreePath }),
    unwatchWorktree: (worktreePath) => ipcRenderer.invoke('unwatch-worktree', { worktreePath }),
    onWorktreeChanged: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('worktree-changed', handler);
      return () => ipcRenderer.removeListener('worktree-changed', handler);
    },
    getPathForFile: (file) => webUtils.getPathForFile(file),
  },

  // ---- lsp: Language-server proxy (thin wrapper around main/ipc/lsp.js) ----
  lsp: {
    start: (worktreePath, languageId) => ipcRenderer.invoke('lsp-start', { worktreePath, languageId }),
    stop: (serverId) => ipcRenderer.invoke('lsp-stop', { serverId }),
    request: (serverId, method, params) => ipcRenderer.invoke('lsp-request', { serverId, method, params }),
    notify: (serverId, method, params) => ipcRenderer.invoke('lsp-notify', { serverId, method, params }),
    install: (languageId) => ipcRenderer.invoke('lsp-install', { languageId }),
    onMessage: (serverId, callback) => {
      const channel = `lsp-message-${serverId}`;
      const handler = (_e, msg) => callback(msg);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onInstallProgress: (languageId, callback) => {
      const channel = `lsp-install-progress-${languageId}`;
      const handler = (_e, msg) => callback(msg);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },

  // ---- ui: Theme, preferences, about, logs, menu/show-* channels, new-window ----
  ui: {
    getTheme: () => ipcRenderer.invoke('get-theme'),
    setTheme: (theme) => ipcRenderer.invoke('set-theme', { theme }),
    getSystemTheme: () => ipcRenderer.invoke('get-system-theme'),
    onSystemThemeChanged: (callback) => {
      ipcRenderer.on('system-theme-changed', (_event, isDark) => callback(isDark));
    },
    openPreferences: () => ipcRenderer.invoke('open-preferences'),
    getPreferences: () => ipcRenderer.invoke('get-preferences'),
    setPreferences: (prefs) => ipcRenderer.invoke('set-preferences', prefs),
    onPreferencesChanged: (callback) => {
      ipcRenderer.on('preferences-changed', (_event, prefs) => callback(prefs));
    },
    getAboutInfo: () => ipcRenderer.invoke('get-about-info'),
    getClaudeInfo: () => ipcRenderer.invoke('get-claude-info'),
    getLogs: () => ipcRenderer.invoke('get-logs'),
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
    onShowHowToUse: (callback) => {
      ipcRenderer.on('show-how-to-use', () => callback());
    },
    onShowFeedback: (callback) => {
      ipcRenderer.on('show-feedback', () => callback());
    },
    onShowLogs: (callback) => {
      ipcRenderer.on('show-logs', () => callback());
    },
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
    newWindow: () => ipcRenderer.invoke('new-window'),
  },

  // ---- gh: gh CLI accounts, external URL opener, CI status, dep probe ----
  gh: {
    listAccounts: () => ipcRenderer.invoke('gh-list-accounts'),
    switchAccount: (username) => ipcRenderer.invoke('gh-switch-account', { username }),
    detectAccountForRepo: (owner, repo, prNumber) =>
      ipcRenderer.invoke('gh-detect-account-for-repo', { owner, repo, prNumber }),
    openExternal: (url) => ipcRenderer.invoke('open-external', { url }),
    ciStatus: (worktreePath, branch) => ipcRenderer.invoke('ci-status', { worktreePath, branch }),
    ciRunLogs: (worktreePath, runId) => ipcRenderer.invoke('ci-run-logs', { worktreePath, runId }),
    checkDependencies: () => ipcRenderer.invoke('check-dependencies'),
    installRequirements: () => ipcRenderer.invoke('install-requirements'),
    loginStart: (hostname) => ipcRenderer.invoke('gh-login-start', { hostname }),
    loginCancel: () => ipcRenderer.invoke('gh-login-cancel'),
    onLoginEvent: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('gh-login-event', listener);
      return () => ipcRenderer.removeListener('gh-login-event', listener);
    },
  },

  // ---- skills: Claude skills / commands / memory / MCP / plugins inventory ----
  skills: {
    listSkills: () => ipcRenderer.invoke('list-skills'),
    openFile: (filePath) => ipcRenderer.invoke('open-skill-file', { filePath }),
    readFile: (filePath) => ipcRenderer.invoke('read-skill-file', { filePath }),
    writeFile: (filePath, content) => ipcRenderer.invoke('write-skill-file', { filePath, content }),
    createFile: ({ type, scope, name }) => ipcRenderer.invoke('create-skill-file', { type, scope, name }),
    listMemory: () => ipcRenderer.invoke('list-memory-files'),
    createMemory: (filePath) => ipcRenderer.invoke('create-memory-file', { filePath }),
    listMcp: () => ipcRenderer.invoke('list-mcp-servers'),
    listPlugins: () => ipcRenderer.invoke('list-plugins'),
  },
});
