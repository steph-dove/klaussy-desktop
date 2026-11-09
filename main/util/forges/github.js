// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// GitHub and GitHub Enterprise behind the forge adapter interface, over the gh CLI.

const fs = require('fs');
const path = require('path');
const log = require('electron-log');
const { execFile, execFileSync, spawn } = require('child_process');
const { ghExec, resolveGhEnv, appendStderr, clearGhTokenCache } = require('../exec');
const { ghJson, ghText } = require('../gh-json');
const { classifyGhError } = require('../gh-error');
const { parseForgeUrl } = require('../forge-url');
const { normalizeStatus, parseCheckRunsJsonl } = require('../check-normalize');
const { isEmptyReview, ghApiErrorMessage } = require('../review-payload');
const { humanizeComment } = require('../humanize-comment');
const { outboundBody } = require('./review-sequence');

const DEFAULT_HOST = 'github.com';
const PR_META_FIELDS = 'number,title,author,state,createdAt,updatedAt,headRefName,baseRefName,headRefOid,isDraft,reviewDecision,url,body,headRepository,headRepositoryOwner,mergeable,mergeStateStatus';

// Error messages name the repo only when it can be read off a PR URL.
function targetFromPrUrl(url) {
  const m = (url || '').match(/[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/pull\/\d+/);
  return m ? m[1] + '/' + m[2] : null;
}

// Pin every gh call in an active review to the account it runs under.
function reviewGhEnv(pr, cwd) {
  const account = pr && pr.account;
  return { ...process.env, ...resolveGhEnv({ account, cwd }) };
}

// Prefers GitHub's response-body message over gh's stderr. withErrors appends
// the API's field-level errors, which explain a rejected reply.
function ghApiInput(endpoint, method, payload, { cwd, env, withErrors = false }) {
  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', method, '--input', '-'], {
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
            if (parsed.message) msg = parsed.message + (withErrors && parsed.errors ? ': ' + JSON.stringify(parsed.errors) : '');
          } catch (_) { /* not JSON: keep stderr */ }
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true });
    });
    proc.stdin.on('error', () => { /* EPIPE when gh exits early; the exit handler reports it */ });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

function activeGhAccountNow() {
  try {
    const out = execFileSync('gh', ['auth', 'status'], { stdio: 'pipe', timeout: 5000 }).toString();
    const lines = out.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/Logged in to \S+ (?:account|as) ([A-Za-z0-9-]+)/);
      if (!m) continue;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (/Active account:\s*true/i.test(lines[j])) return m[1];
        if (/Logged in to/.test(lines[j])) break;
      }
    }
  } catch (_) { /* gh missing or signed out: no active account */ }
  return null;
}

