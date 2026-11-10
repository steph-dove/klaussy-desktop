// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
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

// Azure build results and PR status states to Klaussy check buckets.
function bucketFromAzureStatus(state) {
  const s = String(state || '').toLowerCase();
  if (s === 'succeeded' || s === 'partiallysucceeded') return 'pass';
  if (s === 'failed' || s === 'error') return 'fail';
  if (s === 'canceled' || s === 'cancelled' || s === 'notapplicable') return 'cancel';
  return 'pending';
}

function stripHeads(ref) {
  return String(ref || '').replace(/^refs\/heads\//, '');
}

// pr is GET .../pullrequests/{id}. The web URL is built here because the API
// doesn't return one, and parseForgeUrl reads every later call's repo from it.
function normalizeAzurePr(pr, { collectionUrl } = {}) {
  const repo = pr.repository || {};
  const project = (repo.project && repo.project.name) || '';
  const repoWeb = repo.webUrl
    || `${String(collectionUrl || '').replace(/\/+$/, '')}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo.name || '')}`;
  const url = `${repoWeb}/pullrequest/${pr.pullRequestId}`;
  const base = parseForgeUrl(url);
  if (!base || base.forge !== 'azure') throw new Error(`Could not work out the Azure DevOps repository for PR ${pr.pullRequestId}`);

  // A PR from a fork pushes to the fork, which lives in the same collection.
  const fork = pr.forkSource && pr.forkSource.repository;
  const headRepo = fork || repo;
  const headProject = (headRepo.project && headRepo.project.name) || project;
  const headOwner = `${base.collectionPath}/${headProject}`.toLowerCase();

  const status = String(pr.status || '').toLowerCase();
  const state = status === 'active' ? 'OPEN' : status === 'completed' ? 'MERGED' : status === 'abandoned' ? 'CLOSED' : status.toUpperCase();
  const votes = (pr.reviewers || []).map((r) => r.vote || 0);
  let reviewDecision = 'REVIEW_REQUIRED';
  if (state === 'MERGED') reviewDecision = 'MERGED';
  else if (votes.some((v) => v < 0)) reviewDecision = 'CHANGES_REQUESTED';
  else if (votes.some((v) => v >= 5)) reviewDecision = 'APPROVED';

  const author = pr.createdBy || {};
  const [mergeable, mergeStateStatus] = AZURE_MERGE[String(pr.mergeStatus || '').toLowerCase()] || ['UNKNOWN', ''];
  return {
    forge: 'azure',
    host: base.host,
    number: pr.pullRequestId,
    title: pr.title || '',
    author: { login: author.uniqueName || author.displayName || 'unknown', name: author.displayName || author.uniqueName || '' },
    state,
    createdAt: pr.creationDate || '',
    updatedAt: pr.closedDate || pr.creationDate || '',
    headRefName: stripHeads(pr.sourceRefName),
    baseRefName: stripHeads(pr.targetRefName),
    headRefOid: (pr.lastMergeSourceCommit && pr.lastMergeSourceCommit.commitId) || '',
    baseRefOid: (pr.lastMergeTargetCommit && pr.lastMergeTargetCommit.commitId) || '',
    isDraft: !!pr.isDraft,
    reviewDecision,
    url,
    body: pr.description || '',
    mergeable,
    mergeStateStatus,
    headRepositoryOwner: headOwner ? { login: headOwner } : null,
    headRepository: headRepo.name ? { name: headRepo.name.toLowerCase() } : null,
  };
}

// Azure mergeStatus to GitHub's mergeable/mergeStateStatus pair the merge gate reads.
// queued and notSet mean Azure hasn't tried the merge yet.
const AZURE_MERGE = {
  succeeded: ['MERGEABLE', 'CLEAN'],
  conflicts: ['CONFLICTING', 'DIRTY'],
  rejectedbypolicy: ['MERGEABLE', 'BLOCKED'],
  failure: ['UNKNOWN', 'BLOCKED'],
};

const AZURE_RESOLVED = new Set(['fixed', 'closed', 'wontfix', 'bydesign']);

// A thread with a file context is a review thread; one without is a PR comment.
// databaseId is "{threadId}:{commentId}" because Azure comment ids restart at 1 in every thread.
function transformAzureThreads(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.value) ? raw.value : []);
  const threads = [];
  const issueComments = [];
  for (const t of list) {
    if (!t || t.isDeleted) continue;
    const comments = (t.comments || [])
      .filter((c) => c && !c.isDeleted && c.commentType !== 'system' && c.commentType !== 'codeChange')
      .map((c) => ({
        databaseId: `${t.id}:${c.id}`,
        author: { login: (c.author && (c.author.uniqueName || c.author.displayName)) || 'unknown' },
        createdAt: c.publishedDate || '',
        body: c.content || '',
        diffHunk: '',
      }));
    if (!comments.length) continue;
    const ctx = t.threadContext;
    if (ctx && ctx.filePath) {
      const right = ctx.rightFileStart && ctx.rightFileStart.line;
      const left = ctx.leftFileStart && ctx.leftFileStart.line;
      const line = right || left || 1;
      threads.push({
        id: String(t.id),
        isResolved: AZURE_RESOLVED.has(String(t.status || '').toLowerCase()),
        isOutdated: false,
        path: ctx.filePath.replace(/^\//, ''),
        line,
        originalLine: line,
        startLine: null,
        originalStartLine: null,
        diffSide: right ? 'RIGHT' : 'LEFT',
        comments,
      });
    } else {
      for (const c of comments) issueComments.push({ ...c, url: '' });
    }
  }
  return { threads, issueComments };
}

// The picker's row shape, the same fields `gh pr list --json` returns.
function prListItem(norm) {
  return {
    number: norm.number,
    title: norm.title,
    author: norm.author,
    state: norm.state,
    updatedAt: norm.updatedAt,
    headRefName: norm.headRefName,
    baseRefName: norm.baseRefName,
    isDraft: norm.isDraft,
    reviewDecision: norm.reviewDecision,
    url: norm.url,
  };
}

module.exports = {
  prListItem,
  bucketFromGitLabStatus,
  normalizeGitLabMr,
  transformGitLabDiscussions,
  bucketFromBitbucketStatus,
  normalizeBitbucketPr,
  transformBitbucketComments,
  bucketFromAzureStatus,
  normalizeAzurePr,
  transformAzureThreads,
};
