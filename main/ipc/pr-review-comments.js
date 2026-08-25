// PR-review comment + review-submission IPC: issue comments, inline review
// comment edits/replies, the batched review submission (G4), and the cached
// current-user lookup. Split out of pr-review.js; required for its
// ipcMain.handle side effects.

const { ipcMain } = require('electron');
const log = require('electron-log');
const { execFile, execFileSync, spawn } = require('child_process');
const { ghExec, ghExecP, resolveGhEnv, appendStderr, execFileP } = require('../util/exec');
const { resolveGlabEnv } = require('../util/glab-exec');
const { ghJson, ghText } = require('../util/gh-json');
const { glabJson, glabText } = require('../util/glab-json');
const { bitbucketFetch, bitbucketJson } = require('../util/bitbucket-api');
const { humanizeComment } = require('../util/humanize-comment');
const { isEmptyReview, ghApiErrorMessage } = require('../util/review-payload');
const {
  prReview, currentRepoPath, sanitizePrReview, broadcastPrReview, fetchThreadsForActive,
} = require('../state/pr-review');

// Pin every gh/glab call in an active review to the account it runs under.
function reviewGhEnv(cwd) {
  const account = prReview.active && prReview.active.account;
  return { ...process.env, ...resolveGhEnv({ account, cwd }) };
}

function reviewGlabEnv(cwd) {
  const account = prReview.active && prReview.active.account;
  const host = prReview.active && prReview.active.host;
  const resolved = resolveGlabEnv({ account, host, cwd });
  const env = { ...process.env, ...resolved };
  delete env.GITLAB_TOKEN;
  return env;
}

ipcMain.handle('pr-add-issue-comment', async (_event, { body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number, forge, projectPath } = prReview.active;
  if (!baseOwner && !projectPath) return { error: 'Could not determine base repo' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  body = humanizeComment(body);
  const cwd = currentRepoPath() || require('os').homedir();

  if (forge === 'bitbucket') {
    const target = projectPath || `${baseOwner}/${baseRepo}`;
    const host = prReview.active.host || 'bitbucket.org';
    const account = prReview.active.account;
    try {
      await bitbucketFetch(`/repositories/${target}/pullrequests/${number}/comments`, {
        method: 'POST',
        account, host, cwd,
        body: { content: { raw: body } },
      });
      return { ok: true };
    } catch (err) {
      return { error: (err.responseBody || err.message || '').trim() };
    }
  }

  if (forge === 'gitlab') {
    const target = projectPath || `${baseOwner}/${baseRepo}`;
    const endpoint = `projects/${encodeURIComponent(target)}/merge_requests/${number}/notes`;
    return new Promise((resolve) => {
      const proc = spawn('glab', ['api', endpoint, '--method', 'POST', '--input', '-', '--header', 'Content-Type: application/json'], {
        cwd,
        env: reviewGlabEnv(cwd),
        stdio: ['pipe', 'pipe', 'pipe'],
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
            } catch (_) {}
          }
          resolve({ error: msg || ('glab exited with code ' + code) });
          return;
        }
        resolve({ ok: true });
      });
      proc.stdin.write(JSON.stringify({ body }));
      proc.stdin.end();
    });
  }

  const endpoint = `repos/${baseOwner}/${baseRepo}/issues/${number}/comments`;
  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
      env: reviewGhEnv(cwd),
      stdio: ['pipe', 'pipe', 'pipe'],
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
          } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

