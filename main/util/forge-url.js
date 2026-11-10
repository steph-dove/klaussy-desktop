// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Parse and normalize PR/MR URLs and git remotes across GitHub, GitLab, and Bitbucket.

function stripGitSuffix(s) {
  return String(s || '').replace(/\.git$/, '');
}

function decodeSegment(s) {
  try { return decodeURIComponent(s); } catch (_) { return s; }
}

const AZURE_SERVICES_HOST = 'dev.azure.com';

// Every Services spelling (dev.azure.com, {org}.visualstudio.com, SSH hosts) maps to dev.azure.com/{org}.
// projectPath/owner/repo are lowercased (Azure is case-insensitive) so matching and cache keys agree.
function azureInfo({ scheme, host, collection, project, repo }) {
  const lowerHost = host.toLowerCase();
  let org = null;
  const vs = lowerHost.match(/^([^.]+)\.visualstudio\.com$/);
  if (vs) {
    org = vs[1];
    if (collection.length && collection[0].toLowerCase() === 'defaultcollection') collection = collection.slice(1);
    if (collection.length) return null;
  } else if (lowerHost === AZURE_SERVICES_HOST) {
    if (collection.length !== 1) return null;
    org = collection[0];
  } else if (!collection.length) {
    return null;
  }
  const services = org !== null;
  const collectionPath = services ? org : collection.join('/');
  const canonicalHost = services ? AZURE_SERVICES_HOST : lowerHost;
  const collectionUrl = services
    ? `https://${AZURE_SERVICES_HOST}/${encodeURIComponent(org)}`
    : `${scheme}://${host}/${collection.map(encodeURIComponent).join('/')}`;
  const owner = `${collectionPath}/${project}`.toLowerCase();
  return {
    forge: 'azure',
    host: canonicalHost,
    collectionUrl,
    collectionPath: collectionPath.toLowerCase(),
    project,
    repoName: repo,
    projectPath: `${owner}/${repo.toLowerCase()}`,
    owner,
    repo: repo.toLowerCase(),
  };
}

// Path segments before "_git": the collection (org on Services) and then the
// project. A repo named after its project can drop the project segment.
function splitAzurePath(beforeGit, repo, host) {
  const segs = beforeGit.filter(Boolean).map(decodeSegment);
  let collectionOnly;
  if (/\.visualstudio\.com$/i.test(host)) {
    collectionOnly = segs.length === 0 || (segs.length === 1 && /^defaultcollection$/i.test(segs[0]));
  } else {
    collectionOnly = segs.length === 1;
  }
  return collectionOnly
    ? { collection: segs, project: repo }
    : { collection: segs.slice(0, -1), project: segs[segs.length - 1] };
}

