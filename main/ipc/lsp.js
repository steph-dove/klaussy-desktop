// Thin IPC wrappers over lsp-manager.js. The renderer never touches
// child_process; lsp-manager owns server lifecycles and proxies JSON-RPC.
// Each renderer webContents registers servers tied to it so we can tear
// them down if the window closes (see hardenWindow in state/windows.js).

const { ipcMain } = require('electron');
const lspManager = require('../../lsp-manager');

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
