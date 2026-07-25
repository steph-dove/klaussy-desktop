// Builds the gateway bring-up script Klaussy runs in an in-app terminal (a real
// node-pty TTY, which the interactive `nemesis8 login` requires). It reuses the
// token Klaussy stores so the app and gateway can't drift.

function shScript(provider, token) {
  const flag = provider ? ` --provider ${provider}` : '';
  const pathLine = 'export PATH="$HOME/.local/bin:$HOME/.nemesis8/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"';
  return `#!/bin/bash
set -e
${pathLine}
echo "== Klaussy: setting up your local Nemesis8 gateway =="
if ! command -v nemesis8 >/dev/null 2>&1; then
  echo "Installing nemesis8 (needs Docker running)..."
  curl -fsSL https://nemesis8.nuts.services/install.sh | sh
  ${pathLine}
fi
echo ""
echo "Signing in to the ${provider || 'default'} agent — COMPLETE the login when prompted."
nemesis8 login${flag}
echo ""
echo "Clearing any stale containers so the gateway starts on the right agent..."
nemesis8 stop all || true
echo ""
echo "Starting the gateway on port 9801 in the background..."
export NEMESIS8_AUTH_TOKEN="${token}"
nemesis8 serve${flag} --background
echo ""
echo "Done. Gateway is running — go back to Preferences and Test connection. You can close this tab."
`;
}

function ps1Script(provider, token) {
  const flag = provider ? ` --provider ${provider}` : '';
  return `Write-Host "== Klaussy: setting up your local Nemesis8 gateway =="
if (-not (Get-Command nemesis8 -ErrorAction SilentlyContinue)) {
  Write-Host "Installing nemesis8 (needs Docker running)..."
  irm https://nemesis8.nuts.services/install.ps1 | iex
}
Write-Host ""
Write-Host "Signing in to the ${provider || 'default'} agent - COMPLETE the login when prompted."
nemesis8 login${flag}
Write-Host ""
Write-Host "Clearing any stale containers so the gateway starts on the right agent..."
nemesis8 stop all
Write-Host ""
Write-Host "Starting the gateway on port 9801 in the background..."
$env:NEMESIS8_AUTH_TOKEN = "${token}"
nemesis8 serve${flag} --background
Write-Host ""
Write-Host "Done. Gateway is running - go back to Preferences and Test connection. You can close this tab."
`;
}

// { ext, content } for the host OS.
function nemesisSetupScript(platform, provider, token) {
  return platform === 'win32'
    ? { ext: 'ps1', content: ps1Script(provider, token) }
    : { ext: 'sh', content: shScript(provider, token) };
}

// How to invoke the written script from a shell tab.
function nemesisRunCmd(platform, scriptPath) {
  return platform === 'win32'
    ? `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`
    : `sh "${scriptPath}"`;
}

module.exports = { nemesisSetupScript, nemesisRunCmd };
