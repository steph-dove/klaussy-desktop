// Bitbucket IPC surface: list accounts, switch account, save and remove accounts.

const { ipcMain } = require('electron');
const {
  listBitbucketAccounts,
  switchBitbucketAccount,
  saveBitbucketAccount,
  removeBitbucketAccount,
} = require('../util/bitbucket-api');

ipcMain.handle('bitbucket-list-accounts', async () => {
  return { accounts: listBitbucketAccounts(), error: null };
});

ipcMain.handle('bitbucket-switch-account', async (_event, { username, hostname }) => {
  return switchBitbucketAccount(username, hostname);
});

ipcMain.handle('bitbucket-save-account', async (_event, account) => {
  return saveBitbucketAccount(account);
});

ipcMain.handle('bitbucket-remove-account', async (_event, { username, hostname }) => {
  return removeBitbucketAccount(username, hostname);
});

module.exports = {
  listBitbucketAccounts,
  switchBitbucketAccount,
  saveBitbucketAccount,
  removeBitbucketAccount,
};
