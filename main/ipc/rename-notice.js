// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// One-time "Klaussy is now Maussian" card for installs upgraded from Klaussy.

const { ipcMain } = require('electron');
const { loadConfig, saveConfig, flushSaveConfig } = require('../util/config');
const { listAzureAccounts } = require('../util/azure-api');
const { usingLegacyUserData } = require('../bootstrap/single-instance');

// Fresh installs never see it, and an upgraded one sees it once. reconnect lists
// the Azure DevOps orgs whose saved token this build can't decrypt (on macOS the
// Keychain entry follows the app name), one per org.
function renameNotice({ legacy, config, azureAccounts }) {
  if (!legacy || (config && config.renameNoticeSeen)) return null;
  const seen = new Set();
  const reconnect = [];
  for (const a of azureAccounts || []) {
    if (!a.needsReentry || !a.collectionUrl || seen.has(a.collectionUrl)) continue;
    seen.add(a.collectionUrl);
    reconnect.push({ collectionUrl: a.collectionUrl, collectionPath: a.collectionPath, host: a.host });
  }
  return { reconnect };
}

ipcMain.handle('rename-notice-get', async () => {
  let azureAccounts = [];
  try { azureAccounts = listAzureAccounts(); } catch (_) { /* no Azure accounts to offer */ }
  const notice = renameNotice({ legacy: usingLegacyUserData(), config: loadConfig(), azureAccounts });
  if (notice) {
    // Marked seen as soon as it's shown, so closing it any way at all counts.
    saveConfig({ renameNoticeSeen: true });
    await flushSaveConfig();
  }
  return notice;
});

module.exports = { renameNotice };
