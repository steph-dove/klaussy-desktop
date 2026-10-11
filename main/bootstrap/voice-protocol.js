// Serves only manifest-listed model files and ORT WASM, by exact lookup, because the page CSP blocks file: and https:.

const fs = require('fs');
const path = require('path');
const { protocol, session, app } = require('electron');
const manifest = require('../util/voice-model.json');

const SCHEME = 'klaussy-voice';
const PRIVILEGED = {
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
};
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];
const CONTENT_TYPES = {
  '.json': 'application/json',
  '.onnx': 'application/octet-stream',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
};

function voiceDirs() {
  return {
    modelDir: app.isPackaged
      ? path.join(process.resourcesPath, 'voice-model')
      : path.join(app.getAppPath(), 'vendor', 'voice-model'),
    ortDir: path.join(app.getAppPath(), 'node_modules', 'onnxruntime-web', 'dist'),
  };
}

function resolveVoicePath(url, { modelDir, ortDir }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== SCHEME + ':') return null;
  const prefix = '/' + manifest.repo + '/';
  if (parsed.host === 'model' && parsed.pathname.startsWith(prefix)) {
    const rel = parsed.pathname.slice(prefix.length);
    return Object.hasOwn(manifest.files, rel) ? path.join(modelDir, ...rel.split('/')) : null;
  }
  if (parsed.host === 'ort') {
    const name = parsed.pathname.slice(1);
    return ORT_FILES.includes(name) ? path.join(ortDir, name) : null;
  }
  return null;
}

// First manifest file not on disk, or null when the model is complete.
function modelMissing(modelDir = voiceDirs().modelDir) {
  return Object.keys(manifest.files).find((rel) => !fs.existsSync(path.join(modelDir, rel))) || null;
}

// Electron grants every permission when no handler is set; keep that for
// everything but media, and allow the mic only to the app's own pages.
function decideMediaPermission(permission, details = {}) {
  if (permission !== 'media') return true;
  const url = String(details.requestingUrl || details.securityOrigin || '');
  const types = details.mediaTypes || [];
  return url.startsWith('file://') && types.length > 0 && types.every((t) => t === 'audio');
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(decideMediaPermission(permission, details));
  });
  protocol.handle(SCHEME, async (request) => {
    const target = resolveVoicePath(request.url, voiceDirs());
    if (!target) return new Response('not found', { status: 404 });
    try {
      const body = await fs.promises.readFile(target);
      return new Response(body, {
        headers: {
          'Content-Type': CONTENT_TYPES[path.extname(target)] || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return new Response('voice model not installed', { status: 404 });
    }
  });
}).catch((err) => {
  console.error('[voice-protocol] scheme registration failed', err);
});

module.exports = { SCHEME, PRIVILEGED, resolveVoicePath, modelMissing, decideMediaPermission, voiceDirs };
