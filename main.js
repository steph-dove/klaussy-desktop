const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, execFileSync, execFile, spawn } = require('child_process');
// Promisified execFile — every git IPC handler should prefer this over the
// sync `execFileSync` form. Sync ops on the main thread freeze every window
// (input, menus, IPC) until git returns; async keeps the event loop breathing.
const execFileP = require('util').promisify(execFile);
const pty = require('node-pty');
const lspManager = require('./lsp-manager');

let mainWindow;
const allWindows = new Set();
const instances = new Map(); // id -> { name, worktreePath, pty, branch }
let nextId = 1;
let isQuitting = false;

// E1: Log ring buffer
const LOG_MAX = 500;
const logBuffer = [];
const origConsoleLog = console.log;
const origConsoleError = console.error;
const origConsoleWarn = console.warn;

// Scrub obviously-sensitive tokens out of log messages so the View Logs
// viewer + the persisted log file don't expose them.
// gh error output occasionally echoes URLs of the form
// `https://oauth2:ghp_xxx@github.com/...` before the app's own scrub runs.
const LOG_TOKEN_SCRUB_RE = /(oauth2:[^@\s]+@)|(\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{20,})|(\bBearer\s+[A-Za-z0-9._\-]+)/g;
function scrubLogMsg(s) {
  try { return String(s).replace(LOG_TOKEN_SCRUB_RE, (m, a) => a ? 'oauth2:***@' : '***'); }
  catch { return '[unserializable]'; }
}

// Cap accumulation of a child process's stderr. Every streaming claude handler
// buffers stderr unboundedly — a `--verbose` run or a lot of warnings could
// balloon memory per request. We keep the last N bytes so the tail is
// preserved for error reporting.
const STDERR_CAP_BYTES = 64 * 1024;
function appendStderr(buf, chunk) {
  const s = buf + chunk.toString();
  if (s.length <= STDERR_CAP_BYTES) return s;
  return s.slice(s.length - STDERR_CAP_BYTES);
}

// Shared streaming-claude primitive. Before this lived in 7 near-identical
// handler bodies with subtle drift (stderr sometimes dropped on zero-exit,
// some handlers didn't kill the subprocess when the renderer went away,
// exit-branch order varied). One helper, one place to fix bugs.
//
// Channel naming convention:
//   `${channelPrefix}-${streamJson ? 'data' : 'chunk'}-${requestId}` for output
//   `${channelPrefix}-done-${requestId}` for completion/error/cancel
// Callers supply the proc map (so cancel handlers can look up the proc),
// the prompt, the cwd, and any extra fields to merge into the done payload
// on successful (zero-exit) completion.
function spawnClaudeStream({
  requestId,
  procMap,
  channelPrefix,
  sender,
  cwd,
  prompt,
  streamJson = false,
  extraDoneFields = null,
}) {
  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  const args = streamJson
    ? ['-p', prompt, '--output-format', 'stream-json', '--verbose']
    : ['-p', prompt];
  const proc = spawn(claudeBin, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procMap.set(requestId, proc);

  const chunkChannel = `${channelPrefix}-${streamJson ? 'data' : 'chunk'}-${requestId}`;
  const doneChannel = `${channelPrefix}-done-${requestId}`;

  let stderrBuf = '';
  proc.stdout.on('data', (chunk) => {
    if (!sender.isDestroyed()) sender.send(chunkChannel, chunk.toString());
  });
  proc.stderr.on('data', (chunk) => { stderrBuf = appendStderr(stderrBuf, chunk); });
  proc.on('error', (err) => {
    procMap.delete(requestId);
    if (!sender.isDestroyed()) sender.send(doneChannel, { error: err.message });
  });
  proc.on('exit', (code, signal) => {
    procMap.delete(requestId);
    if (sender.isDestroyed()) return;
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      sender.send(doneChannel, { cancelled: true });
    } else if (code !== 0) {
      sender.send(doneChannel, { error: stderrBuf.trim() || `claude exited with code ${code}` });
    } else {
      const payload = { ok: true, stderr: stderrBuf && stderrBuf.trim() ? stderrBuf.trim() : undefined };
      if (extraDoneFields) Object.assign(payload, extraDoneFields);
      sender.send(doneChannel, payload);
    }
  });

  // If the renderer goes away while the stream is in flight (window close,
  // reload, crash), kill the subprocess. Previously the proc would keep
  // running to natural completion, silently eating Anthropic quota.
  sender.once('destroyed', () => {
    if (!proc.killed) { try { proc.kill('SIGTERM'); } catch {} }
  });

  return proc;
}

// Tiny helper that produces the cancel handler function for a given proc map.
// All 7 cancel handlers were identical modulo the map reference.
function makeClaudeCancelHandler(procMap) {
  return (_event, { requestId }) => {
    const proc = procMap.get(requestId);
    if (!proc) return { ok: false };
    try { proc.kill('SIGTERM'); } catch {}
    return { ok: true };
  };
}

// Persistent log file — ring buffer is in-memory only, which loses context
// across a crash. Keep a small rotating file in userData so users can attach
// it to a bug report even after the app restarts.
const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024;   // rotate at 2MB
const LOG_FILE_KEEP = 3;                       // keep klaussy.log + .1 + .2
let _logFilePath = null;
let _logRotating = false;
function getLogFilePath() {
  if (_logFilePath) return _logFilePath;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    _logFilePath = path.join(dir, 'klaussy.log');
  } catch {}
  return _logFilePath;
}
function rotateLogFile(file) {
  if (_logRotating) return;
  _logRotating = true;
  try {
    for (let i = LOG_FILE_KEEP - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      const to = `${file}.${i}`;
      try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch {}
    }
  } finally {
    _logRotating = false;
  }
}
function appendLogLine(line) {
  const file = getLogFilePath();
  if (!file) return;
  try {
    fs.appendFileSync(file, line + '\n');
    const st = fs.statSync(file);
    if (st.size >= LOG_FILE_MAX_BYTES) rotateLogFile(file);
  } catch {}
}

function captureLog(level, args) {
  let msg;
  try {
    msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  } catch {
    msg = '[log arg not serializable]';
  }
  msg = scrubLogMsg(msg);
  const ts = new Date().toISOString();
  logBuffer.push({ time: ts, level, msg });
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  appendLogLine(`${ts} ${level.toUpperCase()} ${msg}`);
}

console.log = function (...args) { captureLog('log', args); origConsoleLog.apply(console, args); };
console.error = function (...args) { captureLog('error', args); origConsoleError.apply(console, args); };
console.warn = function (...args) { captureLog('warn', args); origConsoleWarn.apply(console, args); };

// Also capture uncaught errors
process.on('uncaughtException', (err) => {
  captureLog('error', ['Uncaught:', err.stack || err.message]);
  origConsoleError.call(console, 'Uncaught:', err);
});

process.on('unhandledRejection', (reason) => {
  captureLog('error', ['Unhandled rejection:', String(reason)]);
  origConsoleError.call(console, 'Unhandled rejection:', reason);
});

// Persist repo path in a simple JSON file in userData
function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
  } catch {
    return {};
  }
}

// `saveConfig` has ~64 call sites including a 10s auto-save timer, prefs
// changes, PR-review cache writes, and notify-pref updates. Previously this
// was read-modify-write into the final path with no locking: two overlapping
// calls could each read the same prior state, merge their own field, and
// whoever wrote last would lose the first caller's field. A crash mid-write
// would also truncate config.json and wipe every saved session / project.
//
// Fix: atomic writes via tmp+rename, serialized behind a single in-flight
// promise so overlapping callers coalesce to sequential write passes. The
// read inside each pass sees the freshly-written state from the previous
// pass, so field merges compose correctly.
let _saveConfigQueue = Promise.resolve();
function saveConfig(config) {
  _saveConfigQueue = _saveConfigQueue.then(() => {
    try {
      const configPath = getConfigPath();
      let merged;
      try {
        const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        merged = Object.assign(existing, config);
      } catch {
        merged = config;
      }
      const tmp = configPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
      fs.renameSync(tmp, configPath);
    } catch (err) {
      // Surface to the log ring so disk-full / permission issues aren't silent.
      try { console.error('saveConfig failed:', err.message); } catch {}
    }
  });
  return _saveConfigQueue;
}

function getWorktreeDir(repoPath) {
  return path.join(path.dirname(repoPath), 'klaus-worktrees');
}

// One-time migration: the original PR review cache (G-series) stored reviews
// under `config.prReviews[owner/repo#n] = { review, savedAt }`. The current
// cache (G7) is file-per-PR at `userData/pr-review-cache/<owner>-<repo>-<n>.json`
// with a richer shape. We ran both in parallel for a release, which let saves
// from one path invisibly diverge from the other. Bring the legacy entries
// forward on startup and drop the config key so there's exactly one cache.
function migratePrReviewCache() {
  try {
    const config = loadConfig();
    const legacy = config.prReviews;
    if (!legacy || typeof legacy !== 'object' || Object.keys(legacy).length === 0) return;

    const dir = path.join(app.getPath('userData'), 'pr-review-cache');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    let migrated = 0;
    for (const [key, value] of Object.entries(legacy)) {
      // Legacy key shape: "owner/repo#n"
      const hashAt = key.lastIndexOf('#');
      if (hashAt <= 0) continue;
      const repoFull = key.slice(0, hashAt);
      const number = key.slice(hashAt + 1);
      const slashAt = repoFull.indexOf('/');
      if (slashAt <= 0) continue;
      const owner = repoFull.slice(0, slashAt);
      const repo = repoFull.slice(slashAt + 1);
      if (!owner || !repo || !number) continue;

      const safe = `${owner}-${repo}-${number}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const target = path.join(dir, safe + '.json');
      // Don't clobber the new-format cache if it's already populated — the
      // new data is strictly richer (findingState, per-finding usage, etc.)
      // and a legacy write here would overwrite it.
      if (fs.existsSync(target)) continue;

      const out = {
        savedAt: (value && value.savedAt) || new Date().toISOString(),
        finalText: (value && value.review) || '',
      };
      try {
        fs.writeFileSync(target, JSON.stringify(out, null, 2));
        migrated++;
      } catch {}
    }

    // saveConfig merges via Object.assign. To actually remove `prReviews`
    // from disk we set it to undefined (copied by Object.assign, dropped by
    // JSON.stringify) rather than deleting the key locally.
    config.prReviews = undefined;
    saveConfig(config);
    if (migrated > 0) {
      console.log(`pr-review-cache: migrated ${migrated} legacy entries to userData/pr-review-cache/`);
    }
  } catch (err) {
    console.error('pr-review-cache migration failed:', err && err.message);
  }
}
migratePrReviewCache();

// Collect every filesystem root the renderer is allowed to read/write. Used
// by read-file/write-file/read-files-bulk — an XSS in the renderer must not
// be able to hand us ~/.ssh/id_rsa or ~/.config/gh/hosts.yml.
function getRendererAllowedRoots() {
  const roots = new Set();
  try {
    const config = loadConfig();
    if (config.repoPath) roots.add(config.repoPath);
    if (Array.isArray(config.projects)) {
      for (const p of config.projects) if (p && p.path) roots.add(p.path);
    }
  } catch {}
  for (const inst of instances.values()) {
    if (inst && inst.worktreePath) roots.add(inst.worktreePath);
  }
  // Klaussy-owned directories (pr-checkouts clones, userData for caches).
  try { roots.add(app.getPath('userData')); } catch {}
  return Array.from(roots);
}

// Check if `candidate` resolves under any known renderer-allowed root.
// Returns the canonical resolved path on success, null on reject.
function pathUnderAnyRoot(candidate) {
  for (const root of getRendererAllowedRoots()) {
    const safe = pathUnder(root, candidate);
    if (safe) return safe;
  }
  return null;
}

// Resolve `candidate` (absolute or relative to `root`) and confirm the final
// real path is contained within `root`'s real path. Refuses traversal (`..`)
// and symlink escapes. Returns the canonical absolute path, or null on reject.
// Use for every IPC that takes a filesystem path from the renderer.
function pathUnder(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string') return null;
  try {
    const rootReal = fs.realpathSync(root);
    const absCandidate = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(rootReal, candidate);
    // realpath only works if the path exists. For write targets the file may
    // not exist yet — realpath the parent dir instead and rejoin the basename.
    let resolved;
    try {
      resolved = fs.realpathSync(absCandidate);
    } catch {
      const parent = path.dirname(absCandidate);
      const parentReal = fs.realpathSync(parent);
      resolved = path.join(parentReal, path.basename(absCandidate));
    }
    const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
    if (resolved === rootReal || resolved.startsWith(rootWithSep)) return resolved;
    return null;
  } catch {
    return null;
  }
}

// Resolve the correct gh auth token for a given repo directory.
// Matches the remote owner (e.g. "steph-dove") to a logged-in gh account.
//
// Entries have a TTL — previously they lived forever, so after `gh auth switch`
// or `gh auth refresh` (external or internal), we'd keep sending a stale/revoked
// token on every outbound gh call. The `gh-switch-account` handler also clears
// the cache explicitly.
const GH_TOKEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const ghTokenCache = new Map(); // remote owner -> { token: string|null, at: ms }

function ghEnvForRepo(repoDir) {
  try {
    // Get the remote URL
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoDir, stdio: 'pipe',
    }).toString().trim();

    // Extract owner from SSH or HTTPS remote
    // ssh: git@github.com:owner/repo.git  https: https://github.com/owner/repo.git
    // Accept arbitrary hostnames so GitHub Enterprise (github.corp.example)
    // works the same way as github.com.
    let owner;
    const m = remoteUrl.match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?$/);
    if (m) owner = m[1];
    if (!owner) return {};

    const cached = ghTokenCache.get(owner);
    if (cached && (Date.now() - cached.at) < GH_TOKEN_CACHE_TTL_MS) {
      if (cached.token) return { GH_TOKEN: cached.token };
      return {};
    }

    // Try to get a token for this owner from gh auth
    try {
      const token = execFileSync('gh', ['auth', 'token', '--user', owner], {
        stdio: 'pipe', timeout: 5000,
      }).toString().trim();
      if (token) {
        ghTokenCache.set(owner, { token, at: Date.now() });
        return { GH_TOKEN: token };
      }
    } catch {}

    ghTokenCache.set(owner, { token: null, at: Date.now() });
    return {};
  } catch {
    return {};
  }
}

function ghExec(args, opts) {
  const env = ghEnvForRepo(opts.cwd);
  return execFileSync('gh', args, {
    ...opts,
    env: { ...process.env, ...env },
  });
}

// Async variant for background work (timers, polling) — sync ghExec freezes
// the main thread for the full gh round-trip, which is unacceptable at
// 30-second cadence across N tasks.
async function ghExecP(args, opts) {
  const env = ghEnvForRepo(opts && opts.cwd);
  return execFileP('gh', args, {
    ...(opts || {}),
    env: { ...process.env, ...env },
  });
}

// Process `items` in parallel with at most `cap` in flight at once. Used by
// background timers so a 20-task setup doesn't spawn 20 simultaneous `git
// fetch` subprocesses — we keep to `cap` workers and let them drain the queue.
async function runWithConcurrency(items, cap, worker) {
  const queue = items.slice();
  const active = [];
  for (let i = 0; i < Math.min(cap, queue.length); i++) {
    active.push((async () => {
      while (queue.length) {
        const next = queue.shift();
        try { await worker(next); } catch (_) { /* silent — background */ }
      }
    })());
  }
  await Promise.all(active);
}

// Harden every BrowserWindow we create:
//  * deny `window.open` / `target="_blank"` — renderer must go through the
//    scheme-allowlisted `open-external` IPC for outbound links.
//  * block navigation away from file:// — otherwise an XSS can set
//    `window.location = 'https://evil'` and the attacker page inherits the
//    preload (and thus `window.klaus.*`).
//  * when the webContents is destroyed (reload, close, crash), kill any
//    LSP subprocesses it started so they don't leak as zombie processes.
function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  win.webContents.on('destroyed', () => {
    try { lspManager.stopServersForWebContents(win.webContents); } catch {}
  });
}

function createWindow(opts) {
  opts = opts || {};
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Klaussy',
    icon: path.join(__dirname, 'icon.icns'),
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(win);

  var url = path.join(__dirname, 'renderer', 'index.html');
  if (opts.secondary) {
    win.loadFile(url, { query: { secondary: '1' } });
  } else {
    win.loadFile(url);
  }
  allWindows.add(win);
  win.on('closed', () => { allWindows.delete(win); });

  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = win;
  }

  return win;
}

// macOS apps launched from Finder/Dock get a minimal PATH from launchd
// (~/usr/bin:/bin:/usr/sbin:/sbin), missing brew + the user's local bin
// dirs where gh + claude usually live. Spawning them then errors with
// ENOENT. Prepend the well-known locations so the installed .app can find
// them regardless of how it was launched.
function fixSpawnPath() {
  const homedir = require('os').homedir();
  const candidates = [
    '/opt/homebrew/bin',          // Apple Silicon brew
    '/opt/homebrew/sbin',
    '/usr/local/bin',             // Intel brew + manual installs
    '/usr/local/sbin',
    path.join(homedir, '.local/bin'),
    path.join(homedir, 'bin'),
    path.join(homedir, '.cargo/bin'),
    '/Applications/Cursor.app/Contents/Resources/app/bin',
  ];
  const have = (process.env.PATH || '').split(':').filter(Boolean);
  const want = candidates.filter((p) => !have.includes(p));
  if (want.length) {
    process.env.PATH = want.concat(have).join(':');
  }
}
fixSpawnPath();

function checkExternalCLIs() {
  const deps = [
    { bin: 'gh', name: 'GitHub CLI', uses: 'PR review and GitHub features' },
    { bin: 'claude', name: 'Claude Code', uses: 'AI features (inline edits, ghost text, completions)' },
  ];
  const missing = [];
  let remaining = deps.length;
  deps.forEach((d) => {
    execFile('which', [d.bin], { timeout: 2000 }, (err) => {
      if (err) missing.push(d);
      if (--remaining === 0 && missing.length) {
        const detail = missing.map((m) => `• ${m.name} (${m.bin}) — used for ${m.uses}`).join('\n');
        dialog.showMessageBox({
          type: 'info',
          title: 'Optional CLIs not found',
          message: 'Klaussy will run, but some features need these CLIs on your PATH:',
          detail,
          buttons: ['OK'],
        });
      }
    });
  });
}

app.whenReady().then(() => {
  // Force the macOS app menu name. In dev (`npx electron .`) the bundled
  // Info.plist still says "Electron" — setName at startup overrides what
  // the menu template's `label: app.name` resolves to so the menu bar
  // shows "Klaussy" instead.
  app.setName('Klaussy');

  // Set dock icon on macOS using PNG (avoids icon cache issues with .icns)
  if (process.platform === 'darwin' && app.dock) {
    const { nativeImage } = require('electron');
    const iconPath = path.join(__dirname, 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      app.dock.setIcon(icon);
    }
  }

  // Custom menu without Edit menu paste (we handle it ourselves in the renderer)
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Logs',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-logs');
          },
        },
        {
          label: 'How to use Klaussy',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-how-to-use');
          },
        },
        {
          label: 'Skills && Commands',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-skills');
          },
        },
        {
          label: 'Memory (CLAUDE.md)',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-memory');
          },
        },
        {
          label: 'MCP Servers',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-mcp');
          },
        },
        {
          label: 'Plugins',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-plugins');
          },
        },
        {
          label: 'GitHub Accounts',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-gh-accounts');
          },
        },
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-shortcuts');
          },
        },
        {
          label: 'Send feedback…',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('show-feedback');
          },
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => { createWindow({ secondary: true }); },
        },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'close' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  createWindow();
  checkExternalCLIs();

  // Periodically save sessions in case quit events don't fire
  setInterval(() => {
    if (!isQuitting && instances.size > 0) {
      try { saveSessions(); } catch (err) { console.error('saveSessions failed:', err.message); }
    }
  }, 10000);

  // Start auto-fetch background interval
  startAutoFetch();
});

function shutdownAndSave() {
  if (!isQuitting) {
    isQuitting = true;
    try { saveSessions(); } catch (err) { console.error('saveSessions failed at shutdown:', err.message); }
  }
  for (const [, inst] of instances) {
    try { inst.pty.kill(); } catch {}
  }
  // saveConfig is now async (queued atomic writes). Return the tail of the
  // queue so callers can await the flush before quitting.
  return _saveConfigQueue;
}

app.on('window-all-closed', () => {
  if (allWindows.size === 0) {
    shutdownAndSave().finally(() => app.quit());
  }
});

let _beforeQuitFlushed = false;
app.on('before-quit', (event) => {
  // Notify all renderers to save UI state
  for (const win of allWindows) {
    if (!win.isDestroyed()) win.webContents.send('app-before-quit');
  }
  // Stop LSP servers here (merged from a second before-quit handler that
  // used to live further down the file).
  try { lspManager.stopAllServers(); } catch {}
  if (_beforeQuitFlushed) return;
  event.preventDefault();
  shutdownAndSave().finally(() => {
    _beforeQuitFlushed = true;
    app.quit();
  });
});

app.on('will-quit', () => {
  // shutdownAndSave already awaited in before-quit; keep idempotent call here
  // for the window-all-closed path.
  shutdownAndSave();
});

function saveSessions() {
  // Only overwrite savedSessions if there are active instances;
  // otherwise keep whatever was previously saved
  if (instances.size === 0) return;

  // Group claude instances by worktree so we can disambiguate when multiple
  // terminals share a worktree. Each instance owns its own session .jsonl.
  const claudeByWorktree = new Map();
  for (const [, inst] of instances) {
    const saveMode = inst.originalMode || inst.mode;
    if (saveMode !== 'claude') continue;
    if (!claudeByWorktree.has(inst.worktreePath)) claudeByWorktree.set(inst.worktreePath, []);
    claudeByWorktree.get(inst.worktreePath).push(inst);
  }

  // For each worktree, resolve instance session IDs by picking .jsonl files
  // that (a) weren't present at that instance's spawn and (b) haven't already
  // been claimed by another instance on the same worktree. This covers fresh
  // spawns (detect picks up the new file) and resumes where Claude forks the
  // session into a new .jsonl (detect supersedes the initial resume id).
  for (const [, insts] of claudeByWorktree) {
    insts.sort((a, b) => (a.spawnTime || 0) - (b.spawnTime || 0));
    const claimed = new Set();
    for (const inst of insts) {
      const detected = detectClaudeSessionId(inst, claimed);
      if (detected) inst.claudeSessionId = detected;
      if (inst.claudeSessionId) claimed.add(inst.claudeSessionId);
    }
  }

  const config = loadConfig();
  const sessions = [];
  for (const [, inst] of instances) {
    const saveMode = inst.originalMode || inst.mode;
    const sessionId = saveMode === 'claude'
      ? (inst.claudeSessionId || findLatestSessionId(inst.worktreePath))
      : null;
    sessions.push({
      sessionId: sessionId,
      name: inst.name,
      worktreePath: inst.worktreePath,
      branch: inst.branch,
      mode: saveMode,
      savedAt: new Date().toISOString(),
    });
  }
  config.savedSessions = sessions;
  saveConfig(config);
}

