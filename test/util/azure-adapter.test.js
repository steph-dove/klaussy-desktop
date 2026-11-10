require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const azure = require('../../main/util/forges/azure');
const { basicHeader } = require('../../main/util/azure-api');

const PAT = 'env-pat-for-tests';
const PR_URL = 'https://dev.azure.com/contoso/Web%20App/_git/front/pullrequest/42';
const API = 'https://dev.azure.com/contoso/Web%20App/_apis/git/repositories/front/pullRequests/42';
const USER_ID = '11111111-2222-3333-4444-555555555555';

const EMPTY_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ado-gitcfg-')), 'gitconfig');
fs.writeFileSync(EMPTY_GITCONFIG, '');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
};

const fileUrl = (p) => pathToFileURL(p).href;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' }).toString().trim();
}

function commitFile(cwd, file, text, msg) {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD');
}

// A bare "Azure" repo with main, a feature branch, and Azure's merge ref:
// main later gains other.txt, and the merge ref joins main and feature.
function makeOrigin({ mergeRef = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-diff-'));
  const work = path.join(root, 'work');
  const bare = path.join(root, 'origin.git');
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  commitFile(work, 'app.txt', 'one\n', 'base');
  git(work, 'checkout', '-q', '-b', 'feature');
  const head = commitFile(work, 'app.txt', 'one\ntwo\n', 'feature change');
  git(work, 'checkout', '-q', 'main');
  commitFile(work, 'other.txt', 'target only\n', 'target moves on');
  if (mergeRef) {
    git(work, 'checkout', '-q', '--detach', 'main');
    git(work, 'merge', '-q', '--no-ff', '-m', 'Merge pull request 42', 'feature');
    git(work, 'update-ref', 'refs/pull/42/merge', 'HEAD');
    git(work, 'checkout', '-q', 'main');
  }
  // The source branch moves on after Azure computed the merge ref, so the
  // merge ref and a branch diff disagree: only the branch diff has later.txt.
  git(work, 'checkout', '-q', 'feature');
  const later = commitFile(work, 'later.txt', 'pushed after the merge ref\n', 'later push');
  git(work, 'checkout', '-q', 'main');
  git(root, 'clone', '-q', '--bare', work, bare);
  if (mergeRef) git(work, 'push', '-q', bare, 'refs/pull/42/merge:refs/pull/42/merge');
  git(bare, 'config', 'uploadpack.allowFilter', 'true');
  const clone = path.join(root, 'clone');
  git(root, 'clone', '-q', '--filter=blob:none', fileUrl(bare), clone);
  return { root, bare, clone, head, later };
}

const META = { number: 42, baseRefName: 'main', headRefName: 'feature' };

function filesIn(diff) {
  return [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
}

test('localDiff uses a current merge ref, and target-only changes stay out of the diff', async () => {
  const o = makeOrigin();
  try {
    const diff = await azure.localDiff({
      cwd: o.clone, auth: { url: fileUrl(o.bare), env: {} }, number: 42, meta: { ...META, headRefOid: o.head },
    });
    // The branch diff would also list later.txt; the merge ref stops at o.head.
    assert.deepEqual(filesIn(diff), ['app.txt']);
    assert.match(diff, /^\+two$/m);
  } finally {
    fs.rmSync(o.root, { recursive: true, force: true });
  }
});

test('localDiff falls back to the branches when the merge ref is missing or stale', async () => {
  const missing = makeOrigin({ mergeRef: false });
  const stale = makeOrigin();
  try {
    const a = await azure.localDiff({
      cwd: missing.clone, auth: { url: fileUrl(missing.bare), env: {} }, number: 42, meta: { ...META, headRefOid: missing.later },
    });
    assert.deepEqual(filesIn(a), ['app.txt', 'later.txt']);
    // The merge ref's source is o.head, but the PR is now at o.later.
    const b = await azure.localDiff({
      cwd: stale.clone, auth: { url: fileUrl(stale.bare), env: {} }, number: 42, meta: { ...META, headRefOid: stale.later },
    });
    assert.deepEqual(filesIn(b), ['app.txt', 'later.txt']);
  } finally {
    fs.rmSync(missing.root, { recursive: true, force: true });
    fs.rmSync(stale.root, { recursive: true, force: true });
  }
});

test('gitAuth keeps the PAT out of the URL and passes it as an extra header', () => {
  process.env.AZURE_DEVOPS_EXT_PAT = PAT;
  try {
    const pr = { meta: { url: PR_URL } };
    const auth = azure.gitAuth(pr, { owner: 'contoso/web app', repo: 'front' });
    assert.equal(auth.url, 'https://dev.azure.com/contoso/web%20app/_git/front');
    assert.ok(!auth.url.includes(PAT));
    // Scoped to the collection, so submodule or LFS hosts never see the PAT.
    assert.equal(auth.env.GIT_CONFIG_KEY_0, 'http.https://dev.azure.com/contoso/.extraHeader');
    assert.equal(auth.env.GIT_CONFIG_VALUE_0, `Authorization: ${basicHeader(PAT)}`);
    assert.equal(auth.env.GCM_INTERACTIVE, 'never');
    const fork = azure.gitAuth(pr, { owner: 'contoso/sandbox', repo: 'front-fork' });
    assert.equal(fork.url, 'https://dev.azure.com/contoso/sandbox/_git/front-fork');
  } finally {
    delete process.env.AZURE_DEVOPS_EXT_PAT;
  }
});

test('gitAuth appends to GIT_CONFIG_* entries the environment already has', () => {
  process.env.AZURE_DEVOPS_EXT_PAT = PAT;
  process.env.GIT_CONFIG_COUNT = '2';
  try {
    const { env } = azure.gitAuth({ meta: { url: PR_URL } }, { owner: 'contoso/web app', repo: 'front' });
    assert.equal(env.GIT_CONFIG_COUNT, '3');
    assert.equal(env.GIT_CONFIG_KEY_2, 'http.https://dev.azure.com/contoso/.extraHeader');
    assert.equal(env.GIT_CONFIG_KEY_0, undefined);
  } finally {
    delete process.env.AZURE_DEVOPS_EXT_PAT;
    delete process.env.GIT_CONFIG_COUNT;
  }
});

test('headFetch points a fork PR at the fork, and a same-repo PR at nothing extra', () => {
  process.env.AZURE_DEVOPS_EXT_PAT = PAT;
  try {
    const same = azure.headFetch({ meta: {
      url: PR_URL, headRefName: 'feature', headRepositoryOwner: { login: 'contoso/web app' }, headRepository: { name: 'front' },
    } }, 'feature');
    assert.equal(same.url, undefined);
    assert.equal(same.refspec, '+refs/heads/feature:refs/heads/feature');
    const fork = azure.headFetch({ meta: {
      url: PR_URL, headRefName: 'main', headRepositoryOwner: { login: 'contoso/sandbox' }, headRepository: { name: 'front-fork' },
    } }, 'main');
    assert.equal(fork.url, 'https://dev.azure.com/contoso/sandbox/_git/front-fork');
  } finally {
    delete process.env.AZURE_DEVOPS_EXT_PAT;
  }
});

// Runs fn against a stubbed fetch. routes maps "METHOD url-prefix" to a body or (opts) => body/{status, body}.
async function withApi(routes, fn) {
  const realFetch = global.fetch;
  const calls = [];
  process.env.AZURE_DEVOPS_EXT_PAT = PAT;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    calls.push({ method, url: u, body: opts.body ? JSON.parse(opts.body) : undefined });
    const key = Object.keys(routes).find((k) => {
      const [m, prefix] = k.split(' ');
      return m === method && u.startsWith(prefix);
    });
    let out = key ? routes[key] : { status: 404, body: { message: 'no route ' + method + ' ' + u } };
    if (typeof out === 'function') out = out(opts);
    const res = out && typeof out.status === 'number' ? out : { status: 200, body: out };
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    const type = typeof res.body === 'string' ? 'text/plain' : 'application/json';
    return new Response(text, { status: res.status, headers: { 'content-type': type } });
  };
  try {
    await fn(calls);
  } finally {
    global.fetch = realFetch;
    delete process.env.AZURE_DEVOPS_EXT_PAT;
  }
}

const PR = { forge: 'azure', number: 42, meta: { url: PR_URL, headRefOid: 'abc' } };
const CONNECTION = { authenticatedUser: { id: USER_ID, providerDisplayName: 'Me', properties: { Account: { $value: 'me@contoso.com' } } } };

test('submitReview anchors inline threads, posts the summary, then votes', async () => {
  await withApi({
    [`GET ${API}/iterations`]: { value: [{ id: 1 }, { id: 3 }, { id: 2 }] },
    [`POST ${API}/threads`]: { id: 99 },
    'GET https://dev.azure.com/contoso/_apis/connectionData': CONNECTION,
    [`PUT ${API}/reviewers/${USER_ID}`]: { vote: 10 },
  }, async (calls) => {
    const res = await azure.submitReview(PR, {
      event: 'APPROVE',
      body: 'Looks good',
      inlineComments: [
        { path: 'src/a.js', line: 12, side: 'RIGHT', body: 'Right side', humanized: true },
        { path: '/src/b.js', line: 4, startLine: 2, side: 'LEFT', body: 'Left side', humanized: true },
      ],
      issueCommentDrafts: [],
    });
    assert.deepEqual(res, { ok: true });
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 3);
    assert.deepEqual(posts[0].body.threadContext, {
      filePath: '/src/a.js', rightFileStart: { line: 12, offset: 1 }, rightFileEnd: { line: 12, offset: 1 },
    });
    assert.equal(posts[0].body.status, 'active');
    assert.deepEqual(posts[0].body.pullRequestThreadContext, { iterationContext: { firstComparingIteration: 1, secondComparingIteration: 3 } });
    assert.deepEqual(posts[1].body.threadContext, {
      filePath: '/src/b.js', leftFileStart: { line: 2, offset: 1 }, leftFileEnd: { line: 4, offset: 1 },
    });
    assert.equal(posts[2].body.threadContext, undefined);
    const put = calls.find((c) => c.method === 'PUT');
    assert.deepEqual(put.body, { vote: 10 });
    assert.match(put.url, /api-version=7\.1/);
  });
});

