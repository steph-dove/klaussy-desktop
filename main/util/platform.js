// Cross-platform helpers for spawning a user shell (PTY tasks, sub-terminals).
//
// macOS/Linux: $SHELL or /bin/zsh, invoked as a login shell with -l (or
// -l -c <cmd> for a one-shot command).
// Windows: PowerShell 7 (pwsh.exe) if installed, else powershell.exe — invoked
// with -NoLogo (or -NoLogo -Command <cmd>). PowerShell has no login-shell
// flag; the user's $PROFILE is read by default.
// Git Bash on Windows is auto-detected by basename so users who set
// shellPath to bash.exe (in a later phase) get POSIX-style args.
//
// This module has no Electron dep so it can be required from non-main
// contexts (e.g. lsp-manager.js) once §3 lands.

const { execFileSync } = require('child_process');

const IS_WIN = process.platform === 'win32';

// Split on both `/` and `\` so a Windows-style path resolves correctly even
// when this code runs on POSIX (test fixtures, CI matrix, etc.) and vice
// versa. node's path.basename() only honors the host platform's separator.
function isPosixShell(shellPath) {
  if (!shellPath) return false;
  const tail = shellPath.split(/[/\\]/).pop() || '';
  const base = tail.toLowerCase().replace(/\.exe$/, '');
  return base === 'bash' || base === 'sh' || base === 'zsh'
      || base === 'dash' || base === 'ksh';
}

// Return the absolute path of `name` on PATH, or null. Sync because callers
// (defaultShell here, lsp-manager.js later) need it during startup paths
// where async would force a refactor for no real win.
function whichBinSync(name) {
  const cmd = IS_WIN ? 'where.exe' : 'which';
  try {
    const out = execFileSync(cmd, [name], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (!out) return null;
    // `where` may return multiple PATH hits — first wins.
    return out.split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

function defaultShell() {
  if (!IS_WIN) {
    return process.env.SHELL || '/bin/zsh';
  }
  return whichBinSync('pwsh.exe') || 'powershell.exe';
}

// Args for an interactive login shell (no command — drops the user at a prompt).
function shellLoginArgs(shellPath) {
  if (isPosixShell(shellPath)) return ['-l'];
  if (IS_WIN) return ['-NoLogo'];
  return ['-l'];
}

// Args to run a single shell command-line and exit.
function shellRunCmdArgs(shellPath, cmd) {
  if (isPosixShell(shellPath)) return ['-l', '-c', cmd];
  if (IS_WIN) return ['-NoLogo', '-Command', cmd];
  return ['-l', '-c', cmd];
}

module.exports = {
  defaultShell,
  shellLoginArgs,
  shellRunCmdArgs,
  isPosixShell,
  whichBinSync,
};