function parseAzurePrUrl(trimmed) {
  const m = trimmed.match(/^(https?):\/\/([^/]+)\/((?:[^/?#]+\/)*?)_git\/([^/?#]+)\/pullrequest\/(\d+)(?:[/?#]|$)/i);
  if (!m) return null;
  const repo = decodeSegment(m[4]);
  const { collection, project } = splitAzurePath(m[3].split('/'), repo, m[2]);
  const info = azureInfo({ scheme: m[1].toLowerCase(), host: m[2], collection, project, repo });
  return info ? { ...info, number: parseInt(m[5], 10), type: 'pr' } : null;
}

function parseAzureRemote(trimmed) {
  // SSH on Services: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}, and the
  // legacy {org}@vs-ssh.visualstudio.com:v3/... form.
  const ssh = trimmed.match(/^(?:ssh:\/\/)?(?:[^@]+@)?(ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::\d+)?[:/]v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i);
  if (ssh) {
    return azureInfo({
      scheme: 'https', host: AZURE_SERVICES_HOST,
      collection: [decodeSegment(ssh[2])], project: decodeSegment(ssh[3]), repo: decodeSegment(stripGitSuffix(ssh[4])),
    });
  }
  // HTTPS on any host, and SSH to Azure DevOps Server, carry "/_git/".
  const http = trimmed.match(/^(https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/((?:[^/]+\/)*?)_git\/([^/?#]+?)\/?$/i);
  if (!http) return null;
  // An SSH remote to Server doesn't say which scheme the web UI uses; assume https.
  const isSsh = http[1].toLowerCase() === 'ssh';
  const scheme = isSsh ? 'https' : http[1].toLowerCase();
  const host = isSsh ? http[2].replace(/:\d+$/, '') : http[2];
  const repo = decodeSegment(stripGitSuffix(http[4]));
  const { collection, project } = splitAzurePath(http[3].split('/'), repo, host);
  return azureInfo({ scheme, host, collection, project, repo });
}

// Parse a pull request / merge request URL across GitHub, GitLab, Bitbucket and Azure DevOps.
// Returns { forge, host, projectPath, owner, repo, number, type } or null; Azure
// DevOps adds collectionUrl, collectionPath, project and repoName.
function parseForgeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

  // Checked first, by the "_git/.../pullrequest/" path rather than the host, so
  // Azure DevOps Server on any host is recognised.
  const azure = parseAzurePrUrl(trimmed);
  if (azure) return azure;

  // Project path is greedy so nested subgroups survive; `/-/` is optional on self-hosted.
  const glMatch = trimmed.match(/^https?:\/\/([^/]+)\/(.+?)\/(?:-\/)?merge_requests\/(\d+)(?:[/?#]|$)/i);
  if (glMatch) {
    const host = glMatch[1];
    const projectPath = stripGitSuffix(glMatch[2]);
    const segments = projectPath.split('/');
    const repo = segments.pop();
    const owner = segments.join('/');
    const number = parseInt(glMatch[3], 10);
    return {
      forge: 'gitlab',
      host,
      projectPath,
      owner,
      repo,
      number,
      type: 'mr',
    };
  }

  // Host is unanchored so GitHub Enterprise hosts match too.
  const ghMatch = trimmed.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)\/pull\/(\d+)(?:[/?#]|$)/i);
  if (ghMatch) {
    const host = ghMatch[1];
    const owner = ghMatch[2];
    const repo = stripGitSuffix(ghMatch[3]);
    const number = parseInt(ghMatch[4], 10);
    return {
      forge: 'github',
      host,
      projectPath: `${owner}/${repo}`,
      owner,
      repo,
      number,
      type: 'pr',
    };
  }

  const bbMatch = trimmed.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)\/pull-requests\/(\d+)(?:[/?#]|$)/i);
  if (bbMatch) {
    const host = bbMatch[1];
    const owner = bbMatch[2];
    const repo = stripGitSuffix(bbMatch[3]);
    const number = parseInt(bbMatch[4], 10);
    return {
      forge: 'bitbucket',
      host,
      projectPath: `${owner}/${repo}`,
      owner,
      repo,
      number,
      type: 'pr',
    };
  }

  return null;
}

// Detect forge + project path from a git remote URL (SSH or HTTPS form).
function detectForgeFromRemote(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== 'string') return null;
  const trimmed = remoteUrl.trim();

  const azure = parseAzureRemote(trimmed);
  if (azure) return azure;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.toLowerCase();
      const rawPath = parsed.pathname.replace(/^\//, '');
      const projectPath = stripGitSuffix(rawPath);
      const segments = projectPath.split('/');
      const repo = segments.pop();
      const owner = segments.join('/');

      let forge = 'unknown';
      if (host.includes('gitlab')) forge = 'gitlab';
      else if (host.includes('github')) forge = 'github';
      else if (host.includes('bitbucket') || host.includes('stash')) forge = 'bitbucket';

      return { forge, host, projectPath, owner, repo };
    } catch {
      return null;
    }
  }

  const sshMatch = trimmed.match(/^(?:ssh:\/\/)?(?:[^@]+@)?([^/:]+)[:/](.+)$/i);
  if (sshMatch) {
    const host = sshMatch[1].toLowerCase();
    const projectPath = stripGitSuffix(sshMatch[2]);
    const segments = projectPath.split('/');
    const repo = segments.pop();
    const owner = segments.join('/');

    let forge = 'unknown';
    if (host.includes('gitlab')) forge = 'gitlab';
    else if (host.includes('github')) forge = 'github';
    else if (host.includes('bitbucket') || host.includes('stash')) forge = 'bitbucket';

    return { forge, host, projectPath, owner, repo };
  }

  return null;
}

module.exports = {
  parseForgeUrl,
  detectForgeFromRemote,
  stripGitSuffix,
};
