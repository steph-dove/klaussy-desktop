// IPC surface for Ollama-backed inline completion. Mirrors the channel
// layout of claude-stream-ipc.js (chunk-/done- suffixes keyed by requestId)
// so the renderer can reuse the same streaming-subscription pattern.
//
// Request lifecycle: renderer calls ollama-complete-start; main streams
// ollama-complete-chunk-<id> then ollama-complete-done-<id> ({ ok | error |
// cancelled }); renderer may ollama-complete-cancel at any point.

const { ipcMain } = require('electron');
const ollama = require('../state/ollama');
const { loadConfig } = require('../util/config');

// Tracks in-flight requests so the cancel handler can find the AbortController.
const inFlight = new Map();

ipcMain.handle('ollama-probe', async () => {
  return ollama.probe();
});

ipcMain.handle('ollama-probe-refresh', async () => {
  return ollama.probeNow();
});

ipcMain.handle('ollama-warmup', async () => {
  // Fire-and-forget; do not await so the renderer unblocks immediately.
  ollama.warmup();
  return { ok: true };
});

// Pull the configured model if missing, streaming progress to the caller so
// the preferences model-picker can show a download bar. Awaited so the UI can
// report the final result.
ipcMain.handle('ollama-ensure-model', async (event) => {
  const sender = event.sender;
  return ollama.ensureModel({
    onProgress: (p) => { if (!sender.isDestroyed()) sender.send('ollama-setup-progress', p); },
  });
});

ipcMain.handle('ollama-complete-start', (event, { requestId, prefix, suffix, filePath, snippets, repoName }) => {
  if (!requestId) return { error: 'Missing requestId' };
  if (inFlight.has(requestId)) return { error: 'Already in flight' };

  const sender = event.sender;
  const chunkChannel = `ollama-complete-chunk-${requestId}`;
  const doneChannel = `ollama-complete-done-${requestId}`;

  // One destroyed-handler per request was causing MaxListeners warnings after
  // ~11 passive completions in a session. Track the handler so we can detach
  // it when the request finishes naturally.
  const onDestroyed = () => {
    const c = inFlight.get(requestId);
    if (c) { try { c(); } catch {} inFlight.delete(requestId); }
  };

  const cancel = ollama.generateFIM({
    prefix: prefix || '',
    suffix: suffix || '',
    filePath: filePath || null,
    snippets: snippets || [],
    repoName: repoName || null,
    onChunk: (text) => {
      if (!sender.isDestroyed()) sender.send(chunkChannel, text);
    },
    onDone: (msg) => {
      inFlight.delete(requestId);
      try { sender.removeListener('destroyed', onDestroyed); } catch {}
      if (!sender.isDestroyed()) sender.send(doneChannel, msg);
    },
  });
  inFlight.set(requestId, cancel);
  sender.once('destroyed', onDestroyed);

  return { ok: true };
});

ipcMain.handle('ollama-complete-cancel', (_event, { requestId }) => {
  const cancel = inFlight.get(requestId);
  if (!cancel) return { ok: false };
  try { cancel(); } catch {}
  inFlight.delete(requestId);
  return { ok: true };
});

// ---- Setup / consent flow ----

// Guard so a double-click on Enable doesn't kick off two concurrent installs.
let _setupInFlight = false;

ipcMain.handle('ollama-setup-status', async () => {
  // Include the saved consent so the renderer can skip re-asking once the user
  // has accepted: a fresh launch usually reports needs-server (the server isn't
  // auto-started), which must NOT re-trigger the consent prompt.
  return { state: await ollama.getSetupState(), consent: loadConfig().ollamaConsent || null };
});

ipcMain.handle('ollama-setup-decline', () => {
  ollama.declineSetup();
  return { ok: true };
});

ipcMain.handle('ollama-setup-start', async (event) => {
  if (_setupInFlight) return { error: 'Setup already running' };
  _setupInFlight = true;
  const sender = event.sender;

  function onProgress(p) {
    if (!sender.isDestroyed()) sender.send('ollama-setup-progress', p);
  }

  try {
    const result = await ollama.runSetup({ onProgress });
    return result;
  } finally {
    _setupInFlight = false;
  }
});
