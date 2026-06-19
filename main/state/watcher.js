// H3: Worktree file watcher for instant diff refresh.
//
// One fs.watch per worktree, shared across all subscribers (diff panel +
// H2 sidebar + anything else). Subscribers is a per-webContents refcount
// (Map<webContents, number>) rather than a Set, so independent renderer
// features that both watch the same worktree don't clobber each other's
// subscription when one unsubscribes.

const fs = require('fs');

const worktreeWatchers = new Map(); // worktreePath -> { watcher, subscribers: Map<webContents, number>, debounceTimer }

// Path patterns we ignore — high-churn build output and git internals that don't
// affect our UI. .git/index and .git/HEAD are NOT ignored: they signal git state
// changes we want to reflect (commits, stages made from the terminal, etc.).
// `.git/*.lock` (esp. index.lock) is pure git-internal churn: read-only git
// commands the UI runs in reaction to a change (status/diff/ls-files) take and
// drop the index lock, which would re-fire the watcher → reload → git → … an
// infinite loop. Lock files are NEVER a meaningful UI signal, so drop them.
// `.git/index` itself stays watched so real terminal commits/stages refresh.
const WATCH_IGNORE_RE = /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|__pycache__|\.pytest_cache|\.mypy_cache|\.turbo|target|\.DS_Store)(\/|$)|^\.git\/(objects|logs|refs|packed-refs|FETCH_HEAD|ORIG_HEAD|COMMIT_EDITMSG|info)|^\.git\/.*\.lock$/;

// Set KLAUSSY_WATCH_DEBUG=1 to log every change that survives the ignore filter
// — the fastest way to find what's churning behind an "infinite reload".
const WATCH_DEBUG = process.env.KLAUSSY_WATCH_DEBUG === '1';

function startWorktreeWatcher(worktreePath) {
  let state = worktreeWatchers.get(worktreePath);
  if (state) return state;

  state = { watcher: null, subscribers: new Map(), debounceTimer: null };

  try {
    // Coalesce filenames over the debounce window so listeners can scope
    // their reactions (e.g. external-mod detection only rechecks open files
    // that are actually in the changed set).
    state.changed = new Set();
    state.watcher = fs.watch(worktreePath, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      // Normalize separators — on macOS we get forward slashes already, but be safe.
      const rel = filename.replace(/\\/g, '/');
      if (WATCH_IGNORE_RE.test(rel)) return;
      if (WATCH_DEBUG) console.log('[watch]', worktreePath, '→', rel);
      state.changed.add(rel);

      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        const changedFiles = Array.from(state.changed);
        state.changed.clear();
        for (const wc of state.subscribers.keys()) {
          if (!wc.isDestroyed()) wc.send('worktree-changed', { worktreePath, changedFiles });
        }
      }, 200);
    });
    state.watcher.on('error', (err) => {
      console.error('[watch]', worktreePath, err.message);
    });
  } catch (err) {
    console.error('[watch] failed to start', worktreePath, err.message);
    return null;
  }

  worktreeWatchers.set(worktreePath, state);
  return state;
}

function stopWorktreeWatcher(worktreePath) {
  const state = worktreeWatchers.get(worktreePath);
  if (!state) return;
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  try { state.watcher && state.watcher.close(); } catch (_) {}
  worktreeWatchers.delete(worktreePath);
}

module.exports = {
  worktreeWatchers,
  startWorktreeWatcher,
  stopWorktreeWatcher,
};
