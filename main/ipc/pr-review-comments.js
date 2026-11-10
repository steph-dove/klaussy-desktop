// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// PR-review comment + review-submission IPC: issue comments, inline review
// comment edits/replies, the batched review submission (G4), and the cached
// current-user lookup. Split out of pr-review.js; required for its
// ipcMain.handle side effects. The forge-specific calls live in util/forges.

const { ipcMain } = require('electron');
const { humanizeComment, humanizeCommentP } = require('../util/humanize-comment');
const { botCommentBodies } = require('../util/bot-comment');
const { getForge } = require('../util/forges');
const {
  prReview, currentRepoPath, fetchThreadsForActive,
} = require('../state/pr-review');

ipcMain.handle('pr-add-issue-comment', async (_event, { body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, projectPath } = prReview.active;
  if (!baseOwner && !projectPath) return { error: 'Could not determine base repo' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  body = humanizeComment(body);
  const cwd = currentRepoPath() || require('os').homedir();
  return getForge(prReview.active.forge).addIssueComment(prReview.active, { body, cwd });
});

async function editComment(kind, { commentId, body }) {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, projectPath } = prReview.active;
  if (!baseOwner && !projectPath) return { error: 'Could not determine base repo' };
  // Azure DevOps ids are "{threadId}:{commentId}"; the adapter checks them.
  const id = prReview.active.forge === 'azure' ? String(commentId || '') : parseInt(commentId, 10);
  if (!id) return { error: 'Missing or invalid comment id' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  body = humanizeComment(body);
  const cwd = currentRepoPath() || require('os').homedir();
  return getForge(prReview.active.forge).editComment(prReview.active, { id, body, kind, cwd });
}

ipcMain.handle('pr-edit-issue-comment', (_event, args) => editComment('issue', args));

ipcMain.handle('pr-edit-review-comment', (_event, args) => editComment('review', args));

ipcMain.handle('pr-bot-comment-bodies', async (_event, { findings } = {}) => ({
  bodies: await botCommentBodies(findings),
}));

ipcMain.handle('pr-humanize-preview', async (_event, { body } = {}) => {
  if (typeof body !== 'string') return { body: '' };
  return { body: await humanizeCommentP(body) };
});

// Keyed by forge, host and account: one module-wide value made a review on
// another forge or account show the previous review's user as "you". Azure
// DevOps picks the account per organization, so its key adds the repo's owner.
const cachedCurrentUser = new Map();
ipcMain.handle('pr-current-user', async () => {
  const pr = prReview.active;
  const adapter = getForge(pr && pr.forge);
  const scope = adapter.id === 'azure' ? `:${(pr && pr.baseOwner) || ''}` : '';
  const key = `${adapter.id}:${(pr && pr.host) || ''}:${(pr && pr.account) || ''}${scope}`;
  if (cachedCurrentUser.has(key)) return { login: cachedCurrentUser.get(key) };
  const cwd = currentRepoPath() || require('os').homedir();

  const res = await adapter.currentUser(pr, { cwd });
  if (res.error) return res;
  if (res.login) cachedCurrentUser.set(key, res.login);
  return { login: cachedCurrentUser.has(key) ? cachedCurrentUser.get(key) : null };
});

ipcMain.handle('pr-reply-to-review-comment', async (_event, { inReplyTo, body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, projectPath } = prReview.active;
  if (!baseOwner && !projectPath) return { error: 'Could not determine base repo' };
  if (!body || !body.trim()) return { error: 'Reply body is empty' };

  body = humanizeComment(body);
  const cwd = currentRepoPath() || require('os').homedir();
  return getForge(prReview.active.forge).reply(prReview.active, { inReplyTo, body, cwd });
});

ipcMain.handle('pr-review-resolve-thread', async (_event, { threadId, resolve }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  if (!threadId) return { error: 'Missing thread id' };
  const cwd = currentRepoPath() || require('os').homedir();

  const res = await getForge(prReview.active.forge).resolveThread(prReview.active, { threadId, resolve, cwd });
  if (res.error) return res;
  try { await fetchThreadsForActive(); } catch (_) {}
  return { ok: true };
});

ipcMain.handle('pr-submit-review', async (_event, { event, body, comments }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, projectPath } = prReview.active;
  if (!baseOwner && !projectPath) return { error: 'Could not determine base repo' };
  if (!event) return { error: 'Missing review event (APPROVE / REQUEST_CHANGES / COMMENT)' };

  // Split incoming drafts: inline review comments go in the review payload;
  // issueComment:true drafts (Claude-implement follow-ups whose location
  // couldn't be verified) post after the review as general PR comments.
  const rawComments = comments || [];
  const inlineComments = rawComments.filter((c) => !c.issueComment);
  const issueCommentDrafts = rawComments.filter((c) => c.issueComment);

  const cwd = currentRepoPath() || require('os').homedir();
  return getForge(prReview.active.forge).submitReview(prReview.active, {
    event, body, inlineComments, issueCommentDrafts, cwd,
  });
});
