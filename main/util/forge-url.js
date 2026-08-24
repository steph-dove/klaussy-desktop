// Parse and normalize PR/MR URLs and git remotes across GitHub, GitLab, and Bitbucket.

function stripGitSuffix(s) {
  return String(s || '').replace(/\.git$/, '');
}

// Parse a pull request / merge request URL across GitHub, GitLab, and Bitbucket.
// Returns { forge, host, projectPath, owner, repo, number, type } or null.
function parseForgeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

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
