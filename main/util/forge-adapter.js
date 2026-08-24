// Reshape GitLab API payloads into the PR-review shapes the GitHub path already produces.

const { ghJson, ghText } = require('./gh-json');
const { glabJson, glabText } = require('./glab-json');
const { parseForgeUrl, detectForgeFromRemote } = require('./forge-url');
const { classifyGhError } = require('./gh-error');
const { classifyGlabError } = require('./glab-error');
const { humanizeComment } = require('./humanize-comment');

// Map GitLab pipeline/job status to Klaussy check bucket ('pass' | 'fail' | 'pending' | 'cancel')
function bucketFromGitLabStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'success') return 'pass';
  if (s === 'failed') return 'fail';
  if (s === 'canceled' || s === 'cancelled') return 'cancel';
  if (s === 'running' || s === 'pending' || s === 'created' || s === 'waiting_for_resource' || s === 'preparing' || s === 'manual') {
    return 'pending';
  }
  return 'pending';
}

// Normalize GitLab MR JSON from `glab mr view --output json` into unified PR metadata shape
function normalizeGitLabMr(mr, host = 'gitlab.com') {
  const number = mr.iid || mr.id;
  const state = (mr.state === 'opened' || mr.state === 'open') ? 'OPEN' : (mr.state || '').toUpperCase();
  const authorName = (mr.author && (mr.author.username || mr.author.name)) || '';

  return {
    forge: 'gitlab',
    host,
    number,
    title: mr.title || '',
    author: { login: authorName, name: (mr.author && mr.author.name) || authorName },
    state,
    createdAt: mr.created_at || '',
    updatedAt: mr.updated_at || '',
    headRefName: mr.source_branch || '',
    baseRefName: mr.target_branch || '',
    headRefOid: mr.sha || (mr.diff_refs && mr.diff_refs.head_sha) || '',
    isDraft: !!(mr.draft || mr.work_in_progress || /^draft:/i.test(mr.title || '')),
    reviewDecision: mr.detailed_merge_status || (mr.has_conflicts ? 'CONFLICT' : 'REVIEW_REQUIRED'),
    url: mr.web_url || `https://${host}/${mr.project_id}/-/merge_requests/${number}`,
    body: mr.description || '',
    mergeable: mr.has_conflicts ? 'CONFLICTING' : 'MERGEABLE',
    mergeStateStatus: mr.detailed_merge_status || mr.merge_status || '',
    diff_refs: mr.diff_refs || null,
  };
}

// Transform GitLab discussions into unified { threads, issueComments }
function transformGitLabDiscussions(discussions) {
  const threads = [];
  const issueComments = [];

  if (!Array.isArray(discussions)) return { threads, issueComments };

  for (const disc of discussions) {
    if (!disc || !Array.isArray(disc.notes) || disc.notes.length === 0) continue;

    // Filter out system notes (e.g. "merged branch", "assigned to")
    const userNotes = disc.notes.filter((n) => !n.system);
    if (userNotes.length === 0) continue;

    const firstNote = userNotes[0];
    const isDiffDiscussion = !!(firstNote.position && (firstNote.position.new_path || firstNote.position.old_path));

    if (isDiffDiscussion) {
      const pos = firstNote.position;
      const isResolved = userNotes.every((n) => !n.resolvable || n.resolved);
      const filePath = pos.new_path || pos.old_path || '';
      const line = pos.new_line || pos.old_line || 1;
      const diffSide = pos.new_line ? 'RIGHT' : 'LEFT';

      threads.push({
        id: disc.id,
        isResolved,
        isOutdated: false,
        path: filePath,
        line,
        originalLine: line,
        startLine: null,
        originalStartLine: null,
        diffSide,
        comments: userNotes.map((n) => ({
          databaseId: n.id,
          author: { login: (n.author && (n.author.username || n.author.name)) || 'unknown' },
          createdAt: n.created_at || '',
          body: n.body || '',
          diffHunk: '',
        })),
      });
    } else {
      for (const n of userNotes) {
        issueComments.push({
          databaseId: n.id,
          author: { login: (n.author && (n.author.username || n.author.name)) || 'unknown' },
          createdAt: n.created_at || '',
          body: n.body || '',
          url: '',
        });
      }
    }
  }

  return { threads, issueComments };
}

module.exports = {
  bucketFromGitLabStatus,
  normalizeGitLabMr,
  transformGitLabDiscussions,
};
