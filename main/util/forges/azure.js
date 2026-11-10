// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Azure DevOps Services and Server behind the forge adapter interface, over the REST API and local git.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  azureJson, azureText, getAzureAuth, basicHeader, fetchConnectionData, apiVersion, resolveSavedCollection,
} = require('../azure-api');
const { classifyAzureError } = require('../azure-error');
const { parseForgeUrl } = require('../forge-url');
const {
  prListItem, normalizeAzurePr, transformAzureThreads, bucketFromAzureStatus,
} = require('../forge-adapter');
const { submitReviewSequential, outboundBody } = require('./review-sequence');

const execFileP = promisify(execFile);

const DEFAULT_HOST = 'dev.azure.com';
const VOTE = { APPROVE: 10, REQUEST_CHANGES: -5 };
const MERGE_STRATEGY = { squash: 'squash', rebase: 'rebase', merge: 'noFastForward' };
const MAX_LOGS = 5;
const LOG_TAIL_LINES = 400;

function errorText(err) {
  return (err.responseBody || err.message || '').trim();
}

// Every call after load reads the repo from the PR's web URL.
function locate(pr) {
  const loc = parseForgeUrl(pr && pr.meta && pr.meta.url);
  if (!loc || loc.forge !== 'azure') throw new Error('Could not work out the Azure DevOps repository from the PR URL');
  return loc;
}

function ctxFor(loc, account) {
  return { collectionUrl: loc.collectionUrl, host: loc.host, collectionPath: loc.collectionPath, account };
}

function repoApi(loc) {
  return `/${encodeURIComponent(loc.project)}/_apis/git/repositories/${encodeURIComponent(loc.repoName)}`;
}

function prApi(loc, number) {
  return `${repoApi(loc)}/pullRequests/${number}`;
}

// "{threadId}:{commentId}", or a bare thread id.
function splitCommentId(id) {
  const [thread, comment] = String(id || '').split(':');
  return { threadId: parseInt(thread, 10) || null, commentId: parseInt(comment, 10) || null };
}

function newThread(content, extra = {}) {
  return { comments: [{ parentCommentId: 0, content, commentType: 1 }], ...extra };
}

// The PAT goes in an http.extraHeader passed through the environment, so it
// never lands in a URL, argv or .git/config. The key is scoped to the
// collection URL so submodule and LFS requests to other hosts don't get it,
// and it's appended after any GIT_CONFIG_* entries the user's env already has.
function gitEnvFor(auth, collectionUrl) {
  const n = parseInt(process.env.GIT_CONFIG_COUNT, 10) || 0;
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: `http.${collectionUrl.replace(/\/+$/, '')}/.extraHeader`,
    [`GIT_CONFIG_VALUE_${n}`]: `Authorization: ${basicHeader(auth.pat)}`,
    GCM_INTERACTIVE: 'never',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function repoGitUrl(loc, project, repo) {
  return `${loc.collectionUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`;
}

async function git(args, cwd, env) {
  const { stdout } = await execFileP('git', args, {
    cwd, env: { ...process.env, GIT_ASKPASS: '', ...env }, maxBuffer: 200 * 1024 * 1024,
  });
  return stdout;
}

const DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '-M'];

// Azure has no unified-diff endpoint, so diff refs/pull/{id}/merge (^1 target, ^2 source) in the
// base clone, falling back to the branches when that ref is missing or stale (conflicting PRs).
// The diff also carries the auth env, since a blob:none clone fetches blobs from origin lazily.
async function localDiff({ cwd, auth, number, meta, sourceUrl }) {
  const env = auth.env;
  const mergeRef = `refs/klaussy/ado/${number}`;
  try {
    await git(['fetch', '--no-tags', '--no-recurse-submodules', auth.url, `+refs/pull/${number}/merge:${mergeRef}`], cwd, env);
    const source = (await git(['rev-parse', `${mergeRef}^2`], cwd, env)).trim();
    if (!meta.headRefOid || source === meta.headRefOid) {
      return await git([...DIFF_ARGS, `${mergeRef}^1...${mergeRef}^2`], cwd, env);
    }
  } catch (_) { /* no merge ref (conflicts, or not computed yet): diff the branches */ }

  const targetRef = `${mergeRef}-target`;
  const sourceRef = `${mergeRef}-source`;
  await git(['fetch', '--no-tags', '--no-recurse-submodules', auth.url, `+refs/heads/${meta.baseRefName}:${targetRef}`], cwd, env);
  await git(['fetch', '--no-tags', '--no-recurse-submodules', sourceUrl || auth.url, `+refs/heads/${meta.headRefName}:${sourceRef}`], cwd, env);
  return git([...DIFF_ARGS, `${targetRef}...${sourceRef}`], cwd, env);
}

