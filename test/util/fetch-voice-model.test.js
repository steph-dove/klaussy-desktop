require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fetchModel, verifyModel } = require('../../scripts/fetch-voice-model');
const realManifest = require('../../main/util/voice-model.json');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const CONTENT = { 'a.json': '{"a":1}', 'onnx/b.onnx': 'weights', 'rt.wasm': 'wasm-bytes' };
const RT_URL = 'https://cdn.example/pkg@1.0.0/dist/rt.wasm';
const model = {
  repo: 'org/model',
  revision: 'abc123',
  files: { 'a.json': sha(CONTENT['a.json']), 'onnx/b.onnx': sha(CONTENT['onnx/b.onnx']) },
  runtime: { 'rt.wasm': { url: RT_URL, sha256: sha(CONTENT['rt.wasm']) } },
};
const quick = { log: () => {}, model, delays: [1, 1], sleep: () => Promise.resolve() };

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-model-'));
}

function fakeFetch(overrides = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const rel = url === RT_URL ? 'rt.wasm' : url.split('/resolve/abc123/')[1];
    let body = rel in overrides ? overrides[rel] : CONTENT[rel];
    if (typeof body === 'function') body = body();
    if (typeof body === 'number') return new Response('nope', { status: body });
    return new Response(body);
  };
  return { impl, calls };
}

test('downloads every model and runtime file from its pinned URL and verifies it', async () => {
  const dest = tmp();
  const { impl, calls } = fakeFetch();
  await fetchModel({ dest, fetchImpl: impl, ...quick });
  assert.deepEqual(calls.sort(), [
    RT_URL,
    'https://huggingface.co/org/model/resolve/abc123/a.json',
    'https://huggingface.co/org/model/resolve/abc123/onnx/b.onnx',
  ]);
  assert.equal(fs.readFileSync(path.join(dest, 'onnx/b.onnx'), 'utf8'), 'weights');
  assert.equal(fs.readFileSync(path.join(dest, 'runtime/rt.wasm'), 'utf8'), 'wasm-bytes');
  assert.deepEqual(await verifyModel(dest, model), { ok: true, missing: [], bad: [] });
});

test('skips files that already verify', async () => {
  const dest = tmp();
  fs.writeFileSync(path.join(dest, 'a.json'), CONTENT['a.json']);
  const { impl, calls } = fakeFetch();
  await fetchModel({ dest, fetchImpl: impl, ...quick });
  assert.deepEqual(calls, ['https://huggingface.co/org/model/resolve/abc123/onnx/b.onnx', RT_URL]);
});

test('re-downloads a corrupted file', async () => {
  const dest = tmp();
  fs.writeFileSync(path.join(dest, 'a.json'), 'tampered');
  assert.deepEqual((await verifyModel(dest, model)).bad, ['a.json']);
  const { impl } = fakeFetch();
  await fetchModel({ dest, fetchImpl: impl, ...quick });
  assert.equal(fs.readFileSync(path.join(dest, 'a.json'), 'utf8'), CONTENT['a.json']);
});

test('a hash mismatch throws and leaves nothing behind', async () => {
  const dest = tmp();
  const { impl } = fakeFetch({ 'a.json': 'evil' });
  await assert.rejects(fetchModel({ dest, fetchImpl: impl, ...quick }), /a\.json sha256 mismatch/);
  assert.equal(fs.existsSync(path.join(dest, 'a.json')), false);
  assert.equal(fs.existsSync(path.join(dest, 'a.json.part')), false);
});

test('a 404 fails at once without retrying', async () => {
  const { impl, calls } = fakeFetch({ 'a.json': 404 });
  await assert.rejects(fetchModel({ dest: tmp(), fetchImpl: impl, ...quick }), /a\.json download failed \(HTTP 404\)/);
  assert.equal(calls.filter((u) => u.endsWith('a.json')).length, 1);
});

test('a 503 or a dropped connection is retried', async () => {
  let n = 0;
  const flaky = () => { n++; if (n === 1) return 503; if (n === 2) throw new TypeError('fetch failed'); return CONTENT['a.json']; };
  const { impl, calls } = fakeFetch({ 'a.json': flaky });
  const dest = tmp();
  await fetchModel({ dest, fetchImpl: impl, ...quick });
  assert.equal(calls.filter((u) => u.endsWith('a.json')).length, 3);
  assert.equal(fs.readFileSync(path.join(dest, 'a.json'), 'utf8'), CONTENT['a.json']);
});

test('gives up after the last retry', async () => {
  const { impl, calls } = fakeFetch({ 'a.json': 502 });
  await assert.rejects(fetchModel({ dest: tmp(), fetchImpl: impl, ...quick }), /HTTP 502/);
  assert.equal(calls.filter((u) => u.endsWith('a.json')).length, 3);
});

test('the shipped manifest pins a commit and hashes every file', () => {
  assert.match(realManifest.revision, /^[0-9a-f]{40}$/);
  for (const [rel, hash] of Object.entries(realManifest.files)) {
    assert.match(hash, /^[0-9a-f]{64}$/, rel);
  }
  assert.ok(realManifest.files['onnx/encoder_model_quantized.onnx']);
  assert.ok(realManifest.files['onnx/decoder_model_merged_quantized.onnx']);
  for (const [name, { url, sha256 }] of Object.entries(realManifest.runtime)) {
    assert.match(url, /^https:\/\/cdn\.jsdelivr\.net\/npm\/(@[^/]+\/)?[^/@]+@\d[^/]*\/dist\//, name);
    assert.ok(url.endsWith('/' + name), name);
    assert.match(sha256, /^[0-9a-f]{64}$/, name);
  }
});
