// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// GitLab.com and self-managed GitLab behind the forge adapter interface, over the glab CLI.

const { execFile, execFileSync, spawn } = require('child_process');
const { appendStderr } = require('../exec');
const { clearGlabTokenCache, getGlabToken, resolveGlabEnv } = require('../glab-exec');
const { glabJson, glabText } = require('../glab-json');
const { classifyGlabError } = require('../glab-error');
const { parseForgeUrl } = require('../forge-url');
const {
  prListItem, normalizeGitLabMr, transformGitLabDiscussions, bucketFromGitLabStatus,
} = require('../forge-adapter');
const { submitReviewSequential, outboundBody } = require('./review-sequence');

const DEFAULT_HOST = 'gitlab.com';

function targetOf(pr) {
  return pr.projectPath || `${pr.baseOwner}/${pr.baseRepo}`;
}

// Pin every glab call in an active review to the account it runs under.
// GITLAB_TOKEN would override that account, so it's dropped.
function reviewGlabEnv(pr, cwd) {
  const resolved = resolveGlabEnv({ account: pr && pr.account, host: pr && pr.host, cwd });
  const env = { ...process.env, ...resolved };
  delete env.GITLAB_TOKEN;
  return env;
}

// `glab api` with a JSON body on stdin. Resolves { ok } or { error }, preferring
// GitLab's own message from the response body over glab's stderr.
function glabApiInput(endpoint, method, payload, { cwd, env }) {
  return new Promise((resolve) => {
    const proc = spawn('glab', ['api', endpoint, '--method', method, '--input', '-', '--header', 'Content-Type: application/json'], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try {
            const parsed = JSON.parse(stdoutBuf);
            if (parsed.message) msg = parsed.message;
          } catch (_) { /* not JSON: keep stderr */ }
        }
        resolve({ error: msg || ('glab exited with code ' + code) });
        return;
      }
      resolve({ ok: true });
    });
    proc.stdin.on('error', () => { /* EPIPE when glab exits early; the exit handler reports it */ });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

// review-sequence expects a rejected promise for a failed post.
async function glabApiInputOrThrow(endpoint, method, payload, opts) {
  const res = await glabApiInput(endpoint, method, payload, opts);
  if (res.error) throw new Error(res.error);
}

