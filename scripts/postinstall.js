// Cross-platform postinstall: rebrands the dev-mode Electron app on macOS
// so `npx electron .` shows "Klaussy" in the menu bar instead of "Electron".
//
// Was previously inline shell commands chained with `||true`. That worked
// on macOS and silently no-op'd on Linux, but on Windows `cp` and `plutil`
// both error in cmd.exe before npm even forwards the failure. Moving to a
// node script gates by platform cleanly.

const fs = require('fs');
const { execFileSync } = require('child_process');

if (process.platform === 'darwin') {
  const target = 'node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns';
  try {
    fs.copyFileSync('icon.icns', target);
  } catch {
    // Electron not installed yet, or path layout changed — non-fatal.
  }

  const plist = 'node_modules/electron/dist/Electron.app/Contents/Info.plist';
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    try {
      execFileSync('plutil', ['-replace', key, '-string', 'Klaussy', plist], { stdio: 'ignore' });
    } catch {}
  }
}
