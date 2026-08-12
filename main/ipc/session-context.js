// IPC handlers for managing uncommitted OKF session context notes.

const { ipcMain } = require('electron');
const {
  listSessionNotes,
  writeSessionNote,
  buildSessionContextSummary,
  clearSessionNotes,
} = require('../state/session-context');

ipcMain.handle('session-context:list-notes', async (_event, { worktreePath, sessionId } = {}) => {
  try {
    return listSessionNotes(worktreePath, sessionId);
  } catch (err) {
    return [];
  }
});

ipcMain.handle('session-context:add-note', async (_event, { worktreePath, sessionId, noteData } = {}) => {
  try {
    if (!noteData) throw new Error('Missing noteData');
    return writeSessionNote(worktreePath, sessionId, noteData);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('session-context:get-summary', async (_event, { worktreePath, sessionId } = {}) => {
  try {
    return buildSessionContextSummary(worktreePath, sessionId);
  } catch (err) {
    return '';
  }
});

ipcMain.handle('session-context:clear-notes', async (_event, { worktreePath, sessionId } = {}) => {
  try {
    return clearSessionNotes(worktreePath, sessionId);
  } catch (err) {
    return false;
  }
});
