// License activation IPC. Renderer calls `license-status` on startup to
// decide whether to gate any functionality, and `license-activate` from the
// activation modal.

const { ipcMain, shell } = require('electron');
const license = require('../state/license');

// Checkout URL for the Buy button. Set LEMONSQUEEZY_CHECKOUT_URL at build
// time to your storefront's pricing page (e.g. https://klaussy.lemonsqueezy.com).
const BUY_URL = process.env.LEMONSQUEEZY_CHECKOUT_URL || 'https://klaussy.lemonsqueezy.com';

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
