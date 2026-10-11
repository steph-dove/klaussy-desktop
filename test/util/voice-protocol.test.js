const { privilegedSchemeCalls } = require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveVoicePath, modelMissing, decideMediaPermission } = require('../../main/bootstrap/voice-protocol');
const { SCHEMES } = require('../../main/bootstrap/privileged-schemes');
const manifest = require('../../main/util/voice-model.json');

const dirs = { modelDir: '/models', ortDir: '/ort' };
const base = `klaussy-voice://model/${manifest.repo}/`;

test('every privileged scheme is registered in a single call', () => {
  assert.equal(privilegedSchemeCalls.length, 1);
  assert.deepEqual(privilegedSchemeCalls[0].map((s) => s.scheme), ['klaussy-qa', 'klaussy-voice']);
  assert.equal(privilegedSchemeCalls[0], SCHEMES);
  assert.equal(SCHEMES[0].privileges.stream, true);
});

test('manifest files resolve inside the model dir', () => {
  assert.equal(
    resolveVoicePath(base + 'onnx/encoder_model_quantized.onnx', dirs),
    path.join('/models', 'onnx', 'encoder_model_quantized.onnx'),
  );
  assert.equal(resolveVoicePath(base + 'config.json', dirs), path.join('/models', 'config.json'));
});

test('only the ORT asyncify pair is served from the ort host', () => {
  assert.equal(
    resolveVoicePath('klaussy-voice://ort/ort-wasm-simd-threaded.asyncify.wasm', dirs),
    path.join('/ort', 'ort-wasm-simd-threaded.asyncify.wasm'),
  );
  assert.equal(resolveVoicePath('klaussy-voice://ort/ort.min.js', dirs), null);
});

test('traversal and unknown paths are refused', () => {
  for (const url of [
    base + '../../../etc/passwd',
    base + '%2e%2e/%2e%2e/etc/passwd',
    base + '..%2f..%2fetc%2fpasswd',
    base + 'onnx\\..\\..\\secret',
    base + 'onnx/model.onnx',
    'klaussy-voice://model/other/repo/config.json',
    'klaussy-voice://ort/../package.json',
    'klaussy-voice://evil/config.json',
    'klaussy-qa://model/' + manifest.repo + '/config.json',
    'not a url',
  ]) {
    assert.equal(resolveVoicePath(url, dirs), null, url);
  }
});

test('modelMissing names the first absent file, null when complete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-dir-'));
  assert.equal(modelMissing(dir), Object.keys(manifest.files)[0]);
  for (const rel of Object.keys(manifest.files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '');
  }
  assert.equal(modelMissing(dir), null);
});

test('mic is allowed only for app pages asking for audio alone', () => {
  assert.equal(decideMediaPermission('media', { requestingUrl: 'file:///app/index.html', mediaTypes: ['audio'] }), true);
  assert.equal(decideMediaPermission('media', { requestingUrl: 'file:///app/index.html', mediaTypes: ['video'] }), false);
  assert.equal(decideMediaPermission('media', { requestingUrl: 'file:///app/index.html', mediaTypes: ['audio', 'video'] }), false);
  assert.equal(decideMediaPermission('media', { requestingUrl: 'file:///app/index.html', mediaTypes: [] }), false);
  assert.equal(decideMediaPermission('media', { requestingUrl: 'https://example.com', mediaTypes: ['audio'] }), false);
  assert.equal(decideMediaPermission('media', {}), false);
});

test('non-media permissions keep the default grant', () => {
  for (const p of ['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen']) {
    assert.equal(decideMediaPermission(p, { requestingUrl: 'file:///app/index.html' }), true, p);
  }
});