function listSessionFiles(worktreePath) {
  const home = process.env.HOME || require('os').homedir();
  if (!home || !worktreePath) return [];
  const claudeDir = path.join(home, '.claude', 'projects');
  const encodedPath = worktreePath.replace(/\//g, '-');
  const projectDir = path.join(claudeDir, encodedPath);
  try {
    if (!fs.existsSync(projectDir)) return [];
    return fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        // bigint: true gives `ctimeNs` at nanosecond precision. APFS only
        // exposes 1s / sub-ms granularity for `ctimeMs`, which meant two
        // sessions spawned in the same second could tie in a sort and swap
        // identities on resume. ns-precision is stable across tasks.
        const st = fs.statSync(path.join(projectDir, f), { bigint: true });
        return {
          name: f,
          sessionId: f.replace('.jsonl', ''),
          mtime: Number(st.mtimeMs),
          ctime: Number(st.ctimeMs),
          ctimeNs: st.ctimeNs,  // BigInt
        };
      });
  } catch {
    return [];
  }
}

function snapshotSessionIds(worktreePath) {
  return new Set(listSessionFiles(worktreePath).map(f => f.sessionId));
}

// Find the session id for a freshly-spawned claude instance: pick the .jsonl
// that didn't exist at spawn and isn't claimed by another instance. Prefer the
// oldest-created "new" file so concurrent spawns pair up in spawn order.
function detectClaudeSessionId(inst, claimed) {
  const preSpawn = inst.preSpawnSessionIds || new Set();
  const files = listSessionFiles(inst.worktreePath)
    .filter(f => !preSpawn.has(f.sessionId))
    .filter(f => !claimed || !claimed.has(f.sessionId))
    // Sort on ns-precision ctime. BigInt subtraction returns BigInt — convert
    // to Number via sign comparison since Array.sort wants a regular number.
    .sort((a, b) => {
      if (a.ctimeNs < b.ctimeNs) return -1;
      if (a.ctimeNs > b.ctimeNs) return 1;
      return 0;
    });
  return files.length > 0 ? files[0].sessionId : null;
}

function findLatestSessionId(worktreePath) {
  const files = listSessionFiles(worktreePath).sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].sessionId : null;
}

// ---- Idle / Prompt Detection (A1) ----

const IDLE_TIMEOUT_MS = 15000;
const NOTIFY_COOLDOWN_MS = 30000;
const ROLLING_BUFFER_SIZE = 500;

const PROMPT_PATTERNS = [
  /\(y\/n\)\s*$/i,
  /\(Y\/n\)\s*$/,
  /\(yes\/no\)\s*$/i,
  /Do you want to proceed/i,
  /Press Enter to continue/i,
  /Allow\s.*\?/i,
  /❯\s*$/,
];

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]/g, '');
}

function isAnyWindowFocused() {
  for (const win of allWindows) {
    if (!win.isDestroyed() && win.isFocused()) return true;
  }
  for (const [, inst] of instances) {
    for (const win of inst.popoutWindows) {
      if (!win.isDestroyed() && win.isFocused()) return true;
    }
  }
  return false;
}

function sendIdleNotification(inst, reason) {
  if (!inst.notifyEnabled) return;
  if (Date.now() - inst.lastNotifyTime < NOTIFY_COOLDOWN_MS) return;
  if (isAnyWindowFocused()) return;

  const notification = new Notification({
    title: `Klaussy — ${inst.name}`,
    body: reason,
    silent: false,
  });

  notification.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('notification-clicked', { id: inst.id });
    }
  });

  notification.show();
  inst.lastNotifyTime = Date.now();
}

function processIdleDetection(inst, data) {
  if (inst.mode !== 'claude') return;

  inst.lastDataTime = Date.now();
  inst.notifiedIdle = false;

  // Update rolling buffer
  const stripped = stripAnsi(data);
  inst.recentOutput = (inst.recentOutput + stripped).slice(-ROLLING_BUFFER_SIZE);

  // Reset quiet timer
  if (inst.quietTimer) clearTimeout(inst.quietTimer);
  inst.quietTimer = setTimeout(() => {
    if (inst.alive && inst.mode === 'claude' && !inst.notifiedIdle) {
      inst.notifiedIdle = true;
      sendIdleNotification(inst, 'Claude has been idle for 15s');
    }
  }, IDLE_TIMEOUT_MS);

  // Check prompt patterns against recent output tail
  const tail = inst.recentOutput.slice(-200);
  for (const pattern of PROMPT_PATTERNS) {
    if (pattern.test(tail)) {
      sendIdleNotification(inst, 'Claude is waiting for input');
      break;
    }
  }
}

function initIdleDetectionFields(inst) {
  const config = loadConfig();
  inst.notifyEnabled = config.notifyPrefs?.[inst.name] !== false;
  inst.lastDataTime = 0;
  inst.quietTimer = null;
  inst.notifiedIdle = false;
  inst.lastNotifyTime = 0;
  inst.recentOutput = '';
}

function clearIdleTimer(inst) {
  if (inst.quietTimer) {
    clearTimeout(inst.quietTimer);
    inst.quietTimer = null;
  }
}

// ---- IPC Handlers ----

// ---- Session Persistence ----

ipcMain.handle('list-saved-sessions', () => {
  const config = loadConfig();
  return config.savedSessions || [];
});

ipcMain.handle('resume-session', (_event, { sessionId, name, worktreePath, branch, mode }) => {
  // Verify the worktree still exists
  if (!fs.existsSync(worktreePath)) {
    return { error: 'Worktree no longer exists: ' + worktreePath };
  }
  const resumeMode = mode || 'claude';
  return spawnInWorktree(name, worktreePath, branch, resumeMode, resumeMode === 'claude' ? sessionId : null);
});

ipcMain.handle('save-ui-state', (_event, state) => {
  const config = loadConfig();
  config.uiState = state;
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('get-ui-state', () => {
  const config = loadConfig();
  return config.uiState || null;
});

ipcMain.handle('get-latest-session', (_event, { worktreePath }) => {
  return findLatestSessionId(worktreePath);
});

ipcMain.handle('clear-saved-sessions', () => {
  const config = loadConfig();
  config.savedSessions = [];
  saveConfig(config);
  return { ok: true };
});

// Remove a single saved session by stable identity (worktreePath + sessionId).
// Renderer used to splice-by-index in a closure, which silently deleted the
// wrong row after any prior dismiss shifted the array.
ipcMain.handle('dismiss-saved-session', (_event, { worktreePath, sessionId }) => {
  const config = loadConfig();
  const before = config.savedSessions || [];
  config.savedSessions = before.filter((s) => {
    if (!s || s.worktreePath !== worktreePath) return true;
    // If the dismissed row carries a sessionId, only drop that exact row;
    // otherwise drop every row for the worktree (shell-only saves).
    if (sessionId) return s.sessionId !== sessionId;
    return false;
  });
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('select-repo', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select the git repository to manage',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const repoPath = result.filePaths[0];

  // Validate it's a git repo
  try {
    execSync('git rev-parse --git-dir', { cwd: repoPath, stdio: 'pipe' });
  } catch {
    dialog.showErrorBox('Not a git repository', `${repoPath} is not a git repository.`);
    return null;
  }

  const config = loadConfig();
  config.repoPath = repoPath;
  saveConfig(config);
  return repoPath;
});

ipcMain.handle('get-repo', () => {
  const config = loadConfig();
  if (config.repoPath) return config.repoPath;
  // Fall back to first project if repoPath is missing
  if (config.projects && config.projects.length > 0) {
    config.repoPath = config.projects[0].path;
    saveConfig(config);
    return config.repoPath;
  }
  return null;
});

ipcMain.handle('create-task', async (_event, { name, repoPath, mode, basePath, envVars, baseBranch: requestedBase }) => {
  // Validate repoPath is a git repo
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoPath, stdio: 'pipe' });
  } catch {
    return { error: 'Active project is not a git repository. Remove and re-add the project to initialize git.' };
  }

  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const branch = sanitized;

  // Match klausify CLI convention: worktree as sibling of repo
  const repoBasename = path.basename(repoPath);
  const worktreeDir = basePath || path.dirname(repoPath);
  const worktreePath = path.join(worktreeDir, repoBasename + '-' + sanitized);

  if (fs.existsSync(worktreePath)) {
    return { error: 'Worktree directory already exists: ' + worktreePath };
  }

  // Resolve the base. Caller can pass an explicit branch (chosen from the
  // dropdown); otherwise fall back to origin/HEAD or the usual defaults.
  let baseBranch = (requestedBase || '').trim();
  if (baseBranch) {
    try {
      execFileSync('git', ['rev-parse', '--verify', baseBranch], { cwd: repoPath, stdio: 'pipe' });
    } catch {
      try {
        execFileSync('git', ['branch', baseBranch, 'origin/' + baseBranch], { cwd: repoPath, stdio: 'pipe' });
      } catch (err) {
        return { error: 'Base branch "' + baseBranch + '" not found locally or on origin.' };
      }
    }
  }
  if (!baseBranch) {
    try {
      baseBranch = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', {
        cwd: repoPath, stdio: 'pipe',
      }).toString().trim().replace('origin/', '');
    } catch {
      for (const candidate of ['main', 'master', 'develop']) {
        try {
          execFileSync('git', ['rev-parse', '--verify', candidate], { cwd: repoPath, stdio: 'pipe' });
          baseBranch = candidate;
          break;
        } catch {}
      }
      if (!baseBranch) baseBranch = 'main';
    }
  }

  // Create the worktree (matching klausify CLI: git worktree add ../<repo>-<branch> -b <branch>)
  try {
    execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, baseBranch], {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch (err) {
    return { error: `Failed to create worktree: ${err.stderr ? err.stderr.toString() : err.message}` };
  }

  // Verify the worktree was created in the correct repo
  try {
    const wtTopLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: worktreePath, stdio: 'pipe'
    }).toString().trim();
    console.log(`Worktree created: ${worktreePath} (repo: ${wtTopLevel}, base: ${baseBranch})`);
  } catch {}

  await runKlausifyInit(worktreePath, baseBranch);
  return spawnInWorktree(name, worktreePath, branch, mode || 'claude', null, envVars);
});

// List branches for a repo (local + remote, excluding those already checked out in worktrees)
ipcMain.handle('list-branches', async (_event, { repoPath }) => {
  try {
    await execFileP('git', ['rev-parse', '--git-dir'], { cwd: repoPath });
  } catch {
    return { error: 'Not a git repository: ' + repoPath };
  }

  // Get branches already checked out in worktrees
  let worktreeBranches = new Set();
  try {
    const { stdout: wtList } = await execFileP('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    for (const line of wtList.split('\n')) {
      if (line.startsWith('branch ')) {
        worktreeBranches.add(line.replace('branch refs/heads/', ''));
      }
    }
  } catch {}

  let branches = [];
  try {
    const { stdout } = await execFileP('git', ['branch', '-a', '--format', '%(refname:short)\t%(objectname:short)\t%(committerdate:relative)'], {
      cwd: repoPath,
    });
    const raw = stdout.trim();
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const [ref, hash, date] = line.split('\t');
      // Skip HEAD pointers and branches already in worktrees
      if (ref.includes('/HEAD')) continue;
      // For remote branches, strip origin/ prefix for the local name
      let localName = ref;
      let isRemote = false;
      if (ref.startsWith('origin/')) {
        localName = ref.replace('origin/', '');
        isRemote = true;
      }
      if (worktreeBranches.has(localName)) continue;
      branches.push({ ref, localName, hash, date, isRemote });
    }
  } catch (err) {
    return { error: 'Failed to list branches: ' + (err.stderr ? err.stderr.toString() : err.message) };
  }

  // Deduplicate: prefer local over remote
  const seen = new Map();
  for (const b of branches) {
    if (!seen.has(b.localName) || !b.isRemote) {
      seen.set(b.localName, b);
    }
  }

  // Resolve the default branch (origin/HEAD target). Falls back to the usual
  // suspects if the symbolic ref isn't set on the remote.
  let defaultBranch = '';
  try {
    defaultBranch = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', {
      cwd: repoPath, stdio: 'pipe',
    }).toString().trim().replace('origin/', '');
  } catch {
    for (const candidate of ['main', 'master', 'develop']) {
      try {
        execFileSync('git', ['rev-parse', '--verify', candidate], { cwd: repoPath, stdio: 'pipe' });
        defaultBranch = candidate;
        break;
      } catch {}
    }
  }

  return { branches: Array.from(seen.values()), defaultBranch };
});

// Create worktree from an existing branch
ipcMain.handle('checkout-branch', async (_event, { repoPath, branch, mode, basePath, envVars }) => {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoPath, stdio: 'pipe' });
  } catch {
    return { error: 'Not a git repository: ' + repoPath };
  }

  const sanitized = branch.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const repoBasename = path.basename(repoPath);
  const worktreeDir = basePath || path.dirname(repoPath);
  const worktreePath = path.join(worktreeDir, repoBasename + '-' + sanitized);

  if (fs.existsSync(worktreePath)) {
    return { error: 'Worktree directory already exists: ' + worktreePath };
  }

  try {
    // Check if it's a local branch already
    try {
      execFileSync('git', ['rev-parse', '--verify', branch], { cwd: repoPath, stdio: 'pipe' });
    } catch {
      // If not local, create tracking branch from origin
      execFileSync('git', ['branch', branch, 'origin/' + branch], { cwd: repoPath, stdio: 'pipe' });
    }
    execFileSync('git', ['worktree', 'add', worktreePath, branch], {
      cwd: repoPath, stdio: 'pipe',
    });
  } catch (err) {
    return { error: 'Failed to create worktree: ' + (err.stderr ? err.stderr.toString() : err.message) };
  }

  await runKlausifyInit(worktreePath);
  const name = sanitized;
  return spawnInWorktree(name, worktreePath, branch, mode || 'claude', null, envVars);
});

// Attach to an existing worktree directory
ipcMain.handle('attach-worktree', async (_event, { worktreePath, mode }) => {
  // Validate it's a git worktree / repo
  try {
    execSync('git rev-parse --git-dir', { cwd: worktreePath, stdio: 'pipe' });
  } catch {
    return { error: 'Selected directory is not a git repository or worktree.' };
  }

  // Get branch name for display
  let branch = '';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: worktreePath,
      stdio: 'pipe',
    }).toString().trim();
  } catch {}

  const name = path.basename(worktreePath);
  return spawnInWorktree(name, worktreePath, branch, mode || 'claude');
});

// Browse for a directory (used by the existing worktree tab)
ipcMain.handle('browse-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select existing worktree directory',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Open a plain directory (not a git worktree). Git-dependent panels will
// degrade gracefully because `branch` is empty — auto-fetch and CI polling
// explicitly skip instances without a branch.
ipcMain.handle('open-folder', async (_event, { folderPath, mode }) => {
  if (!folderPath) {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select folder to open',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    folderPath = result.filePaths[0];
  }
  try {
    if (!fs.statSync(folderPath).isDirectory()) {
      return { error: 'Not a directory: ' + folderPath };
    }
  } catch {
    return { error: 'Folder does not exist: ' + folderPath };
  }
  const name = path.basename(folderPath) || 'folder';
  return spawnInWorktree(name, folderPath, '', mode || 'claude');
});

let klausifyAvailable = null; // null = unchecked, true/false after first check

function checkKlausifyInstalled() {
  if (klausifyAvailable !== null) return klausifyAvailable;
  try {
    execFileSync('klausify', ['--version'], { stdio: 'pipe', timeout: 5000 });
    klausifyAvailable = true;
  } catch {
    klausifyAvailable = false;
  }
  return klausifyAvailable;
}

async function promptKlausifyInstall() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Install with pipx', 'Skip'],
    defaultId: 0,
    cancelId: 1,
    title: 'klausify not found',
    message: 'klausify CLI is not installed.',
    detail: 'klausify sets up Claude Code boilerplate (CLAUDE.md, etc.) for each new worktree.\n\nInstall it now with pipx?',
  });
  if (response !== 0) return false;
  try {
    execSync('pipx install klausify', { stdio: 'pipe', timeout: 60000 });
    klausifyAvailable = true;
    return true;
  } catch (err) {
    dialog.showErrorBox('Installation failed', 'Could not install klausify:\n' + (err.stderr ? err.stderr.toString() : err.message) + '\n\nTry manually: pipx install klausify');
    return false;
  }
}

async function runKlausifyInit(worktreePath, baseBranch) {
  if (!checkKlausifyInstalled()) {
    const installed = await promptKlausifyInstall();
    if (!installed) return;
  }
  try {
    const args = ['init', '--repo', worktreePath, '--skip-enrich'];
    if (baseBranch) args.push('--base-branch', baseBranch);
    execFileSync('klausify', args, { stdio: 'pipe', timeout: 30000 });
    console.log('klausify init completed for', worktreePath);
  } catch (err) {
    console.warn('klausify init failed (non-fatal):', err.message);
  }
}

// Drop any renderer-supplied env var whose name would let an attacker
// hijack the PTY's dynamic linker or Node's startup (LD_PRELOAD / DYLD_* /
// NODE_OPTIONS / PATH override / PYTHONPATH / RUBYOPT / PERL5LIB / etc.),
// or whose name isn't a plausible env-var identifier. Called for every
// PTY spawn + restart — a compromised renderer (via XSS) or a malicious
// pasted .env must not be able to inject dylib loads into the shell /
// claude / gh subprocesses.
const ENV_NAME_DENYLIST = /^(LD_|DYLD_|NODE_OPTIONS$|PATH$|PYTHONPATH$|RUBYOPT$|PERL5LIB$|RUBYLIB$|PYTHONSTARTUP$)/;
function sanitizeExtraEnv(extraEnv) {
  if (!extraEnv || typeof extraEnv !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(extraEnv)) {
    if (typeof k !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(k)) continue;
    if (ENV_NAME_DENYLIST.test(k)) continue;
    if (typeof v !== 'string') continue;
    out[k] = v;
  }
  return out;
}

function spawnInWorktree(name, worktreePath, branch, mode, resumeSessionId, extraEnv, prNumber) {
  const id = nextId++;
  const userShell = process.env.SHELL || '/bin/zsh';
  extraEnv = sanitizeExtraEnv(extraEnv);

  // 'claude' mode launches claude code, 'shell' mode launches a login shell
  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  let claudeCmd;
  if (mode === 'shell') {
    claudeCmd = null;
  } else if (resumeSessionId) {
    claudeCmd = `${claudeBin} --resume ${resumeSessionId}`;
  } else {
    claudeCmd = claudeBin;
  }

  const args = claudeCmd ? ['-l', '-c', claudeCmd] : ['-l'];
  const ptyProc = pty.spawn(userShell, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: worktreePath,
    env: { ...process.env, TERM: 'xterm-256color', ...(extraEnv || {}) },
  });

  const instance = {
    id, name, worktreePath, branch, mode, originalMode: mode,
    pty: ptyProc, alive: true, popoutWindows: new Set(), extraEnv: extraEnv || {},
    subTerminals: [], nextSubId: 1,
    spawnTime: Date.now(),
    preSpawnSessionIds: mode === 'claude' ? snapshotSessionIds(worktreePath) : new Set(),
    claudeSessionId: mode === 'claude' ? (resumeSessionId || null) : null,
    // G5: if this task was spawned from a PR review "Check out locally", the
    // PR number is recorded here so pr-for-branch can load the PR directly
    // instead of guessing from branch-name heuristics (which fail for fork
    // PRs where the local branch name differs from the original head ref).
    prNumber: prNumber || null,
    prBaseOwner: null,
    prBaseRepo: null,
  };
  initIdleDetectionFields(instance);
  instances.set(id, instance);

  ptyProc.onData((data) => {
    processIdleDetection(instance, data);
    for (const win of allWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-data-${id}`, data);
    }
    for (const win of instance.popoutWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-data-${id}`, data);
    }
  });

  ptyProc.onExit(({ exitCode }) => {
    clearIdleTimer(instance);
    // If this was a Claude session, auto-convert to shell in-place — but
    // only for natural exits. An explicit kill-task sets `killed`, and
    // restart-task sets `restarting`; neither should spawn a shell we'd
    // lose track of (kill-task already deleted the instances entry; the
    // orphan shell would have no Map entry and nothing could kill it).
    if (instance.mode === 'claude' && !isQuitting
        && !instance.killed && !instance.restarting) {
      convertInstanceToShell(instance);
      return;
    }
    instance.alive = false;
    for (const win of allWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-exit-${id}`, exitCode);
    }
    for (const win of instance.popoutWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-exit-${id}`, exitCode);
    }
  });

  // Start CI polling for this task
  startCIPolling(id, worktreePath, branch);

  return { id, name, worktreePath, branch, mode };
}

function convertInstanceToShell(inst) {
  sendIdleNotification(inst, 'Claude has exited');
  const id = inst.id;
  const userShell = process.env.SHELL || '/bin/zsh';
  const ptyProc = pty.spawn(userShell, ['-l'], {
    name: 'xterm-256color',
    cols: inst.pty.cols || 120,
    rows: inst.pty.rows || 30,
    cwd: inst.worktreePath,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  inst.pty = ptyProc;
  inst.alive = true;
  inst.mode = 'shell';

  ptyProc.onData((data) => {
    for (const win of allWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-data-${id}`, data);
    }
    for (const win of inst.popoutWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-data-${id}`, data);
    }
  });

  ptyProc.onExit(() => {
    inst.alive = false;
    for (const win of allWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-exit-${id}`);
    }
    for (const win of inst.popoutWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-exit-${id}`);
    }
  });

  // Notify all windows that this task is now a shell
  for (const win of allWindows) {
    if (!win.isDestroyed()) win.webContents.send('task-converted-to-shell', { id });
  }
}

ipcMain.handle('list-tasks', () => {
  return Array.from(instances.values()).map(({ id, name, worktreePath, branch, mode, alive }) => ({
    id, name, worktreePath, branch, mode, alive,
  }));
});

