// IPC surface for the global Agents panel. All handlers are thin wrappers
// over agent-registry — the registry owns state and broadcasts
// `agents-changed` to every BrowserWindow on every mutation, so renderers
// only invoke for one-shot reads + commands.

const { ipcMain } = require('electron');
const agentRegistry = require('../state/agent-registry');

ipcMain.handle('agents-list', () => agentRegistry.list());
ipcMain.handle('agents-get', (_e, { id }) => agentRegistry.get(id));
ipcMain.handle('agents-find-by-dedupe-key', (_e, { key }) => agentRegistry.findByDedupeKey(key));
ipcMain.handle('agents-cancel', (_e, { id }) => ({ ok: agentRegistry.cancel(id) }));
ipcMain.handle('agents-mark-read', (_e, { id }) => { agentRegistry.markRead(id); return { ok: true }; });
ipcMain.handle('agents-mark-all-read', () => { agentRegistry.markAllRead(); return { ok: true }; });
ipcMain.handle('agents-clear-completed', () => { agentRegistry.clearCompleted(); return { ok: true }; });
