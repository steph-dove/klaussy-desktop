// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// `npm run web`: starts web/helper.js under Electron's own Node, so native
// modules (node-pty) load with the ABI electron-rebuild built them for.

const path = require('path');
const { spawn } = require('child_process');
const electronBinary = require('electron'); // from plain Node this is the binary's path

const child = spawn(electronBinary, [path.join(__dirname, 'helper.js'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
child.on('error', (err) => {
  console.error(`Couldn't start Maussian (${err.message}). Run \`npm install\` and try again.`);
  process.exit(1);
});
// Pass Ctrl-C and SIGTERM on so the helper can save sessions before it exits.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { if (child.exitCode == null && child.signalCode == null) child.kill(sig); });
}
child.on('exit', (code, signal) => process.exit(code == null ? (signal ? 1 : 0) : code));
