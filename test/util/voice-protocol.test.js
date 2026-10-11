const { privilegedSchemeCalls } = require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveVoicePath, modelMissing } = require('../../main/bootstrap/voice-protocol');
const { SCHEMES } = require('../../main/bootstrap/privileged-schemes');
const manifest = require('../../main/util/voice-model.json');

const dir = '/voice';
const base = 'klaussy-voice://model/bundled/';

test('every privileged scheme is registered in a single call', () => {
  assert.equal(privilegedSchemeCalls.length, 1);
  assert.deepEqual(privilegedSchemeCalls[0].map((s) => s.scheme), ['klaussy-qa', 'klaussy-voice']);
  assert.equal(privilegedSchemeCalls[0], SCHEMES);
  assert.equal(SCHEMES[0].privileges.stream, true);
});

test('manifest files resolve inside the model dir', () => {
  assert.equal(
    resolveVoicePath(base + 'onnx/encoder_model_quantized.onnx', dir),
    path.join('/voice', 'onnx', 'encoder_model_quantized.onnx'),
  );
  assert.equal(resolveVoicePath(base + 'config.json', dir), path.join('/voice', 'config.json'));
});

test('only manifest runtime files are served from the runtime host', () => {
  assert.equal(
    resolveVoicePath('klaussy-voice://runtime/ort-wasm-simd-threaded.asyncify.wasm', dir),
    path.join('/voice', 'runtime', 'ort-wasm-simd-threaded.asyncify.wasm'),
  );
  assert.equal(
    resolveVoicePath('klaussy-voice://runtime/transformers.min.js', dir),
    path.join('/voice', 'runtime', 'transformers.min.js'),
  );
  assert.equal(resolveVoicePath('klaussy-voice://runtime/ort.min.js', dir), null);
});

test('traversal and unknown paths are refused', () => {
  for (const url of [
    base + '../../../etc/passwd',
    base + '%2e%2e/%2e%2e/etc/passwd',
    base + '..%2f..%2fetc%2fpasswd',
    base + 'onnx\\..\\..\\secret',
    base + 'onnx/model.onnx',
    'klaussy-voice://model/other/repo/config.json',
    'klaussy-voice://runtime/../package.json',
    'klaussy-voice://runtime/%2e%2e/config.json',
    base + 'runtime/transformers.min.js',
    'klaussy-voice://model/' + manifest.repo + '/config.json',
    'klaussy-voice://evil/config.json',
    'klaussy-qa://model/bundled/config.json',
    'not a url',
  ]) {
    assert.equal(resolveVoicePath(url, dir), null, url);
  }
});

test('modelMissing names the first absent file, including the runtime, null when complete', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-dir-'));
  assert.equal(modelMissing(tmp), Object.keys(manifest.files)[0]);
  for (const rel of Object.keys(manifest.files)) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), '');
  }
  assert.equal(modelMissing(tmp), 'runtime/transformers.min.js');
  fs.mkdirSync(path.join(tmp, 'runtime'));
  for (const name of Object.keys(manifest.runtime)) fs.writeFileSync(path.join(tmp, 'runtime', name), '');
  assert.equal(modelMissing(tmp), null);
});
