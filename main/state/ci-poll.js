// Background timers: per-task GitHub CI polling (30s cadence) and repo-wide
// auto-fetch (60s default). Both push update events out to every window.
//
// This module imports the `instances` Map from ./instances to iterate live
// tasks in startAutoFetch. That's a one-way dep — instances never imports
// ci-poll. Instead, instances.spawnInWorktree calls startCIPolling through
// a setDeps injection wired from main.js, which breaks the would-be cycle.

const { execFileP, ghExecP, runWithConcurrency } = require('../util/exec');
const { loadConfig } = require('../util/config');
const { allWindows } = require('./windows');
const { instances, sendCIFlipNotification } = require('./instances');

// ---- CI/CD Status (Feature 3) ----

const ciPollingIntervals = new Map(); // taskId -> intervalId
// Per-task aggregate-bucket memory so we can fire a notification only on the
// transition from pending → pass/fail (not on every successful poll).
// Shape: Map<taskId, { bucket, headRunUrl }>.
const lastBucketByTask = new Map();

function bucketFromRun(run) {
  const status = (run && run.status || '').toLowerCase();
  const conclusion = (run && run.conclusion || '').toLowerCase();
  if (status === 'in_progress' || status === 'queued' || status === 'requested' || status === 'waiting' || status === 'pending' || status === '') {
    return 'pending';
  }
  if (conclusion === 'success' || conclusion === 'neutral') return 'pass';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required') return 'fail';
  if (conclusion === 'cancelled') return 'cancel';
  if (conclusion === 'skipped') return 'pending';
  return 'pending';
}

function startCIPolling(id, worktreePath, branch) {
  stopCIPolling(id);
  // No branch = plain folder (open-folder flow). CI has nothing to poll for.
  if (!branch) return;
  // Async poll so gh round-trip doesn't block the main thread. A 10s timeout
  // on a stuck gh call used to freeze every window; now the event loop keeps
  // running while we wait.
  const poll = async () => {
    try {
      const { stdout } = await ghExecP([
        'run', 'list', '--branch', branch, '--limit', '5',
        '--json', 'status,conclusion,name,url,createdAt',
      ], { cwd: worktreePath, timeout: 10000 });
      const runs = JSON.parse(stdout);
      for (const win of allWindows) {
        if (!win.isDestroyed()) {
          win.webContents.send('ci-status-update', { id, runs });
        }
      }

      // Detect bucket flips on the latest run. Only fire when transitioning
      // *out of* pending — this avoids notifications on the first poll (which
      // would otherwise spam every time a task is created).
      if (Array.isArray(runs) && runs.length > 0) {
        const latest = runs.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
        const newBucket = bucketFromRun(latest);
        const prev = lastBucketByTask.get(id);
        const inst = instances.get(id);
        if (inst && prev && prev.bucket === 'pending' && (newBucket === 'pass' || newBucket === 'fail')) {
          sendCIFlipNotification(inst, latest, newBucket);
        }
        // Always update — including on the first poll, so we have a baseline
        // for next time.
        lastBucketByTask.set(id, { bucket: newBucket, headRunUrl: latest.url || null });
      }
    } catch (_) { /* silent — background poll */ }
  };
  // Initial poll after short delay.
  const initialTimer = setTimeout(poll, 3000);
  const intervalTimer = setInterval(poll, 30000);
  // Track both so stopCIPolling can cancel a pending initial-poll timeout
  // (previously only the interval was tracked, so a kill within 3s of spawn
  // still left the initial poll firing against the now-dead task).
  ciPollingIntervals.set(id, { intervalTimer, initialTimer });
}

function stopCIPolling(id) {
  const timers = ciPollingIntervals.get(id);
  if (!timers) return;
  // Older entries were a single intervalId; new ones are { intervalTimer,
  // initialTimer }. Handle both shapes defensively.
  if (typeof timers === 'object') {
    if (timers.intervalTimer) clearInterval(timers.intervalTimer);
    if (timers.initialTimer) clearTimeout(timers.initialTimer);
  } else {
    clearInterval(timers);
  }
  ciPollingIntervals.delete(id);
  lastBucketByTask.delete(id);
}

// ---- Auto-fetch (Feature 15) ----

let autoFetchIntervalId = null;

function startAutoFetch() {
  if (autoFetchIntervalId) {
    clearInterval(autoFetchIntervalId);
    autoFetchIntervalId = null;
  }
  const config = loadConfig();
  const interval = config.autoFetchInterval || 60000; // default 60s
  if (interval <= 0) return;

  // Per-task fetch + ahead/behind refresh. Cap concurrency at 4 so a user with
  // many tasks doesn't spawn 20 simultaneous git fetch subprocesses (which
  // both hammers GH and exhausts connection slots).
  async function fetchOne([id, inst]) {
    if (!inst.alive || !inst.worktreePath) return;
    // Plain-folder tasks (opened via open-folder) have no branch — skip git.
    if (!inst.branch) return;
    try {
      await execFileP('git', ['fetch', '--prune'], {
        cwd: inst.worktreePath, timeout: 10000,
      });
    } catch (_) { return; /* fetch failed — nothing to report */ }
    try {
      const { stdout } = await execFileP(
        'git', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
        { cwd: inst.worktreePath, timeout: 5000 },
      );
      const parts = stdout.trim().split(/\s+/);
      const ahead = parseInt(parts[0], 10) || 0;
      const behind = parseInt(parts[1], 10) || 0;
      for (const win of allWindows) {
        if (!win.isDestroyed()) {
          win.webContents.send('auto-fetch-update', { id, ahead, behind });
        }
      }
    } catch (_) { /* no upstream — skip */ }
  }

  autoFetchIntervalId = setInterval(() => {
    // Snapshot the instances map — new tasks spawned mid-tick will pick up
    // on the next tick instead of racing with this one.
    const snapshot = Array.from(instances.entries());
    runWithConcurrency(snapshot, 4, fetchOne);
  }, interval);
}

module.exports = {
  ciPollingIntervals,
  startCIPolling,
  stopCIPolling,
  startAutoFetch,
};
