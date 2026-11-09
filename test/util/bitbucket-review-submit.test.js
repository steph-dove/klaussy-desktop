// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Bitbucket review submission against a stubbed fetch: the inline-to-general fallback and failed writes.
require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const bitbucket = require('../../main/util/forges/bitbucket');
const { clearBitbucketAuthCache } = require('../../main/util/bitbucket-api');
const { loadConfig, saveConfig, flushSaveConfig } = require('../../main/util/config');

const pr = {
  number: 5, host: 'bitbucket.org', projectPath: 'ws/repo', baseOwner: 'ws', baseRepo: 'repo', account: 'bbuser',
};

// `respond(url, body)` returns [status, responseBody] for each request.
async function withFetch(respond, fn) {
  const initialConfig = loadConfig();
  const realFetch = global.fetch;
  const calls = [];
  try {
    saveConfig({ bitbucketAccounts: [{ username: 'bbuser', appPassword: 'pw', active: true }] });
    await flushSaveConfig();
    clearBitbucketAuthCache();
    global.fetch = async (url, opts) => {
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ url, method: opts.method, body });
      const [status, text] = respond(url, body);
      return new Response(text, { status, headers: { 'content-type': 'application/json' } });
    };
    await fn(calls);
  } finally {
    global.fetch = realFetch;
    saveConfig(initialConfig);
    await flushSaveConfig();
    clearBitbucketAuthCache();
  }
}

const inline = { path: 'src/a.js', line: 3, side: 'RIGHT', body: 'Off by one.', humanized: true };

test('a rejected inline comment is reposted as a general comment, then the vote', async () => {
  await withFetch((url, body) => {
    if (body && body.inline) return [400, '{"type":"error","error":{"message":"line is not part of the diff"}}'];
    return [201, '{}'];
  }, async (calls) => {
    const res = await bitbucket.submitReview(pr, {
      event: 'APPROVE', body: '', inlineComments: [inline], issueCommentDrafts: [], cwd: process.cwd(),
    });
    assert.deepEqual(res, { ok: true });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].body.inline, { path: 'src/a.js', to: 3 });
    assert.equal(calls[1].url, 'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/5/comments');
    assert.equal(calls[1].body.inline, undefined);
    assert.equal(calls[1].body.content.raw, '**[src/a.js:3]**\n\nOff by one.');
    assert.equal(calls[2].url, 'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/5/approve');
  });
});

test('a LEFT-side inline comment anchors with from', async () => {
  await withFetch(() => [201, '{}'], async (calls) => {
    await bitbucket.submitReview(pr, {
      event: 'COMMENT', body: '', inlineComments: [{ ...inline, side: 'LEFT' }], issueCommentDrafts: [], cwd: process.cwd(),
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.inline, { path: 'src/a.js', from: 3 });
  });
});

test('when every write is refused, nothing is reported as posted', async () => {
  await withFetch(() => [403, '{"type":"error","error":{"message":"Forbidden"}}'], async (calls) => {
    const res = await bitbucket.submitReview(pr, {
      event: 'REQUEST_CHANGES',
      body: '',
      inlineComments: [inline],
      issueCommentDrafts: [{ body: 'Follow-up.', humanized: true, issueComment: true }],
      cwd: process.cwd(),
    });
    assert.equal(res.ok, undefined);
    assert.match(res.error, /^Nothing was posted: /);
    assert.match(res.error, /Bitbucket API error \(HTTP 403\): Forbidden/);
    assert.equal(calls.at(-1).url, 'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/5/request-changes');
  });
});

test('a refused vote after posted comments is a warning', async () => {
  await withFetch((url) => (url.endsWith('/approve') ? [409, '{"error":{"message":"already approved"}}'] : [201, '{}']), async () => {
    const res = await bitbucket.submitReview(pr, {
      event: 'APPROVE', body: '', inlineComments: [inline], issueCommentDrafts: [], cwd: process.cwd(),
    });
    assert.equal(res.ok, true);
    assert.match(res.warning, /already approved/);
  });
});

test('other Bitbucket writes report a refusal instead of success', async () => {
  await withFetch(() => [403, '{"error":{"message":"Forbidden"}}'], async () => {
    const cwd = process.cwd();
    assert.deepEqual(await bitbucket.addIssueComment(pr, { body: 'hi', cwd }), { error: 'Forbidden' });
    assert.deepEqual(await bitbucket.editComment(pr, { id: 1, body: 'hi', cwd }), { error: 'Forbidden' });
    assert.deepEqual(await bitbucket.reply(pr, { inReplyTo: '1', body: 'hi', cwd }), { error: 'Forbidden' });
    assert.deepEqual(await bitbucket.resolveThread(pr, { threadId: 1, resolve: true, cwd }), { error: 'Forbidden' });
    assert.deepEqual(await bitbucket.merge(pr, { strategy: 'squash' }), { error: 'Bitbucket API error (HTTP 403): Forbidden' });
  });
});
