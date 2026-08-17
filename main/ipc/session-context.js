// IPC handlers for managing uncommitted OKF session context notes.

const { ipcMain } = require('electron');
const {
  listSessionNotes,
  writeSessionNote,
  buildSessionContextSummary,
  clearSessionNotes,
} = require('../state/session-context');

ipcMain.handle('session-context:list-notes', async (_event, { worktreePath } = {}) => {
  try {
    return listSessionNotes(worktreePath);
  } catch (err) {
    console.warn('[session-context] list failed:', err && err.message);
    return { error: err && err.message || String(err) };
  }
});

ipcMain.handle('session-context:add-note', async (_event, { worktreePath, noteData } = {}) => {
  try {
    if (!noteData) throw new Error('Missing noteData');
    return writeSessionNote(worktreePath, noteData);
  } catch (err) {
    console.warn('[session-context] add failed:', err && err.message);
    return { error: err && err.message || String(err) };
  }
});

ipcMain.handle('session-context:get-summary', async (_event, { worktreePath } = {}) => {
  try {
    return buildSessionContextSummary(worktreePath);
  } catch (err) {
    console.warn('[session-context] summary failed:', err && err.message);
    return { error: err && err.message || String(err) };
  }
});

// Returns the eligible count too, so the drawer can explain a zero: a lone agent
// has nobody to tell.
ipcMain.handle('session-context:capture-now', async () => {
  try {
    const { instances } = require('../state/instances');
    const { captureActivity, agentsWithCompany } = require('../state/session-activity');
    const agents = [...instances.values()];
    const eligible = agentsWithCompany(agents).length;
    const written = await captureActivity(agents);
    return { written: written.length, eligible };
  } catch (err) {
    console.warn('[session-context] capture failed:', err && err.message);
    return { error: err && err.message || String(err) };
  }
});

ipcMain.handle('session-context:clear-notes', async (_event, { worktreePath } = {}) => {
  try {
    return clearSessionNotes(worktreePath);
  } catch (err) {
    console.warn('[session-context] clear failed:', err && err.message);
    return { error: err && err.message || String(err) };
  }
});