async function userIdFor(loc, account) {
  const auth = getAzureAuth(ctxFor(loc, account));
  if (auth.userId) return auth.userId;
  return (await fetchConnectionData(loc.collectionUrl, auth.pat)).userId;
}

// One row per failed job, so the Fix button gets that job's logs. No runId:
// Rerun, Cancel and Watch are GitHub Actions only.
async function buildRows(ctx, loc, build) {
  const web = (build._links && build._links.web && build._links.web.href) || '';
  const name = (build.definition && build.definition.name) || `Build ${build.id}`;
  const state = build.status === 'completed' ? build.result : build.status;
  const base = {
    name,
    state,
    bucket: build.status === 'completed' ? bucketFromAzureStatus(build.result) : 'pending',
    link: web,
    workflow: name,
    description: build.buildNumber ? `#${build.buildNumber}` : '',
    id: String(build.id),
  };
  if (base.bucket !== 'fail') return [base];
  const timeline = await azureJson(ctx, `/${encodeURIComponent(loc.project)}/_apis/build/builds/${build.id}/timeline`);
  const jobs = ((timeline && timeline.records) || []).filter((r) => r.type === 'Job' && r.result === 'failed');
  if (!jobs.length) return [base];
  return jobs.map((j) => ({
    ...base,
    name: `${name} / ${j.name}`,
    link: web ? `${web}&view=logs&j=${j.id}` : '',
    id: `${build.id}:${j.id}`,
  }));
}