test('submitReview reposts a rejected inline comment as a general one, and request-changes votes -5', async () => {
  await withApi({
    [`GET ${API}/iterations`]: { value: [{ id: 1 }] },
    [`POST ${API}/threads`]: (opts) => (JSON.parse(opts.body).threadContext ? { status: 400, body: { message: 'bad line' } } : { id: 1 }),
    'GET https://dev.azure.com/contoso/_apis/connectionData': CONNECTION,
    [`PUT ${API}/reviewers/`]: { vote: -5 },
  }, async (calls) => {
    const res = await azure.submitReview(PR, {
      event: 'REQUEST_CHANGES', body: '', issueCommentDrafts: [],
      inlineComments: [{ path: 'a.js', line: 900, body: 'Out of diff', humanized: true }],
    });
    assert.deepEqual(res, { ok: true });
    const general = calls.filter((c) => c.method === 'POST' && !c.body.threadContext);
    assert.equal(general.length, 1);
    assert.match(general[0].body.comments[0].content, /\*\*\[a\.js:900\]\*\*/);
    assert.deepEqual(calls.find((c) => c.method === 'PUT').body, { vote: -5 });
  });
});

test('reply, edit and resolve address the right thread and comment', async () => {
  await withApi({
    [`POST ${API}/threads/7/comments`]: { id: 3 },
    [`PATCH ${API}/threads/7/comments/2`]: { id: 2 },
    [`PATCH ${API}/threads/7`]: { id: 7 },
  }, async (calls) => {
    assert.deepEqual(await azure.reply(PR, { inReplyTo: '7:2', body: 'Done' }), { ok: true });
    assert.deepEqual(calls[0].body, { content: 'Done', parentCommentId: 2, commentType: 1 });
    assert.deepEqual(await azure.editComment(PR, { id: '7:2', body: 'Edited' }), { ok: true, body: 'Edited' });
    assert.deepEqual(await azure.resolveThread(PR, { threadId: '7', resolve: true }), { ok: true });
    assert.deepEqual(calls[2].body, { status: 'fixed' });
    await azure.resolveThread(PR, { threadId: '7', resolve: false });
    assert.deepEqual(calls[3].body, { status: 'active' });
    assert.match((await azure.editComment(PR, { id: '7', body: 'x' })).error, /comment id/);
  });
});

