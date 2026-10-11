// Serves only manifest-listed files by exact lookup (never joining the request path), since the page CSP blocks file: and https:.

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { protocol, app } = require('electron');
const manifest = require('../util/voice-model.json');
const { voiceFiles } = require('../util/voice-files');

const SCHEME = 'klaussy-voice';
// The model name voice-worker.js asks for; kept fixed so a model bump only touches the manifest.
const MODEL_ID = 'bundled';
const PRIVILEGED = {
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
};
const CONTENT_TYPES = {
  '.json': 'application/json',
  '.onnx': 'application/octet-stream',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
};

function voiceDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'voice-model')
    : path.join(app.getAppPath(), 'vendor', 'voice-model');
}

function resolveVoicePath(url, dir) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== SCHEME + ':') return null;
  const prefix = '/' + MODEL_ID + '/';
  if (parsed.host === 'model' && parsed.pathname.startsWith(prefix)) {
    const rel = parsed.pathname.slice(prefix.length);
    return Object.hasOwn(manifest.files, rel) ? path.join(dir, ...rel.split('/')) : null;
  }
  if (parsed.host === 'runtime') {
    const name = parsed.pathname.slice(1);
    return Object.hasOwn(manifest.runtime, name) ? path.join(dir, 'runtime', name) : null;
  }
  return null;
}

function modelMissing(dir = voiceDir()) {
  const missing = voiceFiles().find(({ rel }) => !fs.existsSync(path.join(dir, rel)));
  return missing ? missing.rel : null;
}

app.whenReady().then(() => {
  protocol.handle(SCHEME, async (request) => {
    const target = resolveVoicePath(request.url, voiceDir());
    if (!target) return new Response('not found', { status: 404 });
    let size;
    try {
      ({ size } = await fs.promises.stat(target));
    } catch {
      return new Response('voice model not installed', { status: 404 });
    }
    // Streamed: the decoder and the WASM are tens of MB each.
    return new Response(Readable.toWeb(fs.createReadStream(target)), {
      headers: {
        'Content-Type': CONTENT_TYPES[path.extname(target)] || 'application/octet-stream',
        'Content-Length': String(size),
        'Access-Control-Allow-Origin': '*',
      },
    });
  });
}).catch((err) => {
  console.error('[voice-protocol] scheme registration failed', err);
});

module.exports = { SCHEME, PRIVILEGED, resolveVoicePath, modelMissing };