module.exports = {
  id: 'gitlab',
  label: 'GitLab',
  itemNoun: 'MR',
  defaultHost: DEFAULT_HOST,
  branchPrefix: 'mr',

  classifyError(raw, ctx = {}) {
    return classifyGlabError(raw, ctx);
  },

  async listOpen({ info, cwd }) {
    const raw = await glabJson(['mr', 'list', '--output', 'json'], cwd);
    return (Array.isArray(raw) ? raw : []).map((mr) => prListItem(normalizeGitLabMr(mr, info.host)));
  },

  async lookupPr(url, { parsed, cwd }) {
    const raw = await glabJson(['mr', 'view', url, '--output', 'json'], cwd);
    return normalizeGitLabMr(raw, parsed.host);
  },

  async loadPr({ target, projectPath, host, cwd }) {
    const [rawMr, diff] = await Promise.all([
      glabJson(['mr', 'view', target, '--output', 'json'], cwd),
      glabText(['mr', 'diff', target], cwd),
    ]);
    const meta = normalizeGitLabMr(rawMr, host);
    const base = parseForgeUrl(meta.url);
    return {
      meta,
      diff,
      host,
      repo: base ? base.projectPath : (projectPath || null),
      baseOwner: base ? base.owner : null,
      baseRepo: base ? base.repo : null,
    };
  },

  async refreshPr(pr, { cwd }) {
    const url = pr.meta.url;
    const [rawMr, diff] = await Promise.all([
      glabJson(['mr', 'view', url, '--output', 'json'], cwd),
      glabText(['mr', 'diff', url], cwd),
    ]);
    return { meta: normalizeGitLabMr(rawMr, pr.host || DEFAULT_HOST), diff };
  },

  async reloadMeta(pr, { cwd }) {
    const raw = await glabJson(['mr', 'view', pr.meta.url, '--output', 'json'], cwd);
    return normalizeGitLabMr(raw, pr.host || DEFAULT_HOST);
  },

  // Resolves null when the review moved on during the retry wait.
  async fetchThreads(pr, { cwd, stale }) {
    const host = pr.host || DEFAULT_HOST;
    const account = pr.account;
    const target = targetOf(pr);
    const endpoint = `projects/${encodeURIComponent(target)}/merge_requests/${pr.number}/discussions`;
    const glabEnv = { ...process.env, ...resolveGlabEnv({ account, host, cwd }) };
    delete glabEnv.GITLAB_TOKEN;

    const runGitLabOnce = () => new Promise((resolve) => {
      execFile('glab', ['api', endpoint, '--paginate'], { cwd, env: glabEnv, maxBuffer: 50 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
          return resolve({ errorRaw: (stderr || '').toString().trim() || err.message });
        }
        try {
          const raw = JSON.parse(stdout);
          return resolve({ data: raw });
        } catch (_) {
          return resolve({ errorRaw: 'glab returned non-JSON: ' + String(stdout).slice(0, 200) });
        }
      });
    });

    let res = await runGitLabOnce();
    if (res.errorRaw && classifyGlabError(res.errorRaw, { target, host }).retryable) {
      await new Promise((r) => setTimeout(r, 900));
      if (stale()) return null;
      res = await runGitLabOnce();
    }

    if (res.errorRaw) {
      const cls = classifyGlabError(res.errorRaw, { target, host });
      return { error: { summary: cls.summary, fix: cls.fix, raw: res.errorRaw } };
    }

    const { threads, issueComments } = transformGitLabDiscussions(res.data);
    return { threads, issueComments, reviews: [] };
  },

  async listChecks(pr, { cwd }) {
    const { number, account, host } = pr;
    const target = targetOf(pr);
    const glabEnv = { ...process.env, ...resolveGlabEnv({ account, host, cwd }) };
    delete glabEnv.GITLAB_TOKEN;
    try {
      // A failed pipeline or job lookup reads as "no checks", as it always has.
      const pipelines = await new Promise((resolve) => {
        execFile('glab', ['api', `projects/${encodeURIComponent(target)}/merge_requests/${number}/pipelines`], { cwd, env: glabEnv, maxBuffer: 10 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
          if (err) return resolve([]);
          try { resolve(JSON.parse(stdout)); } catch (_) { resolve([]); }
        });
      });

      if (!Array.isArray(pipelines) || pipelines.length === 0) {
        return { checks: [] };
      }

      const latestPipeline = pipelines[0];
      const jobs = await new Promise((resolve) => {
        execFile('glab', ['api', `projects/${encodeURIComponent(target)}/pipelines/${latestPipeline.id}/jobs`], { cwd, env: glabEnv, maxBuffer: 10 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
          if (err) return resolve([]);
          try { resolve(JSON.parse(stdout)); } catch (_) { resolve([]); }
        });
      });

      const checks = (Array.isArray(jobs) ? jobs : []).map((job) => ({
        name: job.name,
        state: job.status,
        bucket: bucketFromGitLabStatus(job.status),
        link: job.web_url,
        workflow: job.stage,
        description: job.stage + (job.duration ? ` (${Math.round(job.duration)}s)` : ''),
        runId: job.id,
        jobId: job.id,
      }));

      return { checks };
    } catch (err) {
      return { checks: [], error: err.message };
    }
  },

  // Failing-check logs are only fetched from GitHub Actions run links.
  async failedCheckLogs(_pr, { checkLink }) {
    return { error: 'Could not parse run/job id from link: ' + checkLink };
  },

  async addIssueComment(pr, { body, cwd }) {
    const endpoint = `projects/${encodeURIComponent(targetOf(pr))}/merge_requests/${pr.number}/notes`;
    return glabApiInput(endpoint, 'POST', { body }, { cwd, env: reviewGlabEnv(pr, cwd) });
  },

  // MR notes are one type, so issue and review comments edit the same way.
  async editComment(pr, { id, body, cwd }) {
    const endpoint = `projects/${encodeURIComponent(targetOf(pr))}/merge_requests/${pr.number}/notes/${id}`;
    const res = await glabApiInput(endpoint, 'PUT', { body }, { cwd, env: reviewGlabEnv(pr, cwd) });
    return res.error ? res : { ok: true, body };
  },

  async reply(pr, { inReplyTo, body, cwd }) {
    const { threads } = pr;
    // inReplyTo may be a discussion id or one of its note ids.
    let discussionId = inReplyTo;
    if (threads && Array.isArray(threads)) {
      const matchingThread = threads.find((t) => t.id === inReplyTo || (t.comments && t.comments.some((c) => String(c.databaseId) === String(inReplyTo))));
      if (matchingThread) discussionId = matchingThread.id;
    }
    const endpoint = `projects/${encodeURIComponent(targetOf(pr))}/merge_requests/${pr.number}/discussions/${encodeURIComponent(discussionId)}/notes`;
    return glabApiInput(endpoint, 'POST', { body }, { cwd, env: reviewGlabEnv(pr, cwd) });
  },

  async resolveThread(pr, { threadId, resolve, cwd }) {
    const endpoint = `projects/${encodeURIComponent(targetOf(pr))}/merge_requests/${pr.number}/discussions/${encodeURIComponent(threadId)}`;
    try {
      execFileSync('glab', ['api', endpoint, '-X', 'PUT', '-F', `resolved=${resolve ? 'true' : 'false'}`], {
        cwd, env: reviewGlabEnv(pr, cwd), stdio: 'pipe', timeout: 15000,
      });
      return { ok: true };
    } catch (err) {
      return { error: err.stderr ? err.stderr.toString() : err.message };
    }
  },

  async submitReview(pr, { event, body, inlineComments, issueCommentDrafts, cwd }) {
    const { meta, number } = pr;
    const target = targetOf(pr);
    const headSha = meta && (meta.headRefOid || (meta.diff_refs && meta.diff_refs.head_sha) || '');
    const baseSha = meta && ((meta.diff_refs && meta.diff_refs.base_sha) || headSha);
    const startSha = meta && ((meta.diff_refs && meta.diff_refs.start_sha) || baseSha);
    const opts = { cwd, env: reviewGlabEnv(pr, cwd) };
    const notesEndpoint = `projects/${encodeURIComponent(target)}/merge_requests/${number}/notes`;

    return submitReviewSequential({
      inlineComments,
      body,
      issueCommentDrafts,
      postInline: (c) => {
        const pos = {
          base_sha: baseSha,
          start_sha: startSha,
          head_sha: headSha,
          position_type: 'text',
          new_path: c.path,
          old_path: c.path,
        };
        if (c.side === 'LEFT' && typeof c.line === 'number') {
          pos.old_line = c.line;
        } else if (typeof c.line === 'number') {
          pos.new_line = c.line;
        }
        const endpoint = `projects/${encodeURIComponent(target)}/merge_requests/${number}/discussions`;
        return glabApiInputOrThrow(endpoint, 'POST', { body: outboundBody(c, c.body), position: pos }, opts);
      },
      postGeneral: (text) => glabApiInputOrThrow(notesEndpoint, 'POST', { body: text }, opts),
      vote: async () => {
        if (event !== 'APPROVE') return;
        try {
          execFileSync('glab', ['mr', 'approve', String(number)], {
            cwd, env: opts.env, stdio: 'pipe', timeout: 15000,
          });
        } catch (err) {
          throw new Error((err.stderr ? err.stderr.toString() : err.message).trim());
        }
      },
    });
  },

  async merge(pr, { strategy, cwd }) {
    const flag = { merge: '', squash: '--squash', rebase: '--rebase' }[strategy];
    const args = ['mr', 'merge', String(pr.number)];
    if (flag) args.push(flag);
    try {
      execFileSync('glab', args, { cwd, stdio: 'pipe', timeout: 30000 });
      return { ok: true };
    } catch (err) {
      return { error: (err.stderr ? err.stderr.toString() : err.message).trim() };
    }
  },

  async currentUser(pr, { cwd }) {
    try {
      const out = execFileSync('glab', ['api', 'user', '--jq', '.username'], {
        stdio: 'pipe', timeout: 10000, env: reviewGlabEnv(pr, cwd),
      }).toString().trim();
      return { login: out };
    } catch (err) {
      return { error: err.stderr ? err.stderr.toString() : err.message };
    }
  },

  gitAuth(pr, { owner, repo }) {
    const host = pr.host || DEFAULT_HOST;
    const repoPath = owner ? `${owner}/${repo}` : repo;
    const token = getGlabToken(host);
    if (!token) {
      return { error: `Could not read glab auth token — run \`glab auth login --hostname ${host}\` first.` };
    }
    return {
      url: `https://oauth2:${token}@${host}/${repoPath}.git`,
      cleanUrl: `https://${host}/${repoPath}.git`,
      env: {},
    };
  },

  headFetch(pr, localBranch) {
    return {
      refspec: `+refs/merge-requests/${pr.number}/head:refs/heads/${localBranch}`,
      fetchTarget: `merge-requests/${pr.number}/head`,
    };
  },

  // glab's prior account isn't captured, so there is never one to restore.
  useAccountForReview(account, host = DEFAULT_HOST) {
    if (!account) return null;
    try {
      execFileSync('glab', ['auth', 'switch', '--hostname', host, '--user', account], { stdio: 'pipe', timeout: 5000 });
      clearGlabTokenCache();
    } catch (_) { /* best-effort: review still runs with the ambient account */ }
    return null;
  },

  restoreAccountAfterReview(saved) {
    try {
      execFileSync('glab', ['auth', 'switch', '--hostname', saved.host, '--user', saved.account], { stdio: 'pipe', timeout: 5000 });
      clearGlabTokenCache();
    } catch (_) { /* best-effort, like the switch */ }
  },
};
