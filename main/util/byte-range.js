// Kept out of the media protocol so it is testable without Electron.

// Parses a Range header against a known size. Returns { start, end } inclusive, or null when the header is unusable and
// the caller should answer 416.
function parseRange(rangeHeader, size) {
  if (!Number.isInteger(size) || size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  // Suffix form ("bytes=-500") asks for the LAST n bytes; players use it to
  // read a trailing moov atom before they will report a duration.
  let start = m[1] ? Number(m[1]) : size - Number(m[2]);
  let end = m[1] ? (m[2] ? Number(m[2]) : size - 1) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (start > end) return null;
  return { start, end };
}

module.exports = { parseRange };