ipcMain.on('write-terminal', (_event, { id, data, subId }) => {
  const inst = instances.get(id);
  if (!inst) return;
  if (subId !== undefined && subId > 0) {
    const sub = inst.subTerminals.find(s => s.subId === subId);
    if (sub && sub.alive) sub.pty.write(data);
  } else if (inst.alive) {
    inst.pty.write(data);
  }
});

ipcMain.on('resize-terminal', (_event, { id, cols, rows, subId }) => {
  const inst = instances.get(id);
  if (!inst) return;
  if (subId !== undefined && subId > 0) {
    const sub = inst.subTerminals.find(s => s.subId === subId);
    if (sub && sub.alive) { try { sub.pty.resize(cols, rows); } catch {} }
  } else if (inst.alive) {
    try { inst.pty.resize(cols, rows); } catch {}
  }
});

// ---- Sub-terminal Multiplexing (Feature 5) ----

ipcMain.handle('add-sub-terminal', (_event, { taskId, label }) => {
  const inst = instances.get(taskId);
  if (!inst) return { error: 'Instance not found' };

  const subId = inst.nextSubId++;
  const userShell = process.env.SHELL || '/bin/zsh';
  const ptyProc = pty.spawn(userShell, ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: inst.worktreePath,
    env: { ...process.env, TERM: 'xterm-256color', ...(inst.extraEnv || {}) },
  });

  const sub = { subId, label: label || 'Shell', pty: ptyProc, alive: true };
  inst.subTerminals.push(sub);

  ptyProc.onData((data) => {
    for (const win of allWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-data-${taskId}-${subId}`, data);
    }
  });

  ptyProc.onExit(() => {
    sub.alive = false;
    for (const win of allWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-exit-${taskId}-${subId}`);
    }
  });

  return { subId, label: sub.label };
});

ipcMain.handle('kill-sub-terminal', (_event, { taskId, subId }) => {
  const inst = instances.get(taskId);
  if (!inst) return { error: 'Instance not found' };
  const idx = inst.subTerminals.findIndex(s => s.subId === subId);
  if (idx === -1) return { error: 'Sub-terminal not found' };
  const sub = inst.subTerminals[idx];
  try { sub.pty.kill(); } catch {}
  inst.subTerminals.splice(idx, 1);
  return { ok: true };
});

ipcMain.handle('kill-task', (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  // Mark BEFORE kill(): pty.kill is async, and the onExit handler checks
  // this flag to skip the Claude→shell auto-convert branch. Without it,
  // killing a Claude task would spawn an orphan shell with no instances
  // entry — nothing could find or stop it after this point.
  inst.killed = true;
  clearIdleTimer(inst);
  stopCIPolling(id);
  try { inst.pty.kill(); } catch {}
  // Kill all sub-terminals
  for (const sub of (inst.subTerminals || [])) {
    try { sub.pty.kill(); } catch {}
  }
  inst.alive = false;

  // Never delete worktrees or branches — only kill the process
  instances.delete(id);
  return { ok: true };
});

// Restart Claude in an existing worktree (after process exit)
ipcMain.handle('restart-task', (_event, { id, cols, rows }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  // Mark restarting BEFORE kill(): pty.kill is async and the stale exit
  // handler would otherwise race with the new-pty assignment below — in
  // particular if the instance was still in claude mode, the old-pty's
  // onExit would spawn a convert-shell and overwrite inst.pty right after
  // we set it on line below.
  inst.restarting = true;
  try { inst.pty.kill(); } catch {}

  // Resume as Claude — prefer this instance's tracked session so multiple
  // terminals on the same worktree don't collide on the "latest" .jsonl.
  const userShell = process.env.SHELL || '/bin/zsh';
  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  const resumeId = inst.claudeSessionId || findLatestSessionId(inst.worktreePath);
  const claudeCmd = resumeId ? `${claudeBin} --resume ${resumeId}` : claudeBin;
  inst.mode = 'claude';
  inst.spawnTime = Date.now();
  inst.preSpawnSessionIds = snapshotSessionIds(inst.worktreePath);
  inst.claudeSessionId = resumeId || null;

  const args = ['-l', '-c', claudeCmd];
  const ptyProc = pty.spawn(userShell, args, {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 30,
    cwd: inst.worktreePath,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  inst.pty = ptyProc;
  inst.alive = true;
  inst.recentOutput = '';
  inst.notifiedIdle = false;
  // New pty is live; clear the restart guard so this one's natural exit
  // (or future restarts) behave normally.
  inst.restarting = false;

  ptyProc.onData((data) => {
    processIdleDetection(inst, data);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`terminal-data-${id}`, data);
    }
    for (const win of inst.popoutWindows) {
      if (!win.isDestroyed()) win.webContents.send(`terminal-data-${id}`, data);
    }
  });

  // When this Claude exits, auto-convert to shell again
  ptyProc.onExit(() => {
    clearIdleTimer(inst);
    if (inst.mode === 'claude') {
      convertInstanceToShell(inst);
    } else {
      inst.alive = false;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(`terminal-exit-${id}`);
      }
    }
  });

  return { ok: true };
});

// Open URL in default browser. Scheme-restricted: a compromised renderer (or
// xterm's WebLinksAddon auto-detecting a file:// / javascript: / smb: token in
// the PTY stream) must not be able to hand an arbitrary URI to the OS opener.
const OPEN_EXTERNAL_ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
ipcMain.handle('open-external', (_event, { url }) => {
  if (typeof url !== 'string') return { error: 'url must be a string' };
  let parsed;
  try { parsed = new URL(url); } catch { return { error: 'invalid URL' }; }
  if (!OPEN_EXTERNAL_ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { error: `blocked scheme: ${parsed.protocol}` };
  }
  shell.openExternal(parsed.toString());
  return { ok: true };
});

// ---- Idle Notification Toggle ----

ipcMain.handle('set-notify-enabled', (_event, { id, enabled }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };
  inst.notifyEnabled = enabled;
  const config = loadConfig();
  if (!config.notifyPrefs) config.notifyPrefs = {};
  config.notifyPrefs[inst.name] = enabled;
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('get-notify-enabled', (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return true;
  return inst.notifyEnabled !== false;
});

// ---- About Info (A7) ----

ipcMain.handle('get-about-info', async () => {
  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  let claudeVersion = 'not found';
  try {
    claudeVersion = execFileSync(claudeBin, ['--version'], { stdio: 'pipe', timeout: 5000 }).toString().trim();
  } catch {}
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    claudePath: claudeBin,
    claudeVersion,
  };
});

