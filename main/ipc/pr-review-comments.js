// PR-review comment + review-submission IPC: issue comments, inline review
// comment edits/replies, the batched review submission (G4), and the cached
// current-user lookup. Split out of pr-review.js; required for its
// ipcMain.handle side effects.

const { ipcMain } = require('electron');
const { execFile, execFileSync, spawn } = require('child_process');
const { ghExec, ghExecP, appendStderr, execFileP } = require('../util/exec');
const { ghJson, ghText } = require('../util/gh-json');
const {
  prReview, currentRepoPath, sanitizePrReview, broadcastPrReview, fetchThreadsForActive,
} = require('../state/pr-review');

// G4: post all pending review comments + decision as one review. The GitHub
// REST endpoint accepts `comments` inline so we only make one network call.
// Piping JSON on stdin avoids shell-escaping pain for multiline comment
// bodies.
// General issue comment on the PR — no line context, just a body.
ipcMain.handle('pr-add-issue-comment', async (_event, { body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/issues/${number}/comments`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.

  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
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

// Patch an existing issue comment. `commentId` is the REST numeric id
// (GraphQL exposes it as databaseId). Posts to the `/issues/comments/{id}`
// REST endpoint — distinct from review comments which live under `/pulls/`.
ipcMain.handle('pr-edit-issue-comment', async (_event, { commentId, body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const id = parseInt(commentId, 10);
  if (!id) return { error: 'Missing or invalid comment id' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/issues/comments/${id}`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.
  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'PATCH', '--input', '-'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
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

// Patch an existing inline/review comment. Separate endpoint from issue
// comments: `/repos/{o}/{r}/pulls/comments/{id}`.
ipcMain.handle('pr-edit-review-comment', async (_event, { commentId, body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const id = parseInt(commentId, 10);
  if (!id) return { error: 'Missing or invalid comment id' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/comments/${id}`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.
  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'PATCH', '--input', '-'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
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

// Cache the current gh-authed user so we only show the edit control on
// comments this user can actually modify. gh api /user is the cheap
// canonical endpoint; we call it once per review session.
let cachedCurrentUser = null;
ipcMain.handle('pr-current-user', async () => {
  if (cachedCurrentUser) return { login: cachedCurrentUser };
  try {
    const out = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      stdio: 'pipe', timeout: 10000,
    }).toString().trim();
    if (out) cachedCurrentUser = out;
    return { login: cachedCurrentUser };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// Reply to a specific review comment (threaded). `inReplyTo` is the parent
// comment's REST databaseId — the same id GraphQL returns on each review
// comment so we can thread using data we already fetch. Uses GitHub's
// dedicated replies endpoint so we don't have to fake a new-comment shape.
ipcMain.handle('pr-reply-to-review-comment', async (_event, { inReplyTo, body }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const parentId = parseInt(inReplyTo, 10);
  if (!parentId) return { error: 'Missing or invalid parent comment id' };
  if (!body || !body.trim()) return { error: 'Reply body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/${number}/comments/${parentId}/replies`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.

  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
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

ipcMain.handle('pr-submit-review', async (_event, { event, body, comments }) => {
  if (!prReview.active) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number } = prReview.active;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  if (!event) return { error: 'Missing review event (APPROVE / REQUEST_CHANGES / COMMENT)' };

  // Split incoming drafts: inline review comments go in the review payload;
  // issueComment:true drafts (Claude-implement follow-ups whose location
  // couldn't be verified) post after the review as general PR comments.
  const rawComments = comments || [];
  const inlineComments = rawComments.filter((c) => !c.issueComment);
  const issueCommentDrafts = rawComments.filter((c) => c.issueComment);

  const payload = {
    event,
    body: body || '',
    comments: inlineComments.map((c) => {
      const out = {
        path: c.path,
        body: c.body,
        side: c.side || 'RIGHT',
      };
      // GitHub requires `line` always; `start_line` only for multi-line.
      if (typeof c.line === 'number') out.line = c.line;
      if (typeof c.startLine === 'number' && c.startLine !== c.line) {
        out.start_line = c.startLine;
        out.start_side = c.startSide || out.side;
      }
      return out;
    }),
  };

  const cwd = currentRepoPath() || require('os').homedir();
  const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/${number}/reviews`;
  // `spawn` is imported at the top of the file.

  const reviewResult = await new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        // gh often writes JSON errors to stdout on non-zero exit.
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
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
  if (reviewResult.error) return reviewResult;

  // Post any queued issue-comment drafts sequentially. Failures don't roll
  // back the review; surface them as a partial-success warning so the user
  // can retry manually.
  const issueEndpoint = `repos/${baseOwner}/${baseRepo}/issues/${number}/comments`;
  const issueCommentFailures = [];
  for (const draft of issueCommentDrafts) {
    if (!draft.body || !draft.body.trim()) continue;
    const res = await new Promise((resolve) => {
      const proc = spawn('gh', ['api', issueEndpoint, '--method', 'POST', '--input', '-'], {
        cwd,
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
      proc.stdin.write(JSON.stringify({ body: draft.body }));
      proc.stdin.end();
    });
    if (res.error) issueCommentFailures.push(res.error);
  }

  if (issueCommentFailures.length) {
    return {
      ok: true,
      warning: `Review posted, but ${issueCommentFailures.length} follow-up comment(s) failed: ${issueCommentFailures.join('; ')}`,
    };
  }
  return { ok: true };
});
