// Normalizers that reshape gh's check-rollup / commit-status payloads into
// the { name, state, bucket, link, ... } shape the renderer draws. Pure;
// shared by the review-surface checks (pr-review-checks.js) and the
// worktree-based pr-checks handler (pr-review.js).

function bucketFromState(rawState) {
  const s = (rawState || '').toLowerCase();
  if (s === 'success' || s === 'neutral') return 'pass';
  if (s === 'failure' || s === 'timed_out' || s === 'action_required' || s === 'error') return 'fail';
  if (s === 'cancelled') return 'cancel';
  if (s === 'skipped') return 'skipping';
  if (['queued', 'in_progress', 'pending', 'waiting', 'expected', 'requested'].includes(s)) return 'pending';
  return 'pending';
}

function normalizeCheckRun(r) {
  // GitHub REST check-run: { id, name, status, conclusion, details_url, output: {...}, app: { name, slug }, started_at, completed_at, ... }
  const rawState = (r.conclusion || r.status || '').toLowerCase();
  const link = r.details_url || r.html_url || '';
  // GitHub job links look like https://github.com/<o>/<r>/actions/runs/<runId>/job/<jobId>
  const m = link.match(/\/actions\/runs\/(\d+)\/job\/(\d+)/);
  return {
    id: r.id || null,                                   // check-run id (for annotations endpoint)
    name: r.name || '(unnamed)',
    state: rawState,
    bucket: bucketFromState(rawState),
    link,
    workflow: (r.app && r.app.name) || '',
    appSlug: (r.app && r.app.slug) || '',               // 'github-actions' vs third-party
    description: (r.output && r.output.title) || '',
    summary: (r.output && r.output.summary) || '',      // longer text shown in failing-row expand
    runId: m ? m[1] : null,
    jobId: m ? m[2] : null,
    startedAt: r.started_at || null,
    completedAt: r.completed_at || null,
  };
}

function normalizeStatus(s) {
  // Legacy REST status: { context, state, target_url, description, created_at, updated_at, ... }
  return {
    id: null,
    name: s.context || '(unnamed)',
    state: (s.state || '').toLowerCase(),
    bucket: bucketFromState(s.state),
    link: s.target_url || '',
    workflow: '',
    appSlug: '',
    description: s.description || '',
    summary: '',
    runId: null,
    jobId: null,
    startedAt: s.created_at || null,
    completedAt: s.updated_at || null,
  };
}

module.exports = { bucketFromState, normalizeCheckRun, normalizeStatus };