// List Claude skills + slash commands from disk so users can discover what
// they have installed without leaving Klaussy. Walks user-level skills + a
// source per klausify project (most users keep skills per-repo, so showing
// just the active project would hide most of what they have).
ipcMain.handle('list-skills', async () => {
  const homedir = require('os').homedir();
  const sources = [
    { kind: 'user', label: 'user', skillsDir: path.join(homedir, '.claude', 'skills'), cmdsDir: path.join(homedir, '.claude', 'commands') },
  ];
  const config = loadConfig();
  const projects = config.projects || [];
  for (const p of projects) {
    if (!p || !p.path) continue;
    sources.push({
      kind: 'project',
      label: p.name || path.basename(p.path),
      skillsDir: path.join(p.path, '.claude', 'skills'),
      cmdsDir: path.join(p.path, '.claude', 'commands'),
    });
  }
  // Belt-and-suspenders: include the currently-active repo even if it
  // isn't in config.projects (rare, but happens during transient setup).
  const active = currentRepoPath();
  if (active && !projects.find((p) => p && p.path === active)) {
    sources.push({
      kind: 'project',
      label: path.basename(active),
      skillsDir: path.join(active, '.claude', 'skills'),
      cmdsDir: path.join(active, '.claude', 'commands'),
    });
  }

  function parseFrontmatter(text) {
    if (!text) return { name: '', description: '' };
    const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return { name: '', description: '' };
    const out = {};
    m[1].split('\n').forEach((line) => {
      const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
      if (!kv) return;
      let val = kv[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[kv[1]] = val;
    });
    return out;
  }

  const skills = [];
  const commands = [];

  for (const src of sources) {
    // Skills: each subdirectory of skillsDir is a skill; SKILL.md inside.
    try {
      const entries = fs.readdirSync(src.skillsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const skillFile = path.join(src.skillsDir, ent.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        const text = fs.readFileSync(skillFile, 'utf8');
        const fm = parseFrontmatter(text);
        skills.push({
          name: fm.name || ent.name,
          description: fm.description || '',
          source: src.label,
          path: skillFile,
        });
      }
    } catch (_) { /* dir doesn't exist — fine */ }

    // Slash commands: <name>.md files in commands dir.
    try {
      const entries = fs.readdirSync(src.cmdsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
        const file = path.join(src.cmdsDir, ent.name);
        const text = fs.readFileSync(file, 'utf8');
        const fm = parseFrontmatter(text);
        // Body after frontmatter for a fallback description.
        let body = text.replace(/^---[\s\S]*?\n---\s*/, '').trim();
        commands.push({
          name: '/' + ent.name.replace(/\.md$/, ''),
          description: fm.description || body.split('\n')[0].slice(0, 160),
          source: src.label,
          path: file,
        });
      }
    } catch (_) {}
  }

  // Sort: user first, then projects alphabetically by label, then by name
  // within each source.
  const sorter = (a, b) => {
    if (a.source === 'user' && b.source !== 'user') return -1;
    if (b.source === 'user' && a.source !== 'user') return 1;
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.name.localeCompare(b.name);
  };
  skills.sort(sorter);
  commands.sort(sorter);
  return { skills, commands };
});

ipcMain.handle('open-skill-file', (_event, { filePath }) => {
  if (!filePath) return { ok: false };
  const claudeHome = path.join(require('os').homedir(), '.claude');
  const safe = pathUnder(claudeHome, filePath);
  if (!safe) return { error: 'path outside ~/.claude' };
  shell.openPath(safe);
  return { ok: true };
});

ipcMain.handle('read-skill-file', (_event, { filePath }) => {
  if (!filePath) return { error: 'No file path' };
  const claudeHome = path.join(require('os').homedir(), '.claude');
  const safe = pathUnder(claudeHome, filePath);
  if (!safe) return { error: 'path outside ~/.claude' };
  try {
    const content = fs.readFileSync(safe, 'utf8');
    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-skill-file', (_event, { filePath, content }) => {
  if (!filePath) return { error: 'No file path' };
  if (typeof content !== 'string') return { error: 'Content must be a string' };
  const claudeHome = path.join(require('os').homedir(), '.claude');
  const safe = pathUnder(claudeHome, filePath);
  if (!safe) return { error: 'path outside ~/.claude' };
  try {
    fs.writeFileSync(safe, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// List CLAUDE.md memory files across scopes. Each scope has at most one
// memory file — the dialog uses this to show what's there vs. missing.
ipcMain.handle('list-memory-files', () => {
  const homedir = require('os').homedir();
  const out = [];
  const scopes = [
    { kind: 'user', label: 'user', file: path.join(homedir, '.claude', 'CLAUDE.md') },
  ];
  const config = loadConfig();
  const projects = config.projects || [];
  for (const p of projects) {
    if (!p || !p.path) continue;
    // Project root is the canonical location; fall back to .claude/CLAUDE.md
    // if the user keeps it there instead.
    const rootFile = path.join(p.path, 'CLAUDE.md');
    const dotFile = path.join(p.path, '.claude', 'CLAUDE.md');
    const file = fs.existsSync(rootFile) ? rootFile : (fs.existsSync(dotFile) ? dotFile : rootFile);
    scopes.push({ kind: 'project', label: p.name || path.basename(p.path), file });
  }
  for (const s of scopes) {
    out.push({
      scope: s.label,
      kind: s.kind,
      path: s.file,
      exists: fs.existsSync(s.file),
    });
  }
  return { entries: out };
});

// MCP server inventory. Reads user + project mcp configs from the canonical
// locations claude looks at. Returns each entry's name, command, args, env
// vars (keys only — never values) so the dialog can render a status table.
ipcMain.handle('list-mcp-servers', () => {
  const homedir = require('os').homedir();
  const sources = [
    { kind: 'user', label: 'user', files: [
      path.join(homedir, '.claude.json'),
      path.join(homedir, '.claude', 'mcp.json'),
    ] },
  ];
  const config = loadConfig();
  const projects = config.projects || [];
  for (const p of projects) {
    if (!p || !p.path) continue;
    sources.push({
      kind: 'project',
      label: p.name || path.basename(p.path),
      files: [
        path.join(p.path, '.mcp.json'),
        path.join(p.path, '.claude', 'mcp.json'),
      ],
    });
  }
  const servers = [];
  for (const src of sources) {
    for (const file of src.files) {
      if (!fs.existsSync(file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const map = (raw && raw.mcpServers) || {};
        for (const [name, def] of Object.entries(map)) {
          if (!def || typeof def !== 'object') continue;
          servers.push({
            name,
            source: src.label,
            sourceKind: src.kind,
            sourceFile: file,
            command: def.command || '',
            args: Array.isArray(def.args) ? def.args : [],
            envKeys: def.env && typeof def.env === 'object' ? Object.keys(def.env) : [],
            type: def.type || 'stdio',
          });
        }
      } catch (_) { /* malformed config — skip silently */ }
    }
  }
  servers.sort((a, b) => {
    if (a.sourceKind === 'user' && b.sourceKind !== 'user') return -1;
    if (b.sourceKind === 'user' && a.sourceKind !== 'user') return 1;
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.name.localeCompare(b.name);
  });
  return { servers };
});

// Plugin inventory. Plugins live under ~/.claude/plugins/<name>/ — we read
// each plugin's plugin.json (or package.json fallback) to get name +
// description + what it bundles (skills/commands/agents).
ipcMain.handle('list-plugins', () => {
  const homedir = require('os').homedir();
  const root = path.join(homedir, '.claude', 'plugins');
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return { plugins: out }; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const pluginDir = path.join(root, ent.name);
    let manifest = {};
    for (const candidate of ['plugin.json', 'package.json', 'manifest.json']) {
      const f = path.join(pluginDir, candidate);
      if (!fs.existsSync(f)) continue;
      try { manifest = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch (_) {}
    }
    // Rough inventory of what the plugin bundles.
    const bundles = [];
    for (const sub of ['skills', 'commands', 'agents', 'hooks']) {
      const d = path.join(pluginDir, sub);
      try {
        const items = fs.readdirSync(d).filter((f) => !f.startsWith('.'));
        if (items.length > 0) bundles.push(sub + ' (' + items.length + ')');
      } catch (_) {}
    }
    out.push({
      name: manifest.name || ent.name,
      description: manifest.description || '',
      version: manifest.version || '',
      author: typeof manifest.author === 'string' ? manifest.author : (manifest.author && manifest.author.name) || '',
      path: pluginDir,
      bundles,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { plugins: out };
});

ipcMain.handle('create-memory-file', (_event, { filePath }) => {
  if (!filePath) return { error: 'No file path' };
  // Memory files live either under ~/.claude or under an active project root.
  const claudeHome = path.join(require('os').homedir(), '.claude');
  const safe = pathUnder(claudeHome, filePath) || pathUnderAnyRoot(filePath);
  if (!safe) return { error: 'path not under ~/.claude or an allowed project root' };
  if (fs.existsSync(safe)) return { error: 'File already exists.' };
  const dir = path.dirname(safe);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const starter = '# Project memory\n\n'
      + 'Notes Claude should keep in mind for this scope. Examples:\n\n'
      + '- Coding conventions to follow.\n'
      + '- Files / folders to ignore.\n'
      + '- Domain terminology that may otherwise be ambiguous.\n';
    fs.writeFileSync(safe, starter, 'utf8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Create a new skill or slash-command in the chosen scope. Writes a starter
// file with frontmatter so the user has somewhere to start instead of an
// empty doc; the dialog opens it for editing immediately.
ipcMain.handle('create-skill-file', (_event, { type, scope, name }) => {
  if (type !== 'skill' && type !== 'command') return { error: 'Unknown type: ' + type };
  if (!name || !/^[a-zA-Z0-9_-][a-zA-Z0-9_-]*$/.test(name)) {
    return { error: 'Name must contain only letters, numbers, dashes, and underscores.' };
  }
  // Resolve the scope's .claude root.
  let root;
  if (scope === 'user') {
    root = path.join(require('os').homedir(), '.claude');
  } else {
    // scope is the absolute project path.
    if (!scope || !fs.existsSync(scope)) return { error: 'Invalid project scope: ' + scope };
    root = path.join(scope, '.claude');
  }

  let filePath, starter;
  if (type === 'skill') {
    const skillDir = path.join(root, 'skills', name);
    filePath = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(filePath)) return { error: 'A skill named "' + name + '" already exists in this scope.' };
    try { fs.mkdirSync(skillDir, { recursive: true }); }
    catch (err) { return { error: 'Could not create skill dir: ' + err.message }; }
    starter = '---\n'
      + 'name: ' + name + '\n'
      + 'description: One-line description used by Claude to decide when to apply this skill.\n'
      + '---\n\n'
      + '# ' + name + '\n\n'
      + 'Describe what this skill does, when to use it, and any guardrails.\n';
  } else {
    const cmdsDir = path.join(root, 'commands');
    filePath = path.join(cmdsDir, name + '.md');
    if (fs.existsSync(filePath)) return { error: 'A slash command named "' + name + '" already exists in this scope.' };
    try { fs.mkdirSync(cmdsDir, { recursive: true }); }
    catch (err) { return { error: 'Could not create commands dir: ' + err.message }; }
    starter = '---\n'
      + 'description: One-line description shown when the user types /\n'
      + '---\n\n'
      + 'Instructions Claude should follow when /' + name + ' is invoked.\n';
  }

  try {
    fs.writeFileSync(filePath, starter, 'utf8');
    return { path: filePath, name: name, type: type };
  } catch (err) {
    return { error: 'Could not write file: ' + err.message };
  }
});

// Parse `gh auth status` to surface authed accounts + which one is active.
// gh's output looks like:
//   github.com
//     ✓ Logged in to github.com account stephanie913 (keyring)
//       - Active account: true
//   ...
// We just need (account, isActive) per host.
ipcMain.handle('gh-list-accounts', async () => {
  try {
    const out = execFileSync('gh', ['auth', 'status'], { stdio: 'pipe', timeout: 5000 }).toString();
    const lines = out.split('\n');
    const accounts = [];
    let pending = null;
    for (const raw of lines) {
      const m = raw.match(/account\s+([^\s]+)/);
      if (m) {
        if (pending) accounts.push(pending);
        pending = { username: m[1], active: false };
        continue;
      }
      if (pending && /Active account:\s*true/.test(raw)) pending.active = true;
    }
    if (pending) accounts.push(pending);
    return { accounts };
  } catch (err) {
    return { accounts: [], error: (err.stderr ? err.stderr.toString() : err.message).trim() };
  }
});

ipcMain.handle('gh-switch-account', async (_event, { username }) => {
  if (!username) return { error: 'Missing username' };
  try {
    execFileSync('gh', ['auth', 'switch', '-u', username], { stdio: 'pipe', timeout: 5000 });
    // Drop cached owner→token entries so next gh call re-reads from the
    // freshly switched account.
    ghTokenCache.clear();
    return { ok: true };
  } catch (err) {
    return { error: (err.stderr ? err.stderr.toString() : err.message).trim() };
  }
});

// Probe each logged-in gh account's token against the GitHub REST API for
// the given PR. Returns the first account that gets a 200 response, or the
// currently-active account as fallback. Used by the picker to auto-switch
// when the user pastes a URL their currently-active account can't see.
//
// Scoped to github.com only — GHE autodetect is on the deferred list because
// account<->host binding needs careful handling (a single `gh` install can
// hold accounts across multiple hosts).
ipcMain.handle('gh-detect-account-for-repo', async (_event, { owner, repo, prNumber }) => {
  if (!owner || !repo || !prNumber) return { error: 'missing owner/repo/prNumber' };
  let accounts = [];
  let activeUsername = null;
  try {
    const out = execFileSync('gh', ['auth', 'status'], { stdio: 'pipe', timeout: 5000 }).toString();
    let pending = null;
    for (const raw of out.split('\n')) {
      const m = raw.match(/account\s+([^\s]+)/);
      if (m) {
        if (pending) accounts.push(pending);
        pending = { username: m[1], active: false };
        continue;
      }
      if (pending && /Active account:\s*true/.test(raw)) pending.active = true;
    }
    if (pending) accounts.push(pending);
  } catch (err) {
    return { error: (err.stderr ? err.stderr.toString() : err.message).trim() };
  }
  const active = accounts.find((a) => a.active);
  activeUsername = active ? active.username : null;

  // Try the active account first so the common case (it works, skip the loop)
  // only costs one round trip.
  const ordered = active ? [active, ...accounts.filter((a) => !a.active)] : accounts.slice();
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prNumber)}`;
  for (const acc of ordered) {
    let token;
    try {
      token = execFileSync('gh', ['auth', 'token', '--user', acc.username], {
        stdio: 'pipe', timeout: 5000,
      }).toString().trim();
    } catch { continue; }
    if (!token) continue;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'klaussy-desktop',
        },
      });
      if (res.status === 200) {
        return { username: acc.username, active: acc.active === true, activeUsername };
      }
    } catch { /* network error — try next account */ }
  }
  // Nothing matched: return the active account so the caller can fall back
  // without switching.
  return { username: activeUsername, active: true, activeUsername, noMatch: true };
});

// Pre-launch dep check: probe gh + claude so a first-run dialog can guide
// the user through setup instead of letting them hit cryptic IPC errors
// downstream when these CLIs are missing or unauthed.
ipcMain.handle('check-dependencies', async () => {
  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';

  function probe(cmd, args) {
    try {
      const out = execFileSync(cmd, args, { stdio: 'pipe', timeout: 5000 }).toString().trim();
      return { ok: true, output: out };
    } catch (err) {
      return { ok: false, error: (err.stderr ? err.stderr.toString() : err.message).trim() };
    }
  }

  const ghVersion = probe('gh', ['--version']);
  const ghAuth = ghVersion.ok ? probe('gh', ['auth', 'status']) : { ok: false, error: 'gh not installed' };
  const claudeVersion = probe(claudeBin, ['--version']);

  return {
    gh: {
      installed: ghVersion.ok,
      authed: ghAuth.ok,
      version: ghVersion.ok ? ghVersion.output.split('\n')[0] : null,
      authError: ghAuth.ok ? null : ghAuth.error,
    },
    claude: {
      installed: claudeVersion.ok,
      version: claudeVersion.ok ? claudeVersion.output : null,
      path: claudeBin,
    },
  };
});

// ---- Rename Task (A4) ----

ipcMain.handle('rename-task', (_event, { id, newName }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };
  inst.name = newName;
  return { ok: true };
});

// ---- Duplicate Task (A6) ----

ipcMain.handle('duplicate-task', async (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  const config = loadConfig();
  const repoPath = config.repoPath;
  if (!repoPath) return { error: 'No repo configured' };

  const baseName = inst.name + '-copy';
  const sanitized = baseName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const branch = `task/${sanitized}`;
  const worktreeDir = getWorktreeDir(repoPath);
  const worktreePath = path.join(worktreeDir, sanitized);

  fs.mkdirSync(worktreeDir, { recursive: true });

  // Branch from the same branch as the source
  const sourceBranch = inst.branch || 'main';

  try {
    execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, sourceBranch], {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch (err) {
    return { error: `Failed to create worktree: ${err.message}` };
  }

  await runKlausifyInit(worktreePath, sourceBranch);
  const mode = config.defaultMode || 'claude';
  return spawnInWorktree(baseName, worktreePath, branch, mode);
});

// ---- Phase 1: Git Status & Diff ----

ipcMain.handle('git-status', async (_event, { worktreePath }) => {
  try {
    const [statusRes, branchRes] = await Promise.all([
      execFileP('git', ['status', '--porcelain'], { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 }),
      execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath }),
    ]);
    const status = statusRes.stdout;
    const branch = branchRes.stdout.trim();
    const files = status.split('\n').filter(Boolean).map(line => {
      const xy = line.substring(0, 2);
      const file = line.substring(3);
      // staged if index column (x) has a status letter
      const staged = xy[0] !== ' ' && xy[0] !== '?';
      return { status: xy, staged, file };
    });
    // Split files that are both staged and unstaged (e.g., "MM")
    const expanded = [];
    for (const f of files) {
      if (f.status[0] !== ' ' && f.status[0] !== '?' && f.status[1] !== ' ' && f.status[1] !== '?') {
        // Both staged and unstaged changes
        expanded.push({ status: f.status[0] + ' ', staged: true, file: f.file });
        expanded.push({ status: ' ' + f.status[1], staged: false, file: f.file });
      } else {
        expanded.push(f);
      }
    }
    return { branch, files: expanded };
  } catch (err) {
    return { error: err.message, branch: '', files: [] };
  }
});

ipcMain.handle('git-diff', async (_event, { worktreePath, file, staged }) => {
  try {
    const args = ['diff'];
    if (staged) args.push('--cached');
    if (file) args.push('--', file);
    const { stdout } = await execFileP('git', args, { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 });
    return { diff: stdout };
  } catch (err) {
    return { diff: '', error: err.message };
  }
});

// K7: parsed hunks for a single file against HEAD (or the index if staged).
// Returns line-level change info for the gutter overlay — renderer turns
// these into Monaco decorations. -U0 gives minimal hunks so the ranges
// don't span unchanged context.
ipcMain.handle('git-file-hunks', async (_event, { worktreePath, file }) => {
  try {
    const { stdout: diff } = await execFileP('git', ['diff', '-U0', 'HEAD', '--', file], {
      cwd: worktreePath, maxBuffer: 5 * 1024 * 1024,
    });
    const hunks = [];
    const hunkRe = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/gm;
    let m;
    while ((m = hunkRe.exec(diff))) {
      const oldCount = m[2] === undefined ? 1 : parseInt(m[2], 10);
      const newStart = parseInt(m[3], 10);
      const newCount = m[4] === undefined ? 1 : parseInt(m[4], 10);
      let type;
      if (oldCount === 0) type = 'added';
      else if (newCount === 0) type = 'deleted';
      else type = 'modified';
      // For pure deletions, newCount is 0 — the gutter marker goes on the
      // line where the deletion was visible (newStart, which is the line
      // after the insertion point). Single-line stub for renderer to draw.
      const from = newStart;
      const to = newCount === 0 ? newStart : newStart + newCount - 1;
      hunks.push({ type, from, to });
    }
    return { hunks };
  } catch (err) {
    // Not in a repo, file is untracked, or unmodified — return empty.
    // execFile's promisified form exposes exit code on err.code.
    if (err.code === 128 || err.code === 1) return { hunks: [] };
    return { hunks: [], error: err.message };
  }
});

// ---- Branch Diff Mode ----

ipcMain.handle('git-branches', async (_event, { worktreePath }) => {
  try {
    const [localRes, remoteRes] = await Promise.all([
      execFileP('git', ['branch', '--format=%(refname:short)'], { cwd: worktreePath }),
      execFileP('git', ['branch', '-r', '--format=%(refname:short)'], { cwd: worktreePath }),
    ]);
    const branches = localRes.stdout.split('\n').filter(Boolean);
    const remotes = remoteRes.stdout.split('\n').filter(Boolean).filter(b => !b.includes('HEAD'));
    return { branches, remotes };
  } catch (err) {
    return { branches: [], remotes: [], error: err.message };
  }
});

ipcMain.handle('git-branch-files', async (_event, { worktreePath, baseBranch }) => {
  try {
    // Use merge-base to find the branch point, then diff against working tree
    const mbRes = await execFileP('git', ['merge-base', baseBranch, 'HEAD'], { cwd: worktreePath });
    const mergeBase = mbRes.stdout.trim();
    const { stdout: output } = await execFileP('git', ['diff', '--name-status', mergeBase], { cwd: worktreePath });
    const files = output.split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      return { status: parts[0], file: parts.slice(1).join('\t') };
    });
    return { files, mergeBase };
  } catch (err) {
    return { files: [], error: err.message };
  }
});

ipcMain.handle('git-branch-diff', async (_event, { worktreePath, baseBranch, file }) => {
  try {
    const mbRes = await execFileP('git', ['merge-base', baseBranch, 'HEAD'], { cwd: worktreePath });
    const mergeBase = mbRes.stdout.trim();
    const args = ['diff', mergeBase];
    if (file) args.push('--', file);
    const { stdout: diff } = await execFileP('git', args, { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 });
    return { diff };
  } catch (err) {
    return { diff: '', error: err.message };
  }
});

// ---- Phase 2: Git Operations ----

ipcMain.handle('git-stage', async (_event, { worktreePath, files }) => {
  try {
    await execFileP('git', ['add', '--'].concat(files), { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-unstage', async (_event, { worktreePath, files }) => {
  try {
    await execFileP('git', ['reset', 'HEAD', '--'].concat(files), { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-apply-patch', async (_event, { worktreePath, patch, reverse }) => {
  try {
    const args = ['apply', '--cached', '--whitespace=nowarn'];
    if (reverse) args.push('-R');
    // execFile doesn't take `input` the way execFileSync does — spawn, pipe
    // the patch into stdin, and await exit.
    await new Promise((resolve, reject) => {
      const proc = spawn('git', args, { cwd: worktreePath, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (c) => { stderr += c.toString(); });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else { const err = new Error(stderr || `git apply exited ${code}`); err.stderr = stderr; reject(err); }
      });
      proc.stdin.end(patch);
    });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr || err.message };
  }
});

ipcMain.handle('git-discard', async (_event, { worktreePath, files }) => {
  // Branch per-file on status code. Previously this tried `checkout --` and
  // on ANY failure fell back to `clean -f` — which destroys staged-new files
  // (checkout has nothing to revert to for a brand-new add, so it errors, then
  // clean deletes the file entirely along with its staged content).
  const perFile = [];
  for (const file of files) {
    let status = '';
    try {
      const { stdout } = await execFileP('git', ['status', '--porcelain', '--', file], {
        cwd: worktreePath,
      });
      status = stdout;
    } catch (err) {
      perFile.push({ file, error: err.stderr ? err.stderr.toString() : err.message });
      continue;
    }
    // First two chars are XY — X=staged state, Y=unstaged state.
    const xy = status.slice(0, 2);
    try {
      if (xy === '??') {
        // Untracked: remove it.
        await execFileP('git', ['clean', '-f', '--', file], { cwd: worktreePath });
      } else if (xy[0] === 'A') {
        // Staged new file: unstage, then leave the working-tree file alone
        // (user may want to keep the content; `discard` on a new file means
        // "take it back to untracked"). This avoids the prior data-loss case
        // where the staged content was wiped.
        await execFileP('git', ['reset', 'HEAD', '--', file], { cwd: worktreePath });
      } else {
        // Tracked with unstaged and/or staged changes: reset the index to HEAD
        // for this path, then checkout to restore working tree to HEAD.
        try {
          await execFileP('git', ['reset', 'HEAD', '--', file], { cwd: worktreePath });
        } catch {}
        await execFileP('git', ['checkout', '--', file], { cwd: worktreePath });
      }
      perFile.push({ file, ok: true });
    } catch (err) {
      perFile.push({ file, error: err.stderr ? err.stderr.toString() : err.message });
    }
  }
  const failures = perFile.filter((r) => r.error);
  if (failures.length === files.length && files.length > 0) {
    return { error: failures[0].error, files: perFile };
  }
  return { ok: true, files: perFile };
});

ipcMain.handle('git-commit', async (_event, { worktreePath, message }) => {
  try {
    await execFileP('git', ['commit', '-m', message], { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-push', async (_event, { worktreePath }) => {
  try {
    const { stdout: br } = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath });
    const branch = br.trim();
    // git writes progress + the "To ...refs..." summary to stderr even on
    // success. Capture it so the renderer can surface a useful "pushed X to
    // origin/Y" toast / log entry instead of pretending nothing happened.
    const { stderr } = await execFileP('git', ['push', '-u', 'origin', branch], {
      cwd: worktreePath, timeout: 30000,
    });
    return { ok: true, branch, output: (stderr || '').trim() };
  } catch (err) {
    return {
      error: err.stderr ? err.stderr.toString().trim() : err.message,
      code: err.code,
      signal: err.signal,
    };
  }
});

ipcMain.handle('create-pr', async (_event, { worktreePath, title, body }) => {
  try {
    const result = ghExec(['pr', 'create', '--title', title, '--body', body || ''], { cwd: worktreePath, stdio: 'pipe', timeout: 30000 }).toString().trim();
    return { url: result };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- Phase D: Git Gaps ----

// D1: Fetch & Pull
ipcMain.handle('git-fetch', async (_event, { worktreePath }) => {
  try {
    await execFileP('git', ['fetch', '--prune'], { cwd: worktreePath, timeout: 30000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-pull', async (_event, { worktreePath }) => {
  try {
    const { stdout } = await execFileP('git', ['pull'], { cwd: worktreePath, timeout: 30000 });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-ahead-behind', async (_event, { worktreePath }) => {
  try {
    // The previous sync version had a dead branch-lookup call before upstream;
    // we drop it here — upstream fails the same way if the repo is broken.
    const { stdout: upstream } = await execFileP(
      'git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd: worktreePath },
    );
    const { stdout: counts } = await execFileP(
      'git', ['rev-list', '--left-right', '--count', upstream.trim() + '...HEAD'],
      { cwd: worktreePath },
    );
    const parts = counts.trim().split(/\s+/);
    return { behind: parseInt(parts[0], 10) || 0, ahead: parseInt(parts[1], 10) || 0 };
  } catch {
    return { behind: 0, ahead: 0 };
  }
});

// ---- H2: Cross-task review inbox aggregator ----
//
// Runs git ops truly in parallel (async execFile) so aggregating N worktrees
// costs ~max(per-worktree) instead of ~sum. Per-worktree errors degrade to a
// zeroed row with `error:` set rather than rejecting the whole Promise.all.
async function collectWorktreeState(task) {
  const cwd = task.worktreePath;
  try {
    const [statusOut, branchOut, ahead] = await Promise.all([
      execFileP('git', ['status', '--porcelain'], { cwd, maxBuffer: 10 * 1024 * 1024 })
        .then(r => r.stdout).catch(() => ''),
      execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
        .then(r => r.stdout.trim()).catch(() => ''),
      (async () => {
        try {
          const up = (await execFileP('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd })).stdout.trim();
          const counts = (await execFileP('git', ['rev-list', '--left-right', '--count', up + '...HEAD'], { cwd })).stdout.trim();
          const [behind, ahead] = counts.split(/\s+/).map(n => parseInt(n, 10) || 0);
          return { ahead, behind };
        } catch { return { ahead: 0, behind: 0 }; }
      })(),
    ]);
    // Porcelain status: first col = index (staged), second col = worktree (unstaged).
    // "??" is untracked. "MM" etc. counts in both staged and unstaged.
    let staged = 0, unstaged = 0, untracked = 0;
    for (const line of statusOut.split('\n')) {
      if (!line) continue;
      const x = line.charAt(0), y = line.charAt(1);
      if (x === '?' && y === '?') { untracked++; continue; }
      if (x !== ' ' && x !== '?') staged++;
      if (y !== ' ' && y !== '?') unstaged++;
    }
    return {
      taskId: task.id, branch: branchOut,
      staged, unstaged, untracked,
      ahead: ahead.ahead, behind: ahead.behind,
    };
  } catch (err) {
    return {
      taskId: task.id, branch: '',
      staged: 0, unstaged: 0, untracked: 0,
      ahead: 0, behind: 0,
      error: err.message,
    };
  }
}

ipcMain.handle('list-all-dirty-worktrees', async () => {
  return Promise.all(Array.from(instances.values()).map(collectWorktreeState));
});

ipcMain.handle('get-worktree-state', async (_event, { taskId }) => {
  const task = instances.get(taskId);
  if (!task) return null;
  return collectWorktreeState(task);
});

// D2: Branch checkout
ipcMain.handle('git-checkout', async (_event, { worktreePath, branch }) => {
  try {
    await execFileP('git', ['checkout', branch], { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// D3: Stash
ipcMain.handle('git-stash-push', async (_event, { worktreePath, message }) => {
  try {
    const args = ['stash', 'push'];
    if (message) args.push('-m', message);
    await execFileP('git', args, { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-stash-pop', async (_event, { worktreePath, index }) => {
  try {
    const args = ['stash', 'pop'];
    if (index !== undefined) args.push('stash@{' + index + '}');
    await execFileP('git', args, { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-stash-list', async (_event, { worktreePath }) => {
  try {
    const { stdout } = await execFileP('git', ['stash', 'list', '--format=%gd\t%s'], { cwd: worktreePath });
    const stashes = stdout.split('\n').filter(Boolean).map(function (line) {
      const parts = line.split('\t');
      return { ref: parts[0], message: parts.slice(1).join('\t') };
    });
    return { stashes };
  } catch (err) {
    return { stashes: [], error: err.message };
  }
});

// D4: Commit history
ipcMain.handle('git-log', async (_event, { worktreePath, count }) => {
  try {
    const { stdout } = await execFileP('git', ['log', '--format=%H\t%h\t%an\t%ar\t%s', '-' + (count || 50)], {
      cwd: worktreePath,
    });
    const commits = stdout.split('\n').filter(Boolean).map(function (line) {
      const p = line.split('\t');
      return { hash: p[0], short: p[1], author: p[2], date: p[3], subject: p[4] };
    });
    return { commits };
  } catch (err) {
    return { commits: [], error: err.message };
  }
});

ipcMain.handle('git-show', async (_event, { worktreePath, hash }) => {
  try {
    const { stdout } = await execFileP('git', ['show', '--format=', hash], {
      cwd: worktreePath, maxBuffer: 10 * 1024 * 1024,
    });
    return { diff: stdout };
  } catch (err) {
    return { diff: '', error: err.message };
  }
});

// D5: Blame
ipcMain.handle('git-blame', async (_event, { worktreePath, file }) => {
  try {
    const { stdout: output } = await execFileP('git', ['blame', '--porcelain', file], {
      cwd: worktreePath, maxBuffer: 10 * 1024 * 1024,
    });
    // Parse porcelain blame into per-line annotations
    const lines = [];
    let current = {};
    const commits = {};
    output.split('\n').forEach(function (line) {
      const headerMatch = line.match(/^([0-9a-f]{40}) (\d+) (\d+)/);
      if (headerMatch) {
        current = { hash: headerMatch[1], origLine: parseInt(headerMatch[2]), finalLine: parseInt(headerMatch[3]) };
        return;
      }
      if (line.startsWith('author ')) {
        if (!commits[current.hash]) commits[current.hash] = {};
        commits[current.hash].author = line.substring(7);
      }
      if (line.startsWith('author-time ')) {
        if (!commits[current.hash]) commits[current.hash] = {};
        commits[current.hash].time = parseInt(line.substring(12));
      }
      if (line.startsWith('summary ')) {
        if (!commits[current.hash]) commits[current.hash] = {};
        commits[current.hash].summary = line.substring(8);
      }
      if (line.startsWith('\t')) {
        lines.push({
          line: current.finalLine,
          hash: current.hash.substring(0, 8),
          author: commits[current.hash]?.author || '',
          summary: commits[current.hash]?.summary || '',
          time: commits[current.hash]?.time || 0,
        });
      }
    });
    return { lines };
  } catch (err) {
    return { lines: [], error: err.message };
  }
});

// D7: Conflict detection
ipcMain.handle('git-conflicts', async (_event, { worktreePath }) => {
  try {
    const { stdout } = await execFileP('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd: worktreePath,
    });
    const files = stdout.split('\n').filter(Boolean);
    return { files };
  } catch {
    return { files: [] };
  }
});

// ---- Phase E: Reliability / Diagnostics ----

// E1: Log viewer
ipcMain.handle('get-logs', () => {
  return logBuffer.slice();
});

// E2: Export session transcript
//
// The dialog-selected path is held main-side in `pendingTranscripts` rather
// than round-tripping through the renderer. Previously the renderer could
// hand any path back to `write-transcript` (including /etc/hosts) because
// main had no way to verify the path actually came from a dialog.
const pendingTranscripts = new Map(); // instanceId -> expected file path
ipcMain.handle('export-transcript', async (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Session Transcript',
    defaultPath: path.join(app.getPath('documents'), inst.name + '-transcript.txt'),
    filters: [{ name: 'Text', extensions: ['txt'] }, { name: 'Markdown', extensions: ['md'] }],
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  pendingTranscripts.set(id, result.filePath);
  // The transcript content will arrive from the renderer (xterm buffer)
  // via `write-transcript` below — it MUST pass the same id, not the path.
  return { ok: true };
});

ipcMain.handle('write-transcript', (_event, { id, content }) => {
  const expected = pendingTranscripts.get(id);
  if (!expected) return { error: 'No pending transcript for this task' };
  pendingTranscripts.delete(id);
  try {
    fs.writeFileSync(expected, content, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// E3: Per-task env vars — stored in create-task and passed to pty spawn
// The create-task handler already exists; we extend the modal to pass env/cwd
// and store them on the instance. The spawn functions already use worktreePath as cwd.

// ---- Phase 3: Multi-Project ----

ipcMain.handle('list-projects', () => {
  const config = loadConfig();
  return config.projects || [];
});

ipcMain.handle('add-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a git repository',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const projectPath = result.filePaths[0];

  let isGitRepo = false;
  try {
    execSync('git rev-parse --git-dir', { cwd: projectPath, stdio: 'pipe' });
    isGitRepo = true;
  } catch {}

  if (!isGitRepo) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Initialize Git', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Not a git repository',
      message: `"${path.basename(projectPath)}" is not a git repository.`,
      detail: 'Would you like to initialize it with git? This will run "git init" in the selected directory.',
    });
    if (response !== 0) return null;
    try {
      execSync('git init', { cwd: projectPath, stdio: 'pipe' });
    } catch (err) {
      dialog.showErrorBox('Git init failed', err.message);
      return null;
    }
  }

  const config = loadConfig();
  if (!config.projects) config.projects = [];
  const name = path.basename(projectPath);
  if (!config.projects.find(p => p.path === projectPath)) {
    config.projects.push({ name, path: projectPath });
  }
  config.repoPath = projectPath;
  saveConfig(config);
  return { name, path: projectPath };
});

ipcMain.handle('remove-project', (_event, { projectPath }) => {
  const config = loadConfig();
  config.projects = (config.projects || []).filter(p => p.path !== projectPath);
  if (config.repoPath === projectPath) {
    config.repoPath = config.projects[0]?.path || null;
  }
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('switch-project', (_event, { projectPath }) => {
  const config = loadConfig();
  config.repoPath = projectPath;
  saveConfig(config);
  return { ok: true };
});

// ---- Multi-Window ----

ipcMain.handle('new-window', () => {
  createWindow({ secondary: true });
  return { ok: true };
});

ipcMain.handle('list-worktrees', async () => {
  const config = loadConfig();
  const repoPath = config.repoPath;
  if (!repoPath) return [];

  // Verify it's a git repo before listing worktrees
  try {
    await execFileP('git', ['rev-parse', '--git-dir'], { cwd: repoPath });
  } catch {
    return [];
  }

  try {
    const { stdout: output } = await execFileP('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
    });

    const worktrees = [];
    let current = {};
    output.split('\n').forEach(line => {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current);
        current = { path: line.substring(9) };
      } else if (line.startsWith('branch ')) {
        current.branch = line.substring(7).replace('refs/heads/', '');
      } else if (line === 'bare') {
        current.bare = true;
      } else if (line === '') {
        if (current.path) worktrees.push(current);
        current = {};
      }
    });
    if (current.path) worktrees.push(current);

    // Filter out bare and hidden worktrees, add active status
    const activePaths = new Set(Array.from(instances.values()).map(i => i.worktreePath));
    const hidden = new Set(config.hiddenWorktrees || []);
    return worktrees
      .filter(w => !w.bare && !hidden.has(w.path))
      .map(w => ({
        path: w.path,
        name: path.basename(w.path),
        branch: w.branch || '',
        active: activePaths.has(w.path),
      }));
  } catch {
    return [];
  }
});

ipcMain.handle('hide-worktree', (_event, { worktreePath }) => {
  const config = loadConfig();
  if (!config.hiddenWorktrees) config.hiddenWorktrees = [];
  if (!config.hiddenWorktrees.includes(worktreePath)) {
    config.hiddenWorktrees.push(worktreePath);
  }
  saveConfig(config);
  return { ok: true };
});

// ---- Phase 4: Pop-Out Windows ----

ipcMain.handle('pop-out-task', (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  const popout = new BrowserWindow({
    width: 800,
    height: 600,
    title: `Klaussy \u2014 ${inst.name}`,
    icon: path.join(__dirname, 'icon.icns'),
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(popout);

  popout.loadFile(path.join(__dirname, 'renderer', 'popout.html'));

  inst.popoutWindows.add(popout);

  popout.webContents.once('did-finish-load', () => {
    popout.webContents.send('popout-init', {
      id: inst.id, name: inst.name,
      worktreePath: inst.worktreePath, branch: inst.branch, mode: inst.mode,
    });
  });

  popout.on('closed', () => {
    inst.popoutWindows.delete(popout);
  });

  return { ok: true };
});

// ---- Phase G: Review others' PRs ----
//
// activePrReview is the single source of truth so the main-window panel and
// the detached pop-out see the same state (no duplicate fetches, no lost
// pending comments). null = no review open.

let activePrReview = null; // { repo, number, meta, diff, popout: BrowserWindow|null }

function broadcastPrReview() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('pr-review-state', activePrReview ? sanitizePrReview(activePrReview) : null);
  }
}

function sanitizePrReview(s) {
  // Strip the BrowserWindow reference — not serializable across IPC.
  const { popout, ...rest } = s;
  return { ...rest, popped: !!popout };
}

function ghJson(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error('gh returned non-JSON: ' + stdout.slice(0, 200))); }
    });
  });
}

function ghText(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
  });
}

function currentRepoPath() {
  const config = loadConfig();
  return config.repoPath || null;
}

ipcMain.handle('pr-list', async () => {
  const cwd = currentRepoPath();
  if (!cwd) return { error: 'No active project. Add a project first.' };
  try {
    const prs = await ghJson([
      'pr', 'list',
      '--json', 'number,title,author,state,updatedAt,headRefName,baseRefName,isDraft,reviewDecision,url',
      '--limit', '50',
    ], cwd);
    return { prs };
  } catch (err) {
    return { error: (err.stderr || err.message || '').trim() };
  }
});

ipcMain.handle('pr-lookup-url', async (_event, { url }) => {
  // gh just needs a valid cwd (any git repo or non-repo dir works for a
  // URL-targeted call). Falling back to homedir lets reviewers use Klaussy
  // without first adding a klausify project.
  const cwd = currentRepoPath() || require('os').homedir();
  try {
    const meta = await ghJson([
      'pr', 'view', url,
      '--json', 'number,title,author,state,updatedAt,headRefName,baseRefName,isDraft,reviewDecision,url,body,headRepository,headRepositoryOwner',
    ], cwd);
    return { meta };
  } catch (err) {
    return { error: (err.stderr || err.message || '').trim() };
  }
});

// GitHub PR URLs always encode the base repo: /{owner}/{repo}/pull/{n}.
// Using the URL avoids an extra gh call and works for both the picker path
// and the paste-URL path, since `gh pr view --json url` is always populated.
function parseBaseFromUrl(url) {
  if (!url) return null;
  // Match any host (github.com, github.corp.example, etc.) so GHE works too.
  const m = url.match(/https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/);
  if (!m) return null;
  return { owner: m[1], name: m[2].replace(/\.git$/, '') };
}

ipcMain.handle('pr-load', async (_event, { number, url }) => {
  // URL-form calls don't need an active project — gh derives the repo from
  // the URL. The number-only form (used by the picker's "open in current
  // project" list) does, since gh resolves it against the cwd's origin.
  if (!url && !currentRepoPath()) {
    return { error: 'Add a project to look up PRs by number, or paste a full PR URL.' };
  }
  const cwd = currentRepoPath() || require('os').homedir();
  const target = url || String(number);
  try {
    const [meta, diff] = await Promise.all([
      ghJson([
        'pr', 'view', target,
        '--json', 'number,title,author,state,createdAt,updatedAt,headRefName,baseRefName,headRefOid,isDraft,reviewDecision,url,body,headRepository,headRepositoryOwner,mergeable,mergeStateStatus',
      ], cwd),
      ghText(['pr', 'diff', target], cwd),
    ]);
    const base = parseBaseFromUrl(meta.url);
    const repo = base ? `${base.owner}/${base.name}` : null;
    activePrReview = {
      repo, number: meta.number, meta, diff,
      baseOwner: base ? base.owner : null,
      baseRepo: base ? base.name : null,
      threads: null, // null = loading, [] = loaded-empty
      threadsError: null,
      popout: null,
    };
    broadcastPrReview();

    // Record this PR in review history (most recent first, deduped by URL,
    // capped at 20). Separate from load-path so a storage hiccup can't break
    // the review UI.
    try { pushReviewHistory(meta); } catch (_) {}

    // Fire-and-forget thread fetch; broadcasts again when ready so the renderer
    // can paint the shell immediately without waiting on the GraphQL round-trip.
    fetchThreadsForActive();

    return { ok: true };
  } catch (err) {
    return { error: (err.stderr || err.message || '').trim() };
  }
});

function pushReviewHistory(meta) {
  if (!meta || !meta.url) return;
  const config = loadConfig();
  const history = (config.reviewHistory || []).filter(e => e.url !== meta.url);
  history.unshift({
    url: meta.url,
    number: meta.number,
    title: meta.title || '',
    author: (meta.author && (meta.author.login || meta.author.name)) || '',
    state: meta.state || '',
    isDraft: !!meta.isDraft,
    headRefName: meta.headRefName || '',
    baseRefName: meta.baseRefName || '',
    viewedAt: new Date().toISOString(),
  });
  config.reviewHistory = history.slice(0, 20);
  saveConfig(config);
}

ipcMain.handle('pr-recent', () => {
  const config = loadConfig();
  return { items: config.reviewHistory || [] };
});

// GraphQL-backed thread fetch. Scoped to the *base* repo (target), not the
// head repo (fork), because threads live on the target.
//
// Epoch guard: overlapping refreshes (user hits refresh twice; merge-handler
// piggybacks a refresh during the user's manual refresh) can return out of
// order. We only commit results from the most-recent fetch; stale responses
// are silently dropped to avoid overwriting newer data with older data.
let _threadsFetchEpoch = 0;
async function fetchThreadsForActive() {
  if (!activePrReview) return;
  const epoch = ++_threadsFetchEpoch;
  // gh api graphql doesn't need to run inside the target repo — owner/repo
  // are passed as query variables. Falling back to homedir means reviewers
  // without an active klausify project still get threads + comments.
  const cwd = currentRepoPath() || require('os').homedir();
  if (!activePrReview.baseOwner || !activePrReview.baseRepo) {
    activePrReview.threadsError = 'Could not parse base repo from PR url';
    broadcastPrReview();
    return;
  }
  const owner = activePrReview.baseOwner;
  const repo = activePrReview.baseRepo;
  const number = activePrReview.number;
  const stale = () => epoch !== _threadsFetchEpoch
    || !activePrReview
    || activePrReview.number !== number;

  // One round trip for threads + issue-comments + reviews. Conversation tab
  // reads from comments + reviews; Files tab reads from reviewThreads. There's
  // duplication between review.comments and reviewThreads.comments, but the
  // two consumers render different shapes, so we keep both and let them pick.
  const query = 'query($owner: String!, $repo: String!, $number: Int!) {'
    + '  repository(owner: $owner, name: $repo) {'
    + '    pullRequest(number: $number) {'
    + '      reviewThreads(first: 100) {'
    + '        nodes {'
    + '          id isResolved isOutdated path line originalLine startLine originalStartLine diffSide'
    + '          comments(first: 100) { nodes { databaseId author { login } createdAt body diffHunk } }'
    + '        }'
    + '      }'
    + '      comments(first: 100) {'
    + '        nodes { databaseId author { login } createdAt body url }'
    + '      }'
    + '      reviews(first: 100) {'
    + '        nodes {'
    + '          databaseId state body submittedAt author { login }'
    + '          comments(first: 100) { nodes { databaseId body path line diffHunk } }'
    + '        }'
    + '      }'
    + '    }'
    + '  }'
    + '}';

  try {
    const out = await new Promise((resolve, reject) => {
      execFile('gh', [
        'api', 'graphql',
        '-f', 'query=' + query,
        '-f', 'owner=' + owner,
        '-f', 'repo=' + repo,
        '-F', 'number=' + number,
      ], { cwd, maxBuffer: 50 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
        if (err) { err.stderr = stderr; err.stdout = stdout; return reject(err); }
        resolve(stdout);
      });
    });
    const parsed = JSON.parse(out);
    if (parsed.errors && parsed.errors.length) {
      if (stale()) return;
      activePrReview.threadsError = parsed.errors.map(e => e.message).join('; ');
      broadcastPrReview();
      return;
    }
    const pr = parsed.data && parsed.data.repository && parsed.data.repository.pullRequest;
    const threads = (pr && pr.reviewThreads && pr.reviewThreads.nodes) || [];
    const issueComments = (pr && pr.comments && pr.comments.nodes) || [];
    const reviews = (pr && pr.reviews && pr.reviews.nodes) || [];
    // User may have navigated away while we were fetching; bail if the review
    // behind us was swapped for a different PR.
    if (stale()) return;
    activePrReview.threads = threads;
    activePrReview.issueComments = issueComments;
    activePrReview.reviews = reviews;
    activePrReview.threadsError = null;
    broadcastPrReview();
  } catch (err) {
    if (stale()) return;
    // gh api writes error JSON to stdout on non-zero exit
    let msg = (err.stderr || err.message || '').trim();
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout.toString());
        if (parsed.errors) msg = parsed.errors.map(e => e.message).join('; ');
      } catch (_) {}
    }
    activePrReview.threadsError = msg;
    broadcastPrReview();
  }
}

ipcMain.handle('pr-refresh-threads', async () => {
  if (!activePrReview) return { error: 'No active PR review' };
  await fetchThreadsForActive();
  return { ok: true };
});

// G6: CI checks scoped to the PR review surface. `gh pr checks -R …`
// mangles the repo name in its GraphQL query on some gh versions. Using
// `gh pr view -R … --json statusCheckRollup` reads the same rollup through a
// different code path that handles the -R flag cleanly, and reshapes to the
// { name, state, bucket, link, workflow, description } shape the renderer
// already knows how to draw.
ipcMain.handle('pr-review-checks', async () => {
  if (!activePrReview) return { error: 'No active PR review' };
  const { meta, baseOwner, baseRepo } = activePrReview;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const sha = meta && meta.headRefOid;
  if (!sha) return { checks: [], error: 'Missing head commit sha' };
  const cwd = currentRepoPath() || require('os').homedir();

  // REST endpoint is more forgiving than gh's GraphQL path for this repo
  // (which throws "Could not resolve to a Repository" on both `gh pr checks`
  // and a custom gh api graphql call). Runs + statuses are separate APIs,
  // so we fetch both in parallel and merge.
  async function run(args) {
    return new Promise((resolve) => {
      execFile('gh', ['api'].concat(args), { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
        (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    });
  }
  const [runsRes, statusRes] = await Promise.all([
    run([`repos/${baseOwner}/${baseRepo}/commits/${sha}/check-runs`, '--paginate']),
    run([`repos/${baseOwner}/${baseRepo}/commits/${sha}/status`]),
  ]);

  const checks = [];
  if (!runsRes.err) {
    try {
      const parsed = JSON.parse(runsRes.stdout);
      const runs = parsed.check_runs || [];
      runs.forEach((r) => checks.push(normalizeCheckRun(r)));
    } catch (_) {}
  }
  if (!statusRes.err) {
    try {
      const parsed = JSON.parse(statusRes.stdout);
      const statuses = parsed.statuses || [];
      statuses.forEach((s) => checks.push(normalizeStatus(s)));
    } catch (_) {}
  }

  // Only surface an error if BOTH APIs failed — previously `||` meant that
  // a legitimate "no checks" response from one endpoint plus a transient
  // failure on the other was reported as an error, swallowing real data.
  if (checks.length === 0 && runsRes.err && statusRes.err) {
    const first = runsRes.err || statusRes.err;
    const raw = (first.stderr ? first.stderr.toString() : first.message) || '';
    return { checks: [], error: raw.trim() };
  }
  return { checks };
});

function bucketFromState(rawState) {
  const s = (rawState || '').toLowerCase();
  if (s === 'success' || s === 'neutral') return 'pass';
  if (s === 'failure' || s === 'timed_out' || s === 'action_required' || s === 'error') return 'fail';
  if (s === 'cancelled') return 'cancel';
  if (s === 'skipped') return 'skipping';
  if (['queued', 'in_progress', 'pending', 'waiting', 'expected', 'requested'].includes(s)) return 'pending';
  return 'pending';
}

function normalizeCheckRun(r) {
  // GitHub REST check-run: { name, status, conclusion, details_url, output: {...}, app: { name }, ... }
  const rawState = (r.conclusion || r.status || '').toLowerCase();
  return {
    name: r.name || '(unnamed)',
    state: rawState,
    bucket: bucketFromState(rawState),
    link: r.details_url || r.html_url || '',
    workflow: (r.app && r.app.name) || '',
    description: (r.output && r.output.title) || '',
  };
}

function normalizeStatus(s) {
  // Legacy REST status: { context, state, target_url, description, ... }
  return {
    name: s.context || '(unnamed)',
    state: (s.state || '').toLowerCase(),
    bucket: bucketFromState(s.state),
    link: s.target_url || '',
    workflow: '',
    description: s.description || '',
  };
}

// Debug a single failing CI check. Pulls the failing job's logs, builds a
// prompt with PR description + diff + log tail, and streams claude's analysis
// back to the renderer. Same chunk/done event protocol as Explain so the
// renderer can reuse the same UX.
const debugCheckProcs = new Map();

ipcMain.handle('pr-debug-check-start', (event, { requestId, checkLink, checkName }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (debugCheckProcs.has(requestId)) return { error: 'Already debugging' };
  if (!activePrReview) return { error: 'No active PR review' };
  const { meta, baseOwner, baseRepo, diff } = activePrReview;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  if (!checkLink) return { error: 'Check has no run link to fetch logs from' };

  // GitHub job links look like:
  //   https://github.com/<owner>/<repo>/actions/runs/<runId>/job/<jobId>
  const m = checkLink.match(/\/actions\/runs\/(\d+)\/job\/(\d+)/);
  const runId = m ? m[1] : null;
  const jobId = m ? m[2] : null;
  if (!runId || !jobId) return { error: 'Could not parse run/job id from link: ' + checkLink };

  const cwd = currentRepoPath() || require('os').homedir();
  const sender = event.sender;

  // Fetch logs. gh run view follows the 302-to-download redirect properly,
  // unlike the bare `gh api .../jobs/{id}/logs` call which often surfaces
  // as HTTP 404. Fall back to the api endpoint if `gh run view` fails (e.g.
  // wrong repo, expired retention).
  let logs = '';
  try {
    logs = execFileSync('gh', [
      'run', 'view', String(runId),
      '-R', `${baseOwner}/${baseRepo}`,
      '--log-failed',
    ], { cwd, stdio: 'pipe', timeout: 30000, maxBuffer: 50 * 1024 * 1024 }).toString();
  } catch (errA) {
    try {
      logs = execFileSync('gh', [
        'api', `/repos/${baseOwner}/${baseRepo}/actions/jobs/${jobId}/logs`,
      ], { cwd, stdio: 'pipe', timeout: 20000, maxBuffer: 50 * 1024 * 1024 }).toString();
    } catch (errB) {
      const msg = (errA.stderr ? errA.stderr.toString().trim() : errA.message)
        || (errB.stderr ? errB.stderr.toString().trim() : errB.message);
      return { error: 'Could not fetch logs: ' + msg };
    }
  }
  const logLines = logs.split('\n');
  const logTail = logLines.slice(-400).join('\n');

  // Truncate diff too — long PRs can easily exceed the prompt budget. The
  // file list + first ~600 lines is usually enough to let claude judge
  // whether the PR caused the failure; full diff is rarely needed.
  const diffSnippet = (diff || '').split('\n').slice(0, 600).join('\n')
    + ((diff || '').split('\n').length > 600 ? '\n\n[... diff truncated ...]\n' : '');

  const prompt =
    `A pull request has a failing CI check. Help diagnose it.\n\n`
    + `## PR\n#${meta.number}: ${meta.title || ''}\n`
    + (meta.body ? `\n${meta.body.slice(0, 2000)}\n` : '')
    + `\n## Failing check\nName: ${checkName || '(unnamed)'}\nLink: ${checkLink}\n`
    + `\n## Last lines of the failing job log\n\`\`\`\n${logTail}\n\`\`\`\n`
    + `\n## PR diff (truncated to 600 lines)\n\`\`\`\n${diffSnippet}\n\`\`\`\n`
    + `\nAnswer in this structure:\n`
    + `1. **What broke** — one or two sentences naming the actual failure.\n`
    + `2. **Caused by this PR?** — yes / no / likely, with the specific evidence from the diff vs log.\n`
    + `3. **Fix** — concrete, code-level suggestion. Use file:line references when possible.\n`
    + `Keep it tight; no preamble.`;

  spawnClaudeStream({
    requestId, procMap: debugCheckProcs, channelPrefix: 'pr-debug-check',
    sender, cwd, prompt,
  });
  return { ok: true };
});

ipcMain.handle('pr-debug-check-cancel', makeClaudeCancelHandler(debugCheckProcs));

// K3: inline AI edit — streams a claude -p replacement for a selection.
// Kept deliberately strict: the prompt tells claude to emit ONLY the
// replacement code so the renderer can paste it back verbatim without
// having to strip markdown fences or preamble.
const inlineEditProcs = new Map();
ipcMain.handle('inline-edit-start', (event, { requestId, worktreePath, instruction, selection, languageId, filePath }) => {
  const prompt =
    'You are editing code inline. Apply this instruction to the code below and return ONLY the replacement code.\n\n' +
    'Rules (strict):\n' +
    '- Respond with ONLY the replacement code — no explanations, no markdown code fences, no preamble, no trailing commentary.\n' +
    '- Preserve the indentation style of the original (tabs vs spaces, width).\n' +
    '- Keep the replacement self-contained: it will replace the exact selection in-place.\n' +
    '- Do not add imports unless the instruction requires them; if you do, they belong inside the replacement, not elsewhere.\n\n' +
    (filePath ? `File: ${filePath}\n` : '') +
    (languageId ? `Language: ${languageId}\n\n` : '\n') +
    `Instruction: ${instruction}\n\n` +
    'Original selection:\n' +
    selection + '\n';

  spawnClaudeStream({
    requestId, procMap: inlineEditProcs, channelPrefix: 'inline-edit',
    sender: event.sender,
    cwd: worktreePath || currentRepoPath() || require('os').homedir(),
    prompt,
  });
  return { ok: true };
});

ipcMain.handle('inline-edit-cancel', makeClaudeCancelHandler(inlineEditProcs));

// K6: inline AI completion — predicts what comes at the cursor.
// Context-before / context-after let claude see both sides of the insertion
// point so completions respect what already exists on the next line.
const inlineCompleteProcs = new Map();
ipcMain.handle('inline-complete-start', (event, { requestId, worktreePath, before, after, languageId, filePath }) => {
  const prompt =
    'You are an inline code-completion engine. Predict what belongs at the cursor position.\n\n' +
    'Rules (strict):\n' +
    '- Return ONLY the insertion text — no explanations, no markdown fences, no preamble.\n' +
    '- Keep it concise: a few lines at most; stop when the natural unit ends (statement, block, close paren).\n' +
    '- Do NOT repeat the text that already comes before or after the cursor.\n' +
    '- Match the surrounding indentation style exactly.\n' +
    '- If nothing obvious should go here, return an empty response.\n\n' +
    (filePath ? `File: ${filePath}\n` : '') +
    (languageId ? `Language: ${languageId}\n\n` : '\n') +
    'Before cursor:\n' + before + '\n\n' +
    '<CURSOR>\n\n' +
    'After cursor:\n' + after + '\n';

  spawnClaudeStream({
    requestId, procMap: inlineCompleteProcs, channelPrefix: 'inline-complete',
    sender: event.sender,
    cwd: worktreePath || currentRepoPath() || require('os').homedir(),
    prompt,
  });
  return { ok: true };
});

ipcMain.handle('inline-complete-cancel', makeClaudeCancelHandler(inlineCompleteProcs));

ipcMain.handle('pr-review-merge', async (_event, { strategy }) => {
  if (!activePrReview) return { error: 'No active PR review' };
  const flag = { merge: '--merge', squash: '--squash', rebase: '--rebase' }[strategy];
  if (!flag) return { error: 'Unknown merge strategy: ' + strategy };
  const { meta } = activePrReview;
  if (!meta || !meta.url) return { error: 'Could not determine PR URL' };
  const cwd = currentRepoPath() || require('os').homedir();
  try {
    // URL form bypasses gh's buggy -R repo resolution (see pr-review-checks
    // for the failure mode we're avoiding).
    ghExec(['pr', 'merge', meta.url, flag], {
      cwd, stdio: 'pipe', timeout: 30000,
    });
    await reloadActivePrReviewMeta();
    fetchThreadsForActive();
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

async function reloadActivePrReviewMeta() {
  if (!activePrReview) return;
  const { meta: existingMeta } = activePrReview;
  if (!existingMeta || !existingMeta.url) return;
  const cwd = currentRepoPath() || require('os').homedir();
  try {
    const meta = await ghJson([
      'pr', 'view', existingMeta.url,
      '--json', 'number,title,author,state,createdAt,updatedAt,headRefName,baseRefName,headRefOid,isDraft,reviewDecision,url,body,headRepository,headRepositoryOwner,mergeable,mergeStateStatus',
    ], cwd);
    if (!activePrReview || activePrReview.number !== meta.number) return;
    activePrReview.meta = Object.assign({}, activePrReview.meta, meta);
    broadcastPrReview();
  } catch (_) { /* non-fatal */ }
}

// Walk the user's klausify projects and return the first whose `origin`
// remote points at <owner>/<repo> (GitHub URL, either SSH or HTTPS form).
// Returns null when no project matches — the caller surfaces an explicit
// "add this repo as a project" error.
function findProjectForRepo(owner, repo) {
  const config = loadConfig();
  const projects = config.projects || [];
  const needle = `${owner}/${repo}`;
  for (const p of projects) {
    if (!p || !p.path) continue;
    try {
      const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: p.path, stdio: 'pipe',
      }).toString().trim();
      // Accept https://github.com/owner/repo(.git)? and git@github.com:owner/repo(.git)?
      const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (m && `${m[1]}/${m[2]}` === needle) return p.path;
    } catch (_) { /* skip */ }
  }
  return null;
}

// Scan `git worktree list --porcelain` for the worktree (if any) that has
// `refs/heads/<branch>` checked out. Returns the worktree path or null.
function findWorktreeForBranch(cwd, branch) {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd, stdio: 'pipe',
    }).toString();
    // Entries are blank-line-separated "worktree <path>\nHEAD ...\nbranch ..." blocks.
    const blocks = out.split(/\n\n+/);
    for (const block of blocks) {
      let wtPath = null, wtBranch = null;
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length).trim();
        else if (line.startsWith('branch ')) wtBranch = line.slice('branch '.length).trim();
      }
      if (wtBranch === `refs/heads/${branch}` && wtPath) return wtPath;
    }
  } catch (_) {}
  return null;
}

// Shared helper: ensure a worktree exists for activePrReview's PR head and
// return its path. Used by G5 (which then spawns a task) and G7 (which runs
// the AI review there). Resolves cwd in this order:
//   1. active project's origin matches the PR base repo
//   2. another klausify project's origin matches
//   3. auto-clone into userData/pr-checkouts (partial clone)
// Reuses an existing worktree on the branch instead of fighting git when
// the user has it checked out already.
async function ensureWorktreeForActivePr() {
  if (!activePrReview) return { error: 'No active PR review' };
  const { number, meta, baseOwner, baseRepo } = activePrReview;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo from PR metadata' };

  const active = currentRepoPath();
  let cwd = null;
  if (active) {
    try {
      const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: active, stdio: 'pipe',
      }).toString().trim();
      const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (m && `${m[1]}/${m[2]}` === `${baseOwner}/${baseRepo}`) cwd = active;
    } catch (_) {}
  }
  if (!cwd) cwd = findProjectForRepo(baseOwner, baseRepo);

  let token = '';
  try {
    token = execFileSync('gh', ['auth', 'token'], { stdio: 'pipe' }).toString().trim();
  } catch (_) {
    return { error: 'Could not read gh auth token — run `gh auth login` first.' };
  }
  const authedUrl = `https://oauth2:${token}@github.com/${baseOwner}/${baseRepo}.git`;
  const scrub = (s) => (s || '').replace(/oauth2:[^@]+@/g, 'oauth2:***@');

  // Token-bearing remote URL: DON'T let git persist this into .git/config.
  // Instead we pass it only for the single clone/fetch call (via argv), then
  // immediately rewrite the stored remote URL to the clean form. This way
  // the token isn't in .git/config forever — and `ps` exposure is bounded
  // to the lifetime of the single operation.
  const cleanUrl = `https://github.com/${baseOwner}/${baseRepo}.git`;

  if (!cwd) {
    const cloneBase = path.join(app.getPath('userData'), 'pr-checkouts');
    const clonePath = path.join(cloneBase, `${baseOwner}-${baseRepo}`);
    if (!fs.existsSync(clonePath)) {
      try { fs.mkdirSync(cloneBase, { recursive: true }); } catch (_) {}
      try {
        execFileSync('git', ['clone', '--filter=blob:none', authedUrl, clonePath], { stdio: 'pipe' });
      } catch (err) {
        const raw = (err.stderr ? err.stderr.toString() : err.message) || '';
        return { error: 'Clone failed: ' + scrub(raw) };
      }
      // Strip token from persisted origin URL.
      try {
        execFileSync('git', ['remote', 'set-url', 'origin', cleanUrl], { cwd: clonePath, stdio: 'pipe' });
      } catch {}
    }
    cwd = clonePath;
  }

  const localBranch = (meta && meta.headRefName) || `pr-${number}`;
  const sanitizedForPath = localBranch.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);

  const existingWorktreePath = findWorktreeForBranch(cwd, localBranch);
  if (existingWorktreePath) {
    return { worktreePath: existingWorktreePath, branch: localBranch, baseRepoCwd: cwd, existed: true };
  }

  try {
    execFileSync('git', ['fetch', authedUrl, `+refs/pull/${number}/head:refs/heads/${localBranch}`], {
      cwd, stdio: 'pipe',
    });
  } catch (err) {
    const raw = (err.stderr ? err.stderr.toString() : err.message) || '';
    return { error: 'Fetch failed: ' + scrub(raw) };
  }

  const repoBasename = path.basename(cwd);
  const worktreeDir = path.dirname(cwd);
  const worktreePath = path.join(worktreeDir, repoBasename + '-' + sanitizedForPath);

  if (fs.existsSync(worktreePath)) {
    // Stale dir from a prior run we never wired up — reuse silently rather
    // than failing. git worktree add would error if it's still registered.
    return { worktreePath, branch: localBranch, baseRepoCwd: cwd, existed: true };
  }

  try {
    execFileSync('git', ['worktree', 'add', worktreePath, localBranch], { cwd, stdio: 'pipe' });
  } catch (err) {
    return { error: 'Worktree create failed: ' + (err.stderr ? err.stderr.toString() : err.message) };
  }

  try { await runKlausifyInit(worktreePath); } catch (_) {}
  return { worktreePath, branch: localBranch, baseRepoCwd: cwd, existed: false };
}

// G5: materialize the PR as a worktree + spawn a task in it.
ipcMain.handle('pr-checkout-locally', async () => {
  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };
  const { worktreePath, branch } = ensured;
  const { number, baseOwner, baseRepo } = activePrReview;

  // Already tracked as a task? Focus it instead of spawning a duplicate.
  const existingTask = Array.from(instances.values()).find(i => i.worktreePath === worktreePath);
  let payload;
  if (existingTask) {
    if (!existingTask.prNumber) existingTask.prNumber = number;
    if (!existingTask.prBaseOwner) existingTask.prBaseOwner = baseOwner;
    if (!existingTask.prBaseRepo) existingTask.prBaseRepo = baseRepo;
    payload = {
      id: existingTask.id, name: existingTask.name,
      worktreePath: existingTask.worktreePath, branch: existingTask.branch, mode: existingTask.mode,
    };
  } else {
    const task = spawnInWorktree(branch, worktreePath, branch, 'claude', null, null, number);
    const inst = instances.get(task.id);
    if (inst) {
      inst.prBaseOwner = baseOwner;
      inst.prBaseRepo = baseRepo;
    }
    payload = task;
  }

  // Exit review mode first so the task grid is visible again, THEN announce
  // the new task so the main-window listener can focus it without fighting
  // the review-mode takeover.
  if (activePrReview && activePrReview.popout && !activePrReview.popout.isDestroyed()) {
    activePrReview.popout.close();
  }
  activePrReview = null;
  broadcastPrReview();

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('pr-checkout-ready', payload);
  }
  return { ok: true, task: payload, reused: !!existingTask };
});

// G7: AI review in the PR review surface. Ensures a worktree (auto-cloning
// if needed) and spawns claude with the PR_REVIEW_TEMPLATE, streaming
// stream-json events back to the renderer. Mirrors F6's protocol so the
// renderer can reuse the same chunk parser.
const reviewSurfaceAiProcs = new Map();

ipcMain.handle('pr-review-ai-start', async (event, { requestId }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (reviewSurfaceAiProcs.has(requestId)) return { error: 'Already in flight' };
  if (!activePrReview) return { error: 'No active PR review' };

  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };

  const baseBranch = (activePrReview.meta && activePrReview.meta.baseRefName) || 'main';
  const prompt = PR_REVIEW_TEMPLATE
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch)
    .replace(/\{\{REPO_SPECIFIC_CHECKS\}\}/g, '');

  spawnClaudeStream({
    requestId, procMap: reviewSurfaceAiProcs, channelPrefix: 'pr-review-ai',
    sender: event.sender,
    cwd: ensured.worktreePath,
    prompt,
    streamJson: true,
  });
  return { ok: true, worktreePath: ensured.worktreePath };
});

