// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Bitbucket Cloud and Data Center behind the forge adapter interface, over the REST API.

const { loadConfig } = require('../config');
const {
  bitbucketJson, bitbucketText, bitbucketFetch, getBitbucketAuth, switchBitbucketAccount,
} = require('../bitbucket-api');
const { classifyBitbucketError } = require('../bitbucket-error');
const { parseForgeUrl } = require('../forge-url');
const {
  prListItem, normalizeBitbucketPr, transformBitbucketComments, bucketFromBitbucketStatus,
} = require('../forge-adapter');
const { submitReviewSequential, outboundBody } = require('./review-sequence');

const DEFAULT_HOST = 'bitbucket.org';

function hostOf(pr) {
  return pr.host || DEFAULT_HOST;
}

function targetOf(pr) {
  return pr.projectPath || `${pr.baseOwner}/${pr.baseRepo}`;
}

function errorText(err) {
  return (err.responseBody || err.message || '').trim();
}

module.exports = {
  id: 'bitbucket',
  label: 'Bitbucket',
  itemNoun: 'PR',
  defaultHost: DEFAULT_HOST,
  branchPrefix: 'bb',

  classifyError(raw, ctx = {}) {
    return classifyBitbucketError(raw, ctx);
  },

  async listOpen({ info }) {
    const raw = await bitbucketJson(`/repositories/${encodeURIComponent(info.projectPath)}/pullrequests?state=OPEN&pagelen=50`, { host: info.host });
    const values = (raw && Array.isArray(raw.values)) ? raw.values : (Array.isArray(raw) ? raw : []);
    return values.map((pr) => prListItem(normalizeBitbucketPr(pr, info.host)));
  },

  async lookupPr(_url, { parsed }) {
    const raw = await bitbucketJson(`/repositories/${parsed.projectPath}/pullrequests/${parsed.number}`, { host: parsed.host });
    return normalizeBitbucketPr(raw, parsed.host);
  },

  async loadPr({ target, projectPath, host, account }) {
    let targetNumber = target;
    if (typeof targetNumber === 'string' && targetNumber.includes('/')) {
      const p = parseForgeUrl(targetNumber);
      if (p) {
        targetNumber = String(p.number);
        projectPath = p.projectPath;
        host = p.host;
      }
    }
    const [rawPr, diff] = await Promise.all([
      bitbucketJson(`/repositories/${projectPath}/pullrequests/${targetNumber}`, { account, host }),
      bitbucketText(`/repositories/${projectPath}/pullrequests/${targetNumber}/diff`, { account, host }),
    ]);
    const meta = normalizeBitbucketPr(rawPr, host);
    const base = parseForgeUrl(meta.url);
    const repo = base ? base.projectPath : (projectPath || null);
    return {
      meta,
      diff,
      host,
      repo,
      baseOwner: base ? base.owner : (repo ? repo.split('/')[0] : null),
      baseRepo: base ? base.repo : (repo ? repo.split('/')[1] : null),
    };
  },

  async refreshPr(pr) {
    const host = hostOf(pr);
    const parsed = parseForgeUrl(pr.meta.url);
    const proj = (parsed && parsed.projectPath) || pr.projectPath;
    const num = (parsed && parsed.number) || pr.number;
    const [rawPr, diff] = await Promise.all([
      bitbucketJson(`/repositories/${proj}/pullrequests/${num}`, { account: pr.account, host }),
      bitbucketText(`/repositories/${proj}/pullrequests/${num}/diff`, { account: pr.account, host }),
    ]);
    return { meta: normalizeBitbucketPr(rawPr, host), diff };
  },

  async reloadMeta(pr) {
    const host = hostOf(pr);
    const parsed = parseForgeUrl(pr.meta.url);
    const proj = (parsed && parsed.projectPath) || pr.projectPath;
    const num = (parsed && parsed.number) || pr.number;
    const raw = await bitbucketJson(`/repositories/${proj}/pullrequests/${num}`, { account: pr.account, host });
    return normalizeBitbucketPr(raw, host);
  },

  async fetchThreads(pr, { cwd }) {
    const host = hostOf(pr);
    const account = pr.account;
    const target = targetOf(pr);
    try {
      const res = await bitbucketJson(`/repositories/${target}/pullrequests/${pr.number}/comments?pagelen=100`, {
        account, host, cwd,
      });
      const { threads, issueComments } = transformBitbucketComments(res.values || res);
      return { threads, issueComments, reviews: [] };
    } catch (err) {
      const raw = errorText(err);
      const cls = classifyBitbucketError(raw, { target, host, account });
      return { error: { summary: cls.summary, fix: cls.fix, raw } };
    }
  },

  async listChecks(pr, { cwd }) {
    const { meta, account, host } = pr;
    const target = targetOf(pr);
    const sha = meta && (meta.headRefOid || (meta.diff_refs && meta.diff_refs.head_sha) || '');
    if (!sha) return { checks: [], error: 'Missing head commit sha' };
    try {
      const res = await bitbucketJson(`/repositories/${target}/commit/${sha}/statuses`, {
        host: host || DEFAULT_HOST,
        account,
        cwd,
      });
      const values = (res && Array.isArray(res.values)) ? res.values : (Array.isArray(res) ? res : []);
      const checks = values.map((st) => ({
        name: st.name || st.key || 'Bitbucket Check',
        state: st.state,
        bucket: bucketFromBitbucketStatus(st.state),
        link: (st.links && st.links.html && st.links.html.href) || st.url || '',
        workflow: st.key || '',
        description: st.description || (st.state ? String(st.state) : ''),
        runId: st.uuid || st.key || '',
        jobId: st.uuid || st.key || '',
      }));
      return { checks };
    } catch (err) {
      return { checks: [], error: errorText(err) };
    }
  },

  // Failing-check logs are only fetched from GitHub Actions run links.
  async failedCheckLogs(_pr, { checkLink }) {
    return { error: 'Could not parse run/job id from link: ' + checkLink };
  },

  async addIssueComment(pr, { body, cwd }) {
    try {
      await bitbucketFetch(`/repositories/${targetOf(pr)}/pullrequests/${pr.number}/comments`, {
        method: 'POST',
        account: pr.account, host: hostOf(pr), cwd,
        body: { content: { raw: body } },
      });
      return { ok: true };
    } catch (err) {
      return { error: errorText(err) };
    }
  },

  // Bitbucket has one comment type, so issue and review comments edit the same way.
  async editComment(pr, { id, body, cwd }) {
    try {
      await bitbucketFetch(`/repositories/${targetOf(pr)}/pullrequests/${pr.number}/comments/${id}`, {
        method: 'PUT',
        account: pr.account, host: hostOf(pr), cwd,
        body: { content: { raw: body } },
      });
      return { ok: true, body };
    } catch (err) {
      return { error: errorText(err) };
    }
  },

  async reply(pr, { inReplyTo, body, cwd }) {
    const { threads } = pr;
    let parentCommentId = parseInt(inReplyTo, 10);
    if (!parentCommentId && threads && Array.isArray(threads)) {
      const matchingThread = threads.find((t) => t.id === inReplyTo || (t.comments && t.comments.some((c) => String(c.databaseId) === String(inReplyTo))));
      if (matchingThread && matchingThread.comments && matchingThread.comments.length > 0) {
        parentCommentId = matchingThread.comments[0].databaseId;
      }
    }
    // An unresolved parent is sent as null on purpose; Bitbucket decides what to do with it.
    try {
      await bitbucketFetch(`/repositories/${targetOf(pr)}/pullrequests/${pr.number}/comments`, {
        method: 'POST',
        account: pr.account, host: hostOf(pr), cwd,
        body: {
          content: { raw: body },
          parent: { id: parentCommentId },
        },
      });
      return { ok: true };
    } catch (err) {
      return { error: errorText(err) };
    }
  },

  async resolveThread(pr, { threadId, resolve, cwd }) {
    try {
      const method = resolve ? 'POST' : 'DELETE';
      await bitbucketFetch(`/repositories/${targetOf(pr)}/pullrequests/${pr.number}/comments/${threadId}/resolve`, {
        method,
        account: pr.account, host: hostOf(pr), cwd,
      });
      return { ok: true };
    } catch (err) {
      return { error: errorText(err) };
    }
  },

  async submitReview(pr, { event, body, inlineComments, issueCommentDrafts, cwd }) {
    const target = targetOf(pr);
    const host = hostOf(pr);
    const account = pr.account;
    const number = pr.number;
    const postComment = (payload) => bitbucketFetch(`/repositories/${target}/pullrequests/${number}/comments`, {
      method: 'POST',
      account, host, cwd,
      body: payload,
    });

    return submitReviewSequential({
      inlineComments,
      body,
      issueCommentDrafts,
      postInline: (c) => {
        const inlineData = { path: c.path };
        if (c.side === 'LEFT' && typeof c.line === 'number') {
          inlineData.from = c.line;
        } else if (typeof c.line === 'number') {
          inlineData.to = c.line;
        }
        return postComment({ content: { raw: outboundBody(c, c.body) }, inline: inlineData });
      },
      postGeneral: (text) => postComment({ content: { raw: text } }),
      vote: async () => {
        if (event === 'APPROVE') {
          await bitbucketFetch(`/repositories/${target}/pullrequests/${number}/approve`, {
            method: 'POST',
            account, host, cwd,
          });
        } else if (event === 'REQUEST_CHANGES') {
          await bitbucketFetch(`/repositories/${target}/pullrequests/${number}/request-changes`, {
            method: 'POST',
            account, host, cwd,
          });
        }
      },
    });
  },

  async merge(pr, { strategy }) {
    const strat = strategy === 'squash' ? 'squash' : strategy === 'rebase' ? 'fast_forward' : 'merge_commit';
    try {
      await bitbucketFetch(`/repositories/${targetOf(pr)}/pullrequests/${pr.number}/merge`, {
        method: 'POST',
        account: pr.account,
        host: hostOf(pr),
        body: { merge_strategy: strat, close_source_branch: false },
      });
      return { ok: true };
    } catch (err) {
      // The message already carries Bitbucket's reason; it's what the merge dialog has always shown.
      return { error: err.message };
    }
  },

  async currentUser(pr, { cwd }) {
    try {
      const host = (pr && pr.host) || DEFAULT_HOST;
      const account = pr && pr.account;
      const res = await bitbucketJson('/user', { host, account, cwd });
      return { login: res.nickname || res.username || res.display_name };
    } catch (err) {
      return { error: errorText(err) };
    }
  },

  gitAuth(pr, { owner, repo }) {
    const host = hostOf(pr);
    const repoPath = owner ? `${owner}/${repo}` : repo;
    const auth = getBitbucketAuth({ host, account: pr.account });
    let url;
    if (auth && auth.username && (auth.password || auth.token)) {
      url = `https://${encodeURIComponent(auth.username)}:${encodeURIComponent(auth.password || auth.token)}@${host}/${repoPath}.git`;
    } else if (auth && auth.token) {
      url = `https://x-token-auth:${auth.token}@${host}/${repoPath}.git`;
    } else {
      url = `https://${host}/${repoPath}.git`;
    }
    return { url, cleanUrl: `https://${host}/${repoPath}.git`, env: {} };
  },

  headFetch(pr, localBranch) {
    const head = (pr.meta && pr.meta.headRefName) || localBranch;
    return { refspec: `+refs/heads/${head}:refs/heads/${localBranch}`, fetchTarget: head };
  },

  // Returns the account that was active before, for restoreAccountAfterReview.
  useAccountForReview(account, host = DEFAULT_HOST) {
    if (!account) return null;
    const accounts = loadConfig().bitbucketAccounts || [];
    const currentActive = accounts.find((a) => a.active && (!a.hostname || a.hostname === host));
    switchBitbucketAccount(account, host);
    return currentActive ? { account: currentActive.username, host: currentActive.hostname || host } : null;
  },

  restoreAccountAfterReview(saved) {
    switchBitbucketAccount(saved.account, saved.host);
  },
};
