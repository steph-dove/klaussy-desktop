// Language server lifecycle + JSON-RPC plumbing (Phase I3).
//
// Each LSP server runs as a child process in the main process; we shuttle
// JSON-RPC messages between the renderer and the server over stdio. The
// renderer treats this as a request/response bus (plus a notification
// channel). Keeping the lifecycle in main avoids any `child_process` /
// node API in the renderer, which is contextIsolated by design.
//
// Servers are keyed by (languageId, worktreePath). One pyright per Python
// folder, not global — matches how VS Code scopes workspace folders.

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const rpc = require('vscode-jsonrpc/node');

const servers = new Map(); // serverId -> { proc, connection, languageId, worktreePath, webContents }
let nextServerId = 1;

// Tracks in-flight install jobs so concurrent opens of the same language
// don't kick off duplicate installs. Key = languageId, value = Promise.
const installInFlight = new Map();

// How a language's server is launched + installed. `installers` is tried
// in order; the first manager whose CLI is on PATH wins. We try pipx before
// npm for Python because pipx gives an isolated env and avoids polluting
// a project's node_modules.
const LAUNCHERS = {
  python: {
    candidates: ['pyright-langserver'],
    args: ['--stdio'],
    friendly: 'pyright',
    installers: [
      { cmd: 'pipx', args: ['install', 'pyright'] },
      { cmd: 'npm', args: ['install', '-g', 'pyright'] },
    ],
    installHint:
      'Install pyright manually with either:\n' +
      '  pipx install pyright\n' +
      '  npm install -g pyright',
  },
  rust: {
    candidates: ['rust-analyzer'],
    args: [],
    friendly: 'rust-analyzer',
    installers: [
      // rustup-managed rust-analyzer is the upstream-recommended install; it
      // tracks the toolchain and updates with `rustup update`. `cargo install`
      // also works but compiles from source (slow). We try rustup first.
      { cmd: 'rustup', args: ['component', 'add', 'rust-analyzer'] },
    ],
    installHint:
      'Install rust-analyzer with:\n' +
      '  rustup component add rust-analyzer\n\n' +
      'Needs rustup. If you don\'t have it, install from https://rustup.rs',
  },
  go: {
    candidates: ['gopls'],
    // `serve` is the explicit LSP-over-stdio mode; omitting it works too but
    // this is the documented form and doesn't rely on gopls's tty detection.
    args: ['serve'],
    friendly: 'gopls',
    installers: [
      { cmd: 'go', args: ['install', 'golang.org/x/tools/gopls@latest'] },
    ],
    installHint:
      'Install gopls with:\n' +
      '  go install golang.org/x/tools/gopls@latest\n\n' +
      'Needs Go 1.19+. Also make sure $(go env GOBIN) (or $GOPATH/bin) is on your PATH.',
  },
  ruby: {
    // ruby-lsp auto-detects Rails projects (checks for config/application.rb)
    // and hot-swaps its analysis to include Rails-specific intel — one binary
    // covers plain Ruby and Rails with no per-project switching here.
    candidates: ['ruby-lsp'],
    args: [],
    friendly: 'ruby-lsp',
    installers: [
      { cmd: 'gem', args: ['install', 'ruby-lsp'] },
    ],
    installHint:
      'Install ruby-lsp with:\n' +
      '  gem install ruby-lsp\n\n' +
      'Needs Ruby. If `gem install` puts it in a non-PATH bin dir, add it to your shell and relaunch Klaussy.',
  },
  java: {
    candidates: ['jdtls'],
    args: [],
    friendly: 'jdtls',
    installers: [
      { cmd: 'brew', args: ['install', 'jdtls'] },
    ],
    installHint:
      'Install jdtls with:\n' +
      '  brew install jdtls\n\n' +
      'Needs a JDK (Homebrew pulls one in as a dependency). On non-macOS, download from https://download.eclipse.org/jdtls/snapshots/',
  },
};

