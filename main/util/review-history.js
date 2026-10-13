// Review history is a local snapshot, so revoked repos' PRs would otherwise stay listed forever.

const { parseForgeUrl } = require('./forge-url');

// GitHub answers 404 for a repo the token can't see; anything but a unanimous 404 is unknown.
async function probeRepoAccess(owner, repo, tokens, fetchFn = fetch) {
  if (!tokens.length) return 'unknown';
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let allGone = true;
  for (const token of tokens) {
    let status;
    try {
      const res = await fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'klaussy-desktop',
        },
      });
      status = res.status;
    } catch {
      status = null;
    }
    if (status === 200) return 'ok';
    if (status !== 404) allGone = false;
  }
  return allGone ? 'gone' : 'unknown';
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
  return { items: kept, removed: items.length - kept.length };
}

module.exports = { probeRepoAccess, pruneUnreachableHistory };
