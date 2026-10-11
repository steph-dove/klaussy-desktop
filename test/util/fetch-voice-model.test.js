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

const CONTENT = { 'a.json': '{"a":1}', 'onnx/b.onnx': 'weights' };
const model = {
  repo: 'org/model',
  revision: 'abc123',
  files: { 'a.json': sha(CONTENT['a.json']), 'onnx/b.onnx': sha(CONTENT['onnx/b.onnx']) },
};

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-model-'));
}

function fakeFetch(overrides = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const rel = url.split('/resolve/abc123/')[1];
    const body = rel in overrides ? overrides[rel] : CONTENT[rel];
    if (body === null) return new Response('nope', { status: 404 });
    return new Response(body);
  };
  return { impl, calls };
}

test('downloads every file from the pinned revision and verifies it', async () => {
  const dest = tmp();
  const { impl, calls } = fakeFetch();
  await fetchModel({ dest, fetchImpl: impl, log: () => {}, model });
  assert.deepEqual(calls.sort(), [
    'https://huggingface.co/org/model/resolve/abc123/a.json',
    'https://huggingface.co/org/model/resolve/abc123/onnx/b.onnx',
  ]);
  assert.equal(fs.readFileSync(path.join(dest, 'onnx/b.onnx'), 'utf8'), 'weights');
  assert.deepEqual(await verifyModel(dest, model), { ok: true, missing: [], bad: [] });
});

test('skips files that already verify', async () => {
  const dest = tmp();
  fs.writeFileSync(path.join(dest, 'a.json'), CONTENT['a.json']);
  const { impl, calls } = fakeFetch();
  await fetchModel({ dest, fetchImpl: impl, log: () => {}, model });
  assert.deepEqual(calls, ['https://huggingface.co/org/model/resolve/abc123/onnx/b.onnx']);
});

test('re-downloads a corrupted file', async () => {
  const dest = tmp();
  fs.writeFileSync(path.join(dest, 'a.json'), 'tampered');
  assert.deepEqual((await verifyModel(dest, model)).bad, ['a.json']);
  const { impl } = fakeFetch();
  await fetchModel({ dest, fetchImpl: impl, log: () => {}, model });
  assert.equal(fs.readFileSync(path.join(dest, 'a.json'), 'utf8'), CONTENT['a.json']);
});

test('a hash mismatch throws and leaves nothing behind', async () => {
  const dest = tmp();
  const { impl } = fakeFetch({ 'a.json': 'evil' });
  await assert.rejects(fetchModel({ dest, fetchImpl: impl, log: () => {}, model }), /a\.json sha256 mismatch/);
  assert.equal(fs.existsSync(path.join(dest, 'a.json')), false);
  assert.equal(fs.existsSync(path.join(dest, 'a.json.part')), false);
});

test('an HTTP error throws', async () => {
  const { impl } = fakeFetch({ 'a.json': null });
  await assert.rejects(fetchModel({ dest: tmp(), fetchImpl: impl, log: () => {}, model }), /HTTP 404/);
});

test('the shipped manifest pins a commit and hashes every file', () => {
  assert.match(realManifest.revision, /^[0-9a-f]{40}$/);
  for (const [rel, hash] of Object.entries(realManifest.files)) {
    assert.match(hash, /^[0-9a-f]{64}$/, rel);
  }
  assert.ok(realManifest.files['onnx/encoder_model_quantized.onnx']);
  assert.ok(realManifest.files['onnx/decoder_model_merged_quantized.onnx']);
});
