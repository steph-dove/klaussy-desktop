// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Azure DevOps IPC surface: list, save, switch and remove PAT-backed accounts.

const { ipcMain } = require('electron');
const {
  AzureAuthError,
  listAzureAccounts,
  saveAzureAccount,
  switchAzureAccount,
  removeAzureAccount,
} = require('../util/azure-api');
const { classifyAzureError } = require('../util/azure-error');

// Input and secure-storage refusals already read as instructions; anything
// else (a rejected PAT, a network error) goes through the classifier.
function saveError(err) {
  if (err instanceof AzureAuthError) {
    return { error: err.message, errorKind: err.kind, errorSummary: err.message, errorFix: '' };
  }
  const raw = ((err && (err.responseBody || err.message)) || '').trim();
  const cls = classifyAzureError(raw || (err && err.message));
  return { error: raw, errorKind: cls.kind, errorSummary: cls.summary, errorFix: cls.fix };
}

ipcMain.handle('azure-list-accounts', async () => {
  return { accounts: listAzureAccounts(), error: null };
});

ipcMain.handle('azure-save-account', async (_event, { collection, pat } = {}) => {
  try {
    return { account: await saveAzureAccount({ collection, pat }) };
  } catch (err) {
    return saveError(err);
  }
});

ipcMain.handle('azure-switch-account', async (_event, { id } = {}) => {
  return { ok: await switchAzureAccount(id) };
});

ipcMain.handle('azure-remove-account', async (_event, { id } = {}) => {
  return { ok: await removeAzureAccount(id) };
});

module.exports = { saveError };