ipcMain.handle('pr-review-ai-cancel', makeClaudeCancelHandler(reviewSurfaceAiProcs));

// G7: implement a single finding (or "all findings" via one big prompt) by
// spawning claude in the PR's worktree with edit tools. Mirrors the AI-review
// streaming protocol so the renderer can show progress chips + result.
const implementProcs = new Map();

ipcMain.handle('pr-review-implement-start', async (event, { requestId, mode, body }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (implementProcs.has(requestId)) return { error: 'Already in flight' };
  if (!activePrReview) return { error: 'No active PR review' };
  if (!body || !body.trim()) return { error: 'Empty implement body' };

  const ensured = await ensureWorktreeForActivePr();
  if (ensured.error) return { error: ensured.error };

  // Two prompts depending on whether we're implementing one finding or many.
  // Both share guardrails so claude doesn't drift into unrelated cleanup or
  // start running tests/commits.
  const guardrails =
    `\n\nGuidelines:\n`
    + `- Only change what the finding(s) ask for; do not add unrelated cleanup.\n`
    + `- Do not run tests, install deps, or commit/push.\n`
    + `- After making the changes, summarize each change in one short bullet,\n`
    + `  prefixed with the file path. Be terse.\n`;
  const prompt = mode === 'all'
    ? `Apply the following code-review findings to the codebase:\n\n${body}` + guardrails
    : `Apply the following code-review finding to the codebase:\n\n${body}` + guardrails;

  spawnClaudeStream({
    requestId, procMap: implementProcs, channelPrefix: 'pr-review-implement',
    sender: event.sender,
    cwd: ensured.worktreePath,
    prompt,
    streamJson: true,
    extraDoneFields: { worktreePath: ensured.worktreePath },
  });
  return { ok: true, worktreePath: ensured.worktreePath };
});

