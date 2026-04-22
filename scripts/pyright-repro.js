// Standalone pyright LSP repro — spawns pyright-langserver, sends a handcrafted
// initialize + didOpen for a file with an obvious type error, and logs every
// server message. Lets us see whether diagnostics flow outside our renderer.
//
// Usage:
//   node scripts/pyright-repro.js
//
// Flags:
//   --no-root       : drop rootUri / workspaceFolders from initialize
//   --no-watch      : drop didChangeWatchedFiles client capability
//   --wait-ms N     : how long to wait for diagnostics before exiting (default 8000)

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const rpc = require('vscode-jsonrpc/node');

const argv = process.argv.slice(2);
const dropRoot = argv.includes('--no-root');
const dropWatch = argv.includes('--no-watch');
const pushConfig = argv.includes('--push-config');
const waitIdx = argv.indexOf('--wait-ms');
const waitMs = waitIdx >= 0 ? parseInt(argv[waitIdx + 1], 10) : 8000;

const t0 = Date.now();
const ts = () => `+${(Date.now() - t0).toString().padStart(5, ' ')}ms`;
const log = (...args) => console.log(ts(), ...args);

// Fresh temp dir so pyright has a clean workspace (no inherited pyproject,
// no stale analysis cache). Obvious type error so diagnostics are inevitable
// if pyright is actually analyzing.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pyright-repro-'));
const filePath = path.join(tmp, 'bug.py');
fs.writeFileSync(
  filePath,
  'x: int = "not an int"\n' +
    'def greet(name: str) -> str:\n' +
    '    return name + 1\n' +
    '\n' +
    'y = undefined_symbol\n',
);
log('[repro] workspace:', tmp);
log('[repro] file     :', filePath);

const fileUri = 'file://' + filePath;
const wsUri = 'file://' + tmp;

const proc = spawn('pyright-langserver', ['--stdio'], {
  cwd: tmp,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});
proc.stderr.on('data', (chunk) => {
  process.stdout.write('[pyright stderr] ' + chunk.toString());
});
proc.on('exit', (code, signal) => {
  log(`[pyright] exited code=${code} signal=${signal}`);
});

// Raw byte spy — sits on stdout's data events so we can see every payload
// pyright emits even if vscode-jsonrpc's reader hasn't processed it yet.
// Helps distinguish "server hasn't sent it" from "reader hasn't drained it".
proc.stdout.on('data', (chunk) => {
  const s = chunk.toString();
  const lines = s.split(/\r?\n/).filter((l) => l.includes('"method"'));
  lines.forEach((l) => {
    const m = l.match(/"method":"([^"]+)"/);
    if (m) log('[raw stdout]', m[1]);
  });
});

const connection = rpc.createMessageConnection(
  new rpc.StreamMessageReader(proc.stdout),
  new rpc.StreamMessageWriter(proc.stdin),
);

let diagCount = 0;
connection.onNotification((method, params) => {
  if (method === 'textDocument/publishDiagnostics') {
    diagCount += 1;
    const n = (params && params.diagnostics && params.diagnostics.length) || 0;
    log(`[←notif] publishDiagnostics uri=${params.uri} count=${n}`);
    (params.diagnostics || []).forEach((d, i) => {
      log(`   [${i}] sev=${d.severity} range=${JSON.stringify(d.range)} msg=${d.message}`);
    });
  } else if (method === 'window/logMessage' || method === 'window/showMessage') {
    const msg = params && params.message ? String(params.message) : '';
    log(`[←notif] ${method} (${params && params.type}) :: ${msg}`);
  } else {
    log(`[←notif] ${method}`);
  }
});

connection.onRequest((method, params) => {
  log(`[←req] ${method}`, params ? JSON.stringify(params).slice(0, 200) : '');
  if (method === 'workspace/configuration') {
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
        };
      }
      return {};
    });
  }
  if (method === 'window/workDoneProgress/create') return null;
  if (method === 'client/registerCapability') return null;
  return null;
});

connection.onError(([err]) => console.warn('[conn error]', err && err.message));
connection.listen();

(async () => {
  const initParams = {
    processId: process.pid,
    capabilities: {
      textDocument: {
        synchronization: { didSave: true, willSave: false, willSaveWaitUntil: false, dynamicRegistration: false },
        publishDiagnostics: { relatedInformation: true, versionSupport: false },
        hover: { contentFormat: ['markdown', 'plaintext'] },
      },
      workspace: {
        workspaceFolders: !dropRoot,
        configuration: true,
        ...(dropWatch ? {} : { didChangeWatchedFiles: { dynamicRegistration: false } }),
      },
    },
    initializationOptions: {},
  };
  if (!dropRoot) {
    initParams.rootUri = wsUri;
    initParams.rootPath = tmp;
    initParams.workspaceFolders = [{ uri: wsUri, name: path.basename(tmp) }];
  }

  log(
    '[→req] initialize',
    'dropRoot=' + dropRoot,
    'dropWatch=' + dropWatch,
  );
  const result = await connection.sendRequest('initialize', initParams);
  log('[init result] capability keys:', Object.keys(result.capabilities || {}));
  log('[init result] textDocumentSync:', JSON.stringify(result.capabilities && result.capabilities.textDocumentSync));
  log('[init result] server info     :', JSON.stringify(result.serverInfo));

  log('[→notif] initialized');
  connection.sendNotification('initialized', {});

  // Short settle window. Sometimes pyright logs its "assuming Python version"
  // banner here before it'll accept didOpen. Keeps ordering clean in the log.
  await new Promise((r) => setTimeout(r, 200));

  if (pushConfig) {
    log('[→notif] workspace/didChangeConfiguration');
    connection.sendNotification('workspace/didChangeConfiguration', {
      settings: {
        python: {
          analysis: {
            diagnosticMode: 'openFilesOnly',
            useLibraryCodeForTypes: true,
            autoSearchPaths: true,
          },
        },
      },
    });
    await new Promise((r) => setTimeout(r, 100));
  }

  log('[→notif] didOpen', fileUri);
  connection.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri: fileUri,
      languageId: 'python',
      version: 1,
      text: fs.readFileSync(filePath, 'utf8'),
    },
  });

  log(`[repro] waiting ${waitMs}ms for diagnostics…`);
  await new Promise((r) => setTimeout(r, waitMs));
  log(`[repro] done. publishDiagnostics seen: ${diagCount}`);

  try { await connection.sendRequest('shutdown'); } catch (_) {}
  try { connection.sendNotification('exit'); } catch (_) {}
  try { connection.dispose(); } catch (_) {}
  try { proc.kill('SIGTERM'); } catch (_) {}

  process.exit(diagCount > 0 ? 0 : 2);
})();
