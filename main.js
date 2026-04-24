// Electron main entry point. Almost everything has moved into main/ — this
// file just wires modules together and hands control to the app-events
// bootstrap.
//
// Require order matters for a few pieces:
//   1. util/logging — installs console hooks on load, so anything that logs
//      later (including import-time errors) routes through the ring buffer +
//      rolling file.
//   2. util/path-gate — gets its loadConfig + getInstances deps injected
//      here (the one cross-module wire-up that still lives in main.js,
//      because app-events.js doesn't know about path-gate).
//   3. IPC modules — side-effect imports; each registers its ipcMain
//      handlers on load.
//   4. bootstrap/app-events.install() — attaches app.whenReady +
//      window-all-closed + before-quit + will-quit, injects remaining state
//      deps (isQuitting / startCIPolling / runKlausifyInit), and kicks off
//      the migrate-on-startup + PATH-fix.
//
// See SPLIT_PLAN.md for the full module layout and shared-state contract.

require('./main/util/logging');
const pathGate = require('./main/util/path-gate');
const { loadConfig } = require('./main/util/config');
const { instances } = require('./main/state/instances');

// State-module side effects (require these before the IPC modules so any
// handler that reaches into state finds it fully initialized).
require('./main/state/windows');
require('./main/state/claude-streaming');
require('./main/state/watcher');
require('./main/state/ci-poll');
require('./main/state/pr-review');

// path-gate needs loadConfig + the live instances Map for the allowed-roots
// check. Both are stable imports; we set them once here and forget.
pathGate.setDeps({ loadConfig, getInstances: () => instances });

// IPC handler registrations (side-effectful requires).
require('./main/ipc/windows-ipc');
require('./main/ipc/lsp');
require('./main/ipc/skills');
require('./main/ipc/files');
require('./main/ipc/gh');
require('./main/ipc/git');
require('./main/ipc/tasks');
require('./main/ipc/repo');
require('./main/ipc/claude-stream-ipc');
require('./main/ipc/pr-review');
require('./main/ipc/ollama');
require('./main/ipc/license');

require('./main/bootstrap/error-reporter').install();
require('./main/bootstrap/app-events').install();
require('./main/bootstrap/auto-updater').install();
