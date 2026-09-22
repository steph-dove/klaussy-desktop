// The page CSP blocks file:, and widening it would let renderer-side XSS read
// arbitrary local files, so QA media is served over this scheme and only for
// paths the QA scanner returned.
//
// Must be required before app ready — registerSchemesAsPrivileged is pre-ready.

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { protocol, net, app } = require('electron');
const { pathToFileURL } = require('url');
const { parseRange } = require('../util/byte-range');

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

// net.fetch on a file: URL always returns the whole file, so a seek has to be
// served by hand: 206 plus Content-Range, or the element cannot scrub.
const MEDIA_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

function rangeResponse(target, rangeHeader) {
  const size = fs.statSync(target).size;
  const span = parseRange(rangeHeader, size);
  if (!span) {
    return new Response('bad range', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const { start, end } = span;
  const type = MEDIA_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
  return new Response(Readable.toWeb(fs.createReadStream(target, { start, end })), {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

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
    // QA media lives in Downloads and tmp, which get cleaned up between the
    // scan and the render; a rejection here would just be a broken tile.
    try {
      const range = request.headers.get('range');
      if (range) return rangeResponse(target, range);
      // Accept-Ranges is what tells <video> it may seek at all; without it the
      // player treats the source as unseekable and the scrubber does nothing.
      const res = await net.fetch(pathToFileURL(target).toString());
      const headers = new Headers(res.headers);
      headers.set('Accept-Ranges', 'bytes');
      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      return new Response('unavailable: ' + ((err && err.message) || String(err)), { status: 404 });
    }
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
