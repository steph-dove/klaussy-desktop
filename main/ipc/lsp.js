// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
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

// Exactly the LSP traffic the editor (renderer/lsp-client.js) sends; a test
// fails if it starts sending something not listed. Nothing else reaches a
// server: workspace/executeCommand and friends make it run commands or edit
// files outside the document the editor has open.
const LSP_REQUESTS = new Set([
  'initialize', 'shutdown',
  'textDocument/completion', 'textDocument/hover', 'textDocument/definition',
  'textDocument/codeAction', 'textDocument/formatting', 'textDocument/rangeFormatting',
  'textDocument/rename',
]);
const LSP_NOTIFICATIONS = new Set([
  'initialized', 'exit', '$/cancelRequest',
  'textDocument/didOpen', 'textDocument/didChange', 'textDocument/didSave', 'textDocument/didClose',
  'workspace/didChangeConfiguration', 'workspace/didChangeWatchedFiles',
]);
const lspAllowed = (method, list) => typeof method === 'string' && list.has(method);

ipcMain.handle('lsp-request', async (_event, { serverId, method, params }) => {
  if (!lspAllowed(method, LSP_REQUESTS)) return { error: `LSP method not allowed: ${String(method)}` };
  return lspManager.request(serverId, method, params);
});

ipcMain.handle('lsp-notify', async (_event, { serverId, method, params }) => {
  if (!lspAllowed(method, LSP_NOTIFICATIONS)) return { error: `LSP method not allowed: ${String(method)}` };
  return lspManager.notify(serverId, method, params);
});

ipcMain.handle('lsp-install', async (event, { languageId }) => {
  return lspManager.installServer({ languageId, webContents: event.sender });
});

module.exports = { LSP_REQUESTS, LSP_NOTIFICATIONS };
