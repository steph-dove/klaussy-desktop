// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Review history is a local snapshot, so revoked repos' PRs would otherwise stay listed forever.

const { parseForgeUrl } = require('./forge-url');

// GitHub answers 404 for a repo the token can't see; anything but a unanimous 404 is unknown.
async function probeRepoAccess(owner, repo, tokens, fetchFn = fetch) {
  if (!tokens.length) return 'unknown';
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const statusFor = async (token) => {
    try {
      const res = await fetchFn(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'klaussy-desktop',
        },
      });
      return res.status;
    } catch {
      return null;
    }
  };
  // Accounts are asked at once; the first 200 answers without waiting on the rest.
  return new Promise((resolve) => {
    let left = tokens.length;
    let allGone = true;
    for (const token of tokens) {
      statusFor(token).then((status) => {
        if (status === 200) return resolve('ok');
        if (status !== 404) allGone = false;
        if (--left === 0) resolve(allGone ? 'gone' : 'unknown');
      });
    }
  });
}

// Definite verdicts are reused for ttlMs so opening the picker doesn't probe every time; 'unknown' is asked again.
function cachedProbe(probe, ttlMs, now = Date.now) {
  const cache = new Map();
  return async (owner, repo, ...rest) => {
    const key = owner + '/' + repo;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.verdict;
    const verdict = await probe(owner, repo, ...rest);
    if (verdict === 'unknown') cache.delete(key);
    else cache.set(key, { verdict, at: now() });
    return verdict;
  };
}

function withoutUrls(history, urls) {
  const drop = new Set(urls);
  return (history || []).filter((e) => !drop.has(e.url));
}

async function pruneUnreachableHistory(items, probe) {
  const verdicts = new Map();
  for (const it of items) {
    const p = parseForgeUrl(it.url);
    if (!p || p.forge !== 'github' || p.host !== 'github.com') continue;
    const key = p.owner + '/' + p.repo;
    if (!verdicts.has(key)) verdicts.set(key, probe(p.owner, p.repo));
  }
  const settled = new Map();
  for (const [key, pending] of verdicts) settled.set(key, await pending);
  const kept = items.filter((it) => {
    const p = parseForgeUrl(it.url);
    if (!p || p.forge !== 'github' || p.host !== 'github.com') return true;
    return settled.get(p.owner + '/' + p.repo) !== 'gone';
  });
  const keptSet = new Set(kept);
  return { items: kept, removed: items.length - kept.length, dropped: items.filter((it) => !keptSet.has(it)).map((it) => it.url) };
}

module.exports = { probeRepoAccess, pruneUnreachableHistory, cachedProbe, withoutUrls };