test('merge completes the PR and warns when Azure only queues it', async () => {
  await withApi({ [`PATCH ${API}?`]: { status: 'completed' } }, async (calls) => {
    assert.deepEqual(await azure.merge(PR, { strategy: 'squash' }), { ok: true });
    assert.deepEqual(calls[0].body, {
      status: 'completed',
      lastMergeSourceCommit: { commitId: 'abc' },
      completionOptions: { mergeStrategy: 'squash', deleteSourceBranch: false },
    });
  });
  await withApi({ [`PATCH ${API}?`]: { status: 'active' } }, async () => {
    assert.match((await azure.merge(PR, { strategy: 'merge' })).warning, /branch policies/);
  });
  await withApi({ [`PATCH ${API}?`]: { status: 409, body: { message: 'TF401181: policies not met' } } }, async () => {
    assert.match((await azure.merge(PR, { strategy: 'merge' })).error, /TF401181/);
  });
  assert.match((await azure.merge({ ...PR, meta: { url: PR_URL } }, {})).error, /source commit/);
});

const BUILDS = 'https://dev.azure.com/contoso/Web%20App/_apis/build/builds';

test('listChecks lists the latest statuses and one row per failed pipeline job, with no runId', async () => {
  await withApi({
    [`GET ${API}/statuses`]: { value: [
      { id: 1, state: 'pending', context: { genre: 'sonar', name: 'quality' } },
      { id: 2, state: 'succeeded', context: { genre: 'sonar', name: 'quality' }, targetUrl: 'https://sonar/x' },
    ] },
    [`GET ${BUILDS}?`]: { value: [
      { id: 501, status: 'completed', result: 'failed', definition: { id: 9, name: 'CI' }, buildNumber: '20261109.3', _links: { web: { href: 'https://dev.azure.com/contoso/Web%20App/_build/results?buildId=501' } } },
      { id: 400, status: 'completed', result: 'succeeded', definition: { id: 9, name: 'CI' } },
      { id: 502, status: 'inProgress', definition: { id: 10, name: 'Lint' } },
    ] },
    [`GET ${BUILDS}/501/timeline`]: { records: [
      { id: 'job-a', type: 'Job', name: 'Unit', result: 'failed' },
      { id: 'job-b', type: 'Job', name: 'Lint', result: 'succeeded' },
    ] },
  }, async (calls) => {
    const { checks, error } = await azure.listChecks(PR);
    assert.equal(error, undefined);
    assert.equal(checks.length, 3);
    assert.deepEqual(checks.map((c) => [c.name, c.bucket]), [['sonar/quality', 'pass'], ['CI / Unit', 'fail'], ['Lint', 'pending']]);
    assert.equal(checks[1].link, 'https://dev.azure.com/contoso/Web%20App/_build/results?buildId=501&view=logs&j=job-a');
    for (const c of checks) assert.equal(c.runId, undefined);
    assert.ok(calls.some((c) => c.url.includes('branchName=refs%2Fpull%2F42%2Fmerge')));
    assert.ok(calls.some((c) => c.url.includes('/statuses?api-version=7.1-preview.1')));
  });
});

