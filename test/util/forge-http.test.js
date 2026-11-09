// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// forge-http: 2xx resolves, every other status throws with its status and body.
require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { ForgeHttpError, httpFetch, httpJson, httpText } = require('../../main/util/forge-http');

const realFetch = global.fetch;
function stubFetch(status, body, headers = {}) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return new Response(body, { status, headers });
  };
  return calls;
}
test.afterEach(() => { global.fetch = realFetch; });

test('httpFetch resolves with the response on 2xx', async () => {
  stubFetch(200, 'ok');
  const res = await httpFetch('https://example.test/x');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('httpFetch resolves on 204 No Content', async () => {
  stubFetch(204, null);
  const res = await httpFetch('https://example.test/x', { method: 'DELETE' });
  assert.equal(res.status, 204);
});

for (const status of [400, 403, 404, 500, 503]) {
  test(`httpFetch throws on ${status} with status and body`, async () => {
    stubFetch(status, '{"error":{"message":"nope"}}', { 'content-type': 'application/json' });
    await assert.rejects(httpFetch('https://example.test/x', { method: 'POST' }), (err) => {
      assert.ok(err instanceof ForgeHttpError);
      assert.equal(err.status, status);
      assert.equal(err.statusCode, status);
      assert.equal(err.responseBody, '{"error":{"message":"nope"}}');
      assert.match(err.message, new RegExp(`HTTP ${status}`));
      return true;
    });
  });
}

test('httpFetch keeps a non-JSON error body as text', async () => {
  stubFetch(502, '<html>Bad Gateway</html>', { 'content-type': 'text/html' });
  await assert.rejects(httpFetch('https://example.test/x'), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.responseBody, '<html>Bad Gateway</html>');
    return true;
  });
});

test('httpFetch falls back to statusText when the error body is empty', async () => {
  global.fetch = async () => new Response('', { status: 401, statusText: 'Unauthorized' });
  await assert.rejects(httpFetch('https://example.test/x'), (err) => {
    assert.equal(err.responseBody, '');
    assert.equal(err.message, 'HTTP 401: Unauthorized');
    return true;
  });
});

test('httpJson parses a 2xx JSON body and asks for JSON', async () => {
  const calls = stubFetch(200, '{"a":1}', { 'content-type': 'application/json' });
  assert.deepEqual(await httpJson('https://example.test/x'), { a: 1 });
  assert.equal(calls[0].opts.headers.Accept, 'application/json');
});

test('httpJson throws on a 203 reply', async () => {
  stubFetch(203, '{"a":1}', { 'content-type': 'application/json' });
  await assert.rejects(httpJson('https://example.test/x'), (err) => {
    assert.ok(err instanceof ForgeHttpError);
    assert.equal(err.status, 203);
    return true;
  });
});

test('httpJson throws on a 200 HTML sign-in page', async () => {
  stubFetch(200, '<html>Sign in</html>', { 'content-type': 'text/html; charset=utf-8' });
  await assert.rejects(httpJson('https://example.test/x'), (err) => {
    assert.equal(err.status, 200);
    assert.equal(err.responseBody, '<html>Sign in</html>');
    return true;
  });
});

test('httpJson throws on 4xx before parsing', async () => {
  stubFetch(404, 'not found');
  await assert.rejects(httpJson('https://example.test/x'), (err) => err.status === 404);
});

test('httpText returns the body on 2xx and throws on 5xx', async () => {
  stubFetch(200, 'diff --git a b');
  assert.equal(await httpText('https://example.test/x'), 'diff --git a b');
  stubFetch(500, 'boom');
  await assert.rejects(httpText('https://example.test/x'), (err) => err.status === 500 && err.responseBody === 'boom');
});