ipcMain.handle('pr-review-implement-cancel', makeClaudeCancelHandler(implementProcs));

// G7 persistence: cache a PR's AI review + per-finding state by
// (owner, repo, number) so re-opening a PR (or restarting the app) restores
// the prior review and the user's Ignore / Implemented marks.
function reviewCachePathFor(owner, repo, number) {
  const dir = path.join(app.getPath('userData'), 'pr-review-cache');
  const safe = `${owner}-${repo}-${number}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return { dir, file: path.join(dir, safe + '.json') };
}

ipcMain.handle('pr-review-cache-get-by-pr', (_event, { owner, repo, number }) => {
  if (!owner || !repo || !number) return { cached: null };
  const { file } = reviewCachePathFor(owner, repo, number);
  try {
    if (!fs.existsSync(file)) return { cached: null };
    const raw = fs.readFileSync(file, 'utf8');
    return { cached: JSON.parse(raw) };
  } catch (err) {
    return { cached: null, error: err.message };
  }
});

ipcMain.handle('pr-review-cache-save-by-pr', (_event, { owner, repo, number, data }) => {
  if (!owner || !repo || !number) return { ok: false, error: 'Missing key' };
  const { dir, file } = reviewCachePathFor(owner, repo, number);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('pr-review-cache-clear-by-pr', (_event, { owner, repo, number }) => {
  if (!owner || !repo || !number) return { ok: false };
  const { file } = reviewCachePathFor(owner, repo, number);
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
  return { ok: true };
});

// G4: post all pending review comments + decision as one review. The GitHub
// REST endpoint accepts `comments` inline so we only make one network call.
// Piping JSON on stdin avoids shell-escaping pain for multiline comment
// bodies.
// General issue comment on the PR — no line context, just a body.
ipcMain.handle('pr-add-issue-comment', async (_event, { body }) => {
  if (!activePrReview) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number } = activePrReview;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/issues/${number}/comments`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.

  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try {
            const parsed = JSON.parse(stdoutBuf);
            if (parsed.message) msg = parsed.message;
          } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

// Patch an existing issue comment. `commentId` is the REST numeric id
// (GraphQL exposes it as databaseId). Posts to the `/issues/comments/{id}`
// REST endpoint — distinct from review comments which live under `/pulls/`.
ipcMain.handle('pr-edit-issue-comment', async (_event, { commentId, body }) => {
  if (!activePrReview) return { error: 'No active PR review' };
  const { baseOwner, baseRepo } = activePrReview;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const id = parseInt(commentId, 10);
  if (!id) return { error: 'Missing or invalid comment id' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/issues/comments/${id}`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.
  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'PATCH', '--input', '-'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try { const p = JSON.parse(stdoutBuf); if (p.message) msg = p.message; } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true, body });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

// Patch an existing inline/review comment. Separate endpoint from issue
// comments: `/repos/{o}/{r}/pulls/comments/{id}`.
ipcMain.handle('pr-edit-review-comment', async (_event, { commentId, body }) => {
  if (!activePrReview) return { error: 'No active PR review' };
  const { baseOwner, baseRepo } = activePrReview;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const id = parseInt(commentId, 10);
  if (!id) return { error: 'Missing or invalid comment id' };
  if (!body || !body.trim()) return { error: 'Comment body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/comments/${id}`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.
  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'PATCH', '--input', '-'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try { const p = JSON.parse(stdoutBuf); if (p.message) msg = p.message; } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true, body });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

// Cache the current gh-authed user so we only show the edit control on
// comments this user can actually modify. gh api /user is the cheap
// canonical endpoint; we call it once per review session.
let cachedCurrentUser = null;
ipcMain.handle('pr-current-user', async () => {
  if (cachedCurrentUser) return { login: cachedCurrentUser };
  try {
    const out = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      stdio: 'pipe', timeout: 10000,
    }).toString().trim();
    if (out) cachedCurrentUser = out;
    return { login: cachedCurrentUser };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// Reply to a specific review comment (threaded). `inReplyTo` is the parent
// comment's REST databaseId — the same id GraphQL returns on each review
// comment so we can thread using data we already fetch. Uses GitHub's
// dedicated replies endpoint so we don't have to fake a new-comment shape.
ipcMain.handle('pr-reply-to-review-comment', async (_event, { inReplyTo, body }) => {
  if (!activePrReview) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number } = activePrReview;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  const parentId = parseInt(inReplyTo, 10);
  if (!parentId) return { error: 'Missing or invalid parent comment id' };
  if (!body || !body.trim()) return { error: 'Reply body is empty' };

  const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/${number}/comments/${parentId}/replies`;
  const cwd = currentRepoPath() || require('os').homedir();
  // `spawn` is imported at the top of the file.

  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try {
            const parsed = JSON.parse(stdoutBuf);
            if (parsed.message) msg = parsed.message + (parsed.errors ? ': ' + JSON.stringify(parsed.errors) : '');
          } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true });
    });
    proc.stdin.write(JSON.stringify({ body }));
    proc.stdin.end();
  });
});

ipcMain.handle('pr-submit-review', async (_event, { event, body, comments }) => {
  if (!activePrReview) return { error: 'No active PR review' };
  const { baseOwner, baseRepo, number } = activePrReview;
  if (!baseOwner || !baseRepo) return { error: 'Could not determine base repo' };
  if (!event) return { error: 'Missing review event (APPROVE / REQUEST_CHANGES / COMMENT)' };

  const payload = {
    event,
    body: body || '',
    comments: (comments || []).map((c) => {
      const out = {
        path: c.path,
        body: c.body,
        side: c.side || 'RIGHT',
      };
      // GitHub requires `line` always; `start_line` only for multi-line.
      if (typeof c.line === 'number') out.line = c.line;
      if (typeof c.startLine === 'number' && c.startLine !== c.line) {
        out.start_line = c.startLine;
        out.start_side = c.startSide || out.side;
      }
      return out;
    }),
  };

  const cwd = currentRepoPath() || require('os').homedir();
  const endpoint = `repos/${baseOwner}/${baseRepo}/pulls/${number}/reviews`;
  // `spawn` is imported at the top of the file.

  return new Promise((resolve) => {
    const proc = spawn('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.stderr.on('data', (c) => { stderrBuf = appendStderr(stderrBuf, c); });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('exit', (code) => {
      if (code !== 0) {
        // gh often writes JSON errors to stdout on non-zero exit.
        let msg = stderrBuf.trim();
        if (stdoutBuf) {
          try {
            const parsed = JSON.parse(stdoutBuf);
            if (parsed.message) msg = parsed.message + (parsed.errors ? ': ' + JSON.stringify(parsed.errors) : '');
          } catch (_) {}
        }
        resolve({ error: msg || ('gh exited with code ' + code) });
        return;
      }
      resolve({ ok: true });
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
});

ipcMain.handle('pr-review-state', () => activePrReview ? sanitizePrReview(activePrReview) : null);

ipcMain.handle('pr-review-close', () => {
  if (activePrReview && activePrReview.popout && !activePrReview.popout.isDestroyed()) {
    activePrReview.popout.close();
  }
  activePrReview = null;
  broadcastPrReview();
  return { ok: true };
});

ipcMain.handle('pop-out-pr-review', () => {
  if (!activePrReview) return { error: 'No active PR review' };
  if (activePrReview.popout && !activePrReview.popout.isDestroyed()) {
    activePrReview.popout.focus();
    return { ok: true };
  }

  const popout = new BrowserWindow({
    width: 1100,
    height: 800,
    title: `Review \u2014 #${activePrReview.number} ${activePrReview.meta.title || ''}`,
    icon: path.join(__dirname, 'icon.icns'),
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(popout);

  popout.loadFile(path.join(__dirname, 'renderer', 'pr-review.html'));
  activePrReview.popout = popout;
  broadcastPrReview();

  popout.on('closed', () => {
    if (activePrReview && activePrReview.popout === popout) {
      activePrReview.popout = null;
      broadcastPrReview();
    }
  });

  return { ok: true };
});

ipcMain.handle('pop-in-pr-review', () => {
  if (activePrReview && activePrReview.popout && !activePrReview.popout.isDestroyed()) {
    activePrReview.popout.close();
  }
  return { ok: true };
});

// ---- Phase 5: Theme ----

ipcMain.handle('get-theme', () => {
  const config = loadConfig();
  return config.theme || { preset: 'dark' };
});

ipcMain.handle('set-theme', (_event, { theme }) => {
  const config = loadConfig();
  config.theme = theme;
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('get-system-theme', () => {
  return nativeTheme.shouldUseDarkColors;
});

// Listen for system theme changes and forward to renderer
nativeTheme.on('updated', () => {
  for (const win of allWindows) {
    if (!win.isDestroyed()) win.webContents.send('system-theme-changed', nativeTheme.shouldUseDarkColors);
  }
});

// ---- Preferences Window (B1-B4) ----

let prefsWindow = null;

ipcMain.handle('open-preferences', () => {
  if (prefsWindow && !prefsWindow.isDestroyed()) {
    prefsWindow.focus();
    return { ok: true };
  }

  prefsWindow = new BrowserWindow({
    width: 520,
    height: 560,
    title: 'Preferences',
    icon: path.join(__dirname, 'icon.icns'),
    backgroundColor: '#1a1a2e',
    resizable: true,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(prefsWindow);

  prefsWindow.loadFile(path.join(__dirname, 'renderer', 'preferences.html'));
  prefsWindow.on('closed', () => { prefsWindow = null; });
  return { ok: true };
});

ipcMain.handle('get-preferences', () => {
  const config = loadConfig();
  return {
    fontFamily: config.fontFamily || "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    fontSize: config.fontSize || 13,
    lineHeight: config.lineHeight || 1.2,
    cursorStyle: config.cursorStyle || 'block',
    claudePath: config.claudePath || '',
    defaultMode: config.defaultMode || 'claude',
    theme: config.theme || { preset: 'dark' },
    keybindings: config.keybindings || {},
    autoFetchInterval: config.autoFetchInterval || 60000,
  };
});

ipcMain.handle('set-preferences', (_event, prefs) => {
  const config = loadConfig();
  if (prefs.fontFamily !== undefined) config.fontFamily = prefs.fontFamily;
  if (prefs.fontSize !== undefined) config.fontSize = prefs.fontSize;
  if (prefs.lineHeight !== undefined) config.lineHeight = prefs.lineHeight;
  if (prefs.cursorStyle !== undefined) config.cursorStyle = prefs.cursorStyle;
  if (prefs.claudePath !== undefined) config.claudePath = prefs.claudePath;
  if (prefs.defaultMode !== undefined) config.defaultMode = prefs.defaultMode;
  if (prefs.theme !== undefined) config.theme = prefs.theme;
  if (prefs.keybindings !== undefined) config.keybindings = prefs.keybindings;
  if (prefs.autoFetchInterval !== undefined) {
    config.autoFetchInterval = prefs.autoFetchInterval;
    startAutoFetch(); // Reset the auto-fetch timer
  }
  saveConfig(config);

  // Broadcast to all windows so they can apply changes live
  for (const win of allWindows) {
    if (!win.isDestroyed()) win.webContents.send('preferences-changed', prefs);
  }
  return { ok: true };
});

ipcMain.handle('get-claude-info', async () => {
  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  try {
    const version = execFileSync(claudeBin, ['--version'], { stdio: 'pipe', timeout: 5000 }).toString().trim();
    return { path: claudeBin, version };
  } catch {
    return { path: claudeBin, version: 'not found' };
  }
});

// ---- File Tree & Search (C1-C3) ----

// Directories we never descend into during the plain-fs fallback. Mirrors
// the patterns used by the H3 watcher.
const WALK_IGNORE = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.turbo', 'target',
  '.DS_Store', '.venv', 'venv', '.tox', 'coverage',
]);
const WALK_FILE_CAP = 10000;

function walkDirectory(root) {
  const results = [];
  const stack = [''];
  while (stack.length && results.length < WALK_FILE_CAP) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch { continue; }
    for (const ent of entries) {
      if (WALK_IGNORE.has(ent.name)) continue;
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        stack.push(childRel);
      } else if (ent.isFile()) {
        results.push(childRel);
        if (results.length >= WALK_FILE_CAP) break;
      }
    }
  }
  return results;
}

// ---- LSP (Phase I3) ----
//
// The renderer never touches child_process; lsp-manager.js owns server
// lifecycles and proxies JSON-RPC. Each renderer webContents registers
// servers tied to it so we can tear them down if the window closes.

ipcMain.handle('lsp-start', async (event, { worktreePath, languageId }) => {
  return lspManager.startServer({
    worktreePath,
    languageId,
    webContents: event.sender,
  });
});

ipcMain.handle('lsp-stop', async (_event, { serverId }) => {
  return lspManager.stopServer(serverId);
});

ipcMain.handle('lsp-request', async (_event, { serverId, method, params }) => {
  return lspManager.request(serverId, method, params);
});

ipcMain.handle('lsp-notify', async (_event, { serverId, method, params }) => {
  return lspManager.notify(serverId, method, params);
});

ipcMain.handle('lsp-install', async (event, { languageId }) => {
  return lspManager.installServer({ languageId, webContents: event.sender });
});

// (LSP shutdown merged into the main before-quit handler earlier in this file.)

// Bulk-read many files in one IPC round-trip. Used by the Monaco file
// viewer to hydrate sibling TS/JS models for cross-file IntelliSense.
// Per-file size is capped to avoid shipping giant minified bundles; total
// file count is capped by the caller.
ipcMain.handle('read-files-bulk', async (_event, { worktreePath, relPaths, maxBytesPerFile }) => {
  const cap = maxBytesPerFile || 256 * 1024; // 256KB per file default
  const out = {};
  for (const rel of relPaths) {
    // Reject path traversal AND symlink escapes — every entry must resolve
    // under the real worktree path (a symlink pointing outside is refused).
    const safe = pathUnder(worktreePath, rel);
    if (!safe) continue;
    try {
      const stat = fs.lstatSync(safe);
      if (!stat.isFile() || stat.size > cap) continue;
      out[rel] = fs.readFileSync(safe, 'utf-8');
    } catch {}
  }
  return { files: out };
});

ipcMain.handle('list-files', async (_event, { worktreePath }) => {
  // Try git first — for a checked-out repo, ls-files respects .gitignore.
  try {
    const { stdout } = await execFileP('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: worktreePath, maxBuffer: 5 * 1024 * 1024,
    });
    return { files: stdout.split('\n').filter(Boolean) };
  } catch (err) {
    // Not a git repo (open-folder flow) — walk the directory directly.
    const msg = err.stderr ? err.stderr.toString() : err.message;
    if (/not a git repository/i.test(msg)) {
      try {
        return { files: walkDirectory(worktreePath) };
      } catch (walkErr) {
        return { files: [], error: walkErr.message };
      }
    }
    return { files: [], error: msg };
  }
});

function parseGrepOutput(output) {
  const results = [];
  output.split('\n').filter(Boolean).forEach(function (line) {
    const match = line.match(/^([^:]+):(\d+):(.*)$/);
    if (match) {
      results.push({ file: match[1], line: parseInt(match[2], 10), text: match[3] });
    }
  });
  return results.slice(0, 100);
}

ipcMain.handle('search-files', async (_event, { worktreePath, query, maxPerFile }) => {
  // Literal (fixed-string) search via -F. Matches what the I7 replace path
  // does under the hood (content.split(query)), so preview and replace are
  // guaranteed to see the same hits. If regex search is ever needed, it
  // should land as an explicit opt-in flag rather than the default — the
  // replace path can't honor it safely.
  const cap = '--max-count=' + (typeof maxPerFile === 'number' ? maxPerFile : 5);
  // Try git grep — respects .gitignore and is fast.
  try {
    // `--` is mandatory: without it, a `query` starting with `-` (or a
    // long flag git-grep recognizes) is parsed as an option rather than
    // the search pattern. `-F` alone doesn't fully defend against that.
    const args = ['grep', '-n', '--no-color', '-I', '-r', '-F', cap, '--', query];
    const { stdout: output } = await execFileP('git', args, {
      cwd: worktreePath, maxBuffer: 5 * 1024 * 1024, timeout: 10000,
    });
    return { results: parseGrepOutput(output) };
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : err.message;
    if (/not a git repository/i.test(msg)) {
      // fall through to plain-grep fallback
    } else if (err.status === 1) {
      return { results: [] };
    } else {
      return { results: [], error: msg };
    }
  }
  // Non-git fallback — plain `grep -rnF -I` with the same ignore list the walker uses.
  try {
    const args = ['-rnF', '-I', cap];
    for (const dir of WALK_IGNORE) args.push('--exclude-dir=' + dir);
    args.push('--', query, '.');
    const { stdout: output } = await execFileP('grep', args, {
      cwd: worktreePath, maxBuffer: 5 * 1024 * 1024, timeout: 10000,
    });
    // grep prefixes paths with "./" — trim for consistency with git grep.
    const normalized = output.split('\n').map(l => l.replace(/^\.\//, '')).join('\n');
    return { results: parseGrepOutput(normalized) };
  } catch (err) {
    // grep exits 1 when nothing matched (promisified exposes this on err.code).
    if (err.code === 1) return { results: [] };
    return { results: [], error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// Replace-in-files (I7). Takes the same worktree + a list of file-relative
// paths plus a (literal) search string and replacement string. For each file
// we read, replaceAll, and write. Returns per-file counts so the caller can
// report "N replacements in M files".
//
// Intentionally literal-only: regex replace opens the door to capture-group
// surprises and destructive mistakes. If needed later we can add a flag.
ipcMain.handle('replace-in-files', async (_event, { worktreePath, relPaths, query, replacement }) => {
  if (!worktreePath || !Array.isArray(relPaths) || !query) {
    return { error: 'Missing required arguments' };
  }
  const perFile = [];
  let totalReplacements = 0;
  for (const rel of relPaths) {
    // pathUnder canonicalizes via realpath on both the root and the file,
    // so a symlink inside the worktree pointing out (e.g. -> /etc/passwd)
    // is refused — not just the lexical `..` traversal.
    const safe = pathUnder(worktreePath, rel);
    if (!safe) {
      perFile.push({ file: rel, error: 'Path escapes worktree' });
      continue;
    }
    try {
      const content = fs.readFileSync(safe, 'utf8');
      // Fast literal count via split; avoids needing to regex-escape the query.
      const parts = content.split(query);
      const count = parts.length - 1;
      if (count === 0) {
        perFile.push({ file: rel, replaced: 0 });
        continue;
      }
      const next = parts.join(replacement);
      fs.writeFileSync(safe, next);
      perFile.push({ file: rel, replaced: count });
      totalReplacements += count;
    } catch (err) {
      perFile.push({ file: rel, error: err.message });
    }
  }
  return { ok: true, totalReplacements, files: perFile };
});

// ---- Explain Diff ----

function explainPrompt(file, hunk) {
  return `Explain this specific code concisely. What does it do and why might it have been written this way?\n\nFile: ${file}\n\nSelected code:\n\`\`\`\n${hunk}\n\`\`\``;
}

ipcMain.handle('explain-diff', async (_event, { worktreePath, file, hunk }) => {
  // PR review mode calls this without a worktree — fall back to the current
  // project path (or the user's home as a last resort) since execFile insists
  // on a valid cwd. Claude doesn't actually need repo context for this prompt.
  const cwd = worktreePath || currentRepoPath() || require('os').homedir();
  return new Promise((resolve) => {
    execFile('claude', ['-p', explainPrompt(file, hunk)], {
      cwd,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: stderr || err.message });
      } else {
        resolve({ explanation: stdout.trim() });
      }
    });
  });
});

// Streaming variant. Pipes claude stdout to the renderer in real time so the
// user sees tokens as they arrive instead of staring at a 10-second spinner.
// Callers pass a requestId; chunks arrive on `explain-diff-chunk-<id>` and
// completion on `explain-diff-done-<id>`.
const explainStreamProcs = new Map();

ipcMain.handle('explain-diff-stream-start', (event, { requestId, worktreePath, file, hunk }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (explainStreamProcs.has(requestId)) return { error: 'Already streaming' };
  spawnClaudeStream({
    requestId, procMap: explainStreamProcs, channelPrefix: 'explain-diff',
    sender: event.sender,
    cwd: worktreePath || currentRepoPath() || require('os').homedir(),
    prompt: explainPrompt(file, hunk),
  });
  return { ok: true };
});

// Streams a suggested commit message for the staged changes into the diff
// panel. Renderer shows a sparkle button next to the commit input; the result
// is editable before the user actually commits. Pulls the last few commit
// subjects so claude can match the repo's tone (conventional / prefix / etc.)
// without us prescribing a style.
const commitMsgProcs = new Map();
ipcMain.handle('claude-commit-message-start', async (event, { requestId, worktreePath }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (commitMsgProcs.has(requestId)) return { error: 'Already generating' };
  if (!worktreePath) return { error: 'Missing worktreePath' };

  let diff = '';
  try {
    const { stdout } = await execFileP('git', ['diff', '--cached'], {
      cwd: worktreePath, maxBuffer: 5 * 1024 * 1024,
    });
    diff = stdout;
  } catch (err) {
    return { error: 'Could not read staged diff: ' + (err.stderr || err.message) };
  }
  if (!diff.trim()) return { error: 'No staged changes to summarize' };

  // Cap diff to keep the prompt inside a reasonable budget. If the staged diff
  // is huge, trim and tell claude we truncated so it doesn't hallucinate whole
  // regions of the change.
  const MAX = 80 * 1024;
  const diffForPrompt = diff.length > MAX
    ? diff.slice(0, MAX) + '\n\n[... diff truncated ...]\n'
    : diff;

  let recent = '';
  try {
    const { stdout } = await execFileP('git', ['log', '-n', '10', '--format=%s'], {
      cwd: worktreePath,
    });
    recent = stdout.trim();
  } catch { /* brand-new repo or no commits; omit style sample */ }

  const prompt =
    'Write a commit message for the staged changes below.\n\n' +
    'Rules (strict):\n' +
    '- Output ONLY the commit message — no explanations, no code fences, no preamble.\n' +
    '- First line is the subject: imperative mood, under 72 chars, no trailing period.\n' +
    '- If the change is non-trivial, add a blank line and a short body explaining the "why".\n' +
    '- Match the style (prefix conventions, length, tone) of the recent subjects shown below.\n\n' +
    (recent ? 'Recent commit subjects (for style only):\n' + recent + '\n\n' : '') +
    'Staged diff:\n' + diffForPrompt;

  spawnClaudeStream({
    requestId, procMap: commitMsgProcs, channelPrefix: 'claude-commit-message',
    sender: event.sender,
    cwd: worktreePath,
    prompt,
  });
  return { ok: true };
});

ipcMain.handle('claude-commit-message-cancel', makeClaudeCancelHandler(commitMsgProcs));

ipcMain.handle('explain-diff-stream-cancel', makeClaudeCancelHandler(explainStreamProcs));

// ---- Whole-PR AI Review ----

const PR_REVIEW_TEMPLATE = `You are conducting a thorough PR review. Follow these phases in order.

---

## Phase 1: Context Gathering

1. Run \`git diff --stat {{BASE_BRANCH}}...HEAD\` and count the total lines changed (additions + deletions).
2. Run \`git diff {{BASE_BRANCH}}...HEAD\` to get the full diff.
3. Run \`git log {{BASE_BRANCH}}..HEAD --oneline\` to understand commit history and intent.
4. For each changed file, read the full file (not just the diff hunks) to understand surrounding context.
5. If the branch name contains a ticket reference (e.g. FEAT-1234), note it for context.

Store the diff output, file contents, and commit log — you will need them in the next phase.

---

## Phase 2: Triage

Count the total lines changed from the \`--stat\` output.

- **If < 150 lines changed:** proceed to [Small PR Review](#small-pr-review) below.
- **If >= 150 lines changed:** proceed to [Parallel Review](#parallel-review) below.

---

## Small PR Review

You are a senior/principal-level engineer reviewing a pull request. Treat this as a real production PR. Output ONLY PR-style review comments, as if leaving inline comments on GitHub/GitLab.

### Comment format (required for every comment):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (specific suggestion or alternative)

### Review rules:

- Be skeptical and precise.
- Assume the code will be read and modified by others.
- Repeat the code to help pinpoint the issue. No more than 10 lines.
- If something relies on an unstated assumption, call it out.
- If behavior is unclear, treat that as a problem.
- Prefer concrete fixes over vague advice.

### What to look for (in order of priority):

1. **Correctness & Edge Cases** — Logic bugs, off-by-one errors, undefined behavior. Error handling gaps, partial failures.
2. **Concurrency & State** — Race conditions, shared mutable state. Thread safety, async misuse, ordering assumptions.
3. **Design & API Boundaries** — Leaky abstractions, tight coupling. Public interfaces that are hard to evolve.
4. **Performance & Scalability** — Inefficient loops, N+1 calls, blocking I/O. Work done in hot paths that doesn't need to be.
5. **Reliability** — Missing retries, timeouts, idempotency. Resource cleanup (connections, files, tasks).
6. **Security** — Input validation, trust boundaries. Logging sensitive data.
7. **Readability & Maintainability** — Ambiguous naming, overly clever code. Comments that explain "what" instead of "why".
8. **Test Coverage** — Were tests added or updated for the changes? Are edge cases covered?
9. **Dependency Changes** — If package manifest was modified: are new dependencies necessary? Are versions pinned? Flag any new dependencies that duplicate existing functionality.
10. **Scope** — Identify the primary intent of the PR. Flag changes unrelated to that intent with **Warn** severity.

{{REPO_SPECIFIC_CHECKS}}

### Tone & standards:

- Assume a high bar (staff/principal quality).
- If something is "technically correct but fragile," say so.
- If something would fail under load or future change, flag it.
- Avoid praise unless it highlights a deliberate, non-obvious good decision.

### Validate findings:

Before writing the final output, validate every finding you produced. For each one:

1. **Read the full file** referenced in the finding (not just the diff hunk).
2. **Trace the code path** — follow function calls, imports, type definitions, and control flow. Read caller and callee files as needed.
3. **Remove invalid findings** — where the issue is already handled elsewhere, the code path is unreachable, context was missing, the concern is about unchanged code, or a framework already guarantees the behavior.
4. **Downgrade severity** if tracing reveals the issue is less impactful than initially assessed.

A shorter, accurate review is far more valuable than a long review with false positives.

### End of review:

After validation, add a final PR summary:

**Overall verdict:** Approve / Request Changes / Block

**Highest-risk issues:**
1. ...
2. ...
3. ...

**Test coverage assessment:**
- [ ] Adequate test coverage for changes
- [ ] Edge cases tested

---

## Parallel Review

This PR is large enough to benefit from focused, parallel review. Use the **Agent tool** to launch all four of the following review agents **simultaneously in a single response**. Pass each agent the full diff, changed file contents, and commit log you gathered in Phase 1.

**Important:** Each agent returns its findings as text. Agents must NOT write any files.

---

### Agent 1: Correctness & Logic

Use the Agent tool with this prompt (include the diff and file contents you gathered):

\`\`\`
You are a senior engineer reviewing a pull request. Your ONLY focus is correctness and concurrency. Ignore all other concerns (design, style, security, etc.) — other reviewers are handling those.

Here is the diff:
[PASTE THE FULL DIFF HERE]

Here is the commit log:
[PASTE THE COMMIT LOG HERE]

Read every changed file in full for surrounding context.

## What to look for:

### Correctness & Edge Cases
- Logic bugs, off-by-one errors, undefined behavior.
- Error handling gaps, partial failures.
- Incorrect return values or wrong types.
- Boundary conditions: empty inputs, nil/null, max values, overflow.
- State mutations that violate invariants.

### Concurrency & State
- Race conditions, shared mutable state.
- Thread safety, async misuse, ordering assumptions.
- Deadlocks, livelocks, starvation.
- Missing synchronization or incorrect lock scope.
- Assumptions about execution order in async code.

## Output format (required for every finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**Comment:**

- What is wrong, why this is a problem (be specific about the failure mode)
- What should be changed (concrete fix or alternative)

Rules:
- Be skeptical and precise.
- Repeat the relevant code (up to 10 lines) to pinpoint the issue.
- If something relies on an unstated assumption, call it out.
- Prefer concrete fixes over vague advice.
- Return ONLY your findings. Do not write any files.
\`\`\`

---

### Agent 2: Architecture & Design

Use the Agent tool with this prompt (include the diff and file contents you gathered):

\`\`\`
You are a senior engineer reviewing a pull request. Your ONLY focus is architecture, design, performance, reliability, and dependency changes. Ignore correctness bugs, style, and security — other reviewers are handling those.

Here is the diff:
[PASTE THE FULL DIFF HERE]

Here is the commit log:
[PASTE THE COMMIT LOG HERE]

Read every changed file in full for surrounding context.

## What to look for:

### Design & API Boundaries
- Leaky abstractions, tight coupling.
- Public interfaces that are hard to evolve.
- Violation of existing architectural patterns in the codebase.
- Responsibilities placed in the wrong layer or module.

### Performance & Scalability
- Inefficient loops, N+1 calls, blocking I/O.
- Work done in hot paths that doesn't need to be.
- Missing pagination, unbounded queries, or unbounded memory growth.
- Allocations or copies that could be avoided.

### Reliability
- Missing retries, timeouts, idempotency.
- Resource cleanup (connections, files, tasks).
- Failure modes that leave the system in an inconsistent state.
- Missing circuit breakers or backpressure for external calls.

### Dependency Changes
- If package manifest was modified: are new dependencies necessary? Are versions pinned?
- Flag any new dependencies that duplicate existing functionality.
- Evaluate transitive dependency impact.

## Output format (required for every finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (concrete fix or alternative)

Rules:
- Be skeptical and precise.
- Repeat the relevant code (up to 10 lines) to pinpoint the issue.
- Think about how changes behave at scale and over time.
- Prefer concrete fixes over vague advice.
- Return ONLY your findings. Do not write any files.
\`\`\`

---

### Agent 3: Security & Quality

Use the Agent tool with this prompt (include the diff and file contents you gathered):

\`\`\`
You are a senior engineer reviewing a pull request. Your ONLY focus is security, readability, maintainability, and test coverage. Ignore correctness bugs, architecture, and performance — other reviewers are handling those.

Here is the diff:
[PASTE THE FULL DIFF HERE]

Here is the commit log:
[PASTE THE COMMIT LOG HERE]

Read every changed file in full for surrounding context.

## What to look for:

### Security
- Input validation gaps, trust boundary violations.
- Injection vectors: SQL, command, XSS, path traversal.
- Authentication/authorization bypasses.
- Logging or exposing sensitive data (tokens, passwords, PII).
- Insecure defaults or missing security headers.
- Cryptographic misuse (weak algorithms, hardcoded keys).

### Readability & Maintainability
- Ambiguous naming, overly clever code.
- Comments that explain "what" instead of "why".
- Functions that are too long or do too many things.
- Magic numbers or strings without explanation.
- Dead code or unreachable branches.

### Test Coverage
- Were tests added or updated for the changes?
- Are edge cases covered?
- Are failure paths tested?
- Do tests actually assert meaningful behavior (not just "doesn't crash")?
- Are mocks/stubs appropriate, or do they hide real behavior?

## Output format (required for every finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (concrete fix or alternative)

Rules:
- Be skeptical and precise.
- Repeat the relevant code (up to 10 lines) to pinpoint the issue.
- For security issues, describe the attack vector concretely.
- Prefer concrete fixes over vague advice.
- Return ONLY your findings. Do not write any files.
\`\`\`

---

### Agent 4: Scope & Conventions

Use the Agent tool with this prompt (include the diff and file contents you gathered):

\`\`\`
You are a senior engineer reviewing a pull request. Your ONLY focus is scope analysis and adherence to project conventions. Ignore bugs, architecture, security, and style — other reviewers are handling those.

Here is the diff:
[PASTE THE FULL DIFF HERE]

Here is the commit log:
[PASTE THE COMMIT LOG HERE]

Read every changed file in full for surrounding context.

## What to look for:

### Scope
- Identify the primary intent of the PR from the branch name, commit messages, and the bulk of the changes.
- Flag any changes that do not appear related to that primary intent (e.g. drive-by refactors, unrelated formatting, feature creep).
- Use **Warn** severity for unrelated changes — they may be intentional, but should be called out for the author to confirm.
- Check that the PR does one thing well rather than bundling unrelated work.

### Project Conventions
{{REPO_SPECIFIC_CHECKS}}

If no repo-specific checks are listed above, check the CLAUDE.md file in the repository for project conventions, commands, and known pitfalls, and verify the PR adheres to them.

## Output format (required for every finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (concrete fix or alternative)

Rules:
- Be precise about what is out of scope vs. in scope.
- For convention violations, reference the specific convention.
- Prefer concrete fixes over vague advice.
- Return ONLY your findings. Do not write any files.
\`\`\`

---

## Phase 3: Validation

Before synthesizing, validate every finding from the sub-agents. For each finding:

1. **Read the full file** referenced in the finding's location (not just the diff hunk).
2. **Trace the code path** — follow function calls, imports, type definitions, and control flow to understand the full context. Read caller and callee files as needed.
3. **Determine if the finding is still valid** given the full context. Common reasons a finding is invalid:
   - The issue is already handled elsewhere (e.g., validation happens in a caller, error is caught upstream).
   - The code path cannot actually be reached in the way the finding assumes.
   - The finding misreads the logic due to missing surrounding context.
   - The concern is about code that was not changed in this PR and is out of scope.
   - A dependency or framework already guarantees the behavior the finding questions.
4. **Remove invalid findings.** Do not include them in the final output. Do not note that they were removed.
5. **Downgrade severity** if tracing reveals the issue is less impactful than initially assessed (e.g., a "High" race condition that only affects a debug-only path should be "Low" or "Nit").

Be thorough — read as many files as needed to verify each finding. A shorter, accurate review is far more valuable than a long review with false positives.

---

## Phase 4: Synthesis

After validation, synthesize the remaining findings:

1. **Deduplicate**: If multiple agents flagged the same issue, keep the most detailed comment and use the highest severity assigned.
2. **Sort by severity**: Blocker > High > Medium > Low > Warn > Nit.
3. **Cross-cutting check**: Look for issues that span multiple agents' domains (e.g., a correctness bug that is also a security vulnerability). Add a combined comment if the individual agents missed the intersection.
4. **Assess overall quality**: Consider the findings holistically.

### Comment format (for each finding):

**[Severity: Blocker | High | Medium | Low | Warn | Nit]**
**[Location: file_path:line_number and code_snippet]**
**[Category: Correctness | Concurrency | Design | Performance | Reliability | Security | Readability | Tests | Dependencies | Scope | Conventions]**
**Comment:**

- What is wrong or questionable, why this is a problem
- What should be changed (specific suggestion or alternative)

### Final PR summary:

**Overall verdict:** Approve / Request Changes / Block

**Highest-risk issues:**
1. ...
2. ...
3. ...

**Test coverage assessment:**
- [ ] Adequate test coverage for changes
- [ ] Edge cases tested

**Review method:** Parallel (4 focused sub-agents)

---

## IMPORTANT: Output

Do NOT write any files. Output the final review directly as your response to this prompt. The user will read it from your stdout.`;

// In-flight AI review processes, keyed by renderer-generated request id
// so the renderer can cancel them.
const aiReviewProcs = new Map();

// Legacy config.prReviews cache was retired in favor of the file-per-PR cache
// in userData/pr-review-cache/. Entries are migrated once on startup via
// migratePrReviewCache(); see the file-per-PR handlers above for the current
// shape and the *-by-pr IPCs.

// Send text to the Claude terminal for a given worktree (via bracketed paste,
// so multi-line content doesn't submit partial lines). Returns the task id.
ipcMain.handle('pr-fix-in-terminal', (_event, { worktreePath, text }) => {
  // Prefer an alive claude-mode instance; fall back to any alive instance.
  let target = null;
  for (const [, inst] of instances) {
    if (inst.worktreePath === worktreePath && inst.alive && inst.mode === 'claude') { target = inst; break; }
  }
  if (!target) {
    for (const [, inst] of instances) {
      if (inst.worktreePath === worktreePath && inst.alive) { target = inst; break; }
    }
  }
  if (!target) return { error: 'No active task for this worktree. Start a Claude task first.' };

  const BP_START = '\x1b[200~';
  const BP_END = '\x1b[201~';
  // `text` is PR-comment / AI-finding content from untrusted GitHub. If it
  // contains \x1b[201~ (the paste end marker), the shell exits paste mode
  // mid-write and treats the remainder as typed input — which would execute
  // injected commands. Strip the paste-mode sequences from `text` so they
  // cannot break out of the bracket we wrap it in.
  const safeText = typeof text === 'string'
    ? text.replace(/\x1b\[20[01]~/g, '')
    : '';
  try {
    target.pty.write(BP_START + safeText + BP_END);
    return { ok: true, taskId: target.id, mode: target.mode };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('pr-ai-review-start', (event, { worktreePath, baseBranch, requestId }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (aiReviewProcs.has(requestId)) return { error: 'Review already in flight for ' + requestId };

  const prompt = PR_REVIEW_TEMPLATE
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch || 'main')
    .replace(/\{\{REPO_SPECIFIC_CHECKS\}\}/g, '');

  // stream-json gives us a JSONL event per assistant/tool/result block so we
  // can surface progress in the UI instead of a 15-minute silent spinner.
  spawnClaudeStream({
    requestId, procMap: aiReviewProcs, channelPrefix: 'pr-ai-review',
    sender: event.sender,
    cwd: worktreePath,
    prompt,
    streamJson: true,
  });
  return { ok: true };
});

ipcMain.handle('pr-ai-review-cancel', makeClaudeCancelHandler(aiReviewProcs));

// ---- PR Comment AI Review ----

ipcMain.handle('pr-ai-review-comment', async (_event, { worktreePath, prTitle, prBody, commentAuthor, commentBody, filePath, diffHunk }) => {
  let context = `PR Title: ${prTitle}\n`;
  if (prBody) context += `PR Description: ${prBody}\n`;
  if (filePath) context += `File: ${filePath}\n`;
  if (diffHunk) context += `Code context:\n\`\`\`\n${diffHunk}\n\`\`\`\n`;

  const prompt = `You are reviewing a PR comment. Analyze whether the comment raises a valid concern, and draft a concise reply.

${context}
Comment by ${commentAuthor}:
"${commentBody}"

Respond in this exact format:
VALIDITY: [Valid / Partially Valid / Not Valid] — one sentence explaining why.
SUGGESTED REPLY:
[Your drafted reply to post on the PR. Be professional, concise, and constructive. If the concern is valid, acknowledge it and describe how you'll address it. If not, explain why politely.]`;

  const config = loadConfig();
  const claudeBin = config.claudePath || 'claude';
  return new Promise((resolve) => {
    execFile(claudeBin, ['-p', prompt], {
      cwd: worktreePath,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: stderr || err.message });
      } else {
        resolve({ review: stdout.trim() });
      }
    });
  });
});

// ---- PR Threaded Reply ----

ipcMain.handle('pr-reply-to-comment', async (_event, { worktreePath, prNumber, commentId, body }) => {
  try {
    const repoResult = ghExec(['repo', 'view', '--json', 'nameWithOwner'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const repo = JSON.parse(repoResult).nameWithOwner;
    ghExec(['api', '-X', 'POST',
      'repos/' + repo + '/pulls/' + prNumber + '/comments',
      '-F', 'in_reply_to=' + commentId,
      '-f', 'body=' + body,
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- PR Interaction ----

ipcMain.handle('pr-for-branch', async (_event, { worktreePath }) => {
  const jsonFields = 'number,title,state,body,url,headRefName,baseRefName,headRefOid,additions,deletions,reviewDecision,comments,reviews,mergeable,mergeStateStatus,isDraft';

  // G5 fast path: if this worktree was created from "Check out locally",
  // look up the PR by its recorded number + base repo. Avoids gh's default
  // branch-matching lookup which fails for cross-repo (fork) PRs and for
  // any situation where the local branch name doesn't match the head ref.
  let hintedInst = null;
  for (const inst of instances.values()) {
    if (inst.worktreePath === worktreePath && inst.prNumber) { hintedInst = inst; break; }
  }
  if (hintedInst) {
    try {
      const args = ['pr', 'view', String(hintedInst.prNumber), '--json', jsonFields];
      if (hintedInst.prBaseOwner && hintedInst.prBaseRepo) {
        args.push('-R', `${hintedInst.prBaseOwner}/${hintedInst.prBaseRepo}`);
      }
      const result = ghExec(args, { cwd: worktreePath, stdio: 'pipe', timeout: 15000 }).toString();
      return { pr: JSON.parse(result) };
    } catch (err) {
      // Fall through to branch-matching lookup if the hinted one errors.
    }
  }

  try {
    const result = ghExec([
      'pr', 'view', '--json', jsonFields,
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 15000 }).toString();
    return { pr: JSON.parse(result) };
  } catch (err) {
    const msg = (err.stderr ? err.stderr.toString() : err.message) || '';
    if (msg.includes('no pull requests found')) {
      return { pr: null };
    }
    if (msg.includes('Could not resolve')) {
      return { pr: null, error: 'Cannot access this repository. Check that `gh` is authenticated with the correct GitHub account.' };
    }
    return { pr: null, error: msg };
  }
});

ipcMain.handle('pr-add-review-comment', async (_event, { worktreePath, prNumber, body, path: filePath, line, side, startLine, startSide, commitId }) => {
  try {
    const repoResult = ghExec(['repo', 'view', '--json', 'nameWithOwner'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const repo = JSON.parse(repoResult).nameWithOwner;
    const args = [
      'api', '--method', 'POST',
      `repos/${repo}/pulls/${prNumber}/comments`,
      '-f', 'body=' + body,
      '-f', 'path=' + filePath,
      '-F', 'line=' + line,
      '-f', 'side=' + (side || 'RIGHT'),
      '-f', 'commit_id=' + commitId,
    ];
    if (startLine && startLine !== line) {
      args.push('-F', 'start_line=' + startLine);
      args.push('-f', 'start_side=' + (startSide || side || 'RIGHT'));
    }
    ghExec(args, { cwd: worktreePath, stdio: 'pipe', timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('pr-merge', async (_event, { worktreePath, prNumber, strategy }) => {
  const flag = { merge: '--merge', squash: '--squash', rebase: '--rebase' }[strategy];
  if (!flag) return { error: 'Unknown merge strategy: ' + strategy };
  try {
    ghExec(['pr', 'merge', String(prNumber), flag], {
      cwd: worktreePath, stdio: 'pipe', timeout: 30000
    });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('pr-checks', async (_event, { worktreePath, prNumber }) => {
  try {
    const out = ghExec(
      ['pr', 'checks', String(prNumber), '--json', 'name,state,bucket,link,workflow,description'],
      { cwd: worktreePath, stdio: 'pipe', timeout: 15000 }
    ).toString();
    return { checks: JSON.parse(out) };
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : err.message;
    // `gh pr checks` exits non-zero when checks are failing — the JSON still
    // prints to stdout. Try to recover from err.stdout before giving up.
    if (err.stdout) {
      try { return { checks: JSON.parse(err.stdout.toString()) }; } catch {}
    }
    // "no checks reported" is not an error
    if (msg && /no checks reported/i.test(msg)) {
      return { checks: [] };
    }
    return { checks: [], error: msg };
  }
});

ipcMain.handle('pr-review-threads', async (_event, { worktreePath, prNumber }) => {
  try {
    const repoResult = ghExec(['repo', 'view', '--json', 'nameWithOwner'], { cwd: worktreePath, stdio: 'pipe' }).toString();
    const [owner, repo] = JSON.parse(repoResult).nameWithOwner.split('/');
    const query = 'query($owner: String!, $repo: String!, $number: Int!) {'
      + '  repository(owner: $owner, name: $repo) {'
      + '    pullRequest(number: $number) {'
      + '      reviewThreads(first: 100) {'
      + '        nodes {'
      + '          id isResolved isOutdated path line originalLine startLine originalStartLine diffSide'
      + '          comments(first: 100) { nodes { databaseId author { login } createdAt body diffHunk } }'
      + '        }'
      + '      }'
      + '    }'
      + '  }'
      + '}';
    const out = ghExec([
      'api', 'graphql',
      '-f', 'query=' + query,
      '-f', 'owner=' + owner,
      '-f', 'repo=' + repo,
      '-F', 'number=' + prNumber,
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 15000 }).toString();
    const parsed = JSON.parse(out);
    if (parsed && parsed.errors && parsed.errors.length) {
      return { threads: [], error: parsed.errors.map(e => e.message).join('; ') };
    }
    const threads = (parsed && parsed.data && parsed.data.repository && parsed.data.repository.pullRequest
      && parsed.data.repository.pullRequest.reviewThreads && parsed.data.repository.pullRequest.reviewThreads.nodes) || [];
    return { threads };
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    // `gh api graphql` often writes the JSON error body to stdout even on non-zero exit
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout.toString());
        if (parsed.errors && parsed.errors.length) {
          return { threads: [], error: parsed.errors.map(e => e.message).join('; ') };
        }
      } catch {}
    }
    return { threads: [], error: stderr || err.message };
  }
});

function resolveOrUnresolveThread(worktreePath, threadId, resolve) {
  const mutation = resolve
    ? 'mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }'
    : 'mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }';
  try {
    ghExec([
      'api', 'graphql',
      '-f', 'query=' + mutation,
      '-F', 'id=' + threadId,
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
}

ipcMain.handle('pr-resolve-thread', (_event, { worktreePath, threadId }) => {
  return resolveOrUnresolveThread(worktreePath, threadId, true);
});

ipcMain.handle('pr-unresolve-thread', (_event, { worktreePath, threadId }) => {
  return resolveOrUnresolveThread(worktreePath, threadId, false);
});

ipcMain.handle('pr-add-comment', async (_event, { worktreePath, prNumber, body }) => {
  try {
    ghExec(['pr', 'comment', String(prNumber), '--body', body], {
      cwd: worktreePath, stdio: 'pipe', timeout: 15000
    });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('pr-review', async (_event, { worktreePath, prNumber, event, body }) => {
  try {
    const args = ['pr', 'review', String(prNumber), '--' + event];
    if (body) args.push('--body', body);
    ghExec(args, { cwd: worktreePath, stdio: 'pipe', timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- Merge Conflict Resolution (Feature 1) ----

ipcMain.handle('read-conflict-file', async (_event, { worktreePath, file }) => {
  const safe = pathUnder(worktreePath, file);
  if (!safe) return { error: 'file outside worktree' };
  try {
    const content = fs.readFileSync(safe, 'utf-8');
    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-resolved-file', async (_event, { worktreePath, file, content }) => {
  const safe = pathUnder(worktreePath, file);
  if (!safe) return { error: 'file outside worktree' };
  try {
    fs.writeFileSync(safe, content, 'utf-8');
    // Use the original relative `file` arg for `git add` (git wants a repo-relative path).
    await execFileP('git', ['add', '--', file], { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- .env File Viewer/Editor (Feature 12) ----

ipcMain.handle('list-env-files', async (_event, { worktreePath }) => {
  try {
    const entries = fs.readdirSync(worktreePath);
    const envFiles = entries.filter(f => /^\.env/.test(f) && fs.statSync(path.join(worktreePath, f)).isFile());
    return { files: envFiles };
  } catch (err) {
    return { files: [], error: err.message };
  }
});

ipcMain.handle('read-env-file', async (_event, { worktreePath, filename }) => {
  // Security: prevent path traversal
  if (filename.includes('/') || filename.includes('\\') || !filename.startsWith('.env')) {
    return { error: 'Invalid filename' };
  }
  try {
    const content = fs.readFileSync(path.join(worktreePath, filename), 'utf-8');
    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-env-file', async (_event, { worktreePath, filename, content }) => {
  // Security: prevent path traversal
  if (filename.includes('/') || filename.includes('\\') || !filename.startsWith('.env')) {
    return { error: 'Invalid filename' };
  }
  try {
    fs.writeFileSync(path.join(worktreePath, filename), content, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// ---- CI/CD Status (Feature 3) ----

const ciPollingIntervals = new Map(); // taskId -> intervalId

function startCIPolling(id, worktreePath, branch) {
  stopCIPolling(id);
  // No branch = plain folder (open-folder flow). CI has nothing to poll for.
  if (!branch) return;
  // Async poll so gh round-trip doesn't block the main thread. A 10s timeout
  // on a stuck gh call used to freeze every window; now the event loop keeps
  // running while we wait.
  const poll = async () => {
    try {
      const { stdout } = await ghExecP([
        'run', 'list', '--branch', branch, '--limit', '5',
        '--json', 'status,conclusion,name,url,createdAt',
      ], { cwd: worktreePath, timeout: 10000 });
      const runs = JSON.parse(stdout);
      for (const win of allWindows) {
        if (!win.isDestroyed()) {
          win.webContents.send('ci-status-update', { id, runs });
        }
      }
    } catch (_) { /* silent — background poll */ }
  };
  // Initial poll after short delay.
  const initialTimer = setTimeout(poll, 3000);
  const intervalTimer = setInterval(poll, 30000);
  // Track both so stopCIPolling can cancel a pending initial-poll timeout
  // (previously only the interval was tracked, so a kill within 3s of spawn
  // still left the initial poll firing against the now-dead task).
  ciPollingIntervals.set(id, { intervalTimer, initialTimer });
}

function stopCIPolling(id) {
  const timers = ciPollingIntervals.get(id);
  if (!timers) return;
  // Older entries were a single intervalId; new ones are { intervalTimer,
  // initialTimer }. Handle both shapes defensively.
  if (typeof timers === 'object') {
    if (timers.intervalTimer) clearInterval(timers.intervalTimer);
    if (timers.initialTimer) clearTimeout(timers.initialTimer);
  } else {
    clearInterval(timers);
  }
  ciPollingIntervals.delete(id);
}

ipcMain.handle('ci-status', async (_event, { worktreePath, branch }) => {
  try {
    const output = ghExec([
      'run', 'list', '--branch', branch, '--limit', '5',
      '--json', 'status,conclusion,name,url,createdAt'
    ], { cwd: worktreePath, stdio: 'pipe', timeout: 10000 }).toString();
    return { runs: JSON.parse(output) };
  } catch (err) {
    return { runs: [], error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('ci-run-logs', async (_event, { worktreePath, runId }) => {
  try {
    const output = ghExec(['run', 'view', String(runId), '--log-failed'], {
      cwd: worktreePath, stdio: 'pipe', timeout: 15000, maxBuffer: 5 * 1024 * 1024
    }).toString();
    return { logs: output };
  } catch (err) {
    return { logs: '', error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- Git Tags (Feature 11) ----

ipcMain.handle('git-tags', async (_event, { worktreePath }) => {
  try {
    const { stdout } = await execFileP('git', ['tag', '-l', '--sort=-creatordate',
      '--format=%(refname:short)\t%(objectname:short)\t%(subject)\t%(creatordate:short)'],
      { cwd: worktreePath, maxBuffer: 5 * 1024 * 1024 });
    const tags = stdout.split('\n').filter(Boolean).map(line => {
      const [name, commit, message, date] = line.split('\t');
      return { name, commit, message: message || '', date: date || '' };
    });
    return { tags };
  } catch (err) {
    return { tags: [], error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-tag-create', async (_event, { worktreePath, name, message, commit }) => {
  try {
    const args = ['tag'];
    if (message) {
      args.push('-a', name, '-m', message);
    } else {
      args.push(name);
    }
    if (commit) args.push(commit);
    await execFileP('git', args, { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-tag-delete', async (_event, { worktreePath, name }) => {
  try {
    await execFileP('git', ['tag', '-d', name], { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

ipcMain.handle('git-tag-push', async (_event, { worktreePath, name }) => {
  try {
    await execFileP('git', ['push', 'origin', name], { cwd: worktreePath, timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- Task Notes (Feature 14) ----

ipcMain.handle('get-task-note', async (_event, { taskName }) => {
  const config = loadConfig();
  return { note: (config.taskNotes && config.taskNotes[taskName]) || '' };
});

ipcMain.handle('set-task-note', async (_event, { taskName, note }) => {
  const config = loadConfig();
  if (!config.taskNotes) config.taskNotes = {};
  config.taskNotes[taskName] = note;
  saveConfig(config);
  return { ok: true };
});

// ---- Auto-fetch (Feature 15) ----

let autoFetchIntervalId = null;

function startAutoFetch() {
  if (autoFetchIntervalId) {
    clearInterval(autoFetchIntervalId);
    autoFetchIntervalId = null;
  }
  const config = loadConfig();
  const interval = config.autoFetchInterval || 60000; // default 60s
  if (interval <= 0) return;

  // Per-task fetch + ahead/behind refresh. Cap concurrency at 4 so a user with
  // many tasks doesn't spawn 20 simultaneous git fetch subprocesses (which
  // both hammers GH and exhausts connection slots).
  async function fetchOne([id, inst]) {
    if (!inst.alive || !inst.worktreePath) return;
    // Plain-folder tasks (opened via open-folder) have no branch — skip git.
    if (!inst.branch) return;
    try {
      await execFileP('git', ['fetch', '--prune'], {
        cwd: inst.worktreePath, timeout: 10000,
      });
    } catch (_) { return; /* fetch failed — nothing to report */ }
    try {
      const { stdout } = await execFileP(
        'git', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
        { cwd: inst.worktreePath, timeout: 5000 },
      );
      const parts = stdout.trim().split(/\s+/);
      const ahead = parseInt(parts[0], 10) || 0;
      const behind = parseInt(parts[1], 10) || 0;
      for (const win of allWindows) {
        if (!win.isDestroyed()) {
          win.webContents.send('auto-fetch-update', { id, ahead, behind });
        }
      }
    } catch (_) { /* no upstream — skip */ }
  }

  autoFetchIntervalId = setInterval(() => {
    // Snapshot the instances map — new tasks spawned mid-tick will pick up
    // on the next tick instead of racing with this one.
    const snapshot = Array.from(instances.entries());
    runWithConcurrency(snapshot, 4, fetchOne);
  }, interval);
}

// ---- H3: Worktree file watcher for instant diff refresh ----

// Subscribers is a per-webContents refcount (Map<webContents, number>) rather
// than a Set, so independent renderer features (diff panel + H2 sidebar) that
// both watch the same worktree don't clobber each other's subscription when
// one unsubscribes.
const worktreeWatchers = new Map(); // worktreePath -> { watcher, subscribers: Map<webContents, number>, debounceTimer }

// Path patterns we ignore — high-churn build output and git internals that don't
// affect our UI. .git/index and .git/HEAD are NOT ignored: they signal git state
// changes we want to reflect (commits, stages made from the terminal, etc.).
const WATCH_IGNORE_RE = /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|__pycache__|\.pytest_cache|\.mypy_cache|\.turbo|target|\.DS_Store)(\/|$)|^\.git\/(objects|logs|refs|packed-refs|FETCH_HEAD|ORIG_HEAD|COMMIT_EDITMSG)/;

function startWorktreeWatcher(worktreePath) {
  let state = worktreeWatchers.get(worktreePath);
  if (state) return state;

  state = { watcher: null, subscribers: new Map(), debounceTimer: null };

  try {
    state.watcher = fs.watch(worktreePath, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      // Normalize separators — on macOS we get forward slashes already, but be safe.
      const rel = filename.replace(/\\/g, '/');
      if (WATCH_IGNORE_RE.test(rel)) return;

      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        for (const wc of state.subscribers.keys()) {
          if (!wc.isDestroyed()) wc.send('worktree-changed', { worktreePath });
        }
      }, 200);
    });
    state.watcher.on('error', (err) => {
      console.error('[watch]', worktreePath, err.message);
    });
  } catch (err) {
    console.error('[watch] failed to start', worktreePath, err.message);
    return null;
  }

  worktreeWatchers.set(worktreePath, state);
  return state;
}

function stopWorktreeWatcher(worktreePath) {
  const state = worktreeWatchers.get(worktreePath);
  if (!state) return;
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  try { state.watcher && state.watcher.close(); } catch (_) {}
  worktreeWatchers.delete(worktreePath);
}

ipcMain.handle('watch-worktree', (event, { worktreePath }) => {
  if (!worktreePath) return { error: 'no worktreePath' };
  const state = startWorktreeWatcher(worktreePath);
  if (!state) return { error: 'watcher failed to start' };
  const count = state.subscribers.get(event.sender) || 0;
  state.subscribers.set(event.sender, count + 1);
  // Auto-cleanup when the renderer is destroyed (window closed, reload, etc.).
  // Only registered on the first subscription from this sender — refcount
  // increments don't re-register the destroyed listener.
  if (count === 0) {
    const cleanup = () => {
      const s = worktreeWatchers.get(worktreePath);
      if (!s) return;
      s.subscribers.delete(event.sender);
      if (s.subscribers.size === 0) stopWorktreeWatcher(worktreePath);
    };
    event.sender.once('destroyed', cleanup);
  }
  return { ok: true };
});

ipcMain.handle('unwatch-worktree', (event, { worktreePath }) => {
  if (!worktreePath) return { ok: true };
  const state = worktreeWatchers.get(worktreePath);
  if (!state) return { ok: true };
  const count = state.subscribers.get(event.sender) || 0;
  if (count <= 1) state.subscribers.delete(event.sender);
  else state.subscribers.set(event.sender, count - 1);
  if (state.subscribers.size === 0) stopWorktreeWatcher(worktreePath);
  return { ok: true };
});

// ---- Phase 7: File Viewer ----

ipcMain.handle('read-file', async (_event, { filePath }) => {
  const safe = pathUnderAnyRoot(filePath);
  if (!safe) return { error: 'path not under an allowed project root' };
  try {
    const content = fs.readFileSync(safe, 'utf-8');
    return { content, ext: path.extname(safe).slice(1) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-file', async (_event, { filePath, content }) => {
  const safe = pathUnderAnyRoot(filePath);
  if (!safe) return { error: 'path not under an allowed project root' };
  try {
    fs.writeFileSync(safe, content, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});