test('listChecks reports an error instead of a partial list', async () => {
  await withApi({ [`GET ${API}/statuses`]: { value: [] } }, async () => {
    const res = await azure.listChecks(PR);
    assert.deepEqual(res.checks, []);
    assert.ok(res.error);
  });
});

test('failedCheckLogs returns the failed tasks\' log tail and the pipeline YAML', async () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-wt-'));
  fs.mkdirSync(path.join(wt, 'ci'));
  fs.writeFileSync(path.join(wt, 'ci', 'build.yml'), 'trigger: none\nsteps:\n  - script: npm test\n');
  const longLog = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
  try {
    await withApi({
      [`GET ${BUILDS}/501/timeline`]: { records: [
        { id: 'job-a', type: 'Job', name: 'Unit', result: 'failed', log: { id: 1 } },
        { id: 't1', type: 'Task', name: 'npm test', result: 'failed', parentId: 'job-a', log: { id: 7 } },
        { id: 't2', type: 'Task', name: 'checkout', result: 'succeeded', parentId: 'job-a', log: { id: 6 } },
        { id: 't3', type: 'Task', name: 'other job', result: 'failed', parentId: 'job-b', log: { id: 8 } },
      ] },
      [`GET ${BUILDS}/501/logs/7`]: longLog,
      [`GET ${BUILDS}/501?`]: { id: 501, definition: { id: 9 } },
      'GET https://dev.azure.com/contoso/Web%20App/_apis/build/definitions/9': { process: { yamlFilename: '/ci/build.yml' } },
    }, async (calls) => {
      const res = await azure.failedCheckLogs(PR, {
        checkLink: 'https://dev.azure.com/contoso/Web%20App/_build/results?buildId=501&view=logs&j=job-a', cwd: wt,
      });
      assert.equal(res.error, undefined);
      assert.equal(res.logTail.split('\n').length, 400);
      assert.match(res.logTail, /line 599$/);
      assert.match(res.workflowBlock, /ci\/build\.yml/);
      assert.match(res.workflowBlock, /npm test/);
      assert.ok(!calls.some((c) => /logs\/(6|8)/.test(c.url)));
    });
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
  assert.match((await azure.failedCheckLogs(PR, { checkLink: 'https://example.com/nope' })).error, /build id/);
});

test('fetchThreads classifies an expired PAT, even behind an HTML sign-in page', async () => {
  for (const status of [401, 203]) {
    await withApi({ [`GET ${API}/threads`]: { status, body: '<html><body>Sign in to your account</body></html>' } }, async () => {
      const res = await azure.fetchThreads(PR);
      assert.match(res.error.summary, /didn't accept the credentials/, String(status));
      assert.match(res.error.fix, /Code \(Read & write\)/);
      assert.ok(!res.error.raw.includes('<html'), 'HTML is not shown to the user');
    });
  }
  await withApi({ [`GET ${API}/threads`]: { status: 503, body: '<html>down</html>' } }, async () => {
    assert.match((await azure.fetchThreads(PR)).error.summary, /outage/);
  });
});