ipcMain.handle('pr-edit-issue-comment', async (_event, { commentId, body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number, forge, projectPath } = prReview.active;
  if (!baseOwner && !projectPath) return { error: 'Could not determine base repo' };
  const id = parseInt(commentId, 10);
  if (!id) return { error: 'Missing or invalid comment id' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  body = humanizeComment(body);
  const cwd = currentRepoPath() || require('os').homedir();

  if (forge === 'bitbucket') {
    const target = projectPath || `${baseOwner}/${baseRepo}`;
    const host = prReview.active.host || 'bitbucket.org';
    const account = prReview.active.account;
    try {
      await bitbucketFetch(`/repositories/${target}/pullrequests/${number}/comments/${id}`, {
        method: 'PUT',
        account, host, cwd,
        body: { content: { raw: body } },
      });
      return { ok: true, body };
    } catch (err) {
      return { error: (err.responseBody || err.message || '').trim() };
    }
  }

  if (forge === 'gitlab') {
    const target = projectPath || `${baseOwner}/${baseRepo}`;
    const endpoint = `projects/${encodeURIComponent(target)}/merge_requests/${number}/notes/${id}`;
    return new Promise((resolve) => {
      const proc = spawn('glab', ['api', endpoint, '--method', 'PUT', '--input', '-', '--header', 'Content-Type: application/json'], {
        cwd, env: reviewGlabEnv(cwd), stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdoutBuf = '', stderrBuf = '';
      proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
      proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
      proc.on('error', (err) => resolve({ error: err.message }));
      proc.on('exit', (code) => {
        if (code !== 0) {
          let msg = stderrBuf.trim();
          if (stdoutBuf) {
            try { const p = JSON.parse(stdoutBuf); if (p.message) msg = p.message; } catch (_) {}
          }
          resolve({ error: msg || ('glab exited with code ' + code) });
          return;
        }
        resolve({ ok: true, body });
      });
      proc.stdin.write(JSON.stringify({ body }));
      proc.stdin.end();
    });
  }

  const endpoint = `repos/${baseOwner}/${baseRepo}/issues/comments/${id}`;
  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'PATCH', '--input', '-'], {
      cwd, env: reviewGhEnv(cwd), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try { const p = JSON.parse(stdoutBuf); if (p.message) msg = p.message; } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true, body });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

ipcMain.handle('pr-edit-review-comment', async (_event, { commentId, body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number, forge, projectPath } = prReview.active;
  if (!baseOwner && !projectPath) return { error: 'Could not determine base repo' };
  const id = parseInt(commentId, 10);
  if (!id) return { error: 'Missing or invalid comment id' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  body = humanizeComment(body);
  const cwd = currentRepoPath() || require('os').homedir();

  if (forge === 'bitbucket') {
    const target = projectPath || `${baseOwner}/${baseRepo}`;
    const host = prReview.active.host || 'bitbucket.org';
    const account = prReview.active.account;
    try {
      await bitbucketFetch(`/repositories/${target}/pullrequests/${number}/comments/${id}`, {
        method: 'PUT',
        account, host, cwd,
        body: { content: { raw: body } },
      });
      return { ok: true, body };
    } catch (err) {
      return { error: (err.responseBody || err.message || '').trim() };
    }
  }

  if (forge === 'gitlab') {
    const target = projectPath || `${baseOwner}/${baseRepo}`;
    const endpoint = `projects/${encodeURIComponent(target)}/merge_requests/${number}/notes/${id}`;
    return new Promise((resolve) => {
      const proc = spawn('glab', ['api', endpoint, '--method', 'PUT', '--input', '-', '--header', 'Content-Type: application/json'], {
        cwd, env: reviewGlabEnv(cwd), stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdoutBuf = '', stderrBuf = '';
      proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
      proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
      proc.on('error', (err) => resolve({ error: err.message }));
      proc.on('exit', (code) => {
        if (code !== 0) {
          let msg = stderrBuf.trim();
          if (stdoutBuf) {
            try { const p = JSON.parse(stdoutBuf); if (p.message) msg = p.message; } catch (_) {}
          }
          resolve({ error: msg || ('glab exited with code ' + code) });
          return;
        }
        resolve({ ok: true, body });
      });
      proc.stdin.write(JSON.stringify({ body }));
      proc.stdin.end();
    });
  }

  const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/comments/${id}`;
  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'PATCH', '--input', '-'], {
      cwd, env: reviewGhEnv(cwd), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try { const p = JSON.parse(stdoutBuf); if (p.message) msg = p.message; } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true, body });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

let cachedCurrentUser = null;
ipcMain.handle('pr-current-user', async () => {
  if (cachedCurrentUser) return { login: cachedCurrentUser };
  const cwd = currentRepoPath() || require('os').homedir();
  const forge = (prReview.active && prReview.active.forge) || 'github';

  if (forge === 'bitbucket') {
    try {
      const host = (prReview.active && prReview.active.host) || 'bitbucket.org';
      const account = prReview.active && prReview.active.account;
      const res = await bitbucketJson('/user', { host, account, cwd });
      const login = res.nickname || res.username || res.display_name;
      if (login) cachedCurrentUser = login;
      return { login: cachedCurrentUser };
    } catch (err) {
      return { error: (err.responseBody || err.message || '').trim() };
    }
  }

  if (forge === 'gitlab') {
    try {
      const out = execFileSync('glab', ['api', 'user', '--jq', '.username'], {
        stdio: 'pipe', timeout: 10000, env: reviewGlabEnv(cwd),
      }).toString().trim();
      if (out) cachedCurrentUser = out;
      return { login: cachedCurrentUser };
    } catch (err) {
      return { error: err.stderr ? err.stderr.toString() : err.message };
    }
  }

  try {
    const out = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      stdio: 'pipe', timeout: 10000, env: reviewGhEnv(cwd),
    }).toString().trim();
    if (out) cachedCurrentUser = out;
    return { login: cachedCurrentUser };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('pr-reply-to-review-comment', async (_event, { inReplyTo, body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number, forge, projectPath, threads } = prReview.active;
  if (!baseOwner && !projectPath) return { error: 'Could not determine base repo' };
  if (!body || !body.trim()) return { error: 'Reply body is empty' };

  body = humanizeComment(body);
  const cwd = currentRepoPath() || require('os').homedir();

  if (forge === 'bitbucket') {
    const target = projectPath || `${baseOwner}/${baseRepo}`;
    const host = prReview.active.host || 'bitbucket.org';
    const account = prReview.active.account;
    let parentCommentId = parseInt(inReplyTo, 10);
    if (!parentCommentId && threads && Array.isArray(threads)) {
      const matchingThread = threads.find((t) => t.id === inReplyTo || (t.comments && t.comments.some((c) => String(c.databaseId) === String(inReplyTo))));
      if (matchingThread && matchingThread.comments && matchingThread.comments.length > 0) {
        parentCommentId = matchingThread.comments[0].databaseId;
      }
    }
    try {
      await bitbucketFetch(`/repositories/${target}/pullrequests/${number}/comments`, {
        method: 'POST',
        account, host, cwd,
        body: {
          content: { raw: body },
          parent: { id: parentCommentId },
        },
      });
      return { ok: true };
    } catch (err) {
      return { error: (err.responseBody || err.message || '').trim() };
    }
  }

  if (forge === 'gitlab') {
    const target = projectPath || `${baseOwner}/${baseRepo}`;
    // Find the thread id: inReplyTo might be thread id or comment id
    let discussionId = inReplyTo;
    if (threads && Array.isArray(threads)) {
      const matchingThread = threads.find((t) => t.id === inReplyTo || (t.comments && t.comments.some((c) => String(c.databaseId) === String(inReplyTo))));
      if (matchingThread) discussionId = matchingThread.id;
    }
    const endpoint = `projects/${encodeURIComponent(target)}/merge_requests/${number}/discussions/${encodeURIComponent(discussionId)}/notes`;
    return new Promise((resolve) => {
      const proc = spawn('glab', ['api', endpoint, '--method', 'POST', '--input', '-', '--header', 'Content-Type: application/json'], {
        cwd,
        env: reviewGlabEnv(cwd),
        stdio: ['pipe', 'pipe', 'pipe'],
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
            } catch (_) {}
          }
          resolve({ error: msg || ('glab exited with code ' + code) });
          return;
        }
        resolve({ ok: true });
      });
      proc.stdin.write(JSON.stringify({ body }));
      proc.stdin.end();
    });
  }

  const parentId = parseInt(inReplyTo, 10);
  if (!parentId) return { error: 'Missing or invalid parent comment id' };
  const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/${number}/comments/${parentId}/replies`;

  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
      env: reviewGhEnv(cwd),
      stdio: ['pipe', 'pipe', 'pipe'],
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
            if (parsed.message) msg = parsed.message + (parsed.errors ? ': ' + JSON.stringify(parsed.errors) : '');
          } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

ipcMain.handle('pr-review-resolve-thread', async (_event, { threadId, resolve }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  if (!threadId) return { error: 'Missing thread id' };
  const cwd = currentRepoPath() || require('os').homedir();
  const forge = prReview.active.forge || 'github';

  if (forge === 'bitbucket') {
    const target = prReview.active.projectPath || `${prReview.active.baseOwner}/${prReview.active.baseRepo}`;
    const host = prReview.active.host || 'bitbucket.org';
    const account = prReview.active.account;
    try {
      const method = resolve ? 'POST' : 'DELETE';
      await bitbucketFetch(`/repositories/${target}/pullrequests/${prReview.active.number}/comments/${threadId}/resolve`, {
        method,
        account, host, cwd,
      });
      try { await fetchThreadsForActive(); } catch (_) {}
      return { ok: true };
    } catch (err) {
      return { error: (err.responseBody || err.message || '').trim() };
    }
  }

  if (forge === 'gitlab') {
    const target = prReview.active.projectPath || `${prReview.active.baseOwner}/${prReview.active.baseRepo}`;
    const endpoint = `projects/${encodeURIComponent(target)}/merge_requests/${prReview.active.number}/discussions/${encodeURIComponent(threadId)}`;
    try {
      execFileSync('glab', ['api', endpoint, '-X', 'PUT', '-F', `resolved=${resolve ? 'true' : 'false'}`], {
        cwd, env: reviewGlabEnv(cwd), stdio: 'pipe', timeout: 15000,
      });
      try { await fetchThreadsForActive(); } catch (_) {}
      return { ok: true };
    } catch (err) {
      return { error: err.stderr ? err.stderr.toString() : err.message };
    }
  }

  const mutation = resolve
    ? 'mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }'
    : 'mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }';
  try {
    ghExec([
      'api', 'graphql',
      '-f', 'query=' + mutation,
      '-F', 'id=' + threadId,
    ], { cwd, ghAccount: prReview.active.account, stdio: 'pipe', timeout: 15000 });
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
  try { await fetchThreadsForActive(); } catch (_) {}
  return { ok: true };
});

ipcMain.handle('pr-submit-review', async (_event, { event, body, comments }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number, forge, projectPath, meta } = prReview.active;
  if (!baseOwner && !projectPath) return { error: 'Could not determine base repo' };
  if (!event) return { error: 'Missing review event (APPROVE / REQUEST_CHANGES / COMMENT)' };

  // Split incoming drafts: inline review comments go in the review payload;
  // issueComment:true drafts (Claude-implement follow-ups whose location
  // couldn't be verified) post after the review as general PR comments.
  const rawComments = comments || [];
  const inlineComments = rawComments.filter((c) => !c.issueComment);
  const issueCommentDrafts = rawComments.filter((c) => c.issueComment);

  const cwd = currentRepoPath() || require('os').homedir();

  if (forge === 'bitbucket') {
    const target = projectPath || `${baseOwner}/${baseRepo}`;
    const host = prReview.active.host || 'bitbucket.org';
    const account = prReview.active.account;
    const errors = [];
    let postedCount = 0;

    for (const c of inlineComments) {
      if (!c.body || !c.body.trim()) continue;
      const inlineData = { path: c.path };
      if (c.side === 'LEFT' && typeof c.line === 'number') {
        inlineData.from = c.line;
      } else if (typeof c.line === 'number') {
        inlineData.to = c.line;
      }
      try {
        await bitbucketFetch(`/repositories/${target}/pullrequests/${number}/comments`, {
          method: 'POST',
          account, host, cwd,
          body: {
            content: { raw: humanizeComment(c.body) },
            inline: inlineData,
          },
        });
        postedCount += 1;
      } catch (err) {
        // Fallback: general comment with line ref
        const fallbackBody = `**[${c.path}${typeof c.line === 'number' ? `:${c.line}` : ''}]**\n\n${c.body}`;
        try {
          await bitbucketFetch(`/repositories/${target}/pullrequests/${number}/comments`, {
            method: 'POST',
            account, host, cwd,
            body: { content: { raw: humanizeComment(fallbackBody) } },
          });
          postedCount += 1;
        } catch (fbErr) {
          errors.push(err.message || fbErr.message);
        }
      }
    }

    if (body && body.trim()) {
      try {
        await bitbucketFetch(`/repositories/${target}/pullrequests/${number}/comments`, {
          method: 'POST',
          account, host, cwd,
          body: { content: { raw: humanizeComment(body) } },
        });
        postedCount += 1;
      } catch (err) {
        errors.push(err.message);
      }
    }

    for (const draft of issueCommentDrafts) {
      if (!draft.body || !draft.body.trim()) continue;
      try {
        await bitbucketFetch(`/repositories/${target}/pullrequests/${number}/comments`, {
          method: 'POST',
          account, host, cwd,
          body: { content: { raw: humanizeComment(draft.body) } },
        });
        postedCount += 1;
      } catch (err) {
        errors.push(err.message);
      }
    }

    if (event === 'APPROVE') {
      try {
        await bitbucketFetch(`/repositories/${target}/pullrequests/${number}/approve`, {
          method: 'POST',
          account, host, cwd,
        });
      } catch (err) {
        errors.push(err.message);
      }
    } else if (event === 'REQUEST_CHANGES') {
      try {
        await bitbucketFetch(`/repositories/${target}/pullrequests/${number}/request-changes`, {
          method: 'POST',
          account, host, cwd,
        });
      } catch (err) {
        errors.push(err.message);
      }
    }

    if (errors.length) {
      if (postedCount === 0) return { error: `Nothing was posted: ${errors.join('; ')}` };
      return { ok: true, warning: `Review posted, but some actions had warnings: ${errors.join('; ')}` };
    }
    return { ok: true };
  }

  if (forge === 'gitlab') {
    const target = projectPath || `${baseOwner}/${baseRepo}`;
    const headSha = meta && (meta.headRefOid || (meta.diff_refs && meta.diff_refs.head_sha) || '');
    const baseSha = meta && ((meta.diff_refs && meta.diff_refs.base_sha) || headSha);
    const startSha = meta && ((meta.diff_refs && meta.diff_refs.start_sha) || baseSha);

    const errors = [];
    let postedCount = 0;

    for (const c of inlineComments) {
      if (!c.body || !c.body.trim()) continue;
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
      const discPayload = {
        body: humanizeComment(c.body),
        position: pos,
      };
      const endpoint = `projects/${encodeURIComponent(target)}/merge_requests/${number}/discussions`;
      const res = await new Promise((resolve) => {
        const proc = spawn('glab', ['api', endpoint, '--method', 'POST', '--input', '-', '--header', 'Content-Type: application/json'], {
          cwd, env: reviewGlabEnv(cwd), stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdoutBuf = '', stderrBuf = '';
        proc.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
        proc.stderr.on('data', (d) => { stderrBuf = appendStderr(stderrBuf, d); });
        proc.on('error', (err) => resolve({ error: err.message }));
        proc.on('exit', (code) => {
          if (code !== 0) {
            let msg = stderrBuf.trim();
            if (stdoutBuf) {
              try { const p = JSON.parse(stdoutBuf); if (p.message) msg = p.message; } catch (_) {}
            }
            resolve({ error: msg || ('glab exited with code ' + code) });
            return;
          }
          resolve({ ok: true });
        });
        proc.stdin.write(JSON.stringify(discPayload));
        proc.stdin.end();
      });
      if (res.error) {
        // Fallback: post as an MR note with file & line reference
        const fallbackBody = `**[${c.path}${typeof c.line === 'number' ? `:${c.line}` : ''}]**\n\n${c.body}`;
        const noteEndpoint = `projects/${encodeURIComponent(target)}/merge_requests/${number}/notes`;
        const noteRes = await new Promise((resolve) => {
          const proc = spawn('glab', ['api', noteEndpoint, '--method', 'POST', '--input', '-', '--header', 'Content-Type: application/json'], {
            cwd, env: reviewGlabEnv(cwd), stdio: ['pipe', 'pipe', 'pipe'],
          });
          let stdoutBuf = '', stderrBuf = '';
          proc.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
          proc.stderr.on('data', (d) => { stderrBuf = appendStderr(stderrBuf, d); });
          proc.on('error', (err) => resolve({ error: err.message }));
          proc.on('exit', (code) => {
            if (code !== 0) {
              let msg = stderrBuf.trim();
              if (stdoutBuf) {
                try { const p = JSON.parse(stdoutBuf); if (p.message) msg = p.message; } catch (_) {}
              }
              resolve({ error: msg || ('glab exited with code ' + code) });
              return;
            }
            resolve({ ok: true });
          });
          proc.stdin.write(JSON.stringify({ body: humanizeComment(fallbackBody) }));
          proc.stdin.end();
        });
        if (noteRes.error) errors.push(res.error);
        else postedCount += 1;
      } else {
        postedCount += 1;
      }
    }

    if (body && body.trim()) {
      const endpoint = `projects/${encodeURIComponent(target)}/merge_requests/${number}/notes`;
      const res = await new Promise((resolve) => {
        const proc = spawn('glab', ['api', endpoint, '--method', 'POST', '--input', '-', '--header', 'Content-Type: application/json'], {
          cwd, env: reviewGlabEnv(cwd), stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdoutBuf = '', stderrBuf = '';
        proc.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
        proc.stderr.on('data', (d) => { stderrBuf = appendStderr(stderrBuf, d); });
        proc.on('error', (err) => resolve({ error: err.message }));
        proc.on('exit', (code) => {
          if (code !== 0) {
            let msg = stderrBuf.trim();
            if (stdoutBuf) {
              try { const p = JSON.parse(stdoutBuf); if (p.message) msg = p.message; } catch (_) {}
            }
            resolve({ error: msg || ('glab exited with code ' + code) });
            return;
          }
          resolve({ ok: true });
        });
        proc.stdin.write(JSON.stringify({ body: humanizeComment(body) }));
        proc.stdin.end();
      });
      if (res.error) errors.push(res.error);
      else postedCount += 1;
    }

    for (const draft of issueCommentDrafts) {
      if (!draft.body || !draft.body.trim()) continue;
      const endpoint = `projects/${encodeURIComponent(target)}/merge_requests/${number}/notes`;
      const res = await new Promise((resolve) => {
        const proc = spawn('glab', ['api', endpoint, '--method', 'POST', '--input', '-', '--header', 'Content-Type: application/json'], {
          cwd, env: reviewGlabEnv(cwd), stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdoutBuf = '', stderrBuf = '';
        proc.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
        proc.stderr.on('data', (d) => { stderrBuf = appendStderr(stderrBuf, d); });
        proc.on('error', (err) => resolve({ error: err.message }));
        proc.on('exit', (code) => {
          if (code !== 0) {
            let msg = stderrBuf.trim();
            if (stdoutBuf) {
              try { const p = JSON.parse(stdoutBuf); if (p.message) msg = p.message; } catch (_) {}
            }
            resolve({ error: msg || ('glab exited with code ' + code) });
            return;
          }
          resolve({ ok: true });
        });
        proc.stdin.write(JSON.stringify({ body: humanizeComment(draft.body) }));
        proc.stdin.end();
      });
      if (res.error) errors.push(res.error);
      else postedCount += 1;
    }

    if (event === 'APPROVE') {
      try {
        execFileSync('glab', ['mr', 'approve', String(number)], {
          cwd, env: reviewGlabEnv(cwd), stdio: 'pipe', timeout: 15000,
        });
      } catch (err) {
        errors.push((err.stderr ? err.stderr.toString() : err.message).trim());
      }
    }

    if (errors.length) {
      if (postedCount === 0) return { error: `Nothing was posted: ${errors.join('; ')}` };
      return { ok: true, warning: `Review posted, but some actions had warnings: ${errors.join('; ')}` };
    }
    return { ok: true };
  }

  const payload = {
    event,
    body: humanizeComment(body || ''),
    comments: inlineComments.map((c) => {
      const out = {
        path: c.path,
        body: humanizeComment(c.body),
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
      env: reviewGhEnv(cwd),
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
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
  if (reviewResult.error) return reviewResult;

  // Post any queued issue-comment drafts sequentially. Failures don't roll
  // back the review; surface them as a partial-success warning so the user
  // can retry manually.
  const issueEndpoint = `repos/${baseOwner}/${baseRepo}/issues/${number}/comments`;
  const issueCommentFailures = [];
  let issueCommentsPosted = 0;
  for (const draft of issueCommentDrafts) {
    if (!draft.body || !draft.body.trim()) continue;
    const res = await new Promise((resolve) => {
      const proc = spawn('gh', ['api', issueEndpoint, '--method', 'POST', '--input', '-'], {
        cwd,
        env: reviewGhEnv(cwd),
        stdio: ['pipe', 'pipe', 'pipe'],
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
            } catch (_) {}
          }
          resolve({ error: msg || ('gh exited with code ' + code) });
          return;
        }
        resolve({ ok: true });
      });
      proc.stdin.write(JSON.stringify({ body: humanizeComment(draft.body) }));
      proc.stdin.end();
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
});
