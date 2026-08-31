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

// Counted per session so the drawer can explain a zero: agents elsewhere are on
// another channel, so their notes would never show up here.
ipcMain.handle('session-context:capture-now', async (_event, { worktreePath } = {}) => {
  try {
    const { liveAgentInstances } = require('../state/instances');
    const activity = require('../state/session-activity');
    const agents = liveAgentInstances();
    const byChannel = activity.liveAgentsByChannel(agents);
    const here = worktreePath ? activity.channelFor(worktreePath) : null;
    const inSession = (here && byChannel.get(here)) ? byChannel.get(here).length : 0;
    const elsewhere = [...byChannel.entries()]
      .filter(([channel]) => channel !== here)
      .reduce((sum, [, group]) => sum + group.length, 0);
    const written = await activity.captureActivity(agents, { worktreePath, requireCompany: false });
    return { written: written.length, inSession, elsewhere };
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
