require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const nemesis = require('../../main/util/nemesis-events');
const { EVENT_TYPES } = nemesis;

test('normalize rejects junk and unknown types', () => {
  assert.equal(nemesis.normalize(null), null);
  assert.equal(nemesis.normalize({}), null);
  assert.equal(nemesis.normalize({ type: 'agent:teleported' }), null);
});

test('normalize coerces a valid event into the stable shape', () => {
  const out = nemesis.normalize({
    type: EVENT_TYPES.COMPLETED,
    containerId: 42, // number coerced to string
    workspacePath: '/w',
    exitCode: 0,
  });
  assert.equal(out.type, EVENT_TYPES.COMPLETED);
  assert.equal(out.containerId, '42');
  assert.equal(out.workspacePath, '/w');
  assert.equal(out.exitCode, 0);
  assert.equal(out.tool, '');
});

test('subscribe receives published events and unsubscribe stops them', () => {
  const seen = [];
  const off = nemesis.subscribe((e) => seen.push(e));

  const published = nemesis.publish({
    type: EVENT_TYPES.APPROVAL_REQUIRED,
    containerId: '1',
    tool: 'shell-exec',
  });
  assert.ok(published, 'publish returned the normalized event');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, 'shell-exec');

  off();
  nemesis.publish({ type: EVENT_TYPES.COMPLETED, containerId: '1' });
  assert.equal(seen.length, 1, 'no delivery after unsubscribe');
});

test('publish of an invalid event returns null and notifies no one', () => {
  const seen = [];
  const off = nemesis.subscribe((e) => seen.push(e));
  assert.equal(nemesis.publish({ type: 'nope' }), null);
  assert.equal(seen.length, 0);
  off();
});

test('a throwing subscriber does not break publish for others', () => {
  const seen = [];
  const offBad = nemesis.subscribe(() => { throw new Error('subscriber blew up'); });
  const offGood = nemesis.subscribe((e) => seen.push(e));
  assert.doesNotThrow(() => nemesis.publish({ type: EVENT_TYPES.COMPLETED, containerId: '9' }));
  // The good subscriber registered after the bad one still ran despite the throw.
  offBad();
  offGood();
});

test('connect() consumes an SSE stream and republishes events', async () => {
  // Stand up a tiny SSE server that emits one lifecycle event, mimicking a real
  // Nemesis8 endpoint, and assert the client turns it into a bus event.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({
      type: EVENT_TYPES.FAILED, containerId: 'sse-1', exitCode: 2,
    }) + '\n\n');
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  let conn;
  try {
    const got = await new Promise((resolve) => {
      const off = nemesis.subscribe((e) => {
        if (e.containerId === 'sse-1') { off(); resolve(e); }
      });
      conn = nemesis.connect({ url });
    });
    assert.equal(got.type, EVENT_TYPES.FAILED);
    assert.equal(got.exitCode, 2);
  } finally {
    // Close the SSE connection FIRST — server.close() only completes once the
    // open connection is gone, so leaving it open would deadlock teardown.
    if (conn) conn.close();
    await new Promise((r) => server.close(r));
  }
});

test('connect() with no url is a harmless no-op handle', () => {
  const h = nemesis.connect({});
  assert.equal(typeof h.close, 'function');
  assert.doesNotThrow(() => h.close());
});
