'use strict';

const fs = require('fs');
const path = require('path').posix;

const STUB_GIT = '/usr/bin/git';

function isRealGit(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.realpathSync(candidate) !== STUB_GIT;
  } catch {
    return false;
  }
}

// On macOS /usr/bin/git is an xcode-select stub: without the Command Line Tools,
// running it fails and pops Apple's install dialog, so only probe a real git.
function gitBinToProbe({ platform, devToolsInstalled, envPath, isGit = isRealGit }) {
  if (platform !== 'darwin' || devToolsInstalled) return 'git';
  const dirs = String(envPath || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'git');
    if (path.resolve(candidate) !== STUB_GIT && isGit(candidate)) return candidate;
  }
  return null;
}

function gitInstallCommand(platform) {
  if (platform === 'darwin') return 'xcode-select --install';
  if (platform === 'win32') return 'winget install --id Git.Git -e';
  return 'sudo apt install git';
}

module.exports = { gitBinToProbe, gitInstallCommand };
