// Headless `claude -p` runs (pre-commit review, comment cleanup) write transcripts beside the tab's.

const fs = require('fs');

// A headless run's first record holds its whole prompt, pushing the entrypoint far into the file.
const CHUNK_BYTES = 64 * 1024;
const MAX_BYTES = 4 * 1024 * 1024;
const cache = new Map();

function transcriptEntrypoint(file) {
  if (cache.has(file)) return cache.get(file);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(CHUNK_BYTES);
    let tail = '';
    for (let pos = 0; pos < MAX_BYTES;) {
      const len = fs.readSync(fd, buf, 0, CHUNK_BYTES, pos);
      if (len === 0) break;
      pos += len;
      const text = tail + buf.toString('latin1', 0, len);
      const m = text.match(/"entrypoint":"([^"]+)"/);
      if (m) {
        cache.set(file, m[1]);
        return m[1];
      }
      tail = text.slice(-64);
    }
    return null; // not written yet; ask again next time
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isHeadlessTranscript(file) {
  return /^sdk-/.test(transcriptEntrypoint(file) || '');
}

function isInteractiveTranscript(file) {
  const ep = transcriptEntrypoint(file);
  return !!ep && !/^sdk-/.test(ep);
}

module.exports = { isHeadlessTranscript, isInteractiveTranscript };
