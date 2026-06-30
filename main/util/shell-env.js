// Resolve where to put env vars an MCP server needs, per the user's shell. The
// manager writes `${VAR}` refs into config (never secrets) and points the user
// at their shell profile (.zshrc etc.) to set the real values.

const path = require('path');
const os = require('os');

// Resolve the shell profile file + export syntax (best-effort from $SHELL;
// defaults to zsh). Windows has no rc file — profilePath is null and callers
// show a setx/PowerShell command instead.
function detectShellProfile({ platform = process.platform, shell = process.env.SHELL, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    return { shell: 'powershell', platform, profilePath: null, syntax: 'powershell' };
  }
  const name = shell ? path.basename(shell) : '';
  if (name.includes('fish')) {
    return { shell: 'fish', platform, profilePath: path.join(home, '.config', 'fish', 'config.fish'), syntax: 'fish' };
  }
  if (name.includes('bash')) {
    // macOS login shells read .bash_profile; Linux uses .bashrc.
    const file = platform === 'darwin' ? '.bash_profile' : '.bashrc';
    return { shell: 'bash', platform, profilePath: path.join(home, file), syntax: 'posix' };
  }
  return { shell: 'zsh', platform, profilePath: path.join(home, '.zshrc'), syntax: 'posix' };
}

// The line a user adds to set VAR. We never embed a real secret — `placeholder`
// (or a generated hint) stands in for the value the user fills in.
function exportLine(syntax, key, placeholder) {
  const ph = placeholder || ('your-' + key.toLowerCase().replace(/_/g, '-'));
  switch (syntax) {
    case 'fish': return `set -Ux ${key} "${ph}"`;
    case 'powershell': return `[Environment]::SetEnvironmentVariable("${key}", "${ph}", "User")`;
    case 'posix':
    default: return `export ${key}="${ph}"`;
  }
}

module.exports = { detectShellProfile, exportLine };