function resolveExecutable(candidates) {
  // `spawn` will search PATH by default when the name has no separator; we
  // only need to check that one of the candidate names resolves to something
  // runnable. Use `which` via the shell to probe without committing to run.
  const { execFileSync } = require('child_process');
  for (const name of candidates) {
    try {
      execFileSync('which', [name], { stdio: 'pipe' });
      return name;
    } catch {}
  }
  return null;
}

function startServer({ languageId, worktreePath, webContents }) {
  const launcher = LAUNCHERS[languageId];
  if (!launcher) {
    return { error: 'Unsupported languageId: ' + languageId };
  }
  const exe = resolveExecutable(launcher.candidates);
  if (!exe) {
    return {
      error: `${launcher.friendly} is not installed or not on PATH.`,
      installHint: launcher.installHint,
      missing: true,
    };
  }

  let proc;
  try {
    proc = spawn(exe, launcher.args, {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
  } catch (err) {
    return { error: 'Failed to spawn ' + launcher.friendly + ': ' + err.message };
  }

  const id = nextServerId++;

  const connection = rpc.createMessageConnection(
    new rpc.StreamMessageReader(proc.stdout),
    new rpc.StreamMessageWriter(proc.stdin),
  );

  // Every server-originated notification (publishDiagnostics, logs, etc.)
  // gets forwarded verbatim to the renderer. Requests from server → client
  // are rare (pyright occasionally sends workspace/configuration); we just
  // respond with null/defaults to keep the stream alive.
  connection.onNotification((method, params) => {
    if (method === 'window/logMessage' || method === 'window/showMessage') {
      const msg = params && params.message ? String(params.message).slice(0, 500) : '';
      console.log(`[lsp ${languageId} ←notif] ${method} :: ${msg}`);
    } else {
      console.log(`[lsp ${languageId} ←notif] ${method}`);
    }
    if (webContents && !webContents.isDestroyed()) {
      webContents.send(`lsp-message-${id}`, { type: 'notification', method, params });
    }
  });
  connection.onRequest((method, params) => {
    console.log(`[lsp ${languageId} ←req] ${method}`);
    if (method === 'workspace/configuration') {
      // Per-section config. Pyright asks for `python.analysis` (and a few
      // siblings). Returning empty objects previously made pyright treat
      // the workspace as `diagnosticMode: "workspace"` which pre-opens every
      // file — then our didOpen collided and pyright refused to publish
      // diagnostics ("redundant open"). `openFilesOnly` is the mode we want.
      return (params.items || []).map((item) => {
        const section = item && item.section;
        if (section === 'python' || section === 'python.analysis') {
          return {
            analysis: {
              diagnosticMode: 'openFilesOnly',
              useLibraryCodeForTypes: true,
              autoSearchPaths: true,
            },
            diagnosticMode: 'openFilesOnly',
            useLibraryCodeForTypes: true,
            autoSearchPaths: true,
          };
        }
        return {};
      });
    }
    if (method === 'window/workDoneProgress/create') return null;
    if (method === 'client/registerCapability') return null;
    if (method === 'client/unregisterCapability') return null;
    return null;
  });
  connection.onError(([err]) => {
    console.warn(`[lsp ${languageId}] connection error:`, err && err.message);
  });

  proc.stderr.on('data', (chunk) => {
    console.log(`[lsp ${languageId} stderr] ${chunk.toString().trim()}`);
  });
  proc.on('exit', (code, signal) => {
    console.log(`[lsp ${languageId}] exited (code=${code}, signal=${signal})`);
    servers.delete(id);
    if (webContents && !webContents.isDestroyed()) {
      webContents.send(`lsp-message-${id}`, { type: 'exit', code, signal });
    }
  });

  connection.listen();

  servers.set(id, { proc, connection, languageId, worktreePath, webContents });
  return { serverId: id };
}

async function request(serverId, method, params) {
  const entry = servers.get(serverId);
  if (!entry) return { error: 'No such LSP server: ' + serverId };
  try {
    const result = await entry.connection.sendRequest(method, params);
    return { result };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

function notify(serverId, method, params) {
  const entry = servers.get(serverId);
  if (!entry) return { error: 'No such LSP server: ' + serverId };
  const uri = params && params.textDocument && params.textDocument.uri;
  console.log(`[lsp ${entry.languageId} →notif] ${method}${uri ? ' ' + uri.split('/').pop() : ''}`);
  try {
    entry.connection.sendNotification(method, params);
    return { ok: true };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

async function stopServer(serverId) {
  const entry = servers.get(serverId);
  if (!entry) return { ok: true };
  try {
    // LSP spec: shutdown request, then exit notification. Give each a short
    // timeout so a misbehaving server can't hang the app on quit.
    await Promise.race([
      entry.connection.sendRequest('shutdown'),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    try { entry.connection.sendNotification('exit'); } catch {}
  } catch {}
  try { entry.connection.dispose(); } catch {}
  try { entry.proc.kill('SIGTERM'); } catch {}
  servers.delete(serverId);
  return { ok: true };
}

function stopServersForWebContents(webContents) {
  for (const [id, entry] of servers) {
    if (entry.webContents === webContents) stopServer(id);
  }
}

function stopAllServers() {
  for (const id of Array.from(servers.keys())) stopServer(id);
}

function hasCommand(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Auto-install a language server on demand. Streams stdout/stderr lines to
// the renderer so the install banner can show live progress — pipx and npm
// both take 10-30s so user feedback matters. Dedupes concurrent calls for
// the same language.
function installServer({ languageId, webContents }) {
  const launcher = LAUNCHERS[languageId];
  if (!launcher) return Promise.resolve({ error: 'Unsupported languageId: ' + languageId });

  // If we already shipped the binary once in this session, skip.
  if (resolveExecutable(launcher.candidates)) {
    return Promise.resolve({ ok: true, cached: true });
  }

  const existing = installInFlight.get(languageId);
  if (existing) return existing;

  const installer = launcher.installers && launcher.installers.find((i) => hasCommand(i.cmd));
  if (!installer) {
    return Promise.resolve({
      error:
        'No install method available. ' +
        (launcher.installers || []).map((i) => i.cmd).join(' or ') +
        ' not found on PATH.',
      installHint: launcher.installHint,
    });
  }

  const chan = `lsp-install-progress-${languageId}`;
  const send = (payload) => {
    if (webContents && !webContents.isDestroyed()) webContents.send(chan, payload);
  };

  const promise = new Promise((resolve) => {
    send({ type: 'start', command: installer.cmd + ' ' + installer.args.join(' ') });
    let proc;
    try {
      proc = spawn(installer.cmd, installer.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ error: `Failed to spawn ${installer.cmd}: ${err.message}` });
      return;
    }
    // Cap per-line length; some pip/npm outputs are very chatty and we only
    // need enough for a user-facing status, not the whole log.
    const stream = (data) => {
      data.toString().split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (trimmed) send({ type: 'log', line: trimmed.slice(0, 400) });
      });
    };
    proc.stdout.on('data', stream);
    proc.stderr.on('data', stream);
    proc.on('exit', (code) => {
      installInFlight.delete(languageId);
      if (code !== 0) {
        send({ type: 'done', ok: false });
        resolve({ error: `${installer.cmd} exited with code ${code}`, installHint: launcher.installHint });
        return;
      }
      // Verify the binary is now on PATH — pipx and npm install paths
      // should be standard, but double-check so we don't greenlight a
      // silently-broken install.
      if (!resolveExecutable(launcher.candidates)) {
        send({ type: 'done', ok: false });
        resolve({
          error: `${launcher.friendly} installed but the binary is still not on PATH. Restart your shell or Klaussy.`,
          installHint: launcher.installHint,
        });
        return;
      }
      send({ type: 'done', ok: true });
      resolve({ ok: true });
    });
    proc.on('error', (err) => {
      installInFlight.delete(languageId);
      send({ type: 'done', ok: false });
      resolve({ error: `${installer.cmd} failed: ${err.message}` });
    });
  });
  installInFlight.set(languageId, promise);
  return promise;
}

module.exports = {
  startServer,
  request,
  notify,
  stopServer,
  stopServersForWebContents,
  stopAllServers,
  installServer,
};
