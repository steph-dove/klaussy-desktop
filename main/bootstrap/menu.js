// Application menu. Call installAppMenu() from whenReady — after app.setName
// so the app-name submenu label picks up "Klaussy" instead of "Electron".
//
// Most items are simple renderer-facing signals (send a channel so the
// renderer toggles a dialog). The Edit menu intentionally keeps paste even
// though the renderer does its own paste handling — the system shortcut path
// is expected to work in input fields.

const { app, BrowserWindow, Menu } = require('electron');
const { createWindow } = require('../state/windows');
const { checkNow: checkForUpdatesNow } = require('./auto-updater');

function installAppMenu() {
  // Custom menu without Edit menu paste (we handle it ourselves in the renderer)
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates…',
          click: () => { checkForUpdatesNow(); },
        },
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
}

module.exports = { installAppMenu };
