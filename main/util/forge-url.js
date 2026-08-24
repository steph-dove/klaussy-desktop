// Forge URL & remote detection utility.
// Parses and normalizes URLs and git remotes across GitHub, GitLab, and Bitbucket.

function stripGitSuffix(s) {
  return String(s || '').replace(/\.git$/, '');
}

// Parse a pull request / merge request URL across GitHub, GitLab, and Bitbucket.
// Returns { forge, host, projectPath, owner, repo, number, type } or null.
function parseForgeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

  // 1. GitLab Merge Request
  // Formats:
  // - https://gitlab.com/group/project/-/merge_requests/123
  // - https://gitlab.com/group/subgroup/project/-/merge_requests/123
  // - https://gitlab.corp.internal/group/project/merge_requests/123
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

  // 2. GitHub Pull Request
  // Format: https://github.com/owner/repo/pull/123 (or enterprise github.corp.com)
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

  // 3. Bitbucket Pull Request
  // Format: https://bitbucket.org/workspace/repo/pull-requests/123
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

// Detect the forge and project path from a git remote URL (SSH or HTTPS).
// Examples:
// - git@gitlab.com:org/subgroup/project.git
// - https://gitlab.com/org/subgroup/project.git
// - git@github.com:owner/repo.git
// - https://github.com/owner/repo.git
// - git@bitbucket.org:workspace/repo.git
function detectForgeFromRemote(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== 'string') return null;
  const trimmed = remoteUrl.trim();

  // HTTPS form: https://<host>/<path>.git
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

  // SSH form: git@<host>:<path>.git or ssh://git@<host>/<path>.git
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
