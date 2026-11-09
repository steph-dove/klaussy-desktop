// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// fetch() wrappers for forge REST APIs that turn every non-2xx reply into a thrown ForgeHttpError.

class ForgeHttpError extends Error {
  constructor(message, { status, statusText, responseBody } = {}) {
    super(message);
    this.name = 'ForgeHttpError';
    this.status = status;
    this.statusCode = status;
    this.statusText = statusText || '';
    this.responseBody = responseBody || '';
  }
}

// fetch() resolves on 4xx/5xx, so a caller that only awaits it reports a
// rejected write as a success. Read the body here so the error can carry it.
async function httpFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_) { /* body unreadable; statusText still identifies it */ }
    throw new ForgeHttpError(`HTTP ${res.status}: ${body || res.statusText}`, {
      status: res.status, statusText: res.statusText, responseBody: body,
    });
  }
  return res;
}

// Some servers answer an expired or missing credential with a 203 or a 200
// sign-in page instead of a 401, which would otherwise surface as a JSON parse error.
async function httpJson(url, opts = {}) {
  const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
  const res = await httpFetch(url, Object.assign({}, opts, { headers }));
  const type = (res.headers && res.headers.get('content-type')) || '';
  if (res.status === 203 || /text\/html/i.test(type)) {
    let body = '';
    try { body = await res.text(); } catch (_) { /* reported by status alone */ }
    throw new ForgeHttpError(`HTTP ${res.status}: expected JSON but got ${type || 'no content type'}`, {
      status: res.status, statusText: res.statusText, responseBody: body,
    });
  }
  return res.json();
}

async function httpText(url, opts = {}) {
  const res = await httpFetch(url, opts);
  return res.text();
}

module.exports = { ForgeHttpError, httpFetch, httpJson, httpText };