module.exports = {
  id: 'github',
  label: 'GitHub',
  itemNoun: 'PR',
  defaultHost: DEFAULT_HOST,
  branchPrefix: 'pr',

  classifyError(raw, ctx = {}) {
    return classifyGhError(raw, { target: targetFromPrUrl(ctx.url) });
  },

  async listOpen({ cwd }) {
    return ghJson([
      'pr', 'list',
      '--json', 'number,title,author,state,updatedAt,headRefName,baseRefName,isDraft,reviewDecision,url',
      '--limit', '50',
    ], cwd);
  },

  async lookupPr(url, { cwd }) {
    const extraEnv = resolveGhEnv({ cwd });
    return ghJson([
      'pr', 'view', url,
      '--json', 'number,title,author,state,updatedAt,headRefName,baseRefName,isDraft,reviewDecision,url,body,headRepository,headRepositoryOwner',
    ], cwd, extraEnv);
  },

  async loadPr({ target, account, cwd }) {
    const extraEnv = resolveGhEnv({ account, cwd });
    const [meta, diff] = await Promise.all([
      ghJson(['pr', 'view', target, '--json', PR_META_FIELDS], cwd, extraEnv),
      ghText(['pr', 'diff', target], cwd, extraEnv),
    ]);
    const base = parseForgeUrl(meta.url);
    return {
      meta,
      diff,
      host: DEFAULT_HOST,
      repo: base ? `${base.owner}/${base.repo}` : null,
      baseOwner: base ? base.owner : null,
      baseRepo: base ? base.repo : null,
    };
  },

  async refreshPr(pr, { cwd }) {
    const url = pr.meta.url;
    const extraEnv = resolveGhEnv({ account: pr.account, cwd });
    const [meta, diff] = await Promise.all([
      ghJson(['pr', 'view', url, '--json', PR_META_FIELDS], cwd, extraEnv),
      ghText(['pr', 'diff', url], cwd, extraEnv),
    ]);
    return { meta, diff };
  },

  async reloadMeta(pr, { cwd }) {
    return ghJson(['pr', 'view', pr.meta.url, '--json', PR_META_FIELDS], cwd);
  },

  // GraphQL against the base repo, where threads live for fork PRs too.
  // Resolves null when the review moved on during the retry wait.
  async fetchThreads(pr, { cwd, stale }) {
    const owner = pr.baseOwner;
    const repo = pr.baseRepo;
    const query = 'query($owner: String!, $repo: String!, $number: Int!) {'
      + '  repository(owner: $owner, name: $repo) {'
      + '    pullRequest(number: $number) {'
      + '      reviewThreads(first: 100) {'
      + '        nodes {'
      + '          id isResolved isOutdated path line originalLine startLine originalStartLine diffSide'
      + '          comments(first: 100) { nodes { databaseId author { login } createdAt body diffHunk } }'
      + '        }'
      + '      }'
      + '      comments(first: 100) {'
      + '        nodes { databaseId author { login } createdAt body url }'
      + '      }'
      + '      reviews(first: 100) {'
      + '        nodes {'
      + '          databaseId state body submittedAt author { login }'
      + '          comments(first: 100) { nodes { databaseId body path line diffHunk } }'
      + '        }'
      + '      }'
      + '    }'
      + '  }'
      + '}';

    const ghArgs = [
      'api', 'graphql',
      '-f', 'query=' + query,
      '-f', 'owner=' + owner,
      '-f', 'repo=' + repo,
      '-F', 'number=' + pr.number,
    ];
    const runOnce = () => new Promise((resolve) => {
      execFile('gh', ghArgs, { cwd, maxBuffer: 50 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
        const fromBody = (s) => {
          try { const p = JSON.parse(String(s)); if (p && p.errors && p.errors.length) return p.errors.map(e => e.message).join('; '); } catch (_) { /* not a GraphQL error body */ }
          return null;
        };
        if (err) {
          return resolve({ errorRaw: fromBody(stdout) || (stderr || '').toString().trim() || err.message });
        }
        const bodyErr = fromBody(stdout);
        if (bodyErr) return resolve({ errorRaw: bodyErr });
        try { return resolve({ data: JSON.parse(stdout).data }); }
        catch (_) { return resolve({ errorRaw: 'gh returned non-JSON: ' + String(stdout).slice(0, 200) }); }
      });
    });

    const target = owner + '/' + repo;
    let res = await runOnce();
    if (res.errorRaw && classifyGhError(res.errorRaw, { target }).retryable) {
      await new Promise((r) => setTimeout(r, 900));
      if (stale()) return null;
      res = await runOnce();
    }

    if (res.errorRaw) {
      const cls = classifyGhError(res.errorRaw, { target });
      return { error: { summary: cls.summary, fix: cls.fix, raw: res.errorRaw } };
    }
    const prData = res.data && res.data.repository && res.data.repository.pullRequest;
    return {
      threads: (prData && prData.reviewThreads && prData.reviewThreads.nodes) || [],
      issueComments: (prData && prData.comments && prData.comments.nodes) || [],
      reviews: (prData && prData.reviews && prData.reviews.nodes) || [],
    };
  },

  async listChecks(pr, { cwd }) {
    const { meta, baseOwner, baseRepo } = pr;
    const sha = meta && meta.headRefOid;
    if (!sha) return { checks: [], error: 'Missing head commit sha' };

    // REST endpoint is more forgiving than gh's GraphQL path for this repo
    async function run(args) {
      return new Promise((resolve) => {
        execFile('gh', ['api'].concat(args), { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
          (err, stdout, stderr) => resolve({ err, stdout, stderr }));
      });
    }
    const [runsRes, statusRes] = await Promise.all([
      run([`repos/${baseOwner}/${baseRepo}/commits/${sha}/check-runs`, '--paginate', '--jq', '.check_runs[]']),
      run([`repos/${baseOwner}/${baseRepo}/commits/${sha}/status`]),
    ]);

    const checks = [];
    const parseErrors = [];
    if (!runsRes.err) {
      const { checks: runChecks, errors } = parseCheckRunsJsonl(runsRes.stdout);
      runChecks.forEach((c) => checks.push(c));
      if (errors.length) {
        parseErrors.push(...errors);
        console.error('[pr-review-checks] check-runs parse errors:', errors.join('; '),
          '— first 200 chars of stdout:', String(runsRes.stdout || '').slice(0, 200));
      }
    }
    if (!statusRes.err) {
      try {
        const parsed = JSON.parse(statusRes.stdout);
        const statuses = parsed.statuses || [];
        statuses.forEach((s) => checks.push(normalizeStatus(s)));
      } catch (e) {
        parseErrors.push('status parse: ' + (e.message || String(e)));
        console.error('[pr-review-checks] status parse error:', e.message,
          '— first 200 chars of stdout:', String(statusRes.stdout || '').slice(0, 200));
      }
    }

    // Error only if BOTH endpoints failed, so one transient failure can't mask the other's data.
    // Parse failures surface too: an HTML auth-redirect 200 would otherwise green-light the required-checks gate.
    if (checks.length === 0) {
      if (runsRes.err && statusRes.err) {
        const first = runsRes.err || statusRes.err;
        const raw = (first.stderr ? first.stderr.toString() : first.message) || '';
        return { checks: [], error: raw.trim() };
      }
      if (parseErrors.length > 0) {
        return { checks: [], error: 'Could not parse GitHub check responses: ' + parseErrors.join('; ') };
      }
    }
    return { checks };
  },

  // The failing job's log tail, its annotations, and the workflow YAML that
  // best matches the check name (read from the PR's worktree at cwd).
  async failedCheckLogs(pr, { checkLink, checkName, checkRunId, cwd }) {
    const { baseOwner, baseRepo } = pr;
    const m = checkLink.match(/\/actions\/runs\/(\d+)\/job\/(\d+)/);
    const runId = m ? m[1] : null;
    const jobId = m ? m[2] : null;
    if (!runId || !jobId) return { error: 'Could not parse run/job id from link: ' + checkLink };

    let logs = '';
    try {
      logs = execFileSync('gh', [
        'api', `/repos/${baseOwner}/${baseRepo}/actions/jobs/${jobId}/logs`,
      ], { cwd, stdio: 'pipe', timeout: 20000, maxBuffer: 50 * 1024 * 1024 }).toString();
    } catch (errA) {
      try {
        logs = execFileSync('gh', [
          'run', 'view', String(runId),
          '-R', `${baseOwner}/${baseRepo}`,
          '--log-failed',
        ], { cwd, stdio: 'pipe', timeout: 30000, maxBuffer: 50 * 1024 * 1024 }).toString();
      } catch (errB) {
        const msg = (errA.stderr ? errA.stderr.toString().trim() : errA.message)
          || (errB.stderr ? errB.stderr.toString().trim() : errB.message);
        return { error: 'Could not fetch logs: ' + msg };
      }
    }
    const logTail = logs.split('\n').slice(-400).join('\n');

    let annotationsBlock = '';
    if (checkRunId) {
      try {
        const annoRaw = execFileSync('gh', [
          'api', `/repos/${baseOwner}/${baseRepo}/check-runs/${checkRunId}/annotations`,
          '--paginate',
        ], { cwd, stdio: 'pipe', timeout: 10000, maxBuffer: 4 * 1024 * 1024 }).toString();
        const annos = JSON.parse(annoRaw);
        if (Array.isArray(annos) && annos.length > 0) {
          const top = annos.slice(0, 10).map((a) => {
            const loc = (a.path ? a.path : '?')
              + (a.start_line ? `:${a.start_line}` : '')
              + (a.end_line && a.end_line !== a.start_line ? `-${a.end_line}` : '');
            return `- [${a.annotation_level || 'notice'}] ${loc} — ${(a.title ? `**${a.title}** ` : '') + (a.message || '')}`.replace(/\n+/g, ' ');
          }).join('\n');
          annotationsBlock = `\n## Annotations (file:line hints from the check run)\n${top}\n`
            + (annos.length > 10 ? `\n[... ${annos.length - 10} more not shown ...]\n` : '');
        }
      } catch (err) {
        console.error('[failing-check-context] annotations fetch failed:',
          ((err && (err.stderr || err.message)) || String(err)).toString().trim());
      }
    }

    let workflowBlock = '';
    try {
      const wfDir = path.join(cwd, '.github', 'workflows');
      if (fs.existsSync(wfDir)) {
        const files = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/i.test(f));
        const targetTokens = (checkName || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        let best = null;
        for (const f of files) {
          const full = path.join(wfDir, f);
          const text = fs.readFileSync(full, 'utf8');
          const nameMatch = text.match(/^name\s*:\s*(.+)$/m);
          const wfName = nameMatch ? nameMatch[1].replace(/['"]/g, '').trim().toLowerCase() : f.toLowerCase();
          const score = targetTokens.reduce((acc, t) => acc + (wfName.includes(t) ? 1 : 0), 0);
          if (!best || score > best.score) best = { score, file: f, text };
        }
        if (best && best.score > 0) {
          const truncated = best.text.split('\n').slice(0, 200).join('\n');
          workflowBlock = `\n## Workflow definition (\`.github/workflows/${best.file}\`)\n\`\`\`yaml\n${truncated}\n${best.text.split('\n').length > 200 ? '\n[... truncated ...]\n' : ''}\`\`\`\n`;
        }
      }
    } catch (err) {
      console.error('[failing-check-context] workflow YAML lookup failed:',
        ((err && err.message) || String(err)).toString().trim());
    }

    return { logTail, annotationsBlock, workflowBlock };
  },

  async addIssueComment(pr, { body, cwd }) {
    const endpoint = `repos/${pr.baseOwner}/${pr.baseRepo}/issues/${pr.number}/comments`;
    return ghApiInput(endpoint, 'POST', { body }, { cwd, env: reviewGhEnv(pr, cwd) });
  },

  // GitHub keeps issue comments and inline review comments under different endpoints.
  async editComment(pr, { id, body, kind, cwd }) {
    const endpoint = kind === 'review'
      ? `repos/${pr.baseOwner}/${pr.baseRepo}/pulls/comments/${id}`
      : `repos/${pr.baseOwner}/${pr.baseRepo}/issues/comments/${id}`;
    const res = await ghApiInput(endpoint, 'PATCH', { body }, { cwd, env: reviewGhEnv(pr, cwd) });
    return res.error ? res : { ok: true, body };
  },

  async reply(pr, { inReplyTo, body, cwd }) {
    const parentId = parseInt(inReplyTo, 10);
    if (!parentId) return { error: 'Missing or invalid parent comment id' };
    const endpoint = `repos/${pr.baseOwner}/${pr.baseRepo}/pulls/${pr.number}/comments/${parentId}/replies`;
    return ghApiInput(endpoint, 'POST', { body }, { cwd, env: reviewGhEnv(pr, cwd), withErrors: true });
  },

  async resolveThread(pr, { threadId, resolve, cwd }) {
    const mutation = resolve
      ? 'mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }'
      : 'mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }';
    try {
      ghExec([
        'api', 'graphql',
        '-f', 'query=' + mutation,
        '-F', 'id=' + threadId,
      ], { cwd, ghAccount: pr.account, stdio: 'pipe', timeout: 15000 });
      return { ok: true };
    } catch (err) {
      return { error: err.stderr ? err.stderr.toString() : err.message };
    }
  },

  // One atomic review carries the summary, the vote and every inline comment;
  // follow-up drafts post after it as issue comments.
  async submitReview(pr, { event, body, inlineComments, issueCommentDrafts, cwd }) {
    const { baseOwner, baseRepo, number } = pr;
    const payload = {
      event,
      body: humanizeComment(body || ''),
      comments: inlineComments.map((c) => {
        const out = {
          path: c.path,
          body: outboundBody(c, c.body),
          side: c.side || 'RIGHT',
        };
        if (typeof c.line === 'number') out.line = c.line;
        if (typeof c.startLine === 'number' && c.startLine !== c.line) {
          out.start_line = c.startLine;
          out.start_side = c.startSide || out.side;
        }
        return out;
      }),
    };

    const skipReview = isEmptyReview(payload);
    if (skipReview && !issueCommentDrafts.some((d) => d.body && d.body.trim())) {
      return { error: 'Nothing to submit — add a summary or a comment first.' };
    }

    const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/${number}/reviews`;

    log.info('[pr-submit-review] POST', endpoint, 'event=' + event,
      'anchors=' + JSON.stringify(payload.comments.map((c) => ({
        path: c.path, line: c.line, start_line: c.start_line, side: c.side,
      }))));

    const reviewResult = skipReview ? { ok: true } : await new Promise((resolve) => {
      const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
        cwd,
        env: reviewGhEnv(pr, cwd),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdoutBuf = '', stderrBuf = '';
      proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
      proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
      proc.on('error', (err) => resolve({ error: err.message }));
      proc.on('exit', (code) => {
        if (code !== 0) {
          // gh often writes JSON errors to stdout on non-zero exit.
          let msg = ghApiErrorMessage(stdoutBuf, stderrBuf);
          log.warn('[pr-submit-review] failed code=' + code,
            'stderr=' + stderrBuf.trim(), 'stdout=' + stdoutBuf.trim());
          // GitHub blocks approve / request-changes on your own PR. Surface the
          // actionable version rather than its cryptic 422 string, in case the
          // UI gate didn't catch it (e.g. author/user not yet known on submit).
          if (/own pull request/i.test(msg)) {
            msg = 'GitHub doesn’t allow Approve or Request changes on your own PR. Use “Comment” to submit your feedback.';
          } else if (/must be part of the diff|line must be part|pull_request_review_thread|line could not be resolved/i.test(msg)) {
            // One inline comment anchors to a line GitHub doesn't consider part
            // of the diff, which fails the whole (atomic) review. Surface the
            // anchors so the user can drop the offending draft and retry.
            msg = 'GitHub rejected an inline comment whose line isn’t part of this PR’s diff. '
              + 'Remove or re-anchor the draft comment(s) and submit again. Anchors: '
              + JSON.stringify(payload.comments.map((c) => c.path + ':' + c.line));
          }
          resolve({ error: msg || ('gh exited with code ' + code) });
          return;
        }
        resolve({ ok: true });
      });
      proc.stdin.on('error', () => { /* EPIPE when gh exits early; the exit handler reports it */ });
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
    });
    if (reviewResult.error) return reviewResult;

    // Failures don't roll back the review; they surface as a partial-success warning.
    const issueEndpoint = `repos/${baseOwner}/${baseRepo}/issues/${number}/comments`;
    const issueCommentFailures = [];
    let issueCommentsPosted = 0;
    for (const draft of issueCommentDrafts) {
      if (!draft.body || !draft.body.trim()) continue;
      const res = await ghApiInput(issueEndpoint, 'POST', { body: outboundBody(draft, draft.body) }, {
        cwd, env: reviewGhEnv(pr, cwd),
      });
      if (res.error) issueCommentFailures.push(res.error);
      else issueCommentsPosted += 1;
    }

    if (issueCommentFailures.length) {
      // With the review skipped, the comments were the whole submission — if none
      // landed, nothing reached the PR and this is a failure, not a warning.
      if (skipReview && issueCommentsPosted === 0) {
        return { error: `Nothing was posted: ${issueCommentFailures.join('; ')}` };
      }
      const led = skipReview ? '' : 'Review posted, but ';
      return {
        ok: true,
        warning: `${led}${issueCommentFailures.length} follow-up comment(s) failed: ${issueCommentFailures.join('; ')}`,
      };
    }
    return { ok: true };
  },

  async merge(pr, { strategy, cwd }) {
    const flag = { merge: '--merge', squash: '--squash', rebase: '--rebase' }[strategy];
    if (!flag) return { error: 'Unknown merge strategy: ' + strategy };
    try {
      ghExec(['pr', 'merge', pr.meta.url, flag], {
        cwd, stdio: 'pipe', timeout: 30000,
      });
      return { ok: true };
    } catch (err) {
      return { error: err.stderr ? err.stderr.toString() : err.message };
    }
  },

  async currentUser(pr, { cwd }) {
    try {
      const out = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
        stdio: 'pipe', timeout: 10000, env: reviewGhEnv(pr, cwd),
      }).toString().trim();
      return { login: out };
    } catch (err) {
      return { error: err.stderr ? err.stderr.toString() : err.message };
    }
  },

  gitAuth(pr, { owner, repo }) {
    const host = pr.host || DEFAULT_HOST;
    const repoPath = owner ? `${owner}/${repo}` : repo;
    let token = '';
    try {
      token = execFileSync('gh', ['auth', 'token'], { stdio: 'pipe' }).toString().trim();
    } catch (_) {
      return { error: 'Could not read gh auth token — run `gh auth login` first.' };
    }
    return {
      url: `https://oauth2:${token}@${host}/${repoPath}.git`,
      cleanUrl: `https://${host}/${repoPath}.git`,
      env: {},
    };
  },

  headFetch(pr, localBranch) {
    return {
      refspec: `+refs/pull/${pr.number}/head:refs/heads/${localBranch}`,
      fetchTarget: `pull/${pr.number}/head`,
    };
  },

  // The embedded agent terminals and git run gh with the ambient account, so
  // reviewing a repo only another account can see needs that account active.
  // Returns the account that was active before, for restoreAccountAfterReview.
  useAccountForReview(account) {
    if (!account) return null;
    const current = activeGhAccountNow();
    if (current === account) return null;
    try {
      execFileSync('gh', ['auth', 'switch', '-u', account], { stdio: 'pipe', timeout: 5000 });
      clearGhTokenCache();
    } catch (_) { /* best-effort: review still runs with the ambient account */ }
    return current;
  },

  restoreAccountAfterReview(saved) {
    try {
      execFileSync('gh', ['auth', 'switch', '-u', saved], { stdio: 'pipe', timeout: 5000 });
      clearGhTokenCache();
    } catch (_) { /* best-effort, like the switch */ }
  },
};