module.exports = {
  id: 'azure',
  label: 'Azure DevOps',
  itemNoun: 'PR',
  defaultHost: DEFAULT_HOST,
  branchPrefix: 'ado',

  classifyError(raw, ctx = {}) {
    const { url, ...rest } = ctx;
    const p = url ? parseForgeUrl(url) : null;
    return classifyAzureError(raw, p ? { ...rest, target: `${p.project}/${p.repoName}`, host: p.host } : rest);
  },

  async listOpen({ info }) {
    // An SSH remote to Server doesn't carry the web scheme or port; a saved account for the collection does.
    info = { ...info, ...resolveSavedCollection(info) };
    const ctx = ctxFor(info);
    const raw = await azureJson(ctx, `${repoApi(info)}/pullrequests?searchCriteria.status=active&$top=50`);
    return ((raw && raw.value) || []).map((pr) => prListItem(normalizeAzurePr(pr, info)));
  },

  async lookupPr(_url, { parsed }) {
    const raw = await azureJson(ctxFor(parsed), prApi(parsed, parsed.number));
    return normalizeAzurePr(raw, parsed);
  },

  // resolveBaseClone comes from state/, which util/ can't require. With
  // deferDiff the diff is left empty so the review can open while diffFor
  // builds it (the first one clones the repo).
  async loadPr({ target, account, resolveBaseClone, deferDiff }) {
    const parsed = typeof target === 'string' ? parseForgeUrl(target) : null;
    if (!parsed || parsed.forge !== 'azure') {
      throw new Error('Paste the full Azure DevOps pull request URL to open it.');
    }
    const raw = await azureJson(ctxFor(parsed, account), prApi(parsed, parsed.number));
    const meta = normalizeAzurePr(raw, parsed);
    const diff = deferDiff ? '' : await this.diffFor({ meta, account, host: parsed.host, resolveBaseClone });
    return {
      meta,
      diff,
      host: parsed.host,
      repo: parsed.projectPath,
      baseOwner: parsed.owner,
      baseRepo: parsed.repo,
    };
  },

  async diffFor({ meta, account, host, resolveBaseClone }) {
    const loc = parseForgeUrl(meta.url);
    const pr = {
      forge: 'azure', host, account, meta, number: meta.number,
      projectPath: loc.projectPath, baseOwner: loc.owner, baseRepo: loc.repo,
    };
    const auth = this.gitAuth(pr, { owner: loc.owner, repo: loc.repo });
    if (auth.error) throw new Error(auth.error);
    const base = await resolveBaseClone(pr, this, auth);
    if (base.error) throw new Error(base.error);
    const head = meta.headRepositoryOwner && meta.headRepository
      ? this.gitAuth(pr, { owner: meta.headRepositoryOwner.login, repo: meta.headRepository.name })
      : null;
    return localDiff({ cwd: base.cwd, auth, number: meta.number, meta, sourceUrl: head && head.url });
  },

  async refreshPr(pr, { resolveBaseClone }) {
    const loc = locate(pr);
    const raw = await azureJson(ctxFor(loc, pr.account), prApi(loc, loc.number));
    const meta = normalizeAzurePr(raw, loc);
    const diff = await this.diffFor({ meta, account: pr.account, host: loc.host, resolveBaseClone });
    return { meta, diff };
  },

  async reloadMeta(pr) {
    const loc = locate(pr);
    return normalizeAzurePr(await azureJson(ctxFor(loc, pr.account), prApi(loc, loc.number)), loc);
  },

  async fetchThreads(pr) {
    let loc;
    try {
      loc = locate(pr);
      const res = await azureJson(ctxFor(loc, pr.account), `${prApi(loc, loc.number)}/threads`);
      const { threads, issueComments } = transformAzureThreads(res);
      return { threads, issueComments, reviews: [] };
    } catch (err) {
      const raw = errorText(err);
      const cls = classifyAzureError(raw, loc ? { target: `${loc.project}/${loc.repoName}`, host: loc.host, account: pr.account } : {});
      return { error: { summary: cls.summary, fix: cls.fix, raw } };
    }
  },

  // PR statuses (posted by external services) plus the newest pipeline run per
  // definition on the PR's merge ref.
  async listChecks(pr) {
    try {
      const loc = locate(pr);
      const ctx = ctxFor(loc, pr.account);
      const [statuses, builds] = await Promise.all([
        // PR statuses are still a preview API on both Services and Server.
        azureJson(ctx, `${prApi(loc, loc.number)}/statuses?api-version=${apiVersion(loc.host)}-preview.1`),
        azureJson(ctx, `/${encodeURIComponent(loc.project)}/_apis/build/builds?branchName=${encodeURIComponent(`refs/pull/${loc.number}/merge`)}&queryOrder=queueTimeDescending&$top=50`),
      ]);

      const latestStatus = new Map();
      for (const st of (statuses && statuses.value) || []) {
        const c = st.context || {};
        const key = `${c.genre || ''}/${c.name || ''}`;
        const prev = latestStatus.get(key);
        if (!prev || (st.id || 0) > (prev.id || 0)) latestStatus.set(key, st);
      }
      const checks = [...latestStatus.values()].map((st) => {
        const c = st.context || {};
        return {
          name: c.genre ? `${c.genre}/${c.name}` : (c.name || 'Status'),
          state: st.state,
          bucket: bucketFromAzureStatus(st.state),
          link: st.targetUrl || '',
          workflow: c.genre || '',
          description: st.description || '',
          id: `status:${st.id}`,
        };
      });

      const seen = new Set();
      const newest = [];
      for (const b of (builds && builds.value) || []) {
        const def = b.definition && b.definition.id;
        if (seen.has(def)) continue;
        seen.add(def);
        newest.push(b);
      }
      for (const rows of await Promise.all(newest.map((b) => buildRows(ctx, loc, b)))) checks.push(...rows);
      return { checks };
    } catch (err) {
      return { checks: [], error: errorText(err) };
    }
  },

  // The failed tasks' log tails for one job, and the pipeline YAML from the worktree.
  async failedCheckLogs(pr, { checkLink, cwd }) {
    const buildId = (String(checkLink || '').match(/[?&]buildId=(\d+)/) || [])[1];
    const jobId = (String(checkLink || '').match(/[?&]j=([0-9a-f-]+)/i) || [])[1];
    if (!buildId) return { error: 'Could not parse the build id from link: ' + checkLink };
    let loc;
    let ctx;
    let build;
    let logTail;
    try {
      loc = locate(pr);
      ctx = ctxFor(loc, pr.account);
      const proj = `/${encodeURIComponent(loc.project)}`;
      const timeline = await azureJson(ctx, `${proj}/_apis/build/builds/${buildId}/timeline`);
      const records = (timeline && timeline.records) || [];
      const jobs = jobId ? records.filter((r) => r.id === jobId) : records.filter((r) => r.type === 'Job' && r.result === 'failed');
      const jobIds = new Set(jobs.map((j) => j.id));
      let targets = records.filter((r) => r.type === 'Task' && r.result === 'failed' && jobIds.has(r.parentId) && r.log);
      if (!targets.length) targets = jobs.filter((j) => j.log);
      if (!targets.length) return { error: 'Azure Pipelines has no log for the failed job yet.' };
      const parts = [];
      for (const t of targets.slice(0, MAX_LOGS)) {
        const text = await azureText(ctx, `${proj}/_apis/build/builds/${buildId}/logs/${t.log.id}`);
        parts.push(`### ${t.name}\n${text}`);
      }
      logTail = parts.join('\n\n').split('\n').slice(-LOG_TAIL_LINES).join('\n');
      build = await azureJson(ctx, `${proj}/_apis/build/builds/${buildId}`);
    } catch (err) {
      return { error: 'Could not fetch logs: ' + errorText(err) };
    }

    let workflowBlock = '';
    try {
      const defId = build && build.definition && build.definition.id;
      const def = defId ? await azureJson(ctx, `/${encodeURIComponent(loc.project)}/_apis/build/definitions/${defId}`) : null;
      const yamlPath = def && def.process && def.process.yamlFilename;
      const full = yamlPath && cwd ? path.join(cwd, yamlPath.replace(/^[/\\]+/, '')) : null;
      // Checked on real paths: a PR can commit the YAML as a symlink to a file outside the repo.
      const rootReal = full && fs.existsSync(full) ? fs.realpathSync(cwd) : null;
      const fullReal = rootReal ? fs.realpathSync(full) : null;
      if (fullReal && fullReal.startsWith(rootReal + path.sep) && fs.statSync(fullReal).isFile()) {
        const lines = fs.readFileSync(fullReal, 'utf8').split('\n');
        workflowBlock = `\n## Pipeline definition (\`${yamlPath.replace(/^[/\\]+/, '')}\`)\n\`\`\`yaml\n${lines.slice(0, 200).join('\n')}\n${lines.length > 200 ? '\n[... truncated ...]\n' : ''}\`\`\`\n`;
      }
    } catch (err) {
      console.error('[failing-check-context] pipeline YAML lookup failed:', errorText(err));
    }
    return { logTail, annotationsBlock: '', workflowBlock };
  },

  async addIssueComment(pr, { body }) {
    try {
      const loc = locate(pr);
      await azureJson(ctxFor(loc, pr.account), `${prApi(loc, loc.number)}/threads`, { method: 'POST', body: newThread(body) });
      return { ok: true };
    } catch (err) {
      return { error: errorText(err) };
    }
  },

  async editComment(pr, { id, body }) {
    const { threadId, commentId } = splitCommentId(id);
    if (!threadId || !commentId) return { error: `Unrecognised Azure DevOps comment id: ${id}` };
    try {
      const loc = locate(pr);
      await azureJson(ctxFor(loc, pr.account), `${prApi(loc, loc.number)}/threads/${threadId}/comments/${commentId}`, {
        method: 'PATCH', body: { content: body },
      });
      return { ok: true, body };
    } catch (err) {
      return { error: errorText(err) };
    }
  },

  async reply(pr, { inReplyTo, body }) {
    const { threadId, commentId } = splitCommentId(inReplyTo);
    if (!threadId) return { error: `Unrecognised Azure DevOps thread: ${inReplyTo}` };
    try {
      const loc = locate(pr);
      await azureJson(ctxFor(loc, pr.account), `${prApi(loc, loc.number)}/threads/${threadId}/comments`, {
        method: 'POST', body: { content: body, parentCommentId: commentId || 1, commentType: 1 },
      });
      return { ok: true };
    } catch (err) {
      return { error: errorText(err) };
    }
  },

  async resolveThread(pr, { threadId, resolve }) {
    try {
      const loc = locate(pr);
      await azureJson(ctxFor(loc, pr.account), `${prApi(loc, loc.number)}/threads/${parseInt(threadId, 10)}`, {
        method: 'PATCH', body: { status: resolve ? 'fixed' : 'active' },
      });
      return { ok: true };
    } catch (err) {
      return { error: errorText(err) };
    }
  },

  async submitReview(pr, { event, body, inlineComments, issueCommentDrafts }) {
    let loc;
    try {
      loc = locate(pr);
    } catch (err) {
      return { error: err.message };
    }
    const ctx = ctxFor(loc, pr.account);
    const threadsPath = `${prApi(loc, loc.number)}/threads`;
    // Anchors inline threads to the latest push, the way the web UI does. If
    // the iterations can't be read the thread is posted without it.
    let iterationContext = null;
    try {
      const its = await azureJson(ctx, `${prApi(loc, loc.number)}/iterations`);
      const ids = ((its && its.value) || []).map((i) => i.id).filter(Boolean);
      if (ids.length) iterationContext = { firstComparingIteration: 1, secondComparingIteration: Math.max(...ids) };
    } catch (err) {
      console.error('[azure] iterations lookup failed; posting threads without iteration context:', errorText(err));
    }
    const post = (thread) => azureJson(ctx, threadsPath, { method: 'POST', body: thread });

    return submitReviewSequential({
      inlineComments,
      body,
      issueCommentDrafts,
      postInline: (c) => {
        const line = typeof c.line === 'number' ? c.line : 1;
        const start = typeof c.startLine === 'number' && c.startLine < line ? c.startLine : line;
        const side = c.side === 'LEFT' ? 'left' : 'right';
        const threadContext = {
          filePath: '/' + String(c.path || '').replace(/^\/+/, ''),
          [`${side}FileStart`]: { line: start, offset: 1 },
          [`${side}FileEnd`]: { line, offset: 1 },
        };
        const extra = { status: 'active', threadContext };
        if (iterationContext) extra.pullRequestThreadContext = { iterationContext };
        return post(newThread(outboundBody(c, c.body), extra));
      },
      postGeneral: (text) => post(newThread(text)),
      vote: async () => {
        const vote = VOTE[event];
        if (vote === undefined) return;
        const userId = await userIdFor(loc, pr.account);
        await azureJson(ctx, `${prApi(loc, loc.number)}/reviewers/${encodeURIComponent(userId)}`, {
          method: 'PUT', body: { vote },
        });
      },
    });
  },

  // A PR with pending policies stays active after the PATCH; Azure finishes it
  // once they pass.
  async merge(pr, { strategy }) {
    const sha = pr.meta && pr.meta.headRefOid;
    if (!sha) return { error: 'The PR has no source commit to complete.' };
    try {
      const loc = locate(pr);
      const res = await azureJson(ctxFor(loc, pr.account), prApi(loc, loc.number), {
        method: 'PATCH',
        body: {
          status: 'completed',
          lastMergeSourceCommit: { commitId: sha },
          completionOptions: { mergeStrategy: MERGE_STRATEGY[strategy] || 'noFastForward', deleteSourceBranch: false },
        },
      });
      if (res && res.status && res.status !== 'completed') {
        return { ok: true, warning: 'Azure DevOps queued the completion. It finishes once the branch policies pass.' };
      }
      return { ok: true };
    } catch (err) {
      return { error: errorText(err) };
    }
  },

  async currentUser(pr) {
    try {
      const loc = locate(pr);
      const auth = getAzureAuth(ctxFor(loc, pr.account));
      if (auth.user) return { login: auth.user };
      return { login: (await fetchConnectionData(loc.collectionUrl, auth.pat)).user };
    } catch (err) {
      return { error: errorText(err) };
    }
  },

  // owner is "{collectionPath}/{project}" in lowercase, the form parseForgeUrl gives.
  gitAuth(pr, { owner, repo }) {
    let loc;
    let auth;
    try {
      loc = locate(pr);
      auth = getAzureAuth(ctxFor(loc, pr.account));
    } catch (err) {
      return { error: err.message };
    }
    const prefix = `${loc.collectionPath}/`;
    const project = owner && owner.startsWith(prefix) ? owner.slice(prefix.length) : loc.project;
    const url = repoGitUrl(loc, project, repo || loc.repoName);
    return { url, cleanUrl: url, env: gitEnvFor(auth, loc.collectionUrl) };
  },

  // A fork PR's branch lives in the fork, so its fetch goes to the fork's URL.
  headFetch(pr, localBranch) {
    const meta = pr.meta || {};
    const head = meta.headRefName || localBranch;
    const out = { refspec: `+refs/heads/${head}:refs/heads/${localBranch}`, fetchTarget: head };
    const owner = meta.headRepositoryOwner && meta.headRepositoryOwner.login;
    const repo = meta.headRepository && meta.headRepository.name;
    const loc = parseForgeUrl(meta.url);
    if (owner && repo && loc && loc.forge === 'azure' && `${owner}/${repo}` !== loc.projectPath) {
      // Falling back to the base repo would check out its same-named branch instead.
      const auth = this.gitAuth(pr, { owner, repo });
      if (auth.error) return { error: auth.error };
      out.url = auth.url;
    }
    return out;
  },

  // Accounts are picked per collection on every call, so there's nothing to switch.
  useAccountForReview() {
    return null;
  },

  restoreAccountAfterReview() {},

  // Exposed for tests, which point it at local repos instead of Azure.
  localDiff,
};
