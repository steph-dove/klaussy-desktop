// Catch-all error logging so uncaught errors end up somewhere actionable
// instead of disappearing into a silent renderer. Three sources funnel into
// electron-log:
//
//   1. Main-process uncaughtException / unhandledRejection
//   2. Electron's native crashReporter (renderer C++ crashes)
//   3. Renderer-side console errors (wired by the renderer itself; not here)
//
// electron-log writes to:
//   ~/Library/Logs/Klaussy/main.log (macOS)
// plus the About → View Logs panel.
//
// When you're ready to ship telemetry off-device (e.g. Sentry), add the
// transport in install() below — electron-log has a Sentry transport that
// drops in without changing the rest of the app.

const { app, crashReporter } = require('electron');
const log = require('electron-log');
const path = require('path');

function install() {
  log.initialize();
  log.transports.file.level = 'info';
  log.transports.console.level = 'debug';
  log.transports.file.resolvePathFn = () =>
    path.join(app.getPath('logs'), 'main.log');

  // JS uncaught errors — these are the ones that actually happen in practice.
  // Native crashes are rare; JS errors are constant feedback.
  process.on('uncaughtException', (err) => {
    log.error('[uncaught]', err && err.stack ? err.stack : err);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
  });

  // Native renderer/GPU process crashes. Electron ships a local minidump
  // writer; enabling this keeps the minidumps on disk (viewable in
  // Console.app). No uploadToServer — we're not running a Breakpad endpoint.
  // If we ever add Sentry, flip uploadToServer and submitURL then.
  try {
    crashReporter.start({
      productName: 'Klaussy',
      companyName: 'Klaussy',
      submitURL: '',
      uploadToServer: false,
    });
  } catch (err) {
    log.warn('[crashReporter] failed to start', err && err.message);
  }

  log.info('[error-reporter] installed; logs at', log.transports.file.getFile().path);
}

module.exports = { install };
