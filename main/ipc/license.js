// License activation IPC. Renderer calls `license-status` on startup to
// decide whether to gate any functionality, and `license-activate` from the
// activation modal.

const { ipcMain, shell } = require('electron');
const license = require('../state/license');

// Checkout URL for the Buy button. Drop your actual Paddle checkout link
// here (or inject at build time via an env var) once the product is set up.
const BUY_URL = process.env.PADDLE_CHECKOUT_URL || 'https://example.com/buy-klaussy';

ipcMain.handle('license-status', () => license.status());

ipcMain.handle('license-activate', async (_event, { key }) => {
  return license.activate(key);
});

ipcMain.handle('license-deactivate', async () => {
  return license.deactivate();
});

ipcMain.handle('license-open-checkout', () => {
  shell.openExternal(BUY_URL);
  return { ok: true };
});

// Background re-verify once on app start. Doesn't block anything; if it
// fails or finds a revocation it quietly updates local state.
license.maybeReVerify();
