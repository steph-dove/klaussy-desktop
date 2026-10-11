// wasmPaths must point at klaussy-voice:, or the library pulls ORT from a CDN.

import { pipeline, env } from '../node_modules/@huggingface/transformers/dist/transformers.min.js';

const MODEL = 'onnx-community/moonshine-base-ONNX';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'klaussy-voice://model/';
env.useBrowserCache = false;
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: 'klaussy-voice://ort/ort-wasm-simd-threaded.asyncify.mjs',
  wasm: 'klaussy-voice://ort/ort-wasm-simd-threaded.asyncify.wasm',
};
// file:// pages aren't cross-origin isolated, so there is no SharedArrayBuffer.
env.backends.onnx.wasm.numThreads = 1;

let transcriber = null;

function load() {
  if (!transcriber) {
    transcriber = pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8', device: 'wasm' });
    transcriber.catch(() => { transcriber = null; });
  }
  return transcriber;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      await load();
      self.postMessage({ type: 'ready', id: data.id });
    } else if (data.type === 'transcribe') {
      const asr = await load();
      const out = await asr(data.audio);
      self.postMessage({ type: 'result', id: data.id, text: (out && out.text) || '' });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, error: (err && err.message) || String(err) });
  }
};
