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
const { whichBinSync } = require('./main/util/platform');

const IS_WIN = process.platform === 'win32';

// Pick the right install hint per platform. Many LSPs have only a macOS
// recipe (brew); for those we want a Windows alternative (scoop/winget/
// download URL) without throwing away the existing text. installHint can
// be either a string (platform-agnostic) or a { darwin?, win32?, default? }
// map — resolveInstallHint flattens it.
function resolveInstallHint(hint) {
  if (typeof hint === 'string' || hint == null) return hint || '';
  return hint[process.platform] || hint.default || '';
}

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
    // and hot-swaps to include Rails-specific intel via the ruby-lsp-rails
    // add-on — one binary covers plain Ruby + Rails with no per-project entry
    // here. We also install ruby-lsp-rails globally for convenience, but the
    // add-on only activates when a Rails project's Gemfile references it.
    candidates: ['ruby-lsp'],
    args: [],
    friendly: 'ruby-lsp',
    installers: [
      { cmd: 'gem', args: ['install', 'ruby-lsp', 'ruby-lsp-rails'] },
    ],
    installHint:
      'Install ruby-lsp with:\n' +
      '  gem install ruby-lsp ruby-lsp-rails\n\n' +
      'For Rails-specific intel, also add to your Gemfile:\n' +
      "  gem 'ruby-lsp-rails', require: false, group: :development\n\n" +
      'If `gem install` puts binaries in a non-PATH bin dir, add it to your shell and relaunch Klaussy.',
  },
  java: {
    candidates: ['jdtls'],
    args: [],
    friendly: 'jdtls',
    installers: [
      { cmd: 'brew', args: ['install', 'jdtls'] },
    ],
    installHint: {
      darwin:
        'Install jdtls with:\n' +
        '  brew install jdtls\n\n' +
        'Needs a JDK (Homebrew pulls one in as a dependency).',
      win32:
        'Install jdtls on Windows by downloading the latest milestone from\n' +
        '  https://download.eclipse.org/jdtls/milestones/\n\n' +
        'Extract somewhere on PATH, then `winget install Microsoft.OpenJDK.21` if you don\'t already have a JDK.',
      default:
        'Download jdtls from https://download.eclipse.org/jdtls/milestones/ and put its bin/ on PATH. Needs a JDK.',
    },
  },
  cpp: {
    // clangd covers both C and C++ from one binary — routed to either from
    // the file-extension mapping in the renderer.
    candidates: ['clangd'],
    args: [],
    friendly: 'clangd',
    installers: [
      { cmd: 'brew', args: ['install', 'llvm'] },
    ],
    installHint: {
      darwin:
        'Install clangd with:\n' +
        '  brew install llvm\n\n' +
        "llvm's bin dir is keg-only on Homebrew — follow brew's post-install instructions to add it to PATH, or symlink /opt/homebrew/opt/llvm/bin/clangd into /usr/local/bin.",
      win32:
        'Install clangd on Windows with one of:\n' +
        '  winget install LLVM.LLVM\n' +
        '  scoop install llvm\n\n' +
        'Both put clangd.exe on PATH automatically.',
      default:
        'Install clangd via your distro\'s package manager (apt install clangd, dnf install clang-tools-extra, etc.) or download from https://releases.llvm.org/.',
    },
  },
  php: {
    candidates: ['intelephense'],
    args: ['--stdio'],
    friendly: 'intelephense',
    installers: [
      { cmd: 'npm', args: ['install', '-g', 'intelephense'] },
    ],
    installHint:
      'Install intelephense with:\n' +
      '  npm install -g intelephense\n\n' +
      "Free tier covers most features. Pro license unlocks some advanced refactors but isn't required.",
  },
  csharp: {
    candidates: ['csharp-ls'],
    args: [],
    friendly: 'csharp-ls',
    installers: [
      { cmd: 'dotnet', args: ['tool', 'install', '-g', 'csharp-ls'] },
    ],
    installHint: {
      darwin:
        'Install csharp-ls with:\n' +
        '  dotnet tool install -g csharp-ls\n\n' +
        'Needs the .NET SDK (`brew install --cask dotnet-sdk`). Adds to ~/.dotnet/tools — ensure that path is on PATH.',
      win32:
        'Install csharp-ls with:\n' +
        '  dotnet tool install -g csharp-ls\n\n' +
        'Needs the .NET SDK (`winget install Microsoft.DotNet.SDK.8`). Adds to %USERPROFILE%\\.dotnet\\tools — that path is on PATH by default.',
      default:
        'Install csharp-ls with:\n' +
        '  dotnet tool install -g csharp-ls\n\n' +
        'Needs the .NET SDK. Adds to ~/.dotnet/tools — ensure that path is on PATH.',
    },
  },
  swift: {
    // sourcekit-lsp ships with the Swift toolchain — there's no standalone
    // installer. If the binary isn't on PATH the user needs Xcode (or the
    // Swift toolchain) installed.
    candidates: ['sourcekit-lsp'],
    args: [],
    friendly: 'sourcekit-lsp',
    installers: [],
    installHint: {
      darwin:
        'sourcekit-lsp ships with Xcode / the Swift toolchain — there is no standalone installer.\n\n' +
        'Install Xcode from the Mac App Store, or download the Swift toolchain from https://www.swift.org/download/ and run:\n' +
        '  xcode-select --install',
      win32:
        'Swift on Windows is supported but ships separately. Download the Swift toolchain from\n' +
        '  https://www.swift.org/download/\n\n' +
        'sourcekit-lsp.exe lands in the toolchain\'s usr\\bin — add that to PATH.',
      default:
        'Install the Swift toolchain from https://www.swift.org/download/ — sourcekit-lsp lands in usr/bin.',
    },
  },
  'objective-c': {
    // Same sourcekit-lsp binary as Swift — it handles Swift and C-family
    // (C / C++ / ObjC / ObjC++). Separate language entry so our didOpen
    // sends languageId=objective-c and the server parses accordingly.
    candidates: ['sourcekit-lsp'],
    args: [],
    friendly: 'sourcekit-lsp (Objective-C)',
    installers: [],
    installHint: {
      darwin:
        'Objective-C intel comes from sourcekit-lsp (the Swift toolchain).\n\n' +
        'Install Xcode from the Mac App Store, or download the Swift toolchain from https://www.swift.org/download/ and run:\n' +
        '  xcode-select --install',
      default:
        'Objective-C intel comes from sourcekit-lsp. Install the Swift toolchain from https://www.swift.org/download/ — Objective-C support is mainly useful on Apple platforms.',
    },
  },
  kotlin: {
    candidates: ['kotlin-language-server'],
    args: [],
    friendly: 'kotlin-language-server',
    installers: [
      { cmd: 'brew', args: ['install', 'kotlin-language-server'] },
    ],
    installHint: {
      darwin:
        'Install kotlin-language-server with:\n' +
        '  brew install kotlin-language-server\n\n' +
        'Needs a JDK (brew pulls one in).',
      win32:
        'Install kotlin-language-server on Windows by downloading from\n' +
        '  https://github.com/fwcd/kotlin-language-server/releases\n\n' +
        'Extract and add the bin/ directory to PATH. Needs a JDK (`winget install Microsoft.OpenJDK.21`).',
      default:
        'Download kotlin-language-server from https://github.com/fwcd/kotlin-language-server/releases. Needs a JDK.',
    },
  },
  vue: {
    // Volar's @vue/language-server — the replacement for the old `vls` from
    // Vetur. Binary name from the npm package is `vue-language-server`.
    candidates: ['vue-language-server'],
    args: ['--stdio'],
    friendly: 'vue-language-server',
    installers: [
      { cmd: 'npm', args: ['install', '-g', '@vue/language-server'] },
    ],
    installHint:
      'Install Vue language server with:\n' +
      '  npm install -g @vue/language-server\n\n' +
      'For deep TypeScript-in-SFC support you may also need typescript-language-server in your project.',
  },
  svelte: {
    candidates: ['svelteserver'],
    args: ['--stdio'],
    friendly: 'svelte-language-server',
    installers: [
      { cmd: 'npm', args: ['install', '-g', 'svelte-language-server'] },
    ],
    installHint:
      'Install Svelte language server with:\n' +
      '  npm install -g svelte-language-server',
  },
  astro: {
    candidates: ['astro-ls'],
    args: ['--stdio'],
    friendly: '@astrojs/language-server',
    installers: [
      { cmd: 'npm', args: ['install', '-g', '@astrojs/language-server'] },
    ],
    installHint:
      'Install Astro language server with:\n' +
      '  npm install -g @astrojs/language-server',
  },
  dockerfile: {
    candidates: ['docker-langserver'],
    args: ['--stdio'],
    friendly: 'docker-langserver',
    installers: [
      { cmd: 'npm', args: ['install', '-g', 'dockerfile-language-server-nodejs'] },
    ],
    installHint:
      'Install Dockerfile language server with:\n' +
      '  npm install -g dockerfile-language-server-nodejs',
  },
  yaml: {
    candidates: ['yaml-language-server'],
    args: ['--stdio'],
    friendly: 'yaml-language-server',
    installers: [
      { cmd: 'npm', args: ['install', '-g', 'yaml-language-server'] },
    ],
    installHint:
      'Install YAML language server with:\n' +
      '  npm install -g yaml-language-server\n\n' +
      'Ships with schema awareness for Kubernetes / GitHub Actions / Compose out of the box.',
  },
  markdown: {
    candidates: ['marksman'],
    args: ['server'],
    friendly: 'marksman',
    installers: [
      { cmd: 'brew', args: ['install', 'marksman'] },
    ],
    installHint: {
      darwin:
        'Install marksman (Markdown LSP) with:\n' +
        '  brew install marksman\n\n' +
        'Provides wikilink resolution + cross-file references across docs folders.',
      win32:
        'Install marksman with:\n' +
        '  scoop install marksman\n' +
        'or download marksman.exe from https://github.com/artempyanykh/marksman/releases and put it on PATH.',
      default:
        'Download marksman from https://github.com/artempyanykh/marksman/releases and put it on PATH.',
    },
  },
  lua: {
    candidates: ['lua-language-server'],
    args: [],
    friendly: 'lua-language-server',
    installers: [
      { cmd: 'brew', args: ['install', 'lua-language-server'] },
    ],
    installHint: {
      darwin:
        'Install lua-language-server with:\n' +
        '  brew install lua-language-server',
      win32:
        'Install lua-language-server with:\n' +
        '  scoop install lua-language-server\n' +
        'or download from https://github.com/LuaLS/lua-language-server/releases.',
      default:
        'Download lua-language-server from https://github.com/LuaLS/lua-language-server/releases.',
    },
  },
};

function resolveExecutable(candidates) {
  // `spawn` will search PATH by default when the name has no separator; we
  // only need to check that one of the candidate names resolves to something
  // runnable. whichBinSync handles `which` on POSIX vs `where.exe` on Windows;
  // we also try a `.exe` variant on Windows since many LSP binaries ship with
  // that suffix and `where` matches by exact name.
  for (const name of candidates) {
    if (whichBinSync(name)) return name;
    if (IS_WIN && !name.endsWith('.exe') && whichBinSync(name + '.exe')) {
      return name + '.exe';
    }
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
      installHint: resolveInstallHint(launcher.installHint),
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
      installHint: resolveInstallHint(launcher.installHint),
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
        resolve({ error: `${installer.cmd} exited with code ${code}`, installHint: resolveInstallHint(launcher.installHint) });
        return;
      }
      // Verify the binary is now on PATH — pipx and npm install paths
      // should be standard, but double-check so we don't greenlight a
      // silently-broken install.
      if (!resolveExecutable(launcher.candidates)) {
        send({ type: 'done', ok: false });
        resolve({
          error: `${launcher.friendly} installed but the binary is still not on PATH. Restart your shell or Klaussy.`,
          installHint: resolveInstallHint(launcher.installHint),
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
