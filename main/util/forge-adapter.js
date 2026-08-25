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

// Map Bitbucket commit/pipeline status to Klaussy check bucket ('pass' | 'fail' | 'pending' | 'cancel')
function bucketFromBitbucketStatus(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'SUCCESSFUL' || s === 'SUCCESS' || s === 'PASSED') return 'pass';
  if (s === 'FAILED' || s === 'FAILURE' || s === 'ERROR') return 'fail';
  if (s === 'STOPPED' || s === 'CANCELLED' || s === 'CANCELED') return 'cancel';
  if (s === 'INPROGRESS' || s === 'PENDING' || s === 'CREATED' || s === 'RUNNING' || s === 'QUEUED') {
    return 'pending';
  }
  return 'pending';
}

// Normalize Bitbucket PR JSON into unified PR metadata shape
function normalizeBitbucketPr(pr, host = 'bitbucket.org') {
  const number = pr.id;
  const state = (pr.state === 'OPEN' || pr.state === 'open') ? 'OPEN' : (pr.state || '').toUpperCase();
  const authorUser = pr.author || {};
  const authorLogin = authorUser.nickname || authorUser.username || authorUser.display_name || 'unknown';
  const authorName = authorUser.display_name || authorLogin;

  const source = pr.source || {};
  const dest = pr.destination || {};
  const srcRepo = source.repository || {};
  const destRepo = dest.repository || {};

  const headOwner = srcRepo.full_name ? srcRepo.full_name.split('/')[0] : '';
  const headRepoName = srcRepo.name || (srcRepo.full_name ? srcRepo.full_name.split('/')[1] : '');

  const body = (pr.summary && pr.summary.raw)
    || (pr.description && pr.description.raw)
    || (typeof pr.description === 'string' ? pr.description : '')
    || '';

  const htmlUrl = (pr.links && pr.links.html && pr.links.html.href)
    || `https://${host}/${destRepo.full_name || ''}/pull-requests/${number}`;

  return {
    forge: 'bitbucket',
    host,
    number,
    title: pr.title || '',
    author: { login: authorLogin, name: authorName },
    state,
    createdAt: pr.created_on || '',
    updatedAt: pr.updated_on || '',
    headRefName: (source.branch && source.branch.name) || '',
    baseRefName: (dest.branch && dest.branch.name) || '',
    headRefOid: (source.commit && source.commit.hash) || '',
    isDraft: !!(pr.draft || /^draft:/i.test(pr.title || '')),
    reviewDecision: (pr.state === 'MERGED') ? 'MERGED' : 'REVIEW_REQUIRED',
    url: htmlUrl,
    body,
    mergeable: 'MERGEABLE',
    mergeStateStatus: pr.state || '',
    headRepositoryOwner: headOwner ? { login: headOwner } : null,
    headRepository: headRepoName ? { name: headRepoName } : null,
  };
}

// Transform Bitbucket comments into unified { threads, issueComments }
function transformBitbucketComments(comments) {
  const threads = [];
  const issueComments = [];

  const rawList = Array.isArray(comments) ? comments : (comments && Array.isArray(comments.values) ? comments.values : []);
  if (rawList.length === 0) return { threads, issueComments };

  const commentMap = new Map();
  const replies = [];

  for (const c of rawList) {
    if (!c || c.deleted) continue;
    const user = c.user || {};
    const authorLogin = user.nickname || user.username || user.display_name || 'unknown';
    const normComment = {
      databaseId: c.id,
      author: { login: authorLogin },
      createdAt: c.created_on || '',
      body: (c.content && c.content.raw) || (typeof c.content === 'string' ? c.content : '') || '',
      diffHunk: '',
    };

    if (c.parent && c.parent.id) {
      replies.push({ parentId: c.parent.id, comment: normComment, raw: c });
    } else if (c.inline && (c.inline.path || c.inline.to || c.inline.from)) {
      const line = c.inline.to || c.inline.from || 1;
      const diffSide = c.inline.to ? 'RIGHT' : 'LEFT';
      const isResolved = !!(c.resolved || (c.resolution && c.resolution.resolved));
      const thread = {
        id: String(c.id),
        isResolved,
        isOutdated: false,
        path: c.inline.path || '',
        line,
        originalLine: line,
        startLine: null,
        originalStartLine: null,
        diffSide,
        comments: [normComment],
      };
      threads.push(thread);
      commentMap.set(c.id, thread);
    } else {
      issueComments.push({
        databaseId: c.id,
        author: { login: authorLogin },
        createdAt: c.created_on || '',
        body: normComment.body,
        url: (c.links && c.links.html && c.links.html.href) || '',
      });
    }
  }

  // Attach replies
  for (const reply of replies) {
    const thread = commentMap.get(reply.parentId);
    if (thread) {
      thread.comments.push(reply.comment);
      if (reply.raw.resolved || (reply.raw.resolution && reply.raw.resolution.resolved)) {
        thread.isResolved = true;
      }
    } else {
      const matchedThread = threads.find((t) => t.comments.some((tc) => tc.databaseId === reply.parentId));
      if (matchedThread) {
        matchedThread.comments.push(reply.comment);
        if (reply.raw.resolved || (reply.raw.resolution && reply.raw.resolution.resolved)) {
          matchedThread.isResolved = true;
        }
      } else {
        issueComments.push({
          databaseId: reply.comment.databaseId,
          author: reply.comment.author,
          createdAt: reply.comment.createdAt,
          body: reply.comment.body,
          url: (reply.raw.links && reply.raw.links.html && reply.raw.links.html.href) || '',
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
  bucketFromBitbucketStatus,
  normalizeBitbucketPr,
  transformBitbucketComments,
};
