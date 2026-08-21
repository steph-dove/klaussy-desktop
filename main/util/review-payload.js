// Helpers for the "submit review" payload. Kept out of the IPC handler so they
// can be unit-tested without stubbing electron.

// A COMMENT review with no inline comments and no summary is one GitHub refuses
// with an opaque 422. APPROVE and REQUEST_CHANGES carry a verdict, so an empty
// body there is still a real review.
function isEmptyReview({ event, comments, body }) {
  return event === 'COMMENT'
    && (!comments || comments.length === 0)
    && !String(body == null ? '' : body).trim();
}

// gh writes its JSON error to stdout on a non-zero exit. Turn that into a
// message worth reading: GitHub's validation errors are often an array of empty
// strings, and appending `: [""]` to the summary only adds noise.
function ghApiErrorMessage(stdout, stderr) {
  const fallback = String(stderr == null ? '' : stderr).trim();
  const raw = String(stdout == null ? '' : stdout).trim();
  if (!raw) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
  if (!parsed || !parsed.message) return fallback;
  const errors = Array.isArray(parsed.errors)
    ? parsed.errors.filter((e) => (typeof e === 'string' ? e.trim() : e != null))
    : parsed.errors;
  const hasDetail = Array.isArray(errors) ? errors.length > 0 : !!errors;
  return parsed.message + (hasDetail ? ': ' + JSON.stringify(errors) : '');
}

module.exports = { isEmptyReview, ghApiErrorMessage };
