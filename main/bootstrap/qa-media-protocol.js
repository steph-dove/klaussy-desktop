// The page CSP blocks file:, and widening it would let renderer-side XSS read
// arbitrary local files, so QA media is served over this scheme and only for
// paths the QA scanner returned.
//
// Must be required before app ready — registerSchemesAsPrivileged is pre-ready.

const path = require('path');
const { protocol, net, app } = require('electron');
const { pathToFileURL } = require('url');

const SCHEME = 'klaussy-qa';

const allowed = new Set();
let registrationError = null;

function allowQaPaths(paths) {
  for (const p of paths || []) {
    if (p) allowed.add(path.resolve(p));
  }
}

function qaMediaUrl(absPath) {
  if (!absPath) return '';
  return SCHEME + '://media/' + Buffer.from(absPath, 'utf8').toString('base64url');
}

// stream: true so <video> range requests work; without it seeking a recording
// re-downloads from zero.
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

app.whenReady().then(() => {
  protocol.handle(SCHEME, async (request) => {
    let target;
    try {
      const encoded = new URL(request.url).pathname.replace(/^\//, '');
      target = Buffer.from(encoded, 'base64url').toString('utf8');
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (!target || !allowed.has(path.resolve(target))) {
      return new Response('not allowed', { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}).catch((err) => {
  registrationError = (err && err.message) || String(err);
  console.error('[qa-media-protocol] scheme registration failed', err);
});

// Non-null once registration failed: nothing the scheme serves will load.
function protocolError() {
  return registrationError;
}

module.exports = { allowQaPaths, qaMediaUrl, protocolError, SCHEME };
